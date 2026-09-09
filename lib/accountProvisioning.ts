// lib/accountProvisioning.ts — the ONE way an ExpertMatch account is created.
//
// Every path that creates a user (platform-admin invite, access-request
// approval, seat-request approval, org-admin team invite, auto-approved access
// request) calls provisionAccountInvite(). No other module may write a pending
// user — that is what makes "first name + last name + email + organization,
// always" impossible to bypass.
//
// Single-use links are Supabase recovery tokens (lib/authLinks.ts) — Redis is
// used here only for the best-effort seat-claim lock, so an Upstash outage
// cannot stop an invitation.
//
// Expected failures come back as a typed result, never thrown: callers turn
// them straight into HTTP responses. Only genuinely unexpected conditions are
// caught and reported as `internal_error`.
//
// Never logs email, name, domain, organization name or tokens.

import { mintSetPasswordLink } from './authLinks';
import { isPublicEmailDomain } from './emailDomains';
import { sendInviteEmail } from './sendAvailabilityRequest';
import { sendPasswordResetEmail } from './passwordReset';
import { trackProductEvent } from './productEvents';
import {
  getFirm,
  upsertFirm,
  getUser,
  upsertUser,
  countActiveUsersForFirm,
  recordSeatRequest,
  sendSeatLimitNotification,
  tryClaimSeat,
  releaseSeatClaim,
  type OrgRole,
} from './firmStore';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProvisionErrorCode =
  | 'invalid_first_name'
  | 'invalid_last_name'
  | 'invalid_email'
  | 'invalid_organization'
  | 'personal_email_domain'
  | 'organization_name_required'
  | 'email_domain_mismatch'
  | 'organization_disabled'
  | 'user_exists'
  | 'seat_limit_reached'
  | 'concurrent_signup'
  | 'storage_unavailable'
  | 'not_configured'
  | 'internal_error';

export interface ProvisionAccountInput {
  firstName:    string;
  lastName:     string;
  email:        string;
  organization: {
    /** Organization domain. Derived from the email domain when omitted. */
    domain?: string;
    /** Required when the organization does not exist yet. */
    name?:   string;
  };
  /** Platform role. Defaults to 'user'. */
  role?:    'user' | 'admin';
  /** Membership role. Omit to let an organization's first member become its admin. */
  orgRole?: OrgRole;
  /** Recorded by the caller for its own audit trail; never emailed to the invitee. */
  invitedByEmail?: string;
  /**
   * Platform admins may invite an address whose domain differs from the
   * organization's (e.g. an advisor attached to a client org). Org admins may not.
   */
  isPlatformAdmin?: boolean;
  /**
   * Deliberate re-send to someone who already has an account. Without it an
   * existing active or pending user is `user_exists`, which is why an admin
   * previously had no way to resend a lost invitation.
   *
   * A pending user gets a fresh invitation; an ACTIVE user keeps their account
   * and gets a set-password (reset) link instead — their seat, membership and
   * onboarding state are never touched, and the seat cap does not apply.
   */
  reinvite?: boolean;
}

export interface ProvisionSuccess {
  ok:               true;
  email:            string;
  firstName:        string;
  lastName:         string;
  /** organizations.id (uuid) — the billing organization id. */
  organizationId:   string;
  organizationName: string;
  organizationDomain: string;
  setPasswordUrl:   string;
  /** false when the invite was stored but the email could not be delivered. */
  emailSent:        boolean;
  /** true when this re-sent a link to an existing member rather than creating one. */
  reinvited?:       boolean;
}

export interface ProvisionFailure {
  ok:      false;
  error:   ProvisionErrorCode;
  message: string;
  status:  number;
}

export type ProvisionResult = ProvisionSuccess | ProvisionFailure;

// ─── Validation ───────────────────────────────────────────────────────────────

const MAX_NAME_LENGTH = 100;

// RFC-ish: one @, no whitespace, a dotted domain with a 2+ char TLD.
const EMAIL_RE  = /^[^\s@]{1,64}@[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/i;
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/;

const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g;

/** Strips control characters, collapses whitespace, trims, caps the length. */
export function sanitizeName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(CONTROL_CHARS_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

export function normalizeEmail(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().slice(0, 254);
}

export function normalizeDomain(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase().replace(/^@/, '').replace(/^www\./, '').slice(0, 253);
}

/** "Jane Q. Okafor" → { firstName: 'Jane', lastName: 'Q. Okafor' } */
export function splitFullName(fullName: unknown): { firstName: string; lastName: string } {
  const clean = sanitizeName(fullName);
  if (!clean) return { firstName: '', lastName: '' };
  const parts = clean.split(' ');
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return {
    firstName: parts[0],
    lastName:  parts.slice(1).join(' ').slice(0, MAX_NAME_LENGTH),
  };
}

function fail(error: ProvisionErrorCode, message: string, status: number): ProvisionFailure {
  return { ok: false, error, message, status };
}

// ─── Provisioning ─────────────────────────────────────────────────────────────

/**
 * Validates the invitee, ensures their organization exists, checks the optional
 * seat cap, writes the pending account + membership, stores a single-use invite
 * token and emails the set-password link.
 *
 * Returns `{ ok: true, setPasswordUrl }` or a typed failure. Never throws.
 */
export async function provisionAccountInvite(
  input: ProvisionAccountInput,
): Promise<ProvisionResult> {
  // ── 1. Names ────────────────────────────────────────────────────────────────
  const firstName = sanitizeName(input.firstName);
  const lastName  = sanitizeName(input.lastName);

  if (firstName.length < 1) return fail('invalid_first_name', 'First name is required.', 400);
  if (lastName.length  < 1) return fail('invalid_last_name',  'Last name is required.',  400);

  // ── 2. Email ────────────────────────────────────────────────────────────────
  const email = normalizeEmail(input.email);
  if (!email || !EMAIL_RE.test(email)) {
    return fail('invalid_email', 'A valid email address is required.', 400);
  }
  const emailDomain = email.split('@')[1] ?? '';

  // ── 3. Organization ─────────────────────────────────────────────────────────
  const requestedDomain = normalizeDomain(input.organization?.domain);
  const orgDomain       = requestedDomain || emailDomain;
  const orgNameInput    = sanitizeName(input.organization?.name);

  if (!orgDomain || !DOMAIN_RE.test(orgDomain)) {
    return fail('invalid_organization', 'A valid organization domain is required.', 400);
  }

  // Members must use their organization's email domain. Only platform admins
  // may deliberately cross that boundary.
  if (orgDomain !== emailDomain && !input.isPlatformAdmin) {
    return fail(
      'email_domain_mismatch',
      `The email address must use your organization's domain (@${orgDomain}).`,
      400,
    );
  }

  // A consumer email domain is never an organization (lib/emailDomains.ts).
  // Someone on Gmail joins the organization a platform admin NAMES for them —
  // never one derived from the address. This is what closed the door the
  // founder's gmail.com admin org had left open.
  if (isPublicEmailDomain(orgDomain)) {
    return fail(
      'personal_email_domain',
      `${orgDomain} is a personal email provider, not an organization. Invite this person into a named organization instead.`,
      400,
    );
  }

  if (!(process.env.NEXT_PUBLIC_APP_URL ?? '').trim()) {
    return fail('not_configured', 'Invite links are not configured. Contact support.', 500);
  }

  try {
    let firm = await getFirm(orgDomain);

    if (firm && firm.status === 'disabled') {
      return fail('organization_disabled', 'This organization is disabled. Contact support.', 403);
    }

    if (!firm) {
      if (!orgNameInput) {
        return fail(
          'organization_name_required',
          'This organization does not exist yet — provide its name to create it.',
          400,
        );
      }
      await upsertFirm(orgDomain, {
        name:      orgNameInput,
        status:    'active',
        seatLimit: null,          // unlimited until a platform admin sets a cap
      });
      firm = await getFirm(orgDomain);
      if (!firm) {
        return fail('storage_unavailable', 'Could not create the organization. Please try again.', 503);
      }
    }

    const organizationName = firm.name || orgNameInput || orgDomain;

    // ── 4. Duplicate check / re-invite ────────────────────────────────────────
    const existing = await getUser(email);
    if (existing && (existing.status === 'active' || existing.status === 'pending')) {
      if (!input.reinvite) {
        return fail('user_exists', 'An account with this email already exists.', 409);
      }

      // An org admin may only re-invite their own members. A mismatch answers
      // exactly like an ordinary duplicate so team management cannot be used to
      // probe for accounts at other organizations.
      if (existing.orgId && existing.orgId !== firm.id && !input.isPlatformAdmin) {
        return fail('user_exists', 'An account with this email already exists.', 409);
      }

      // An active member keeps their account and receives a reset link; a
      // pending one gets a fresh invitation. Either way the token carries the
      // organization, so accepting it cannot re-home them.
      const kind = existing.status === 'active' ? 'reset' : 'invite';
      const link = await mintSetPasswordLink(email, organizationName, { kind, orgId: firm.id });
      if (!link) {
        return fail('storage_unavailable', 'Could not create the link. Please try again shortly.', 503);
      }
      const setPasswordUrl = link.url;
      const greetingName   = existing.firstName || firstName;

      let emailSent = true;
      try {
        if (kind === 'reset') {
          await sendPasswordResetEmail(email, setPasswordUrl, greetingName);
        } else {
          await sendInviteEmail(email, organizationName, setPasswordUrl, greetingName);
        }
      } catch {
        // The token is stored — the link is valid, only delivery failed.
        emailSent = false;
        console.error('[accountProvisioning] re-invite email delivery failed');
      }

      return {
        ok: true,
        email,
        firstName:          existing.firstName || firstName,
        lastName:           existing.lastName  || lastName,
        organizationId:     firm.id,
        organizationName,
        organizationDomain: orgDomain,
        setPasswordUrl,
        emailSent,
        reinvited:          true,
      };
    }

    // ── 5. Optional platform-admin seat cap (null = unlimited) ────────────────
    const activeSeatCount = await countActiveUsersForFirm(orgDomain);
    if (firm.seatLimit !== null && activeSeatCount >= firm.seatLimit) {
      await recordSeatRequest(email, orgDomain, {
        name:     `${firstName} ${lastName}`.trim(),
        firmName: organizationName,
      }).catch(() => {});
      await sendSeatLimitNotification({
        attemptedEmail:  email,
        firmName:        organizationName,
        firmDomain:      orgDomain,
        activeSeatCount,
        seatLimit:       firm.seatLimit,
      });
      return fail(
        'seat_limit_reached',
        'This organization has reached its seat cap. The ExpertMatch team has been notified.',
        403,
      );
    }

    // ── 6. Concurrency claim ─────────────────────────────────────────────────
    const claim = await tryClaimSeat(orgDomain, email, 10);
    if (claim === 'concurrent_signup') {
      return fail('concurrent_signup', 'An invite for this address is already being created.', 409);
    }

    try {
      // ── 7. Auth account + profile + pending membership ─────────────────────
      // upsertUser provisions the Supabase auth user with an unguessable
      // random password; the set-password flow replaces it.
      await upsertUser(email, {
        firstName,
        lastName,
        firmDomain:         orgDomain,
        firmName:           organizationName,
        role:               input.role === 'admin' ? 'admin' : 'user',
        status:             'pending',
        onboardingComplete: false,
        ...(input.orgRole ? { orgRole: input.orgRole } : {}),
      });

      // ── 8. Single-use invite link ──────────────────────────────────────────
      // Our signed token carries the organization, so set-password never
      // re-derives it from the email domain (which used to strand a
      // cross-domain invitee in a new organization of their own). Single use
      // is Supabase's recovery token, not a Redis key (lib/authLinks.ts).
      const link = await mintSetPasswordLink(email, organizationName, { kind: 'invite', orgId: firm.id });
      if (!link) {
        // The pending account exists; "Resend invite" (reinvite: true) mints
        // a fresh link. Say so rather than pretending the invite went out.
        return fail('storage_unavailable', 'The account was created but the invite link could not be minted. Use Resend invite.', 503);
      }
      const setPasswordUrl = link.url;

      await trackProductEvent({
        type:           'account_invited',
        actorEmail:     email,
        organizationId: firm.id,
        payload:        { role: input.role === 'admin' ? 'admin' : 'user', orgRole: input.orgRole ?? 'auto' },
      });

      // ── 9. Invite email ────────────────────────────────────────────────────
      let emailSent = true;
      try {
        await sendInviteEmail(email, organizationName, setPasswordUrl, firstName);
      } catch {
        // The token is stored — the invite is valid, only delivery failed.
        emailSent = false;
        console.error('[accountProvisioning] invite email delivery failed');
      }

      return {
        ok: true,
        email,
        firstName,
        lastName,
        organizationId:     firm.id,
        organizationName,
        organizationDomain: orgDomain,
        setPasswordUrl,
        emailSent,
      };
    } finally {
      await releaseSeatClaim(orgDomain, email).catch(() => {});
    }
  } catch {
    console.error('[accountProvisioning] provisioning failed');
    return fail('internal_error', 'Could not create the account. Please try again.', 500);
  }
}

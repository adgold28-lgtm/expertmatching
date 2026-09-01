// lib/accountProvisioning.ts — the ONE way an ExpertMatch account is created.
//
// Every path that creates a user (platform-admin invite, access-request
// approval, seat-request approval, org-admin team invite, auto-approved access
// request) calls provisionAccountInvite(). No other module may write a pending
// user — that is what makes "first name + last name + email + organization,
// always" impossible to bypass.
//
// Expected failures come back as a typed result, never thrown: callers turn
// them straight into HTTP responses. Only genuinely unexpected conditions are
// caught and reported as `internal_error`.
//
// Never logs email, name, domain, organization name or tokens.

import { getUpstashClient } from './upstashRedis';
import { generateSignupToken } from './signupToken';
import { sendInviteEmail } from './sendAvailabilityRequest';
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
const INVITE_TTL_MS   = 24 * 60 * 60 * 1000;

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

  const redis = getUpstashClient();
  if (!redis) {
    return fail('storage_unavailable', 'Invite storage is unavailable. Please try again shortly.', 503);
  }

  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? '').replace(/\/$/, '');
  if (!appUrl) {
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

    // ── 4. Duplicate check ────────────────────────────────────────────────────
    const existing = await getUser(email);
    if (existing && (existing.status === 'active' || existing.status === 'pending')) {
      return fail('user_exists', 'An account with this email already exists.', 409);
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

      // ── 8. Single-use invite token ─────────────────────────────────────────
      const { token, hash, expiry } = generateSignupToken(email, organizationName);
      const ttlSeconds = Math.max(60, Math.floor((expiry - Date.now()) / 1000));
      await redis.set(`invite-token:${hash}`, email, { ex: Math.min(ttlSeconds, Math.floor(INVITE_TTL_MS / 1000)) });

      const setPasswordUrl = `${appUrl}/auth/set-password?token=${encodeURIComponent(token)}`;

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

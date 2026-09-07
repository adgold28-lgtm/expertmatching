// Team management API — org admins add and remove seats for their own
// organization; platform admins may act on any org via ?orgId= / body.orgId.
//
// Org admins get NO access to their members' projects: this route only ever
// touches organizations / organization_members / profiles.
//
// Every mutation re-syncs the org's Stripe seat quantity (best effort — billing
// must never fail a membership change).

import { NextRequest } from 'next/server';
import { orgAdminGuard, type SessionUser } from '../../../../lib/auth';
import { provisionAccountInvite } from '../../../../lib/accountProvisioning';
import { syncOrgSeatQuantity } from '../../../../lib/orgBilling';
import { seatUnitPriceCents, monthlySeatTotalCents, nextSeatTier } from '../../../../lib/pricing';
import {
  getFirmById,
  getUser,
  listOrgMembers,
  countOrgAdmins,
  upsertUser,
  deleteUser,
  updateOrgMemberRole,
  type OrgRole,
  type UserRecord,
  type UserStatus,
} from '../../../../lib/firmStore';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * The organization this request acts on. Platform admins may target any org;
 * org admins are always scoped to their own — an orgId that is not theirs is
 * rejected rather than silently ignored.
 */
function resolveOrgId(user: SessionUser, requested: string | null | undefined): string | null {
  const asked = (requested ?? '').trim();
  if (user.role === 'admin') return asked || user.orgId || null;
  if (asked && asked !== user.orgId) return null;
  return user.orgId ?? null;
}

interface MemberView {
  email:              string;
  firstName:          string;
  lastName:           string;
  role:               'admin' | 'user';
  orgRole:            OrgRole;
  status:             UserStatus;
  createdAt:          number;
  onboardingComplete: boolean;
}

function toMemberView(user: UserRecord): MemberView {
  return {
    email:              user.email,
    firstName:          user.firstName ?? '',
    lastName:           user.lastName  ?? '',
    role:               user.role,
    orgRole:            user.orgRole ?? 'org_member',
    status:             user.status,
    createdAt:          user.createdAt,
    onboardingComplete: user.onboardingComplete !== false,
  };
}

function seatSummary(members: UserRecord[]) {
  const active  = members.filter(m => m.status === 'active').length;
  const pending = members.filter(m => m.status === 'pending').length;
  const next    = nextSeatTier(active);
  return {
    active,
    pending,
    unitPriceCents:    seatUnitPriceCents(active),
    monthlyTotalCents: monthlySeatTotalCents(active),
    nextTier: next
      ? {
          atSeatCount:    next.minSeats,
          seatsUntil:     Math.max(1, next.minSeats - active),
          unitPriceCents: next.unitPriceCents,
        }
      : null,
  };
}

async function readJson(request: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return typeof body === 'object' && body !== null ? body as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

async function syncSeats(organizationId: string): Promise<void> {
  try { await syncOrgSeatQuantity(organizationId); } catch { /* best effort */ }
}

function noOrg(): Response {
  return Response.json(
    { error: 'no_organization', message: 'No organization to manage.' },
    { status: 400 },
  );
}

// ─── GET — members + seat summary ─────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<Response> {
  const guard = await orgAdminGuard(request);
  if ('error' in guard) return guard.error;

  const orgId = resolveOrgId(guard.user, request.nextUrl.searchParams.get('orgId'));
  if (!orgId) return noOrg();

  try {
    const [firm, members] = await Promise.all([getFirmById(orgId), listOrgMembers(orgId)]);
    if (!firm) {
      return Response.json({ error: 'organization_not_found' }, { status: 404 });
    }

    return Response.json({
      organization: {
        id:        firm.id,
        name:      firm.name,
        domain:    firm.domain,
        status:    firm.status,
        seatLimit: firm.seatLimit,        // null = unlimited
      },
      viewer: {
        email:   guard.user.email,
        role:    guard.user.role,
        orgRole: guard.user.orgRole ?? (guard.user.role === 'admin' ? 'org_admin' : 'org_member'),
      },
      members: members.map(toMemberView),
      seats:   seatSummary(members),
    });
  } catch {
    console.error('[org/members] failed to load team');
    return Response.json({ error: 'load_failed', message: 'Could not load your team.' }, { status: 500 });
  }
}

// ─── POST — invite a member ───────────────────────────────────────────────────
//
// POST { firstName, lastName, email, orgId?, reinvite? }. `reinvite: true`
// re-sends the set-password link to a member who already has an account
// (pending → fresh invitation, active → password reset) instead of failing with
// user_exists; it never consumes an extra seat.

export async function POST(request: NextRequest): Promise<Response> {
  const guard = await orgAdminGuard(request);
  if ('error' in guard) return guard.error;

  const body = await readJson(request);
  if (!body) return Response.json({ error: 'invalid_json' }, { status: 400 });

  const orgId = resolveOrgId(guard.user, typeof body.orgId === 'string' ? body.orgId : null);
  if (!orgId) return noOrg();

  const firm = await getFirmById(orgId).catch(() => null);
  if (!firm) return Response.json({ error: 'organization_not_found' }, { status: 404 });

  const result = await provisionAccountInvite({
    firstName:    typeof body.firstName === 'string' ? body.firstName : '',
    lastName:     typeof body.lastName  === 'string' ? body.lastName  : '',
    email:        typeof body.email     === 'string' ? body.email     : '',
    organization: { domain: firm.domain, name: firm.name },
    // Org admins can only ever add ordinary members — never platform admins.
    role:            'user',
    orgRole:         'org_member',
    invitedByEmail:  guard.user.email,
    isPlatformAdmin: guard.user.role === 'admin',
    // Re-send a link to someone already on the team. provisionAccountInvite
    // refuses when that person belongs to a different organization, so an org
    // admin can only ever re-invite their own members.
    reinvite:        body.reinvite === true,
  });

  if (!result.ok) {
    return Response.json({ error: result.error, message: result.message }, { status: result.status });
  }

  await syncSeats(orgId);

  return Response.json({
    ok:        true,
    email:     result.email,
    emailSent: result.emailSent,
    ...(result.reinvited ? { reinvited: true } : {}),
    ...(result.emailSent
      ? {}
      : { warning: `${result.reinvited ? 'Link created' : 'Invite created'}, but the email could not be delivered.` }),
  });
}

// ─── PATCH — change a member's status or organization role ────────────────────

export async function PATCH(request: NextRequest): Promise<Response> {
  const guard = await orgAdminGuard(request);
  if ('error' in guard) return guard.error;

  const body = await readJson(request);
  if (!body) return Response.json({ error: 'invalid_json' }, { status: 400 });

  const orgId = resolveOrgId(guard.user, typeof body.orgId === 'string' ? body.orgId : null);
  if (!orgId) return noOrg();

  const email   = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const status  = body.status  === 'active'    || body.status  === 'disabled'   ? body.status  : null;
  const orgRole = body.orgRole === 'org_admin' || body.orgRole === 'org_member' ? body.orgRole : null;

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'valid_email_required' }, { status: 400 });
  }
  if (!status && !orgRole) {
    return Response.json(
      { error: 'nothing_to_update', message: 'Provide a status or an organization role.' },
      { status: 400 },
    );
  }

  const isSelf = email === guard.user.email.toLowerCase();
  if (isSelf && status === 'disabled') {
    return Response.json(
      { error: 'cannot_disable_self', message: 'You cannot disable your own seat.' },
      { status: 400 },
    );
  }

  try {
    const member = await getUser(email);
    if (!member || member.orgId !== orgId) {
      return Response.json(
        { error: 'member_not_found', message: 'That person is not in this organization.' },
        { status: 404 },
      );
    }
    if (member.status === 'pending' && status === 'active') {
      return Response.json(
        { error: 'invite_pending', message: 'This person has not accepted their invite yet.' },
        { status: 409 },
      );
    }

    // Never let an organization lose its last admin.
    const currentOrgRole = member.orgRole ?? 'org_member';
    const losesAdmin =
      currentOrgRole === 'org_admin' && (orgRole === 'org_member' || status === 'disabled');

    if (losesAdmin && (await countOrgAdmins(orgId)) <= 1) {
      return Response.json(
        {
          error:   'last_org_admin',
          message: 'This is the only organization admin — promote someone else first.',
        },
        { status: 409 },
      );
    }

    if (orgRole && orgRole !== currentOrgRole) {
      await updateOrgMemberRole(email, orgRole as OrgRole);
    }
    if (status && status !== member.status) {
      await upsertUser(email, { status: status as UserStatus });
    }

    await syncSeats(orgId);

    return Response.json({ ok: true });
  } catch {
    console.error('[org/members] failed to update member');
    return Response.json({ error: 'update_failed', message: 'Could not update this member.' }, { status: 500 });
  }
}

// ─── DELETE — remove a pending or disabled member ─────────────────────────────

export async function DELETE(request: NextRequest): Promise<Response> {
  const guard = await orgAdminGuard(request);
  if ('error' in guard) return guard.error;

  const body = await readJson(request);
  if (!body) return Response.json({ error: 'invalid_json' }, { status: 400 });

  const orgId = resolveOrgId(guard.user, typeof body.orgId === 'string' ? body.orgId : null);
  if (!orgId) return noOrg();

  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@')) {
    return Response.json({ error: 'valid_email_required' }, { status: 400 });
  }
  if (email === guard.user.email.toLowerCase()) {
    return Response.json(
      { error: 'cannot_remove_self', message: 'You cannot remove your own seat.' },
      { status: 400 },
    );
  }

  try {
    const member = await getUser(email);
    if (!member || member.orgId !== orgId) {
      return Response.json(
        { error: 'member_not_found', message: 'That person is not in this organization.' },
        { status: 404 },
      );
    }
    if (member.status === 'active') {
      return Response.json(
        {
          error:   'member_active',
          message: 'Disable this seat before removing it — active members own project history.',
        },
        { status: 409 },
      );
    }

    await deleteUser(email);
    await syncSeats(orgId);

    return Response.json({ ok: true });
  } catch {
    console.error('[org/members] failed to remove member');
    return Response.json({ error: 'delete_failed', message: 'Could not remove this member.' }, { status: 500 });
  }
}

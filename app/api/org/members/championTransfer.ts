// The two "champion" decisions, pure and testable (Wave 5, brief B3).
//
// A route module may export nothing but its handlers, so both decisions live
// here, next to the route that owns the first of them, and are asserted by
// scripts/test-auth-guards.ts without a session, a database or an HTTP server.
//
//   1. decideChampionTransfer — PATCH /api/org/members { action:
//      'transfer_champion', email }: who may hand the championship over, to
//      whom, and who is demoted by it. Promote-then-demote is the caller's job;
//      this only says which writes to make.
//   2. mayAddFirstCard — POST /api/onboarding/billing (the plain, first-time
//      call): the firm's card is the champion's decision, so a member gets
//      403 champion_required and is told who to ask.
//
// Both are pure: no I/O, no Date.now(), no env. Emails are compared
// case-insensitively and returned in the caller's own lower-cased form.

import type { OrgRole, UserStatus } from '../../../../lib/firmStore';

// ─── Shared views ─────────────────────────────────────────────────────────────

/** The slice of the session a champion decision reads. */
export interface ChampionCaller {
  email:   string;
  role:    'admin' | 'user';
  orgRole: OrgRole | null | undefined;
  orgId:   string  | null | undefined;
}

/** The slice of a member record a transfer reads. */
export interface ChampionTarget {
  email:   string;
  orgId:   string | null | undefined;
  status:  UserStatus;
  /** Platform role — staff are off limits to a customer's champion. */
  role:    'admin' | 'user';
  orgRole: OrgRole | null | undefined;
}

function norm(email: string): string {
  return email.trim().toLowerCase();
}

// ─── 1. Champion transfer ─────────────────────────────────────────────────────

export interface ChampionTransferRefusal {
  ok:      false;
  status:  number;
  error:   string;
  message: string;
}

export interface ChampionTransferPlan {
  ok: true;
  /** Promote this address to org_admin (already an admin → a no-op write). */
  promote: string;
  /** Demote these to org_member, AFTER the promotion has landed. */
  demote:  string[];
}

export type ChampionTransferDecision = ChampionTransferPlan | ChampionTransferRefusal;

export interface ChampionTransferInput {
  caller: ChampionCaller;
  /** The organization being acted on (already resolved by the route). */
  orgId:  string;
  /** The member named in the body, or null when there is no such member. */
  target: ChampionTarget | null;
  /** Addresses of the org's current, not-disabled org_admins. */
  currentChampions: string[];
}

/**
 * The set of org_admins this plan leaves behind. Exported so the invariant
 * "an organization never ends a transfer with zero champions" is asserted
 * directly rather than inferred from the decision table.
 */
export function resultingChampions(
  promote: string,
  currentChampions: string[],
  demote: string[],
): string[] {
  const gone = new Set(demote.map(norm));
  const left = currentChampions.map(norm).filter(e => !gone.has(e));
  const promoted = norm(promote);
  return left.includes(promoted) ? left : [...left, promoted];
}

export function decideChampionTransfer(input: ChampionTransferInput): ChampionTransferDecision {
  const { caller, orgId, target } = input;

  const callerIsPlatformAdmin = caller.role === 'admin';
  const callerIsThisOrgAdmin  = caller.orgRole === 'org_admin' && caller.orgId === orgId;

  // Only the sitting champion of THIS org, or ExpertMatch staff, may move it.
  if (!callerIsPlatformAdmin && !callerIsThisOrgAdmin) {
    return {
      ok: false, status: 403, error: 'forbidden',
      message: 'Only the current champion can hand the championship over.',
    };
  }

  if (!target || target.orgId !== orgId) {
    return {
      ok: false, status: 404, error: 'member_not_found',
      message: 'That person is not in this organization.',
    };
  }

  // Rule 1 of this route's header: a customer's champion may not act on
  // ExpertMatch staff holding a seat in their org.
  if (target.role === 'admin' && !callerIsPlatformAdmin) {
    return {
      ok: false, status: 403, error: 'read_only',
      message: 'This account is managed by ExpertMatch and cannot be changed here.',
    };
  }

  // A pending invite has no claims to promote yet, and a disabled seat cannot
  // hold the card — either would leave the firm with a champion who cannot act.
  if (target.status !== 'active') {
    return {
      ok: false, status: 409, error: 'member_not_active',
      message: 'That person must accept their invite and have an active seat first.',
    };
  }

  const promote = norm(target.email);
  const demote  = input.currentChampions.map(norm).filter(e => e !== promote);

  // Defensive: the promotion is always in the resulting set, so this cannot
  // fire today. It is the invariant the whole action exists to protect, so it
  // is checked rather than assumed.
  if (resultingChampions(promote, input.currentChampions, demote).length === 0) {
    return {
      ok: false, status: 409, error: 'last_org_admin',
      message: 'This is the only organization admin — promote someone else first.',
    };
  }

  return { ok: true, promote, demote };
}

// ─── 2. First card: champion only ─────────────────────────────────────────────

export type FirstCardDecision =
  | { ok: true }
  | { ok: false; error: 'champion_required' };

/**
 * May this caller put the firm's FIRST card on file? The card is the firm's
 * commitment, priced per seat for everyone, so it is the champion's to make —
 * the same gate `replace` and `activate` already carry. Members are refused and
 * told who to ask; a firm with a card on file never reaches here, because the
 * `alreadyComplete` short-circuit answers first.
 */
export function mayAddFirstCard(caller: Pick<ChampionCaller, 'role' | 'orgRole'>): FirstCardDecision {
  if (caller.role === 'admin' || caller.orgRole === 'org_admin') return { ok: true };
  return { ok: false, error: 'champion_required' };
}

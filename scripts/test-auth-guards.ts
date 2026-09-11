// scripts/test-auth-guards.ts — the auth hardening from Wave 2 brief W2-D,
// extended in Wave 4 (W4-0) for the admin/users delete-outcome fix.
//
//   npx tsx scripts/test-auth-guards.ts
//
// Five things, all of them pure or driven through injected fakes: no Supabase,
// no Upstash, no HTTP server, no env vars.
//
//   1. lib/loginThrottle   — the two-counter login decision (audit H-14, H-15),
//                            including the in-process fallback that keeps a cap
//                            in place while Upstash is down, and the HMAC key
//                            shapes that keep the IP and the address out of key
//                            names (audit M-1).
//   2. lib/auth            — statusMayUseProduct, the one definition all three
//                            guards now share, so 'pending' is refused
//                            everywhere rather than only by orgAdminGuard
//                            (audit M-2).
//   3. app/api/org/members — the platform-admin target rule (audit M-3),
//                            reimplemented here as the same predicate the route
//                            uses. See the note above that section.
//   4. lib/membershipReconcile — the nightly revocation repair (audit H-16).
//   5. app/api/admin/users — the DELETE outcome decision table (audit M-46):
//                            an owner-with-projects target is refused before
//                            deleteUser is ever called, and no other refusal
//                            is reported as ok:true. See the note above that
//                            section for why it is reimplemented here too.
//
//   6. app/api/org/members/championTransfer — the two Wave 5 champion
//                            decisions: who may hand the championship over and
//                            to whom (PATCH action: 'transfer_champion'), and
//                            who may put the firm's FIRST card on file
//                            (POST /api/onboarding/billing). Both imported for
//                            real — they are pure modules, not route handlers.
//
// Exits non-zero on the first failing assertion set, so it can gate a deploy.

import {
  LOGIN_IP_LIMIT,
  LOGIN_IP_WINDOW_MS,
  LOGIN_FAIL_LIMIT,
  LOGIN_FAIL_WINDOW_MS,
  loginIpKey,
  loginFailKey,
  decideLoginThrottle,
  checkLoginThrottle,
  recordLoginFailure,
  createLoginThrottleBackend,
  InProcessLoginLimiter,
  DegradingLoginThrottleBackend,
} from '../lib/loginThrottle';
import { statusMayUseProduct } from '../lib/auth';
import {
  decideChampionTransfer,
  resultingChampions,
  mayAddFirstCard,
  type ChampionCaller,
  type ChampionTarget,
} from '../app/api/org/members/championTransfer';
import {
  membershipClaimsAreStale,
  sweepMembershipStatus,
  MAX_ROWS,
  type DisabledMembership,
} from '../lib/membershipReconcile';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── 1a. Login throttle: the pure decision ────────────────────────────────────

section('login throttle decision (H-14, H-15)');

const OK_COUNTS = { ipCount: 1, ipTtlMs: LOGIN_IP_WINDOW_MS, accountFailCount: 0 };

eq('first attempt is allowed', decideLoginThrottle(OK_COUNTS).allowed, true);

eq('attempt exactly at the per-IP limit is still allowed',
  decideLoginThrottle({ ...OK_COUNTS, ipCount: LOGIN_IP_LIMIT }).allowed, true);

const overIp = decideLoginThrottle({ ...OK_COUNTS, ipCount: LOGIN_IP_LIMIT + 1, ipTtlMs: 60_000 });
eq('one past the per-IP limit is refused', overIp.allowed, false);
eq('and it is refused as an IP limit', overIp.allowed === false ? overIp.reason : '', 'ip');
eq('with the remaining window as Retry-After material',
  overIp.allowed === false && overIp.reason === 'ip' ? overIp.retryAfterMs : -1, 60_000);

eq('an account one failure below its cap may still try',
  decideLoginThrottle({ ...OK_COUNTS, accountFailCount: LOGIN_FAIL_LIMIT - 1 }).allowed, true);

const overAccount = decideLoginThrottle({ ...OK_COUNTS, accountFailCount: LOGIN_FAIL_LIMIT });
eq('an account whose failure budget is spent is refused', overAccount.allowed, false);
eq('and it is refused as an ACCOUNT limit (the route answers a plain 401)',
  overAccount.allowed === false ? overAccount.reason : '', 'account');
check('the account refusal carries no retry hint — that would confirm the address exists',
  !('retryAfterMs' in overAccount));

// The IP cap is checked FIRST so a flood from one address cannot be used to
// burn a victim's account budget and lock them out of their own account.
const both = decideLoginThrottle({
  ipCount: LOGIN_IP_LIMIT + 1, ipTtlMs: 1000, accountFailCount: LOGIN_FAIL_LIMIT + 5,
});
eq('when both caps are blown, the IP one wins',
  both.allowed === false ? both.reason : '', 'ip');

// ── 1b. Login throttle: key shapes (M-1) ─────────────────────────────────────

section('login throttle key shapes (M-1: no raw IP or address in a key name)');

const IP    = '203.0.113.7';
const EMAIL = 'analyst@examplefirm.com';

check('the per-IP key does not contain the IP',    !loginIpKey(IP).includes(IP));
check('the per-account key does not contain the address',
  !loginFailKey(EMAIL).includes(EMAIL) && !loginFailKey(EMAIL).includes('examplefirm'));
check('the per-IP key keeps its family prefix',    loginIpKey(IP).startsWith('login-rl:'));
check('the per-account key has its own family',    loginFailKey(EMAIL).startsWith('login-fail:'));
eq('the same IP maps to the same key',             loginIpKey(IP), loginIpKey(IP));
check('a different IP maps to a different key',    loginIpKey(IP) !== loginIpKey('198.51.100.9'));
eq('address casing and padding do not create a second bucket',
  loginFailKey('  Analyst@ExampleFirm.com '), loginFailKey(EMAIL));

// ── 1c. Login throttle: the in-process fallback (H-14) ───────────────────────
//
// This is the check that fails on the old code: before this brief, a null or
// throwing Upstash client meant NO cap at all on the credential endpoint.

section('in-process fallback keeps a cap while Upstash is down (H-14)');

async function runFallbackCases(): Promise<void> {
  // A backend with no Redis at all — the "UPSTASH_REDIS_REST_URL unset" case.
  const local   = new InProcessLoginLimiter();
  const noRedis = new DegradingLoginThrottleBackend(null, local);

  let lastDecision = await checkLoginThrottle(noRedis, IP, EMAIL);
  for (let i = 1; i < LOGIN_IP_LIMIT; i++) {
    lastDecision = await checkLoginThrottle(noRedis, IP, EMAIL);
  }
  eq('with no Redis, the first ten attempts are allowed', lastDecision.allowed, true);

  const eleventh = await checkLoginThrottle(noRedis, IP, EMAIL);
  eq('with no Redis, the eleventh attempt is REFUSED (it used to be unlimited)',
    eleventh.allowed, false);
  eq('and refused as an IP limit', eleventh.allowed === false ? eleventh.reason : '', 'ip');
  eq('the backend reports itself degraded', noRedis.degraded, true);

  // A Redis client whose every call throws — an Upstash outage mid-flight.
  const throwing = {
    incrWithWindow: async (): Promise<{ count: number; ttlMs: number }> => {
      throw new Error('upstash down');
    },
    get: async (): Promise<string | null> => { throw new Error('upstash down'); },
  };
  const brokenLocal = new InProcessLoginLimiter();
  const broken      = new DegradingLoginThrottleBackend(throwing, brokenLocal);

  let brokenLast = await checkLoginThrottle(broken, IP, EMAIL);
  for (let i = 1; i <= LOGIN_IP_LIMIT; i++) {
    brokenLast = await checkLoginThrottle(broken, IP, EMAIL);
  }
  eq('a throwing Upstash client also degrades to a cap rather than fail-open',
    brokenLast.allowed, false);
  eq('and it too reports itself degraded', broken.degraded, true);

  // The healthy path must NOT be degraded, and must use Redis's counts.
  const counters = new Map<string, number>();
  const healthy  = {
    incrWithWindow: async (key: string) => {
      const n = (counters.get(key) ?? 0) + 1;
      counters.set(key, n);
      return { count: n, ttlMs: 900_000 };
    },
    get: async (key: string) => {
      const n = counters.get(key);
      return n === undefined ? null : String(n);
    },
  };
  const upstash = new DegradingLoginThrottleBackend(healthy, new InProcessLoginLimiter());
  const first   = await checkLoginThrottle(upstash, IP, EMAIL);
  eq('a healthy Upstash client allows the first attempt', first.allowed, true);
  eq('and is not marked degraded', upstash.degraded, false);
  check('the per-IP counter was incremented in Redis', counters.get(loginIpKey(IP)) === 1);
  check('the per-account counter was NOT incremented by the check',
    counters.get(loginFailKey(EMAIL)) === undefined);

  // Per-account cap: failures only, and it bites across changing IPs.
  for (let i = 0; i < LOGIN_FAIL_LIMIT; i++) {
    await recordLoginFailure(upstash, EMAIL);
  }
  eq('recordLoginFailure incremented the account counter once per failure',
    counters.get(loginFailKey(EMAIL)), LOGIN_FAIL_LIMIT);

  const fromNewIp = await checkLoginThrottle(upstash, '198.51.100.42', EMAIL);
  eq('a spent account budget refuses an attempt from a FRESH IP (H-15)',
    fromNewIp.allowed, false);
  eq('and refuses it as an account limit, which the route answers as a 401',
    fromNewIp.allowed === false ? fromNewIp.reason : '', 'account');

  const otherAccount = await checkLoginThrottle(upstash, '198.51.100.43', 'someone.else@examplefirm.com');
  eq('another account on the same firm is unaffected', otherAccount.allowed, true);

  // A successful login never touches the failure counter, so an ordinary user
  // is not walked towards their own lockout by using the product.
  eq('checkLoginThrottle alone never increments the failure counter',
    counters.get(loginFailKey('someone.else@examplefirm.com')), undefined);

  // The factory returns a usable backend even with a null client.
  const made = createLoginThrottleBackend(null);
  eq('createLoginThrottleBackend(null) still enforces a cap',
    (await checkLoginThrottle(made, '192.0.2.1', 'x@y.com')).allowed, true);
}

// ── 1d. The in-process limiter's own window arithmetic ───────────────────────

section('in-process limiter window arithmetic');

let clock = 1_000_000;
const limiter = new InProcessLoginLimiter(() => clock);

eq('first increment starts at 1',        limiter.increment('k', 60_000).count, 1);
eq('second increment continues',         limiter.increment('k', 60_000).count, 2);
eq('read does not increment',            limiter.read('k'), 2);
eq('ttl shrinks as the window elapses',  limiter.increment('k', 60_000).ttlMs, 60_000);
clock += 59_999;
eq('still inside the window',            limiter.increment('k', 60_000).count, 4);
clock += 1;
eq('past the window, the counter resets', limiter.increment('k', 60_000).count, 1);
eq('an unknown key reads as zero',       limiter.read('never-seen'), 0);
eq('the failure window is an hour',      LOGIN_FAIL_WINDOW_MS, 60 * 60 * 1000);

// ── 2. Guard status decisions (M-2) ──────────────────────────────────────────
//
// statusMayUseProduct is the whole of the change: routeAuthGuard, adminGuard and
// orgAdminGuard all call it, so asserting it here asserts all three agree.

section('guard status decisions (M-2: pending is refused everywhere)');

eq('active may use the product',    statusMayUseProduct('active'),    true);
eq('disabled may not',              statusMayUseProduct('disabled'),  false);
eq('pending may NOT (this is the fix)', statusMayUseProduct('pending'), false);
eq('an absent status is allowed (legacy accounts carry no claim)',
  statusMayUseProduct(undefined), true);
eq('a null status is allowed for the same reason', statusMayUseProduct(null), true);
eq('an unrecognised status is allowed rather than guessed',
  statusMayUseProduct('invited'), true);
eq('the check is exact, not a prefix match', statusMayUseProduct('pending_review'), true);

// ── 3. Platform-admin target rule (M-3) ──────────────────────────────────────
//
// NOTE ON WHAT IS TESTED HERE. The rule lives in app/api/org/members/route.ts as
// `targetIsProtectedStaff`, and a Next 14 route.ts may not export a helper — the
// build rejects it. Rather than move authorization logic out of the route to
// make it importable, the predicate is restated here in one line and asserted
// against every combination. If the route's copy is edited, this must be edited
// with it; the two are three tokens long, which is why the duplication is
// acceptable. Wave 3's HTTP-level scripts/test-route-authz.ts is the check that
// pins the real route.

section('platform-admin target rule (M-3)');

type Role = 'admin' | 'user';
const protectedStaff = (callerRole: Role, targetRole: Role): boolean =>
  targetRole === 'admin' && callerRole !== 'admin';

eq('an org admin may not disable platform staff', protectedStaff('user',  'admin'), true);
eq('a platform admin may act on platform staff',  protectedStaff('admin', 'admin'), false);
eq('an org admin may act on an ordinary member',  protectedStaff('user',  'user'),  false);
eq('a platform admin may act on an ordinary member', protectedStaff('admin', 'user'), false);

// ── 4. Membership reconcile (H-16) ───────────────────────────────────────────

section('membership reconcile staleness rule (H-16)');

eq('claims already disabled are correct',   membershipClaimsAreStale('disabled'), false);
eq('claims still active are stale',         membershipClaimsAreStale('active'),   true);
eq('claims still pending are stale',        membershipClaimsAreStale('pending'),  true);
eq('absent claims are stale (no claim means no guard refuses)',
  membershipClaimsAreStale(null), true);
eq('undefined claims are stale for the same reason',
  membershipClaimsAreStale(undefined), true);

section('membership reconcile sweep (H-16)');

function rows(n: number): DisabledMembership[] {
  return Array.from({ length: n }, (_, i) => ({
    profileId: `p${i}`,
    email:     `member${i}@examplefirm.com`,
  }));
}

async function runSweepCases(): Promise<void> {
  // A healthy night: every disabled row already has disabled claims.
  const healthy = await sweepMembershipStatus({
    listDisabledMemberships: async () => rows(3),
    readAuthStatus:          async () => 'disabled',
    resyncMetadata:          async () => { throw new Error('must not be called'); },
  });
  eq('healthy night scans every row',       healthy.scanned,  3);
  eq('healthy night repairs nothing',       healthy.repaired, 0);
  eq('healthy night records no errors',     healthy.errors,   0);

  // The failure this job exists for: the row says disabled, the JWT does not.
  const resynced: string[] = [];
  const stale = await sweepMembershipStatus({
    listDisabledMemberships: async () => rows(3),
    readAuthStatus:          async (id) => (id === 'p1' ? 'active' : 'disabled'),
    resyncMetadata:          async (email) => { resynced.push(email); return true; },
  });
  eq('a stale row is repaired',             stale.repaired, 1);
  eq('only the stale row is re-synced',     resynced.length, 1);
  eq('and it is the right one',             resynced[0], 'member1@examplefirm.com');
  eq('the healthy rows are still counted as scanned', stale.scanned, 3);
  eq('no errors on a clean repair',         stale.errors, 0);

  // A re-sync that reports false is an error, not a repair — the account is
  // still live and must stay on the attention feed.
  const refused = await sweepMembershipStatus({
    listDisabledMemberships: async () => rows(1),
    readAuthStatus:          async () => 'active',
    resyncMetadata:          async () => false,
  });
  eq('a refused re-sync is not counted as repaired', refused.repaired, 0);
  eq('a refused re-sync is counted as an error',     refused.errors,   1);

  // One unreadable account must not stop the rest of the sweep.
  const partial = await sweepMembershipStatus({
    listDisabledMemberships: async () => rows(3),
    readAuthStatus:          async (id) => {
      if (id === 'p0') throw new Error('auth user unreadable');
      return 'active';
    },
    resyncMetadata:          async () => true,
  });
  eq('an unreadable row is counted as an error',  partial.errors,   1);
  eq('and the remaining rows are still repaired', partial.repaired, 2);

  // A listing that throws returns zeroes and one error, never an exception:
  // this sweep must not be able to fail the reconcile job's other steps.
  const unreadable = await sweepMembershipStatus({
    listDisabledMemberships: async () => { throw new Error('postgres down'); },
  });
  eq('an unreadable listing scans nothing', unreadable.scanned,  0);
  eq('repairs nothing',                     unreadable.repaired, 0);
  eq('and reports exactly one error',       unreadable.errors,   1);

  // The bound is applied and cannot be raised past MAX_ROWS by a caller.
  let askedFor = -1;
  await sweepMembershipStatus({
    listDisabledMemberships: async (limit) => { askedFor = limit; return []; },
    limit: 10_000,
  });
  eq('the row cap is clamped to MAX_ROWS', askedFor, MAX_ROWS);

  let askedForSmall = -1;
  await sweepMembershipStatus({
    listDisabledMemberships: async (limit) => { askedForSmall = limit; return []; },
    limit: 25,
  });
  eq('a smaller cap is honoured', askedForSmall, 25);

  const empty = await sweepMembershipStatus({ listDisabledMemberships: async () => [] });
  eq('no disabled memberships is a clean zero result',
    `${empty.scanned}/${empty.repaired}/${empty.errors}`, '0/0/0');
}

// ── 5. Admin-users DELETE outcome (M-46) ─────────────────────────────────────
//
// NOTE ON WHAT IS TESTED HERE. The decision table lives in
// app/api/admin/users/route.ts as `classifyDeleteOutcome`, and it is not
// exported: a Next.js app-router route.ts may only export the HTTP method
// handlers plus a small config allowlist — the framework's generated route
// typecheck rejects any other named export (confirmed while writing this
// fix; `npx tsc --noEmit` fails on an exported helper with "is not
// assignable to type 'never'"). Rather than move the rule out of the route
// into an importable module, it is restated here verbatim and asserted
// against every combination. If the route's copy is edited, this must be
// edited with it.
//
// The rule: an owner-with-projects target is refused with 409 before
// deleteUser is ever called (so the FK RESTRICT never fires and the account
// is never touched); any OTHER delete refusal is 500, never a silent
// ok:true (the exact gap M-46 describes — deleteUser/deleteSupabaseUser
// report a refusal as `deleted: false` rather than throwing, and the old
// route discarded that signal outright).

section('DELETE /api/admin/users outcome decision table (M-46)');

type DeleteUserOutcome =
  | { status: 200; body: { ok: true } }
  | { status: 409; body: { error: 'owns_projects'; count: number; projectNames: string[] } }
  | { status: 500; body: { error: 'delete_failed' } };

function classifyDeleteOutcome(input: {
  ownedProjectNames: string[];
  deleted: boolean;
}): DeleteUserOutcome {
  if (input.ownedProjectNames.length > 0) {
    return {
      status: 409,
      body: {
        error:        'owns_projects',
        count:        input.ownedProjectNames.length,
        projectNames: input.ownedProjectNames,
      },
    };
  }
  if (!input.deleted) {
    return { status: 500, body: { error: 'delete_failed' } };
  }
  return { status: 200, body: { ok: true } };
}

const noProjectsDeleted   = classifyDeleteOutcome({ ownedProjectNames: [], deleted: true });
eq('no owned projects and a successful delete is 200', noProjectsDeleted.status, 200);

const ownsOneProject = classifyDeleteOutcome({
  ownedProjectNames: ['Q3 Buyer Diligence'],
  deleted: false,
});
eq('an owner of one project is refused, not deleted', ownsOneProject.status, 409);
check('the 409 names the error as owns_projects',
  ownsOneProject.status === 409 && ownsOneProject.body.error === 'owns_projects');
check('the 409 carries the count',
  ownsOneProject.status === 409 && ownsOneProject.body.count === 1);
check('the 409 names the blocking project',
  ownsOneProject.status === 409 &&
  ownsOneProject.body.projectNames[0] === 'Q3 Buyer Diligence');

const ownsThreeProjects = classifyDeleteOutcome({
  ownedProjectNames: ['Alpha', 'Beta', 'Gamma'],
  deleted: false,
});
check('the count matches the number of owned projects',
  ownsThreeProjects.status === 409 && ownsThreeProjects.body.count === 3);

const refusedForOtherReason = classifyDeleteOutcome({ ownedProjectNames: [], deleted: false });
eq('a refusal that is NOT project ownership is 500, never ok:true',
  refusedForOtherReason.status, 500);
check('the 500 names the error as delete_failed',
  refusedForOtherReason.status === 500 && refusedForOtherReason.body.error === 'delete_failed');

// Owned projects are checked first: even a `deleted: true` alongside owned
// projects (should never happen — the route never calls deleteUser in that
// case — but the table itself must not be able to answer ok:true here) is
// still refused as owns_projects.
const ownsProjectsEvenIfDeletedTrue = classifyDeleteOutcome({
  ownedProjectNames: ['Orphan Risk Project'],
  deleted: true,
});
eq('owned-projects refusal takes priority over any deleted flag',
  ownsProjectsEvenIfDeletedTrue.status, 409);

// ── 6. Champion transfer and the first card (Wave 5, brief B3) ───────────────
// These two are imported for real: championTransfer.ts exists precisely so the
// decisions are not trapped inside a route module.
//
// FAILS ON OLD CODE: app/api/org/members/championTransfer.ts does not exist
// before Wave 5, so every check in this section fails at import time.

section('decideChampionTransfer');

const ORG = 'org_alpha';

const champion: ChampionCaller = {
  email: 'champion@firm.test', role: 'user', orgRole: 'org_admin', orgId: ORG,
};
const plainMember: ChampionCaller = {
  email: 'member@firm.test', role: 'user', orgRole: 'org_member', orgId: ORG,
};
const platformAdmin: ChampionCaller = {
  email: 'staff@expertmatch.fit', role: 'admin', orgRole: null, orgId: null,
};

const activeTarget: ChampionTarget = {
  email: 'Deputy@Firm.test', orgId: ORG, status: 'active', role: 'user', orgRole: 'org_member',
};

const happy = decideChampionTransfer({
  caller: champion, orgId: ORG, target: activeTarget,
  currentChampions: ['champion@firm.test'],
});
check('the sitting champion may hand it over', happy.ok === true);
eq('the target is promoted, lower-cased', happy.ok ? happy.promote : '', 'deputy@firm.test');
eq('the outgoing champion is demoted', happy.ok ? happy.demote.join(',') : '', 'champion@firm.test');

const byStaff = decideChampionTransfer({
  caller: platformAdmin, orgId: ORG, target: activeTarget,
  currentChampions: ['champion@firm.test'],
});
check('a platform admin outside the org may do it too', byStaff.ok === true);
eq('and the org\'s sitting champion is still the one demoted',
  byStaff.ok ? byStaff.demote.join(',') : '', 'champion@firm.test');

const byMember = decideChampionTransfer({
  caller: plainMember, orgId: ORG, target: activeTarget,
  currentChampions: ['champion@firm.test'],
});
check('a plain member may not', byMember.ok === false);
eq('  refused 403 forbidden', byMember.ok === false ? byMember.status : 0, 403);

const otherOrgAdmin = decideChampionTransfer({
  caller: { ...champion, orgId: 'org_beta' }, orgId: ORG, target: activeTarget,
  currentChampions: ['champion@firm.test'],
});
check('another firm\'s champion may not reach into this org', otherOrgAdmin.ok === false);

const noSuchMember = decideChampionTransfer({
  caller: champion, orgId: ORG, target: null, currentChampions: ['champion@firm.test'],
});
check('an unknown address is refused', noSuchMember.ok === false);
eq('  refused 404 member_not_found',
  noSuchMember.ok === false ? noSuchMember.error : '', 'member_not_found');

const foreignMember = decideChampionTransfer({
  caller: champion, orgId: ORG,
  target: { ...activeTarget, orgId: 'org_beta' },
  currentChampions: ['champion@firm.test'],
});
check('a member of another org is refused as not found', foreignMember.ok === false);
eq('  and it is 404, not 403 (no cross-org existence leak)',
  foreignMember.ok === false ? foreignMember.status : 0, 404);

const staffTarget = decideChampionTransfer({
  caller: champion, orgId: ORG,
  target: { ...activeTarget, role: 'admin' },
  currentChampions: ['champion@firm.test'],
});
check('a customer champion may not promote ExpertMatch staff', staffTarget.ok === false);
eq('  refused read_only', staffTarget.ok === false ? staffTarget.error : '', 'read_only');

const staffTargetByStaff = decideChampionTransfer({
  caller: platformAdmin, orgId: ORG,
  target: { ...activeTarget, role: 'admin' },
  currentChampions: ['champion@firm.test'],
});
check('but ExpertMatch staff may', staffTargetByStaff.ok === true);

for (const status of ['pending', 'disabled'] as const) {
  const notActive = decideChampionTransfer({
    caller: champion, orgId: ORG,
    target: { ...activeTarget, status },
    currentChampions: ['champion@firm.test'],
  });
  check(`a ${status} seat cannot become champion`, notActive.ok === false);
  eq(`  refused member_not_active (${status})`,
    notActive.ok === false ? notActive.error : '', 'member_not_active');
}

// Promoting the sitting champion to champion: legal, and it must NOT demote
// them — that is the one path that could leave a firm with zero champions.
const selfTransfer = decideChampionTransfer({
  caller: champion, orgId: ORG,
  target: { ...activeTarget, email: 'champion@firm.test', orgRole: 'org_admin' },
  currentChampions: ['champion@firm.test'],
});
check('promoting the current champion is a no-op, not a demotion', selfTransfer.ok === true);
eq('  nobody is demoted', selfTransfer.ok ? selfTransfer.demote.length : -1, 0);

// Two champions (a legacy state) collapse to one in a single transfer.
const twoSitting = decideChampionTransfer({
  caller: champion, orgId: ORG, target: activeTarget,
  currentChampions: ['champion@firm.test', 'cochampion@firm.test'],
});
eq('every other sitting champion is demoted',
  twoSitting.ok ? twoSitting.demote.sort().join(',') : '',
  'champion@firm.test,cochampion@firm.test');

section('resultingChampions');

check('a firm is never left with zero champions',
  resultingChampions('deputy@firm.test', ['champion@firm.test'], ['champion@firm.test']).length === 1);
eq('and the survivor is the promoted address',
  resultingChampions('deputy@firm.test', ['champion@firm.test'], ['champion@firm.test'])[0],
  'deputy@firm.test');
eq('a promoted sitting champion is not double-counted',
  resultingChampions('champion@firm.test', ['champion@firm.test'], []).length, 1);
eq('a champion who is not demoted stays',
  resultingChampions('deputy@firm.test', ['a@firm.test', 'b@firm.test'], ['a@firm.test']).length, 2);

section('mayAddFirstCard');

check('the champion may put the firm\'s first card on file',
  mayAddFirstCard({ role: 'user', orgRole: 'org_admin' }).ok === true);
check('a platform admin may too',
  mayAddFirstCard({ role: 'admin', orgRole: null }).ok === true);

const memberCard = mayAddFirstCard({ role: 'user', orgRole: 'org_member' });
check('a plain member may not', memberCard.ok === false);
eq('  and the refusal is champion_required',
  memberCard.ok === false ? memberCard.error : '', 'champion_required');

check('an account with no org role at all may not (fails closed)',
  mayAddFirstCard({ role: 'user', orgRole: null }).ok === false);
check('an undefined org role may not either',
  mayAddFirstCard({ role: 'user', orgRole: undefined }).ok === false);

// ── Run the async sections, then report ──────────────────────────────────────

async function main(): Promise<void> {
  await runFallbackCases();
  await runSweepCases();
  summary();
}

void main();

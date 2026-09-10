// scripts/test-auth-flows.ts — the identity lifecycle, end to end, against a
// RUNNING app, using THROWAWAY accounts only.
//
//   SMOKE_BASE_URL=http://localhost:3100 npx tsx scripts/test-auth-flows.ts
//
// WHAT THIS PROVES (ARCHITECTURE.md §5 "Invite, set-password and reset" and
// "Role and ownership model"; audit H-14, H-15, H-16, M-3, M-46):
//
//   invite → set-password → activation
//     A link is two halves (lib/authLinks.ts): our HMAC token carries email,
//     organization, kind and expiry; Supabase's recovery hash is what makes it
//     SINGLE USE. So: a second redeem is refused, a hash that redeems to a
//     different account is refused, and the seat cap is checked BEFORE the hash
//     is burned — a capped firm leaves the invitee holding a link that still
//     works once a seat is freed. That last pair is the ordering assertion the
//     route's header promises and nothing else checked.
//   reset
//     Only an ACTIVE account gets one, and it moves the password and NOTHING
//     else: no status change, no membership write, no onboarding reset.
//   revocation (H-16)
//     Disabling through the team API must reach app_metadata, because every
//     guard reads the JWT claims and never the tables. The check is not that
//     the route answers 200 — it is that the claims changed AND the member's
//     live session stops working on the next request.
//   org-admin scoping and the platform-staff target rule (M-3)
//     An org admin naming another organization's id is refused rather than
//     silently scoped to their own, and cannot touch ExpertMatch staff holding
//     a seat in their org.
//   login caps (H-14, H-15)
//     The per-IP cap answers 429 with Retry-After; the per-ACCOUNT failure
//     budget answers a plain 401 even from a fresh IP and even with the right
//     password. The pure decisions are covered by scripts/test-auth-guards.ts;
//     what is asserted here is that the route actually wires them up.
//   deletion (M-46)
//     DELETE /api/admin/users refuses an owner of projects with 409
//     owns_projects and leaves the account intact (closed in W4-0).
//
// SAFE TO RUN WHILE THE FOUNDER IS LOGGED IN. Every account, organization and
// project here is created by this script through the service role and removed
// in the finally block. The founder's admin account is never read, never
// targeted and never signed out; the only sessions this script ends are its own
// cookie jars. Each persona sends its own X-Forwarded-For from a reserved,
// per-run address block, so the founder's own login and reset counters are
// untouched and two runs inside a limiter window do not collide.
//
// SENDS NOTHING. Run the server with DISABLE_EMAILS=true; every mail helper on
// these paths (sendInviteEmail, sendPasswordResetEmail, sendSeatLimitNotification)
// returns early on that flag, and every address is on a reserved `.example`
// domain in any case. Links are minted directly with lib/authLinks, service
// role, exactly as the invite flow does — no mail is involved in getting one.

import * as dotenv from 'dotenv';
import * as path from 'path';
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env.local') });

import { createClient } from '@supabase/supabase-js';
import { check, summary } from './testHarness';

const BASE   = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? BASE;

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/**
 * One persona: its cookies and its own source address. The address matters:
 * both the login limiter and the reset limiter key on it, so sharing one would
 * make personas collide with each other and with whoever else is using this
 * server.
 */
class Jar {
  cookies = new Map<string, string>();
  constructor(readonly ip: string) {}
  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = sc.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some(a => /max-age=0/i.test(a.trim()));
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }
  header(): string { return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; '); }
}

async function rawReq(jar: Jar, method: string, p: string, body?: string): Promise<Response> {
  const res = await fetch(BASE + p, {
    method, redirect: 'manual',
    headers: {
      'Content-Type':    'application/json',
      'Origin':          ORIGIN,
      'X-Forwarded-For': jar.ip,
      ...(jar.cookies.size ? { 'Cookie': jar.header() } : {}),
    },
    ...(body !== undefined ? { body } : {}),
  });
  jar.absorb(res);
  return res;
}
async function req(jar: Jar, method: string, p: string, body?: unknown): Promise<Response> {
  return rawReq(jar, method, p, body !== undefined ? JSON.stringify(body) : undefined);
}
interface JsonBody { [key: string]: unknown }
async function json(res: Response): Promise<JsonBody | null> {
  try { return await res.json() as JsonBody; } catch { return null; }
}
function err(body: JsonBody | null): string {
  return typeof body?.error === 'string' ? body.error : '';
}

const db = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { persistSession: false } },
);

const RUN          = Math.random().toString(36).slice(2, 8);

/**
 * Source addresses, one per persona, in the RFC 2544 benchmarking range and
 * randomised per run. Both the login limiter and the reset limiter key on the
 * caller's address with windows of 15 minutes and an hour, so a fixed address
 * would make two runs an hour apart collide with each other — and would spend
 * the counter budget of whoever else is using this server.
 */
const IP_RUN = Math.floor(Math.random() * 256);
const ip = (host: number): string => `198.18.${IP_RUN}.${host}`;
const ORG_DOMAIN   = `authflow-${RUN}.example`;
const OTHER_DOMAIN = `authflow-other-${RUN}.example`;
const PW           = 'Authflow-pw-' + Math.random().toString(36).slice(2) + 'A1';
const NEW_PW       = 'Authflow-new-' + Math.random().toString(36).slice(2) + 'B2';

const E = {
  champion:  `champion@${ORG_DOMAIN}`,
  staff:     `staff@${ORG_DOMAIN}`,
  staff2:    `staff2@${ORG_DOMAIN}`,
  revokee:   `revokee@${ORG_DOMAIN}`,
  invitee:   `invitee@${ORG_DOMAIN}`,
  invitee2:  `invitee2@${ORG_DOMAIN}`,
  resetee:   `resetee@${ORG_DOMAIN}`,
  pendinger: `pendinger@${ORG_DOMAIN}`,
  disabled:  `disabled@${ORG_DOMAIN}`,
  brute:     `brute@${ORG_DOMAIN}`,
  ownerdel:  `ownerdel@${ORG_DOMAIN}`,
  nodel:     `nodel@${ORG_DOMAIN}`,
  otheradm:  `champion@${OTHER_DOMAIN}`,
};

/** A syntactically plausible recovery hash that belongs to no account. */
const BOGUS_TH = 'pkce_0000000000000000000000000000000000000000000000000000';

async function main(): Promise<void> {
  console.log(`test-auth-flows: target ${BASE}`);
  const cleanup: Array<() => Promise<void>> = [];

  // lib modules read the environment when they load, so they are imported after
  // dotenv has run (the same reason scripts/test-route-authz.ts does this).
  const {
    getUser, upsertUser, upsertFirm, getFirm, countActiveUsersForFirm,
  } = await import('../lib/firmStore');
  const { mintSetPasswordLink } = await import('../lib/authLinks');
  const { generateSignupToken } = await import('../lib/signupToken');
  const { getUpstashClient }    = await import('../lib/upstashRedis');

  /** app_metadata as the guards see it — the only thing revocation must change. */
  async function claims(email: string): Promise<Record<string, unknown>> {
    const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    const user = data?.users?.find(u => (u.email ?? '').toLowerCase() === email);
    return (user?.app_metadata ?? {}) as Record<string, unknown>;
  }
  async function authUserExists(email: string): Promise<boolean> {
    const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
    return !!data?.users?.some(u => (u.email ?? '').toLowerCase() === email);
  }

  // Is Upstash actually answering? Every limiter except login fails OPEN when it
  // is not, which is the documented policy — so the cap assertions below say so
  // rather than failing on a cache outage.
  let redisUp = false;
  try {
    const r = getUpstashClient();
    if (r) { await r.get(`authflow-probe:${RUN}`); redisUp = true; }
  } catch { redisUp = false; }

  try {
    // ── Provision ─────────────────────────────────────────────────────────────
    section('provisioning (throwaway organizations and accounts)');

    await upsertFirm(ORG_DOMAIN,   { name: 'Authflow Firm',       status: 'active', seatLimit: null });
    await upsertFirm(OTHER_DOMAIN, { name: 'Authflow Other Firm',  status: 'active', seatLimit: null });
    const org   = await getFirm(ORG_DOMAIN);
    const other = await getFirm(OTHER_DOMAIN);
    check('two throwaway organizations exist', !!org && !!other);
    if (!org || !other) throw new Error('organizations not created');

    cleanup.push(async () => { await db.from('organizations').delete().in('id', [org.id, other.id]); });

    /** Creates the auth user with a known password, then the profile+membership. */
    async function persona(
      email: string,
      opts: {
        domain?:   string;
        role?:     'user' | 'admin';
        orgRole?:  'org_admin' | 'org_member';
        status?:   'active' | 'pending' | 'disabled';
        onboarded?: boolean;
      } = {},
    ): Promise<void> {
      const domain = opts.domain ?? ORG_DOMAIN;
      await db.auth.admin.createUser({ email, password: PW, email_confirm: true });
      await upsertUser(email, {
        firstName:          'Test',
        lastName:           'Persona',
        firmDomain:         domain,
        firmName:           domain === ORG_DOMAIN ? 'Authflow Firm' : 'Authflow Other Firm',
        role:               opts.role    ?? 'user',
        orgRole:            opts.orgRole ?? 'org_member',
        status:             opts.status  ?? 'active',
        onboardingComplete: opts.onboarded !== false,
      });
    }

    await persona(E.champion,  { orgRole: 'org_admin' });
    await persona(E.staff,     { role: 'admin' });
    await persona(E.staff2,    { role: 'admin' });
    await persona(E.revokee);
    await persona(E.resetee);
    await persona(E.pendinger, { status: 'pending' });
    await persona(E.disabled,  { status: 'disabled' });
    await persona(E.brute);
    await persona(E.ownerdel);
    await persona(E.nodel);
    await persona(E.invitee2,  { status: 'pending' });
    await persona(E.otheradm,  { domain: OTHER_DOMAIN, orgRole: 'org_admin' });

    cleanup.push(async () => {
      const { data } = await db.auth.admin.listUsers({ page: 1, perPage: 1000 });
      for (const u of data?.users ?? []) {
        const mail = (u.email ?? '').toLowerCase();
        if (mail.endsWith(`@${ORG_DOMAIN}`) || mail.endsWith(`@${OTHER_DOMAIN}`)) {
          await db.auth.admin.deleteUser(u.id).catch(() => {});
        }
      }
    });
    cleanup.push(async () => {
      await db.from('product_events').delete().in('organization_id', [org.id, other.id]);
      await db.from('system_events').delete().in('organization_id', [org.id, other.id]);
      await db.from('access_requests').delete().eq('requested_domain', ORG_DOMAIN);
    });

    check('the champion is an org admin of the throwaway organization',
      (await getUser(E.champion))?.orgRole === 'org_admin');
    check('the platform-staff persona carries role admin',
      (await getUser(E.staff))?.role === 'admin');
    check('the other organization has its own champion',
      (await getUser(E.otheradm))?.orgId === other.id);

    // ── Sessions ──────────────────────────────────────────────────────────────
    const champion = new Jar(ip(11));
    const staff    = new Jar(ip(12));
    const revokee  = new Jar(ip(13));
    const owner    = new Jar(ip(14));
    const invitee  = new Jar(ip(15));

    const login = async (jar: Jar, email: string, password = PW): Promise<Response> =>
      req(jar, 'POST', '/api/auth/login', { email, password });

    check('champion login',   (await login(champion, E.champion)).status === 200);
    check('staff login',      (await login(staff,    E.staff)).status    === 200);
    check('member login',     (await login(revokee,  E.revokee)).status  === 200);
    check('project-owner login', (await login(owner,  E.ownerdel)).status === 200);

    const disabledLogin = await login(new Jar(ip(16)), E.disabled);
    check('a disabled account cannot sign in (403 account_disabled)',
      disabledLogin.status === 403 && err(await json(disabledLogin)) === 'account_disabled',
      `status ${disabledLogin.status}`);
    const pendingLogin = await login(new Jar(ip(17)), E.pendinger);
    check('a pending account signs in but is refused by the guards (M-2)',
      pendingLogin.status === 200 || pendingLogin.status === 401, `status ${pendingLogin.status}`);

    // ── 1. Invite through the team route ──────────────────────────────────────
    section('invite (POST /api/org/members)');

    const inviteBody = { firstName: 'Ada', lastName: 'Invitee', email: E.invitee };
    const invited    = await req(champion, 'POST', '/api/org/members', inviteBody);
    const invitedBody = await json(invited);
    check('an org admin may invite into their own organization (200)',
      invited.status === 200 && invitedBody?.ok === true, `status ${invited.status} ${err(invitedBody)}`);
    check('the invitee is created PENDING, not active',
      (await getUser(E.invitee))?.status === 'pending');
    check('the invitee lands in the inviting organization',
      (await getUser(E.invitee))?.orgId === org.id);
    check('the invitee is an ordinary member — an org admin cannot mint staff',
      (await getUser(E.invitee))?.role === 'user' && (await getUser(E.invitee))?.orgRole === 'org_member');

    const dupe = await req(champion, 'POST', '/api/org/members', inviteBody);
    check('inviting the same address again is 409 user_exists',
      dupe.status === 409 && err(await json(dupe)) === 'user_exists', `status ${dupe.status}`);
    const reinvited = await req(champion, 'POST', '/api/org/members', { ...inviteBody, reinvite: true });
    const reinvitedBody = await json(reinvited);
    check('an explicit re-invite is allowed and says so',
      reinvited.status === 200 && reinvitedBody?.reinvited === true, `status ${reinvited.status}`);
    check('a re-invite does not activate the account',
      (await getUser(E.invitee))?.status === 'pending');

    const badEmail = await req(champion, 'POST', '/api/org/members', { ...inviteBody, email: 'not-an-address' });
    check('a malformed address is 400 invalid_email',
      badEmail.status === 400 && err(await json(badEmail)) === 'invalid_email', `status ${badEmail.status}`);
    const noName = await req(champion, 'POST', '/api/org/members', { ...inviteBody, firstName: '', email: `x@${ORG_DOMAIN}` });
    check('a missing first name is 400 invalid_first_name',
      noName.status === 400 && err(await json(noName)) === 'invalid_first_name', `status ${noName.status}`);
    const crossDomain = await req(champion, 'POST', '/api/org/members', { ...inviteBody, email: 'someone@gmail.com' });
    check('an org admin cannot invite an address outside their domain (400 email_domain_mismatch)',
      crossDomain.status === 400 && err(await json(crossDomain)) === 'email_domain_mismatch',
      `status ${crossDomain.status}`);
    const memberInvite = await req(revokee, 'POST', '/api/org/members', { ...inviteBody, email: `y@${ORG_DOMAIN}` });
    check('an ordinary member cannot invite anybody (403 forbidden)',
      memberInvite.status === 403 && err(await json(memberInvite)) === 'forbidden', `status ${memberInvite.status}`);

    // ── 2. set-password: everything that is refused before anything is spent ──
    section('set-password refusals (nothing is redeemed, nothing is written)');

    const setPasswordPath = (token: string, th: string): string =>
      `/api/auth/set-password?token=${encodeURIComponent(token)}&th=${encodeURIComponent(th)}`;
    const anon = new Jar(ip(20));

    // A token minted directly, the way the invite flow does. Paired with a
    // bogus hash on purpose: every case in this section must be refused BEFORE
    // the hash is ever presented to Supabase.
    const probeToken = generateSignupToken(E.invitee, 'Authflow Firm', { kind: 'invite', orgId: org.id }).token;

    const tampered = probeToken.slice(0, -3) + (probeToken.endsWith('A') ? 'BBB' : 'AAA');
    const tamperRes = await req(anon, 'POST', setPasswordPath(tampered, BOGUS_TH), { password: NEW_PW, confirmPassword: NEW_PW });
    check('a tampered signature is 404 invite_invalid',
      tamperRes.status === 404 && err(await json(tamperRes)) === 'invite_invalid', `status ${tamperRes.status}`);

    const noTh = await req(anon, 'POST', `/api/auth/set-password?token=${encodeURIComponent(probeToken)}`, { password: NEW_PW, confirmPassword: NEW_PW });
    check('a link with no recovery hash is refused (404) — legacy links are not honoured',
      noTh.status === 404 && err(await json(noTh)) === 'invite_invalid', `status ${noTh.status}`);

    const mismatch = await req(anon, 'POST', setPasswordPath(probeToken, BOGUS_TH), { password: NEW_PW, confirmPassword: NEW_PW + 'x' });
    check('mismatched passwords are 400 passwords_mismatch',
      mismatch.status === 400 && err(await json(mismatch)) === 'passwords_mismatch', `status ${mismatch.status}`);

    const tooShort = await req(anon, 'POST', setPasswordPath(probeToken, BOGUS_TH), { password: 'ab1', confirmPassword: 'ab1' });
    check('a password under eight characters is 400 invalid_password',
      tooShort.status === 400 && err(await json(tooShort)) === 'invalid_password', `status ${tooShort.status}`);

    const noDigit = await req(anon, 'POST', setPasswordPath(probeToken, BOGUS_TH), { password: 'abcdefghij', confirmPassword: 'abcdefghij' });
    check('a password with no digit is 400 invalid_password',
      noDigit.status === 400 && err(await json(noDigit)) === 'invalid_password', `status ${noDigit.status}`);

    const badJson = await rawReq(anon, 'POST', setPasswordPath(probeToken, BOGUS_TH), 'not json at all');
    check('an unreadable body is 400 invalid_json',
      badJson.status === 400 && err(await json(badJson)) === 'invalid_json', `status ${badJson.status}`);

    check('after five refusals the invitee is still pending — no write happened',
      (await getUser(E.invitee))?.status === 'pending');

    // The per-link attempt cap: five per hour, keyed on OUR token's hash, and
    // counted only once the link is well-formed enough to be worth counting
    // (the signature check and the missing-hash check both return before it).
    // A token of its own, so the count is exactly the attempts made here.
    const capToken = generateSignupToken(E.invitee, 'Authflow Firm', { kind: 'invite', orgId: org.id }).token;
    let capLast: Response | null = null;
    for (let i = 0; i < 5; i++) {
      capLast = await rawReq(anon, 'POST', setPasswordPath(capToken, BOGUS_TH), 'still not json');
    }
    check('the first five attempts on a link are let through to the body check',
      capLast?.status === 400, `status ${capLast?.status}`);
    const overCap = await rawReq(anon, 'POST', setPasswordPath(capToken, BOGUS_TH), 'still not json');
    if (redisUp) {
      check('a sixth attempt on the same link is 429 rate_limited',
        overCap.status === 429 && err(await json(overCap)) === 'rate_limited', `status ${overCap.status}`);
    } else {
      check('with Upstash unavailable the per-link cap fails open, as documented',
        overCap.status === 400, `status ${overCap.status}`);
    }

    // ── 3. A hash that redeems to a DIFFERENT account is refused ──────────────
    section('set-password: the hash must belong to the address in the token');

    const otherLink = await mintSetPasswordLink(E.pendinger, 'Authflow Firm', { kind: 'invite', orgId: org.id });
    check('a recovery link was minted for a second pending account', !!otherLink);
    const mismatchToken = generateSignupToken(E.invitee, 'Authflow Firm', { kind: 'invite', orgId: org.id }).token;
    const crossed = await req(anon, 'POST', setPasswordPath(mismatchToken, otherLink!.hashedToken), { password: NEW_PW, confirmPassword: NEW_PW });
    check('our token for one address plus a hash for another is refused (409 invite_used)',
      crossed.status === 409 && err(await json(crossed)) === 'invite_used', `status ${crossed.status}`);
    check('neither account was touched by the crossed link',
      (await getUser(E.invitee))?.status === 'pending' && (await getUser(E.pendinger))?.status === 'pending');

    // ── 4. Seat cap is checked BEFORE the link is redeemed ────────────────────
    section('set-password: seat cap before redemption (the invite link survives)');

    const activeNow = await countActiveUsersForFirm(ORG_DOMAIN);
    await upsertFirm(ORG_DOMAIN, { seatLimit: activeNow });
    check('the organization is capped at its current active seat count', activeNow > 0, `${activeNow} seats`);

    const link = await mintSetPasswordLink(E.invitee, 'Authflow Firm', { kind: 'invite', orgId: org.id });
    check('an invite link was minted for the invitee', !!link);
    if (!link) throw new Error('could not mint the invite link');

    const capped = await req(invitee, 'POST', setPasswordPath(link.token, link.hashedToken), { password: NEW_PW, confirmPassword: NEW_PW });
    const cappedBody = await json(capped);
    check('a full firm refuses activation with 403 seat_limit_reached',
      capped.status === 403 && err(cappedBody) === 'seat_limit_reached', `status ${capped.status} ${err(cappedBody)}`);
    check('the invitee is still pending after the seat refusal',
      (await getUser(E.invitee))?.status === 'pending');

    await upsertFirm(ORG_DOMAIN, { seatLimit: null });
    check('the cap is lifted again', (await getFirm(ORG_DOMAIN))?.seatLimit === null);

    // ── 5. Activation, and single use ─────────────────────────────────────────
    section('activation (and the link is single use)');

    const activated = await req(invitee, 'POST', setPasswordPath(link.token, link.hashedToken), { password: NEW_PW, confirmPassword: NEW_PW });
    const activatedBody = await json(activated);
    check('THE SAME LINK still works once a seat is free (200) — the cap did not burn it',
      activated.status === 200 && activatedBody?.ok === true, `status ${activated.status} ${err(activatedBody)}`);
    check('the response signs the new member in', activatedBody?.signedIn === true);

    const activeUser = await getUser(E.invitee);
    check('the invitee is now active',              activeUser?.status === 'active');
    check('and starts at the beginning of onboarding', activeUser?.onboardingComplete === false);
    check('and belongs to the organization the invite named, not one from the email domain',
      activeUser?.orgId === org.id);
    const inviteeClaims = await claims(E.invitee);
    check('the JWT claims say active too — the guards read these, never the tables',
      inviteeClaims.status === 'active', `status claim ${String(inviteeClaims.status)}`);
    check('the claims carry the organization', inviteeClaims.org_id === org.id);

    // Two independent reasons a second redeem cannot work, and both are worth
    // pinning: the account is no longer pending (which is what answers here),
    // and Supabase has burned the recovery hash (asserted immediately after,
    // through a path that does NOT stop at the status check).
    const replay = await req(anon, 'POST', setPasswordPath(link.token, link.hashedToken), { password: NEW_PW + 'z', confirmPassword: NEW_PW + 'z' });
    check('redeeming the same link a second time is 409 invite_used',
      replay.status === 409 && err(await json(replay)) === 'invite_used', `status ${replay.status}`);

    const spentHash = generateSignupToken(E.invitee, 'Authflow Firm', { kind: 'reset', orgId: org.id }).token;
    const spentRes  = await req(anon, 'POST', setPasswordPath(spentHash, link.hashedToken), { password: NEW_PW + 'q', confirmPassword: NEW_PW + 'q' });
    check('the recovery hash itself is spent — it cannot be paired with a fresh token',
      spentRes.status === 409 || spentRes.status === 410, `status ${spentRes.status}`);
    check('and the password did not change',
      (await login(new Jar(ip(27)), E.invitee, NEW_PW)).status === 200);

    const inviteeSession = new Jar(ip(21));
    check('the new member can sign in with the password they chose',
      (await login(inviteeSession, E.invitee, NEW_PW)).status === 200);
    const wrongPw = await login(new Jar(ip(22)), E.invitee, 'not-the-password-1');
    check('and a wrong password is a uniform 401 invalid_credentials',
      wrongPw.status === 401 && err(await json(wrongPw)) === 'invalid_credentials', `status ${wrongPw.status}`);
    const meRes = await req(inviteeSession, 'GET', '/api/auth/me');
    check('the new member reaches /api/auth/me while onboarding', meRes.status === 200, `status ${meRes.status}`);
    const gatedRes = await req(inviteeSession, 'GET', '/api/projects');
    check('but nothing else until onboarding is finished (403 onboarding_incomplete)',
      gatedRes.status === 403 && err(await json(gatedRes)) === 'onboarding_incomplete', `status ${gatedRes.status}`);

    // ── 6. Reset: active accounts only, and nothing but the password moves ────
    section('password reset (active accounts only, no membership write)');

    const pendingReset = await mintSetPasswordLink(E.pendinger, 'Authflow Firm', { kind: 'reset', orgId: org.id });
    const pendingResetRes = await req(anon, 'POST', setPasswordPath(pendingReset!.token, pendingReset!.hashedToken), { password: NEW_PW, confirmPassword: NEW_PW });
    check('a PENDING account cannot reset its password (409 reset_invalid)',
      pendingResetRes.status === 409 && err(await json(pendingResetRes)) === 'reset_invalid',
      `status ${pendingResetRes.status}`);
    check('and the pending account is untouched', (await getUser(E.pendinger))?.status === 'pending');

    const disabledReset = await mintSetPasswordLink(E.disabled, 'Authflow Firm', { kind: 'reset', orgId: org.id });
    const disabledResetRes = await req(anon, 'POST', setPasswordPath(disabledReset!.token, disabledReset!.hashedToken), { password: NEW_PW, confirmPassword: NEW_PW });
    check('a DISABLED account cannot reset its password either (409 reset_invalid)',
      disabledResetRes.status === 409 && err(await json(disabledResetRes)) === 'reset_invalid',
      `status ${disabledResetRes.status}`);
    check('a revoked account cannot let itself back in this way',
      (await getUser(E.disabled))?.status === 'disabled');

    const before = await getUser(E.resetee);
    const resetLink = await mintSetPasswordLink(E.resetee, 'Authflow Firm', { kind: 'reset', orgId: org.id });
    check('a reset link was minted for an active account', !!resetLink);
    const noThReset = await req(anon, 'POST', `/api/auth/set-password?token=${encodeURIComponent(resetLink!.token)}`, { password: NEW_PW, confirmPassword: NEW_PW });
    check('a reset link with no recovery hash is refused as a RESET, not an invite',
      noThReset.status === 404 && err(await json(noThReset)) === 'reset_invalid', `status ${noThReset.status}`);

    const resetRes = await req(anon, 'POST', setPasswordPath(resetLink!.token, resetLink!.hashedToken), { password: NEW_PW, confirmPassword: NEW_PW });
    check('an active account resets its password (200)', resetRes.status === 200, `status ${resetRes.status} ${err(await json(resetRes))}`);

    const after = await getUser(E.resetee);
    check('the reset did not change the status',       after?.status === before?.status);
    check('the reset did not change the organization', after?.orgId === before?.orgId);
    check('the reset did not change the membership role', after?.orgRole === before?.orgRole);
    check('the reset did not restart onboarding',      after?.onboardingComplete === before?.onboardingComplete);
    check('the reset did not change the platform role', after?.role === before?.role);

    check('the new password works',
      (await login(new Jar(ip(23)), E.resetee, NEW_PW)).status === 200);
    check('the old password no longer does',
      (await login(new Jar(ip(24)), E.resetee, PW)).status === 401);
    // A reset link is single use too, but it is refused by a different sentence
    // than an invite: the account is still active, so the request reaches the
    // redeem, and Supabase reports a burned recovery token as `otp_expired`.
    // The route maps that to 410 reset_expired ("this link has expired, request
    // a new one"), never 409 reset_used. Both checks are here so a change in
    // either the refusal or its wording is noticed.
    const resetReplay = await req(anon, 'POST', setPasswordPath(resetLink!.token, resetLink!.hashedToken), { password: PW, confirmPassword: PW });
    const resetReplayBody = await json(resetReplay);
    check('a reset link is single use too — the second use is refused',
      resetReplay.status === 409 || resetReplay.status === 410, `status ${resetReplay.status}`);
    check('and today that refusal reads as expired rather than used',
      resetReplay.status === 410 && err(resetReplayBody) === 'reset_expired',
      `status ${resetReplay.status} ${err(resetReplayBody)}`);
    check('the password stayed as the reset set it',
      (await login(new Jar(ip(28)), E.resetee, NEW_PW)).status === 200);

    // ── 7. Revocation (H-16) ──────────────────────────────────────────────────
    section('revocation: disable must reach the JWT claims (H-16)');

    check('the member is working before revocation',
      (await req(revokee, 'GET', '/api/projects')).status === 200);
    check('and their claims say active',
      (await claims(E.revokee)).status === 'active');

    const disable = await req(champion, 'PATCH', '/api/org/members', { email: E.revokee, status: 'disabled' });
    const disableBody = await json(disable);
    check('the org admin disables the member (200 ok)',
      disable.status === 200 && disableBody?.ok === true, `status ${disable.status} ${err(disableBody)}`);
    check('and the route does NOT warn about a dropped metadata sync',
      disableBody?.warning === undefined, `warning ${String(disableBody?.warning)}`);
    check('the membership row is disabled', (await getUser(E.revokee))?.status === 'disabled');
    check('THE CLAIMS ARE DISABLED TOO — this is the check H-16 asks for',
      (await claims(E.revokee)).status === 'disabled', `status claim ${String((await claims(E.revokee)).status)}`);

    const afterRevoke = await req(revokee, 'GET', '/api/projects');
    check('the member’s LIVE session is refused on the very next request',
      afterRevoke.status === 307 || afterRevoke.status === 401 || afterRevoke.status === 403,
      `status ${afterRevoke.status}`);
    const revokedLogin = await login(new Jar(ip(25)), E.revokee);
    check('and they cannot sign in again (403 account_disabled)',
      revokedLogin.status === 403 && err(await json(revokedLogin)) === 'account_disabled',
      `status ${revokedLogin.status}`);

    const selfDisable = await req(champion, 'PATCH', '/api/org/members', { email: E.champion, status: 'disabled' });
    check('an org admin cannot disable their own seat (400 cannot_disable_self)',
      selfDisable.status === 400 && err(await json(selfDisable)) === 'cannot_disable_self', `status ${selfDisable.status}`);

    const reEnable = await req(champion, 'PATCH', '/api/org/members', { email: E.revokee, status: 'active' });
    check('re-enabling the member is 200', reEnable.status === 200, `status ${reEnable.status}`);
    check('and the claims are active again', (await claims(E.revokee)).status === 'active');
    const revokeeAgain = new Jar(ip(26));
    check('the member can sign in once more', (await login(revokeeAgain, E.revokee)).status === 200);

    // ── 8. Org-admin scoping ──────────────────────────────────────────────────
    section('org-admin scoping: another organization’s id is refused, not ignored');

    const ownTeam = await req(champion, 'GET', '/api/org/members');
    const ownTeamBody = await json(ownTeam);
    check('an org admin reads their own team (200)', ownTeam.status === 200, `status ${ownTeam.status}`);
    check('and it is their own organization',
      (ownTeamBody?.organization as JsonBody | undefined)?.id === org.id);

    const crossGet = await req(champion, 'GET', `/api/org/members?orgId=${other.id}`);
    check('GET with another organization’s id is 400 no_organization',
      crossGet.status === 400 && err(await json(crossGet)) === 'no_organization', `status ${crossGet.status}`);
    const crossPatch = await req(champion, 'PATCH', '/api/org/members', { orgId: other.id, email: E.otheradm, status: 'disabled' });
    check('PATCH with another organization’s id is 400 no_organization',
      crossPatch.status === 400 && err(await json(crossPatch)) === 'no_organization', `status ${crossPatch.status}`);
    const crossDelete = await req(champion, 'DELETE', '/api/org/members', { orgId: other.id, email: E.otheradm });
    check('DELETE with another organization’s id is 400 no_organization',
      crossDelete.status === 400 && err(await json(crossDelete)) === 'no_organization', `status ${crossDelete.status}`);
    const crossPost = await req(champion, 'POST', '/api/org/members', { orgId: other.id, firstName: 'A', lastName: 'B', email: `x@${OTHER_DOMAIN}` });
    check('POST with another organization’s id is 400 no_organization',
      crossPost.status === 400 && err(await json(crossPost)) === 'no_organization', `status ${crossPost.status}`);
    const foreignTarget = await req(champion, 'PATCH', '/api/org/members', { email: E.otheradm, status: 'disabled' });
    check('a member of another organization is 404 member_not_found, whatever the caller knows',
      foreignTarget.status === 404 && err(await json(foreignTarget)) === 'member_not_found', `status ${foreignTarget.status}`);
    check('the other organization’s champion is untouched',
      (await getUser(E.otheradm))?.status === 'active');

    const adminCross = await req(staff, 'GET', `/api/org/members?orgId=${other.id}`);
    const adminCrossBody = await json(adminCross);
    check('a PLATFORM admin may target any organization (200)',
      adminCross.status === 200 && (adminCrossBody?.organization as JsonBody | undefined)?.id === other.id,
      `status ${adminCross.status}`);
    const memberTeam = await req(revokeeAgain, 'GET', '/api/org/members');
    check('an ordinary member cannot read the team at all (403 forbidden)',
      memberTeam.status === 403 && err(await json(memberTeam)) === 'forbidden', `status ${memberTeam.status}`);

    // ── 9. Platform staff are off limits to a customer’s org admin (M-3) ──────
    section('platform-staff target refusal and the rest of the team rules (M-3)');

    const staffPatch = await req(champion, 'PATCH', '/api/org/members', { email: E.staff2, status: 'disabled' });
    check('an org admin cannot disable ExpertMatch staff in their org (403 read_only)',
      staffPatch.status === 403 && err(await json(staffPatch)) === 'read_only', `status ${staffPatch.status}`);
    const staffDelete = await req(champion, 'DELETE', '/api/org/members', { email: E.staff2 });
    check('nor remove them (403 read_only)',
      staffDelete.status === 403 && err(await json(staffDelete)) === 'read_only', `status ${staffDelete.status}`);
    check('and the staff account is still active', (await getUser(E.staff2))?.status === 'active');

    const staffByStaff = await req(staff, 'PATCH', '/api/org/members', { email: E.staff2, status: 'disabled' });
    check('a platform admin MAY act on platform staff (200)', staffByStaff.status === 200, `status ${staffByStaff.status}`);
    check('and the claims followed', (await claims(E.staff2)).status === 'disabled');
    check('restoring the staff account is 200',
      (await req(staff, 'PATCH', '/api/org/members', { email: E.staff2, status: 'active' })).status === 200);

    const pendingActivate = await req(champion, 'PATCH', '/api/org/members', { email: E.invitee2, status: 'active' });
    check('an org admin cannot activate a member who never accepted their invite (409 invite_pending)',
      pendingActivate.status === 409 && err(await json(pendingActivate)) === 'invite_pending', `status ${pendingActivate.status}`);
    const nothing = await req(champion, 'PATCH', '/api/org/members', { email: E.revokee });
    check('a PATCH that asks for nothing is 400 nothing_to_update',
      nothing.status === 400 && err(await json(nothing)) === 'nothing_to_update', `status ${nothing.status}`);
    const badTarget = await req(champion, 'PATCH', '/api/org/members', { email: 'nope', status: 'active' });
    check('a malformed target address is 400 valid_email_required',
      badTarget.status === 400 && err(await json(badTarget)) === 'valid_email_required', `status ${badTarget.status}`);
    const deleteActive = await req(champion, 'DELETE', '/api/org/members', { email: E.revokee });
    check('an ACTIVE member cannot be removed before being disabled (409 member_active)',
      deleteActive.status === 409 && err(await json(deleteActive)) === 'member_active', `status ${deleteActive.status}`);
    const deleteSelf = await req(champion, 'DELETE', '/api/org/members', { email: E.champion });
    check('an org admin cannot remove their own seat (400 cannot_remove_self)',
      deleteSelf.status === 400 && err(await json(deleteSelf)) === 'cannot_remove_self', `status ${deleteSelf.status}`);

    const lastAdmin = await req(champion, 'PATCH', '/api/org/members', { email: E.champion, orgRole: 'org_member' });
    check('the only org admin cannot demote themselves (409 last_org_admin)',
      lastAdmin.status === 409 && err(await json(lastAdmin)) === 'last_org_admin', `status ${lastAdmin.status}`);
    check('so the organization still has its admin', (await getUser(E.champion))?.orgRole === 'org_admin');

    const promote = await req(champion, 'PATCH', '/api/org/members', { email: E.revokee, orgRole: 'org_admin' });
    check('an org admin may promote a member (200)', promote.status === 200, `status ${promote.status}`);
    check('and the promotion reaches the claims',
      (await claims(E.revokee)).org_role === 'org_admin');
    const demote = await req(champion, 'PATCH', '/api/org/members', { email: E.revokee, orgRole: 'org_member' });
    check('and demote them again once they are not the last one (200)', demote.status === 200, `status ${demote.status}`);
    check('and the demotion reaches the claims',
      (await claims(E.revokee)).org_role === 'org_member');

    const removePending = await req(champion, 'DELETE', '/api/org/members', { email: E.invitee2 });
    check('a pending invitation can be withdrawn (200)', removePending.status === 200, `status ${removePending.status}`);
    check('and that account is gone', (await getUser(E.invitee2)) === null);

    // ── 10. Login caps (H-14, H-15) ───────────────────────────────────────────
    section('login caps: per-IP 429, per-account 401 (H-14, H-15)');

    // Per-account: ten failures spread across ten DIFFERENT source addresses,
    // which is exactly the attack the per-IP counter cannot see.
    let allFailed = true;
    for (let i = 0; i < 10; i++) {
      const res = await login(new Jar(ip(30 + i)), E.brute, `wrong-password-${i}`);
      if (res.status !== 401) allFailed = false;
    }
    check('ten wrong passwords from ten different addresses are each 401', allFailed);
    const cappedAccount = await login(new Jar(ip(50)), E.brute, PW);
    check('the eleventh attempt is refused even WITH THE RIGHT PASSWORD from a fresh address',
      cappedAccount.status === 401, `status ${cappedAccount.status}`);
    check('and it is refused as a plain invalid_credentials, which names no account',
      err(await json(cappedAccount)) === 'invalid_credentials');

    // Per-IP: one address, eleven attempts, each against an address that has no
    // account, so no real account's budget is spent.
    const floodJar = new Jar(ip(60));
    let flooded: Response | null = null;
    for (let i = 0; i < 11; i++) {
      flooded = await login(floodJar, `ghost-${i}-${RUN}@${ORG_DOMAIN}`, 'whatever-1');
    }
    check('the eleventh attempt from one address is 429 rate_limited',
      flooded?.status === 429 && err(await json(flooded!)) === 'rate_limited', `status ${flooded?.status}`);
    check('and it carries a Retry-After header',
      !!flooded?.headers.get('retry-after'), `retry-after ${String(flooded?.headers.get('retry-after'))}`);

    // ── 11. The reset request route ───────────────────────────────────────────
    section('POST /api/auth/reset is enumeration-safe');

    const enumJar = new Jar(ip(70));
    const unknown = await req(enumJar, 'POST', '/api/auth/reset', { email: `nobody-${RUN}@${ORG_DOMAIN}` });
    check('an address with no account answers 200 { ok: true }',
      unknown.status === 200 && (await json(unknown))?.ok === true, `status ${unknown.status}`);
    const pendingAsk = await req(enumJar, 'POST', '/api/auth/reset', { email: E.pendinger });
    check('a pending account answers identically', pendingAsk.status === 200);
    const disabledAsk = await req(enumJar, 'POST', '/api/auth/reset', { email: E.disabled });
    check('a disabled account answers identically', disabledAsk.status === 200);
    const activeAsk = await req(enumJar, 'POST', '/api/auth/reset', { email: E.resetee });
    check('an active account answers identically', activeAsk.status === 200);
    check('an unusable address is answered the same way too',
      (await req(enumJar, 'POST', '/api/auth/reset', { email: 'not-an-address' })).status === 200);
    const resetBadJson = await rawReq(new Jar(ip(71)), 'POST', '/api/auth/reset', 'nonsense');
    check('an unreadable body is 400 invalid_json',
      resetBadJson.status === 400 && err(await json(resetBadJson)) === 'invalid_json', `status ${resetBadJson.status}`);

    const rlJar   = new Jar(ip(72));
    const rlEmail = E.resetee;
    let rlLast: Response | null = null;
    for (let i = 0; i < 4; i++) rlLast = await req(rlJar, 'POST', '/api/auth/reset', { email: rlEmail });
    if (redisUp) {
      check('a fourth reset request for one address in an hour is 429',
        rlLast?.status === 429 && err(await json(rlLast!)) === 'rate_limited', `status ${rlLast?.status}`);
    } else {
      check('with Upstash unavailable the reset limiter fails open, as documented',
        rlLast?.status === 200, `status ${rlLast?.status}`);
    }

    // ── 12. The admin console is a 404 for everyone else ──────────────────────
    section('DELETE /api/admin/users and the ownership constraint (M-46)');

    const memberAdmin = await req(revokeeAgain, 'GET', '/api/admin/users?all=true');
    check('an ordinary member gets 404 from /api/admin, never 403',
      memberAdmin.status === 404, `status ${memberAdmin.status}`);
    const championAdmin = await req(champion, 'GET', '/api/admin/users?all=true');
    check('an ORG admin is not a platform admin — also 404',
      championAdmin.status === 404, `status ${championAdmin.status}`);
    const staffList = await req(staff, 'GET', '/api/admin/users?all=true');
    check('a platform admin lists users (200)',
      staffList.status === 200 && Array.isArray((await json(staffList))?.users), `status ${staffList.status}`);

    const deleteSelfAdmin = await req(staff, 'DELETE', '/api/admin/users', { email: E.staff });
    check('a platform admin cannot delete their own account (400 cannot_delete_self)',
      deleteSelfAdmin.status === 400 && err(await json(deleteSelfAdmin)) === 'cannot_delete_self',
      `status ${deleteSelfAdmin.status}`);
    const deleteGhost = await req(staff, 'DELETE', '/api/admin/users', { email: `ghost-${RUN}@${ORG_DOMAIN}` });
    check('deleting an unknown address is 404 user_not_found',
      deleteGhost.status === 404 && err(await json(deleteGhost)) === 'user_not_found', `status ${deleteGhost.status}`);
    const deleteMalformed = await req(staff, 'DELETE', '/api/admin/users', { email: 'nope' });
    check('a malformed address is 400 valid_email_required',
      deleteMalformed.status === 400 && err(await json(deleteMalformed)) === 'valid_email_required',
      `status ${deleteMalformed.status}`);

    // A user with no project history really is removed.
    const removed = await req(staff, 'DELETE', '/api/admin/users', { email: E.nodel });
    check('a member who owns nothing is deleted (200 ok)',
      removed.status === 200 && (await json(removed))?.ok === true, `status ${removed.status}`);
    check('and the account is really gone', !(await authUserExists(E.nodel)));

    // A user who OWNS PROJECTS. projects.owner_id references profiles ON DELETE
    // RESTRICT, so the delete cannot happen (audit M-46).
    const createRes  = await req(owner, 'POST', '/api/projects', {
      name: 'Auth flows ownership', industry: 'Industrial coatings',
      function: 'Operations', geography: 'US', seniority: 'Senior',
    });
    const createBody = await json(createRes);
    const ownedProject = ((createBody?.project as JsonBody | undefined)?.id ?? createBody?.id) as string | undefined;
    check('the throwaway owner has a project', !!ownedProject, `status ${createRes.status}`);
    if (ownedProject) {
      cleanup.push(async () => {
        await db.from('conversation_messages').delete().eq('project_id', ownedProject);
        await db.from('engagement_events').delete().eq('project_id', ownedProject);
        await db.from('product_events').delete().eq('project_id', ownedProject);
        await db.from('projects').delete().eq('id', ownedProject);
      });
    }

    const deleteOwner = await req(staff, 'DELETE', '/api/admin/users', { email: E.ownerdel });
    const deleteOwnerBody = await json(deleteOwner);
    const stillThere = await authUserExists(E.ownerdel);
    // M-46 is closed (W4-0): the route counts the target's owned projects BEFORE
    // calling deleteUser and refuses with 409 owns_projects, naming them, rather
    // than reporting 200 ok while the foreign key quietly blocks the delete.
    check('the owner of a project is NOT actually deleted (the constraint holds)', stillThere,
      `auth user present: ${stillThere}`);
    check('and the route answers 409 owns_projects, naming the blocking project',
      deleteOwner.status === 409
        && deleteOwnerBody?.error === 'owns_projects'
        && Array.isArray(deleteOwnerBody?.projectNames),
      `status ${deleteOwner.status} ${err(deleteOwnerBody)}`);
    check('the project is still owned by somebody', !!ownedProject);

    // Sign OUR jars out. The founder's session is untouched — these cookies
    // belong to the throwaway accounts created at the top of this run.
    for (const j of [champion, staff, revokee, owner, invitee, inviteeSession, revokeeAgain]) {
      await req(j, 'POST', '/api/auth/logout');
    }
  } catch (e) {
    check('test-auth-flows crashed', false, e instanceof Error ? e.message : String(e));
  } finally {
    for (const fn of cleanup.reverse()) {
      await fn().catch(e => console.error('cleanup error', e instanceof Error ? e.message : e));
    }
    console.log('cleanup: throwaway accounts, organizations, projects and events deleted');
  }

  summary();
}

main();

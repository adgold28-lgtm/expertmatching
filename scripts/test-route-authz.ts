// scripts/test-route-authz.ts — HTTP-level authorization matrix for every
// project and expert route, against a RUNNING app, using THROWAWAY users only.
//
//   SMOKE_BASE_URL=http://localhost:3100 npx tsx scripts/test-route-authz.ts
//
// WHAT THIS PROVES (audit C-1, H-1, and the guard order in ARCHITECTURE.md §5):
//
//   intruder (another organization) → 404 everywhere. A project the caller
//     cannot reach never confirms that it exists, so the access check always
//     runs BEFORE the owner check and before any field check.
//   collaborator (same org, project_members row) → reads, and keeps notes;
//     403 on every acting verb (bookmark, send, complete, propose, rate,
//     delete, edit the brief, share the project).
//   owner → 403 on the staff-only fields, with the same status a collaborator
//     gets: owning a project buys no right to set your own price (C-1), to
//     mark a call paid, or to redirect Matchy's intro email (H-1).
//   admin → through all of it, and the money fields are writable and readable.
//
// SAFE TO RUN WHILE THE FOUNDER IS LOGGED IN. Every persona here is created
// through the service role and deleted in the finally block, including this
// script's own throwaway platform admin — the founder's session is never
// touched, and no route below signs anybody out but our own four jars.
//
// SENDS NOTHING. Every project is a WALKTHROUGH project (the default), so both
// send routes refuse before any side effect; the one address that exists at any
// point is on a reserved `.example` domain and is removed again immediately.
// The two paid routes (source-experts, interview-guide) are only ever exercised
// on their refusal paths, so no model call is spent.

import * as dotenv from 'dotenv';
import * as path from 'path';
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env.local') });

import { createClient } from '@supabase/supabase-js';

const BASE   = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? BASE;

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

class Jar {
  cookies = new Map<string, string>();
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

async function req(jar: Jar, method: string, p: string, body?: unknown): Promise<Response> {
  const res = await fetch(BASE + p, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN, ...(jar.cookies.size ? { 'Cookie': jar.header() } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  jar.absorb(res);
  return res;
}
async function json(res: Response): Promise<any> { try { return await res.json(); } catch { return null; } }

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const RUN = Math.random().toString(36).slice(2, 8);
const FIRM_DOMAIN  = `authz-${RUN}.example`;
const OTHER_DOMAIN = `authz-other-${RUN}.example`;
const OWNER_EMAIL    = `owner@${FIRM_DOMAIN}`;
const COLLAB_EMAIL   = `collab@${FIRM_DOMAIN}`;
const INTRUDER_EMAIL = `intruder@${OTHER_DOMAIN}`;
const ADMIN_EMAIL    = `staff@${FIRM_DOMAIN}`;
const PW = 'Authz-pw-' + Math.random().toString(36).slice(2) + 'A1';

// A message id that matches the route's UUID shape but exists on no thread.
const ABSENT_MESSAGE_ID = '11111111-2222-3333-4444-555555555555';
const ABSENT_EXPERT_ID  = 'no-such-expert-id';

async function provisionUser(email: string, domain: string, role: 'user' | 'admin'): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email, password: PW, email_confirm: true,
    app_metadata: { role, status: 'active', firm_domain: domain, onboarding_complete: true },
  });
  if (error || !data.user) throw new Error(`createUser ${email}: ${error?.message}`);
  return data.user.id;
}
async function provisionOrg(domain: string, name: string): Promise<string> {
  const { data, error } = await db.from('organizations').insert({ domain, name }).select('id').single();
  if (error || !data) throw new Error(`org ${domain}: ${error?.message}`);
  return data.id as string;
}
async function addMember(orgId: string, profileId: string): Promise<void> {
  const { error } = await db.from('organization_members').upsert({ organization_id: orgId, profile_id: profileId, status: 'active' }, { onConflict: 'organization_id,profile_id' });
  if (error) throw new Error(`member: ${error.message}`);
}

/** Every row this run wrote that a project delete does not take with it. */
function forgetProject(cleanup: Array<() => Promise<void>>, projectId: string): void {
  cleanup.push(async () => {
    await db.from('conversation_messages').delete().eq('project_id', projectId);
    await db.from('engagement_events').delete().eq('project_id', projectId);
    await db.from('product_events').delete().eq('project_id', projectId);
    await db.from('projects').delete().eq('id', projectId);
  });
}

const EXPERT_FIXTURE = {
  title: 'Chief Operating Officer', company: 'Example Coatings Inc',
  location: 'Ohio, US', category: 'Operator', justification: 'Ran operations at a coatings manufacturer.',
  relevance_score: 88, source_url: 'https://example.com', source_label: 'example', source_links: [],
  anonymizedDescriptor: 'COO at a mid-size industrial coatings manufacturer',
};

async function main(): Promise<void> {
  console.log(`test-route-authz: target ${BASE}`);
  const cleanup: Array<() => Promise<void>> = [];
  try {
    // ── provision ──────────────────────────────────────────────────────────
    const ownerId    = await provisionUser(OWNER_EMAIL, FIRM_DOMAIN, 'user');
    const collabId   = await provisionUser(COLLAB_EMAIL, FIRM_DOMAIN, 'user');
    const intruderId = await provisionUser(INTRUDER_EMAIL, OTHER_DOMAIN, 'user');
    const adminId    = await provisionUser(ADMIN_EMAIL, FIRM_DOMAIN, 'admin');
    cleanup.push(async () => { for (const id of [ownerId, collabId, intruderId, adminId]) await db.auth.admin.deleteUser(id).catch(() => {}); });
    const orgId   = await provisionOrg(FIRM_DOMAIN, 'Authz Firm');
    const otherId = await provisionOrg(OTHER_DOMAIN, 'Authz Other Firm');
    cleanup.push(async () => { await db.from('organizations').delete().in('id', [orgId, otherId]); });
    await addMember(orgId, ownerId); await addMember(orgId, collabId);
    await addMember(otherId, intruderId); await addMember(orgId, adminId);
    check('throwaway owner, collaborator, intruder and admin provisioned', true);

    const owner = new Jar(), collab = new Jar(), intruder = new Jar(), admin = new Jar();
    check('owner login',        (await req(owner,    'POST', '/api/auth/login', { email: OWNER_EMAIL,    password: PW })).status === 200);
    check('collaborator login', (await req(collab,   'POST', '/api/auth/login', { email: COLLAB_EMAIL,   password: PW })).status === 200);
    check('intruder login',     (await req(intruder, 'POST', '/api/auth/login', { email: INTRUDER_EMAIL, password: PW })).status === 200);
    check('throwaway admin login', (await req(admin, 'POST', '/api/auth/login', { email: ADMIN_EMAIL,    password: PW })).status === 200);

    // ── the project under test (walkthrough: the default, so nothing sends) ─
    const create  = await req(owner, 'POST', '/api/projects', { name: 'Authz matrix', industry: 'Industrial coatings', function: 'Operations', geography: 'US', seniority: 'Senior' });
    const created = await json(create);
    const P: string | undefined = created?.project?.id ?? created?.id;
    check('owner creates the project under test', !!P, `status ${create.status}`);
    if (!P) throw new Error('no project');
    forgetProject(cleanup, P);
    check('the project under test is a walkthrough project (nothing can be sent)',
      created?.project?.walkthrough !== false, `walkthrough ${JSON.stringify(created?.project?.walkthrough)}`);

    const { addExpertsToProject, updateExpertStatus } = await import('../lib/projectStore');
    const E1 = `authz-${RUN}-1`, E2 = `authz-${RUN}-2`, E3 = `authz-${RUN}-3`;
    await addExpertsToProject(P, [E1, E2, E3].map((id, i) => ({
      status: 'shortlisted' as const,
      expert: { id, name: `Casey Testperson ${i + 1}`, ...EXPERT_FIXTURE } as any,
    })));
    check('three throwaway experts on the project', true);

    // ── GET /api/projects/[id] ─────────────────────────────────────────────
    check('GET project: owner 200',    (await req(owner,    'GET', `/api/projects/${P}`)).status === 200);
    check('GET project: admin 200',    (await req(admin,    'GET', `/api/projects/${P}`)).status === 200);
    const getIntruder = await req(intruder, 'GET', `/api/projects/${P}`);
    check('GET project: intruder 404 (existence is never confirmed)',
      getIntruder.status === 404 && (await json(getIntruder))?.error === 'not_found', `status ${getIntruder.status}`);
    check('GET project: a non-member of the same org is also 404',
      (await req(collab, 'GET', `/api/projects/${P}`)).status === 404);

    // ── PUT /api/projects/[id] ─────────────────────────────────────────────
    check('PUT project: intruder 404',
      (await req(intruder, 'PUT', `/api/projects/${P}`, { notes: 'intruder' })).status === 404);
    check('PUT project: owner 200',
      (await req(owner, 'PUT', `/api/projects/${P}`, { notes: 'owner note' })).status === 200);
    check('PUT project: admin 200',
      (await req(admin, 'PUT', `/api/projects/${P}`, { notes: 'staff note' })).status === 200);

    // ── POST /api/projects/[id]/collaborators — same org only ──────────────
    const shareIntruder = await req(intruder, 'POST', `/api/projects/${P}/collaborators`, { email: COLLAB_EMAIL });
    check('share: intruder 404', shareIntruder.status === 404, `status ${shareIntruder.status}`);
    const shareCrossOrg = await req(owner, 'POST', `/api/projects/${P}/collaborators`, { email: INTRUDER_EMAIL });
    const crossBody = await json(shareCrossOrg);
    check('share: owner cannot share across organizations (422)',
      shareCrossOrg.status === 422 && crossBody?.error === 'collaborator_not_in_organization',
      `status ${shareCrossOrg.status} ${crossBody?.error ?? ''}`);
    const shareCrossAdmin = await req(admin, 'POST', `/api/projects/${P}/collaborators`, { email: INTRUDER_EMAIL });
    check('share: not even staff can share across organizations (422)',
      shareCrossAdmin.status === 422, `status ${shareCrossAdmin.status}`);
    check('share: the owner cannot be their own collaborator (400)',
      (await req(owner, 'POST', `/api/projects/${P}/collaborators`, { email: OWNER_EMAIL })).status === 400);
    check('share: a malformed address is 400',
      (await req(owner, 'POST', `/api/projects/${P}/collaborators`, { email: 'not-an-address' })).status === 400);
    const share = await req(owner, 'POST', `/api/projects/${P}/collaborators`, { email: COLLAB_EMAIL });
    check('share: owner adds a same-org collaborator (200)', share.status === 200, `status ${share.status}`);
    check('share: the collaborator can now read the project (200)',
      (await req(collab, 'GET', `/api/projects/${P}`)).status === 200);
    const shareByCollab = await req(collab, 'POST', `/api/projects/${P}/collaborators`, { email: ADMIN_EMAIL });
    check('share: a collaborator cannot re-share the project (403 forbidden)',
      shareByCollab.status === 403 && (await json(shareByCollab))?.error === 'forbidden', `status ${shareByCollab.status}`);
    check('unshare: intruder 404',
      (await req(intruder, 'DELETE', `/api/projects/${P}/collaborators`, { email: COLLAB_EMAIL })).status === 404);
    const unshareByCollab = await req(collab, 'DELETE', `/api/projects/${P}/collaborators`, { email: COLLAB_EMAIL });
    check('unshare: a collaborator cannot remove themselves or anyone else (403)',
      unshareByCollab.status === 403, `status ${unshareByCollab.status}`);

    // ── PUT project, now that the collaborator IS a member ─────────────────
    const collabPut = await req(collab, 'PUT', `/api/projects/${P}`, { notes: 'reader edit' });
    const collabPutBody = await json(collabPut);
    check('PUT project: collaborator 403 read_only (a shared project is read-only)',
      collabPut.status === 403 && collabPutBody?.error === 'read_only', `status ${collabPut.status} ${collabPutBody?.error ?? ''}`);

    // ── PUT expert: TIER 1, staff-only fields (C-1, H-1) ───────────────────
    // The owner is refused each of these with the same 403 a collaborator gets,
    // and the body names the field so the UI can say which one.
    const STAFF_ONLY_PROBES: Array<[string, unknown]> = [
      ['expertRate',            1],
      ['expertCounterRate',     1],
      ['clientCounterRate',     1],
      ['invoiceAmount',         1],
      ['callDurationMin',       15],
      ['paymentStatus',         'paid'],
      ['paidAt',                1_700_000_000_000],
      ['stripePaymentIntentId', 'pi_x'],
      ['stripePaymentLinkUrl',  'https://example.com/pay'],
      ['stripeConnectAccountId','acct_x'],
      ['contactEmail',          'attacker@example.com'],
      ['emailVerificationStatus', 'verified'],
      ['outreachToken',         'tok_x'],
      ['availabilityTokenHash', 'hash_x'],
      ['calendarAccessToken',   'ya29.x'],
      ['zoomJoinUrl',           'https://zoom.us/j/1'],
      ['scheduling',            { pickTokenHash: 'x' }],
      ['booking',               { bookedAt: 1 }],
      ['nudges',                { scheduledFor: 1 }],
    ];
    for (const [field, value] of STAFF_ONLY_PROBES) {
      const res  = await req(owner, 'PUT', `/api/projects/${P}/experts/${E1}`, { [field]: value });
      const body = await json(res);
      check(`PUT expert: owner is refused the staff-only field \`${field}\` (403 read_only)`,
        res.status === 403 && body?.error === 'read_only' && body?.field === field,
        `status ${res.status} ${JSON.stringify(body)?.slice(0, 120)}`);
    }
    const collabRateProbe = await req(collab, 'PUT', `/api/projects/${P}/experts/${E1}`, { expertRate: 1 });
    check('PUT expert: a collaborator is refused a staff-only field with the same shape',
      collabRateProbe.status === 403 && (await json(collabRateProbe))?.error === 'read_only', `status ${collabRateProbe.status}`);
    const intruderRateProbe = await req(intruder, 'PUT', `/api/projects/${P}/experts/${E1}`, { expertRate: 1 });
    check('PUT expert: the intruder still gets 404, not the field refusal',
      intruderRateProbe.status === 404, `status ${intruderRateProbe.status}`);

    // ── PUT expert: TIER 2 (owner) and TIER 3 (any member) ─────────────────
    const collabStatus = await req(collab, 'PUT', `/api/projects/${P}/experts/${E1}`, { status: 'rejected' });
    check('PUT expert: collaborator cannot move the stage (403 forbidden)',
      collabStatus.status === 403 && (await json(collabStatus))?.error === 'forbidden', `status ${collabStatus.status}`);
    const collabScreening = await req(collab, 'PUT', `/api/projects/${P}/experts/${E1}`, { screeningStatus: 'screened' });
    check('PUT expert: collaborator cannot write screening state (403)', collabScreening.status === 403, `status ${collabScreening.status}`);
    check('PUT expert: collaborator may keep a note (200)',
      (await req(collab, 'PUT', `/api/projects/${P}/experts/${E1}`, { note: 'Reader note.' })).status === 200);
    check('PUT expert: collaborator may keep userNotes (200)',
      (await req(collab, 'PUT', `/api/projects/${P}/experts/${E1}`, { userNotes: 'Reader notes.' })).status === 200);
    const ownerStage = await req(owner, 'PUT', `/api/projects/${P}/experts/${E1}`, { status: 'scheduled' });
    const ownerStageBody = await json(ownerStage);
    check('PUT expert: owner cannot set a server-owned stage (403 status_not_client_settable)',
      ownerStage.status === 403 && ownerStageBody?.error === 'status_not_client_settable',
      `status ${ownerStage.status} ${ownerStageBody?.error ?? ''}`);
    check('PUT expert: owner may pass on a candidate (200)',
      (await req(owner, 'PUT', `/api/projects/${P}/experts/${E1}`, { status: 'rejected', rejectionReason: 'wrong_industry' })).status === 200);
    check('PUT expert: owner may put the candidate back (200)',
      (await req(owner, 'PUT', `/api/projects/${P}/experts/${E1}`, { status: 'shortlisted' })).status === 200);

    // ── bookmark / unbookmark ──────────────────────────────────────────────
    check('bookmark: intruder 404',
      (await req(intruder, 'POST', `/api/projects/${P}/experts/${E1}/bookmark`, {})).status === 404);
    const collabBookmark = await req(collab, 'POST', `/api/projects/${P}/experts/${E1}/bookmark`, {});
    check('bookmark: collaborator 403 forbidden',
      collabBookmark.status === 403 && (await json(collabBookmark))?.error === 'forbidden', `status ${collabBookmark.status}`);
    const ownerBookmark = await req(owner, 'POST', `/api/projects/${P}/experts/${E1}/bookmark`, {});
    const ownerBookmarkBody = await json(ownerBookmark);
    check('bookmark: owner 200, and walkthrough holds the outreach',
      ownerBookmark.status === 200 && ownerBookmarkBody?.outcome === 'walkthrough_held',
      `status ${ownerBookmark.status} outcome ${ownerBookmarkBody?.outcome}`);
    check('bookmark: the client-facing body still hides the expert rate',
      ownerBookmarkBody?.projectExpert?.expertRate === undefined && ownerBookmarkBody?.projectExpert?.contactEmail === undefined);
    check('bookmark: admin 200 on the same engagement',
      (await req(admin, 'POST', `/api/projects/${P}/experts/${E1}/bookmark`, {})).status === 200);
    check('unbookmark: intruder 404',
      (await req(intruder, 'POST', `/api/projects/${P}/experts/${E1}/unbookmark`, {})).status === 404);
    check('unbookmark: collaborator 403 forbidden',
      (await req(collab, 'POST', `/api/projects/${P}/experts/${E1}/unbookmark`, {})).status === 403);
    const unbookmark = await req(owner, 'POST', `/api/projects/${P}/experts/${E1}/unbookmark`, {});
    check('unbookmark: owner 200 → shortlisted',
      unbookmark.status === 200 && (await json(unbookmark))?.projectExpert?.status === 'shortlisted', `status ${unbookmark.status}`);

    // ── PUT expert as ADMIN: the same fields, allowed ──────────────────────
    // The address is on a reserved `.example` domain, this project is a
    // walkthrough project, and both fields are cleared again below.
    const adminRate = await req(admin, 'PUT', `/api/projects/${P}/experts/${E1}`, { expertRate: 500 });
    const adminRateBody = await json(adminRate);
    const adminPe = adminRateBody?.project?.experts?.find((e: any) => e.expert?.id === E1);
    check('PUT expert: admin may set the expert rate (200)', adminRate.status === 200, `status ${adminRate.status}`);
    check('PUT expert: the admin response carries the rate back unredacted',
      adminPe?.expertRate === 500, `expertRate ${adminPe?.expertRate}`);
    check('PUT expert: the client rate was derived in the same write (never one alone)',
      typeof adminPe?.clientRate === 'number' && adminPe.clientRate > 500, `clientRate ${adminPe?.clientRate}`);
    check('PUT expert: admin may set the payment status (200)',
      (await req(admin, 'PUT', `/api/projects/${P}/experts/${E1}`, { paymentStatus: 'unpaid' })).status === 200);
    check('PUT expert: admin may set a server-owned stage (200)',
      (await req(admin, 'PUT', `/api/projects/${P}/experts/${E1}`, { status: 'shortlisted' })).status === 200);
    const badAddress = await req(admin, 'PUT', `/api/projects/${P}/experts/${E1}`, { contactEmail: 'not-an-address' });
    check('PUT expert: a contact address that is not an address is 400 (H-1)',
      badAddress.status === 400 && (await json(badAddress))?.error === 'invalid_contact_email', `status ${badAddress.status}`);
    const mixedCase = await req(admin, 'PUT', `/api/projects/${P}/experts/${E1}`, { contactEmail: `Expert.One@${FIRM_DOMAIN}` });
    const mixedBody = await json(mixedCase);
    const mixedPe = mixedBody?.project?.experts?.find((e: any) => e.expert?.id === E1);
    check('PUT expert: admin may set the contact address (200)', mixedCase.status === 200, `status ${mixedCase.status}`);
    check('PUT expert: the stored address is lower-cased',
      mixedPe?.contactEmail === `expert.one@${FIRM_DOMAIN}`, `contactEmail ${mixedPe?.contactEmail}`);
    // Take the address back off: from here on there is nowhere to write to at all.
    await updateExpertStatus(P, E1, { contactEmail: '', outreachToken: '' });

    // ── messages ───────────────────────────────────────────────────────────
    check('GET messages: owner 200',  (await req(owner, 'GET', `/api/projects/${P}/experts/${E1}/messages`)).status === 200);
    check('GET messages: collaborator 200 (a reader reads the thread)',
      (await req(collab, 'GET', `/api/projects/${P}/experts/${E1}/messages`)).status === 200);
    check('GET messages: admin 200', (await req(admin, 'GET', `/api/projects/${P}/experts/${E1}/messages`)).status === 200);
    check('GET messages: intruder 404',
      (await req(intruder, 'GET', `/api/projects/${P}/experts/${E1}/messages`)).status === 404);
    const collabSend = await req(collab, 'POST', `/api/projects/${P}/experts/${E1}/messages`, { text: 'Tuesday works.' });
    check('POST messages: collaborator 403 read_only',
      collabSend.status === 403 && (await json(collabSend))?.error === 'read_only', `status ${collabSend.status}`);
    check('POST messages: intruder 404',
      (await req(intruder, 'POST', `/api/projects/${P}/experts/${E1}/messages`, { text: 'Hello.' })).status === 404);
    const ownerSend = await req(owner, 'POST', `/api/projects/${P}/experts/${E1}/messages`, { text: 'Tuesday works.' });
    check('POST messages: owner gets past the owner check (422 thread_not_started, nothing to send to)',
      ownerSend.status === 422 && (await json(ownerSend))?.error === 'thread_not_started', `status ${ownerSend.status}`);

    // ── messages/[messageId]/send ──────────────────────────────────────────
    check('send message: intruder 404',
      (await req(intruder, 'POST', `/api/projects/${P}/experts/${E1}/messages/${ABSENT_MESSAGE_ID}/send`, {})).status === 404);
    const collabSendOne = await req(collab, 'POST', `/api/projects/${P}/experts/${E1}/messages/${ABSENT_MESSAGE_ID}/send`, {});
    check('send message: collaborator 403 read_only',
      collabSendOne.status === 403 && (await json(collabSendOne))?.error === 'read_only', `status ${collabSendOne.status}`);
    const ownerSendOne = await req(owner, 'POST', `/api/projects/${P}/experts/${E1}/messages/${ABSENT_MESSAGE_ID}/send`, {});
    check('send message: owner is past the owner check and stopped by walkthrough (409)',
      ownerSendOne.status === 409 && (await json(ownerSendOne))?.error === 'walkthrough_mode', `status ${ownerSendOne.status}`);

    // ── outreach/approve ───────────────────────────────────────────────────
    check('approve outreach: intruder 404',
      (await req(intruder, 'POST', `/api/projects/${P}/experts/${E1}/outreach/approve`, {})).status === 404);
    const collabApprove = await req(collab, 'POST', `/api/projects/${P}/experts/${E1}/outreach/approve`, {});
    check('approve outreach: collaborator 403 read_only',
      collabApprove.status === 403 && (await json(collabApprove))?.error === 'read_only', `status ${collabApprove.status}`);
    const ownerApprove = await req(owner, 'POST', `/api/projects/${P}/experts/${E1}/outreach/approve`, {});
    check('approve outreach: owner is past the owner check and stopped by walkthrough (409)',
      ownerApprove.status === 409 && (await json(ownerApprove))?.error === 'walkthrough_mode', `status ${ownerApprove.status}`);

    // ── propose-times ──────────────────────────────────────────────────────
    const proposePath = `/api/projects/${P}/experts/${E1}/propose-times`;
    check('propose-times: intruder 404', (await req(intruder, 'POST', proposePath, {})).status === 404);
    const collabPropose = await req(collab, 'POST', proposePath, {});
    check('propose-times: collaborator 403 forbidden',
      collabPropose.status === 403 && (await json(collabPropose))?.error === 'forbidden', `status ${collabPropose.status}`);
    const ownerPropose = await req(owner, 'POST', proposePath, {});
    check('propose-times: owner is past the owner check (422 thread_not_started)',
      ownerPropose.status === 422 && (await json(ownerPropose))?.error === 'thread_not_started', `status ${ownerPropose.status}`);
    const adminPropose = await req(admin, 'POST', proposePath, {});
    check('propose-times: admin is past the owner check too (422 thread_not_started)',
      adminPropose.status === 422, `status ${adminPropose.status}`);

    // ── rate-decision ──────────────────────────────────────────────────────
    const ratePath = `/api/projects/${P}/experts/${E1}/rate-decision`;
    check('rate-decision: intruder 404', (await req(intruder, 'POST', ratePath, { action: 'accept' })).status === 404);
    const collabRate = await req(collab, 'POST', ratePath, { action: 'accept' });
    check('rate-decision: collaborator 403 forbidden',
      collabRate.status === 403 && (await json(collabRate))?.error === 'forbidden', `status ${collabRate.status}`);
    const ownerRateDecision = await req(owner, 'POST', ratePath, { action: 'accept' });
    check('rate-decision: owner is past the owner check (409, there is no counter to accept)',
      ownerRateDecision.status === 409, `status ${ownerRateDecision.status} ${(await json(ownerRateDecision))?.error ?? ''}`);

    // ── complete (owner only; the call that charges the card) ──────────────
    const completePath = `/api/projects/${P}/experts/${E1}/complete`;
    const completeBody = { callDurationMin: 45, invoiceAmount: 1_000 };
    check('complete: intruder 404', (await req(intruder, 'POST', completePath, completeBody)).status === 404);
    const collabComplete = await req(collab, 'POST', completePath, completeBody);
    check('complete: collaborator 403 forbidden (a reader never bills a card)',
      collabComplete.status === 403 && (await json(collabComplete))?.error === 'forbidden', `status ${collabComplete.status}`);
    const ownerComplete = await req(owner, 'POST', completePath, completeBody);
    const ownerCompleteBody = await json(ownerComplete);
    check('complete: owner is past the owner check and stopped by the account boundary',
      ownerComplete.status === 403 && ownerCompleteBody?.error === 'activation_required',
      `status ${ownerComplete.status} ${ownerCompleteBody?.error ?? ''}`);
    const adminComplete = await req(admin, 'POST', completePath, completeBody);
    check('complete: admin reaches the same boundary, not a 403 forbidden',
      (await json(adminComplete))?.error === 'activation_required', `status ${adminComplete.status}`);

    // ── booking/ics ────────────────────────────────────────────────────────
    const icsPath = `/api/projects/${P}/experts/${E1}/booking/ics`;
    const icsIntruder = await req(intruder, 'GET', icsPath);
    check('booking ics: intruder 404 project_not_found',
      icsIntruder.status === 404 && (await json(icsIntruder))?.error === 'project_not_found', `status ${icsIntruder.status}`);
    const icsCollab = await req(collab, 'GET', icsPath);
    check('booking ics: a member with nothing booked gets 404, not 403',
      icsCollab.status === 404 && (await json(icsCollab))?.error !== 'project_not_found', `status ${icsCollab.status}`);
    check('booking ics: owner with nothing booked 404', (await req(owner, 'GET', icsPath)).status === 404);

    // ── interview-guide (any member; refusal paths only, no model call) ────
    const guidePath = `/api/projects/${P}/interview-guide`;
    const guideIntruder = await req(intruder, 'POST', guidePath, { expertId: E1 });
    check('interview-guide: intruder 404 not_found',
      guideIntruder.status === 404 && (await json(guideIntruder))?.error === 'not_found', `status ${guideIntruder.status}`);
    check('interview-guide: a missing expertId is 400 before anything is spent',
      (await req(owner, 'POST', guidePath, {})).status === 400);
    const guideCollab = await req(collab, 'POST', guidePath, { expertId: ABSENT_EXPERT_ID });
    check('interview-guide: a collaborator is a member, so they reach expert_not_found (404)',
      guideCollab.status === 404 && (await json(guideCollab))?.error === 'expert_not_found', `status ${guideCollab.status}`);
    const guideOwner = await req(owner, 'POST', guidePath, { expertId: ABSENT_EXPERT_ID });
    check('interview-guide: the owner reaches expert_not_found (404)',
      guideOwner.status === 404 && (await json(guideOwner))?.error === 'expert_not_found', `status ${guideOwner.status}`);
    const guideAdmin = await req(admin, 'POST', guidePath, { expertId: ABSENT_EXPERT_ID });
    check('interview-guide: admin reaches expert_not_found (404)',
      guideAdmin.status === 404 && (await json(guideAdmin))?.error === 'expert_not_found', `status ${guideAdmin.status}`);

    // ── POST experts (adding candidates) and source-experts ────────────────
    const addBody = { experts: [{ id: `authz-${RUN}-x`, name: 'Nobody', ...EXPERT_FIXTURE }] };
    check('POST experts: intruder 404',
      (await req(intruder, 'POST', `/api/projects/${P}/experts`, addBody)).status === 404);
    const collabAdd = await req(collab, 'POST', `/api/projects/${P}/experts`, addBody);
    check('POST experts: collaborator 403 forbidden',
      collabAdd.status === 403 && (await json(collabAdd))?.error === 'forbidden', `status ${collabAdd.status}`);
    check('source-experts: intruder 404',
      (await req(intruder, 'POST', `/api/projects/${P}/source-experts`, {})).status === 404);
    const collabSource = await req(collab, 'POST', `/api/projects/${P}/source-experts`, {});
    check('source-experts: collaborator 403 forbidden',
      collabSource.status === 403 && (await json(collabSource))?.error === 'forbidden', `status ${collabSource.status}`);

    // ── DELETE expert ──────────────────────────────────────────────────────
    check('DELETE expert: intruder 404',
      (await req(intruder, 'DELETE', `/api/projects/${P}/experts/${E1}`)).status === 404);
    const collabDeleteExpert = await req(collab, 'DELETE', `/api/projects/${P}/experts/${E1}`);
    check('DELETE expert: collaborator 403 forbidden',
      collabDeleteExpert.status === 403 && (await json(collabDeleteExpert))?.error === 'forbidden', `status ${collabDeleteExpert.status}`);
    check('DELETE expert: owner 200', (await req(owner, 'DELETE', `/api/projects/${P}/experts/${E2}`)).status === 200);
    check('DELETE expert: admin 200', (await req(admin, 'DELETE', `/api/projects/${P}/experts/${E3}`)).status === 200);

    // ── DELETE project — on its own throwaway projects, last ───────────────
    const makeProject = async (name: string): Promise<string> => {
      const res  = await req(owner, 'POST', '/api/projects', { name, industry: 'Industrial coatings', function: 'Operations', geography: 'US', seniority: 'Senior' });
      const body = await json(res);
      const id: string = body?.project?.id ?? body?.id;
      forgetProject(cleanup, id);
      return id;
    };
    const PDEL  = await makeProject('Authz delete by owner');
    const PDELA = await makeProject('Authz delete by admin');
    check('DELETE project: two more throwaway projects created', !!PDEL && !!PDELA);
    check('DELETE project: intruder 404', (await req(intruder, 'DELETE', `/api/projects/${PDEL}`)).status === 404);
    await req(owner, 'POST', `/api/projects/${PDEL}/collaborators`, { email: COLLAB_EMAIL });
    const collabDeleteProject = await req(collab, 'DELETE', `/api/projects/${PDEL}`);
    check('DELETE project: collaborator 403 forbidden',
      collabDeleteProject.status === 403 && (await json(collabDeleteProject))?.error === 'forbidden', `status ${collabDeleteProject.status}`);
    const ownerDelete = await req(owner, 'DELETE', `/api/projects/${PDEL}`);
    check('DELETE project: owner 200 { ok: true }',
      ownerDelete.status === 200 && (await json(ownerDelete))?.ok === true, `status ${ownerDelete.status}`);
    check('DELETE project: the deleted project is gone (404 afterwards)',
      (await req(owner, 'GET', `/api/projects/${PDEL}`)).status === 404);
    check('DELETE project: admin 200 on a project they do not own',
      (await req(admin, 'DELETE', `/api/projects/${PDELA}`)).status === 200);

    // Sign OUR four jars out. The founder's session is untouched: these cookies
    // belong to the throwaway accounts created at the top of this run.
    for (const j of [owner, collab, intruder, admin]) await req(j, 'POST', '/api/auth/logout');
  } catch (e) {
    check('test-route-authz crashed', false, e instanceof Error ? e.message : String(e));
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(err => console.error('cleanup error', err instanceof Error ? err.message : err));
    console.log('cleanup: throwaway projects, users and orgs deleted');
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

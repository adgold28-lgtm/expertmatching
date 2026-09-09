// scripts/e2e-trial.ts — a TRIAL tester's whole journey against a running app,
// with throwaway accounts only. Sends no email: the invite and reset links are
// minted in-process (lib/authLinks.ts) and redeemed over HTTP.
//
//   SMOKE_BASE_URL=http://localhost:3000 npx tsx scripts/e2e-trial.ts
//   SMOKE_BASE_URL=https://expertmatch.fit npx tsx scripts/e2e-trial.ts
//   KEEP=1 … keeps the tester (credentials printed to scripts/.e2e-trial-keep.json) for a browser pass
//
// What it proves, in order:
//   registration   a personal-domain address can never form or join an org;
//                  the public form never auto-invites
//   invite         a Supabase-native set-password link works once, then 409s;
//                  a legacy link (no `th`) is refused
//   onboarding     calendar → billing (trial: no card) → profile → app
//   product        create project, save brief (versioned), stale save 409,
//                  candidates anonymized, bookmark held, pass, undo, persistence
//   boundary       go-live 403 activation_required; status manipulation 403;
//                  send / approve 409; complete 403; collaborator read-only;
//                  direct PostgREST read of project_experts (reports the count)
//   recovery       reset link → new password works, old one does not
//   cleanup        every row it created is deleted

import * as dotenv from 'dotenv';
import * as path from 'path';
import * as fs from 'fs';
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env.local') });

import { createClient } from '@supabase/supabase-js';
import { mintSetPasswordLink } from '../lib/authLinks';
import { provisionAccountInvite } from '../lib/accountProvisioning';
import { isApprovedDomain } from '../lib/firmStore';
import { TRIAL_SUBSCRIPTION_STATUS } from '../lib/entitlements';

const BASE   = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? BASE;
const KEEP   = process.env.KEEP === '1';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}
function note(name: string, detail: string): void { console.log(`INFO  ${name} — ${detail}`); }

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
  /** The Supabase access token, reassembled from the chunked sb-* cookies. */
  accessToken(): string | null {
    const parts = Array.from(this.cookies.entries())
      .filter(([k]) => /^sb-.*-auth-token(\.\d+)?$/.test(k))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, v]) => v);
    if (parts.length === 0) return null;
    let raw = decodeURIComponent(parts.join(''));
    if (raw.startsWith('base64-')) raw = Buffer.from(raw.slice(7), 'base64').toString('utf8');
    try { return (JSON.parse(raw) as { access_token?: string }).access_token ?? null; } catch { return null; }
  }
}

async function req(jar: Jar, method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
  const res = await fetch(BASE + p, {
    method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN, ...headers, ...(jar.cookies.size ? { 'Cookie': jar.header() } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  jar.absorb(res);
  return res;
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function json(res: Response): Promise<any> { try { return await res.json(); } catch { return null; } }

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const PUBLISHABLE  = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
const db = createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const RUN          = Math.random().toString(36).slice(2, 8);
const ORG_DOMAIN   = `trial-e2e-${RUN}.expertmatch.fit`;
const ORG_NAME     = `Trial E2E ${RUN}`;
const TESTER_EMAIL = `tester-${RUN}@e2e-trial.invalid`;
const COLLAB_EMAIL = `collab-${RUN}@e2e-trial.invalid`;
const GMAIL_EMAIL  = `nobody-${RUN}@gmail.com`;
const PW1 = 'Trial-pw-' + Math.random().toString(36).slice(2) + 'A1';
const PW2 = 'Trial-pw2-' + Math.random().toString(36).slice(2) + 'B2';

const created = { users: [] as string[], orgIds: [] as string[], projectIds: [] as string[] };

async function createPendingUser(email: string, orgId: string, first: string, last: string, role: 'org_admin' | 'org_member'): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email, password: 'placeholder-' + Math.random().toString(36).slice(2) + 'Z9', email_confirm: true,
    app_metadata: { role: 'user', status: 'pending', firm_domain: ORG_DOMAIN, firm_name: ORG_NAME, org_id: orgId, org_role: role, onboarding_complete: false },
  });
  if (error || !data.user) throw new Error(`createUser: ${error?.message}`);
  created.users.push(email);
  await db.from('profiles').update({ first_name: first, last_name: last }).eq('id', data.user.id);
  const { error: me } = await db.from('organization_members').insert({ organization_id: orgId, profile_id: data.user.id, role, status: 'pending' });
  if (me) throw new Error(`member: ${me.message}`);
  return data.user.id;
}

async function cleanup(): Promise<void> {
  if (KEEP) { console.log('KEEP=1 — throwaway rows retained'); return; }
  for (const id of created.projectIds) await db.from('projects').delete().eq('id', id);
  for (const orgId of created.orgIds) await db.from('product_events').delete().eq('organization_id', orgId).then(() => {}, () => {});
  for (const email of created.users) {
    const { data } = await db.from('profiles').select('id').eq('email', email).maybeSingle();
    if (data) await db.auth.admin.deleteUser(data.id);
  }
  for (const orgId of created.orgIds) await db.from('organizations').delete().eq('id', orgId);
  await db.from('access_requests').delete().eq('email', GMAIL_EMAIL);
  console.log('cleanup: throwaway project, users and org deleted');
}

async function main(): Promise<void> {
  // CLEANUP_ORG=<uuid> deletes a run that was kept with KEEP=1 and exits.
  if (process.env.CLEANUP_ORG) {
    const orgId = process.env.CLEANUP_ORG;
    const { data: members } = await db.from('organization_members').select('profile_id').eq('organization_id', orgId);
    for (const m of members ?? []) await db.auth.admin.deleteUser(m.profile_id);
    await db.from('projects').delete().eq('organization_id', orgId);
    await db.from('product_events').delete().eq('organization_id', orgId).then(() => {}, () => {});
    await db.from('organizations').delete().eq('id', orgId);
    console.log(`cleanup: organization ${orgId} and its users/projects deleted`);
    process.exit(0);
  }
  console.log(`e2e-trial: target ${BASE}`);

  // ── 0. Registration boundary ──────────────────────────────────────────────
  check('gmail.com is never an approved domain', !(await isApprovedDomain('gmail.com')));
  check('outlook.com is never an approved domain', !(await isApprovedDomain('outlook.com')));
  const gmailInvite = await provisionAccountInvite({ firstName: 'No', lastName: 'Body', email: GMAIL_EMAIL, organization: {} });
  check('inviting a gmail address with no named org is refused', !gmailInvite.ok && gmailInvite.error === 'personal_email_domain', JSON.stringify(gmailInvite).slice(0, 120));
  const anon = new Jar();
  const ra = await req(anon, 'POST', '/api/request-access', { name: 'No Body', firm: 'Gmail Users', email: GMAIL_EMAIL, useCase: 'testing' });
  const raBody = await json(ra);
  check('public request-access answers ok without inviting', ra.status === 200 && raBody?.ok === true && raBody?.invited === undefined, JSON.stringify(raBody));
  const { data: gmailProfile } = await db.from('profiles').select('id').eq('email', GMAIL_EMAIL).maybeSingle();
  check('no account was created for the gmail requester', !gmailProfile);

  // ── 1. Provision a trial org + pending tester (what /admin does) ──────────
  const { data: org, error: oe } = await db.from('organizations').insert({ domain: ORG_DOMAIN, name: ORG_NAME }).select('id').single();
  if (oe || !org) throw new Error('org: ' + oe?.message);
  created.orgIds.push(org.id);
  const { error: be } = await db.from('organization_billing').insert({ organization_id: org.id, billing_complete: false, subscription_status: TRIAL_SUBSCRIPTION_STATUS });
  if (be) throw new Error('billing row: ' + be.message);
  const testerId = await createPendingUser(TESTER_EMAIL, org.id, 'Trial', 'Tester', 'org_admin');

  // ── 2. Invite link: Supabase-native single use ────────────────────────────
  const link = await mintSetPasswordLink(TESTER_EMAIL, ORG_NAME, { kind: 'invite', orgId: org.id });
  check('invite link minted without Redis', !!link, link ? 'ok' : 'null');
  if (!link) throw new Error('cannot continue without a link');
  const q = `token=${encodeURIComponent(link.token)}&th=${encodeURIComponent(link.hashedToken)}`;

  const tester = new Jar();
  const legacy = await req(tester, 'POST', `/api/auth/set-password?token=${encodeURIComponent(link.token)}`, { password: PW1, confirmPassword: PW1 });
  check('legacy link without th is refused', legacy.status === 404, `status ${legacy.status}`);
  const weak = await req(tester, 'POST', `/api/auth/set-password?${q}`, { password: 'short', confirmPassword: 'short' });
  check('weak password refused before the link is spent', weak.status === 400, `status ${weak.status}`);
  const setPw = await req(tester, 'POST', `/api/auth/set-password?${q}`, { password: PW1, confirmPassword: PW1 });
  const setPwBody = await json(setPw);
  check('set-password 200 and signed in', setPw.status === 200 && setPwBody?.signedIn === true, `status ${setPw.status} ${JSON.stringify(setPwBody)}`);
  const replay = await req(new Jar(), 'POST', `/api/auth/set-password?${q}`, { password: PW1, confirmPassword: PW1 });
  check('the same link cannot be used twice', replay.status === 409 || replay.status === 410, `status ${replay.status}`);

  // ── 3. Login + onboarding ─────────────────────────────────────────────────
  const fresh = new Jar();
  const login = await req(fresh, 'POST', '/api/auth/login', { email: TESTER_EMAIL, password: PW1 });
  check('login with the chosen password', login.status === 200, `status ${login.status}`);
  const me0 = await json(await req(fresh, 'GET', '/api/auth/me'));
  check('me: account kind is trial', me0?.account?.kind === 'trial', JSON.stringify(me0?.account));
  check('me: cannot go live', me0?.account?.canGoLive === false);
  check('me: billing step counts as complete (no card asked)', me0?.billingStepComplete === true);
  check('me: onboarding not yet complete', me0?.onboardingComplete === false);

  const gated = await req(fresh, 'GET', '/api/projects');
  check('app is gated until onboarding completes', gated.status === 403, `status ${gated.status}`);

  const cal = await req(fresh, 'POST', '/api/onboarding/calendar', {
    provider: 'manual', timezone: 'America/New_York',
    weeklyWindows: [{ dayOfWeek: 2, from: '09:00', to: '12:00', timezone: 'America/New_York' }],
  });
  check('calendar step (manual weekly hours)', cal.status === 200, `status ${cal.status} ${JSON.stringify(await json(cal))?.slice(0, 100)}`);
  const bill = await req(fresh, 'POST', '/api/onboarding/billing', {});
  const billBody = await json(bill);
  check('billing step answers trial (no SetupIntent, no card)', bill.status === 200 && billBody?.trial === true && !billBody?.clientSecret, JSON.stringify(billBody)?.slice(0, 120));
  const prof = await req(fresh, 'POST', '/api/onboarding/profile', { firstName: 'Trial', lastName: 'Tester', title: 'Associate' });
  check('profile step completes onboarding without a card', prof.status === 200, `status ${prof.status} ${JSON.stringify(await json(prof))}`);
  const me1 = await json(await req(fresh, 'GET', '/api/auth/me'));
  check('me: onboarding complete', me1?.onboardingComplete === true);

  // ── 4. Product: project, brief, candidates ────────────────────────────────
  const create = await req(fresh, 'POST', '/api/projects', { name: 'Trial diligence', industry: 'Veterinary', function: 'Operations', geography: 'US', seniority: 'Senior' });
  const createBody = await json(create);
  const projectId: string = createBody?.project?.id;
  check('create project 201', create.status === 201 && !!projectId, `status ${create.status}`);
  if (!projectId) throw new Error('no project');
  created.projectIds.push(projectId);
  check('new project is walkthrough', createBody?.project?.walkthrough === undefined || createBody?.project?.walkthrough === true);

  const open = await req(fresh, 'GET', `/api/projects/${projectId}`, undefined, { 'X-Em-Visit': '1' });
  const opened = await json(open);
  check('open project', open.status === 200);
  const v0 = opened?.project?.briefUpdatedAt ?? 0;
  const save1 = await req(fresh, 'PUT', `/api/projects/${projectId}`, { researchQuestion: 'How do multi-site vet groups price rollups?', briefVersion: v0 });
  const save1Body = await json(save1);
  check('save brief with the loaded version', save1.status === 200 && typeof save1Body?.project?.briefUpdatedAt === 'number', `status ${save1.status}`);
  const stale = await req(fresh, 'PUT', `/api/projects/${projectId}`, { researchQuestion: 'A stale edit', briefVersion: v0 });
  const staleBody = await json(stale);
  check('a stale save is refused with the latest brief', stale.status === 409 && staleBody?.error === 'brief_conflict' && staleBody?.project?.researchQuestion?.includes('rollups'), `status ${stale.status}`);
  const clear = await req(fresh, 'PUT', `/api/projects/${projectId}`, { expertType: 'Former VP ops', briefVersion: save1Body.project.briefUpdatedAt });
  const clearBody = await json(clear);
  const clear2 = await req(fresh, 'PUT', `/api/projects/${projectId}`, { expertType: '', briefVersion: clearBody?.project?.briefUpdatedAt });
  const clear2Body = await json(clear2);
  check('a field can be cleared with an empty string', clear2.status === 200 && !clear2Body?.project?.expertType, JSON.stringify(clear2Body?.project?.expertType));

  // Seed candidates the way sourcing would (service role), so no LLM spend.
  const expertRow = (id: string, name: string, company: string) => ({
    project_id: projectId, expert_id: id, status: 'discovered', contact_email: `${id}@experts.invalid`,
    data: { addedAt: Date.now(), updatedAt: Date.now(), expert: {
      id, name, title: 'Former COO', company, location: 'Austin, TX, US', category: 'Operator',
      justification: `Ran ${company} through a rollup.`, relevance_score: 88, source_url: 'https://example.com/p',
      source_label: 'Company Website', source_links: [{ url: 'https://linkedin.com/in/x', label: 'LinkedIn', type: 'LinkedIn' }],
      linkedin_url: 'https://linkedin.com/in/x', seniorityTier: 'executive',
    }, expertRate: 800, availabilityRaw: `Call me at 415-555-0100, ${name}`, calendarEmail: `${id}@gmail.com` },
  });
  const { error: seedErr } = await db.from('project_experts').insert([
    expertRow('exp-a', 'Scott Smithers', 'Bayview Veterinary Partners'),
    expertRow('exp-b', 'Dana Whitfield', 'Lakeside Animal Group'),
  ]);
  check('seeded two candidates', !seedErr, seedErr?.message);

  const view = await json(await req(fresh, 'GET', `/api/projects/${projectId}`));
  const a = view?.project?.experts?.find((e: { expert: { id: string } }) => e.expert.id === 'exp-a');
  check('candidate name is initialed', a?.expert?.name === 'Scott S.', a?.expert?.name);
  check('candidate company hidden', a?.expert?.company === '');
  check('linkedin / sources hidden', !a?.expert?.linkedin_url && (a?.expert?.source_links?.length ?? 0) === 0);
  check('contactEmail hidden', a?.contactEmail === undefined);
  check('expertRate hidden', a?.expertRate === undefined);
  check('availabilityRaw hidden', a?.availabilityRaw === undefined);
  check('calendarEmail hidden', a?.calendarEmail === undefined);

  // ── 5. Bookmark / pass / undo / persistence ───────────────────────────────
  const bm = await req(fresh, 'POST', `/api/projects/${projectId}/experts/exp-a/bookmark`, {});
  const bmBody = await json(bm);
  check('bookmark 200 held (walkthrough, trial)', bm.status === 200 && (bmBody?.outcome === 'walkthrough_held' || bmBody?.outcome === 'intro_drafted'), `status ${bm.status} ${bmBody?.outcome}`);
  const { data: pePost } = await db.from('project_experts').select('status, data').eq('project_id', projectId).eq('expert_id', 'exp-a').maybeSingle();
  check('no intro was sent (status not contacted)', pePost?.status !== 'contacted', pePost?.status);
  const pass = await req(fresh, 'PUT', `/api/projects/${projectId}/experts/exp-b`, { status: 'rejected', rejectionReason: 'wrong_industry' });
  check('pass 200', pass.status === 200, `status ${pass.status}`);
  const undo = await req(fresh, 'PUT', `/api/projects/${projectId}/experts/exp-b`, { status: 'discovered', rejectionReason: null, rejectionNotes: '' });
  check('undo 200', undo.status === 200, `status ${undo.status}`);
  const noteRes = await req(fresh, 'PUT', `/api/projects/${projectId}/experts/exp-b`, { note: 'Ask about staffing' });
  check('note 200', noteRes.status === 200);
  const again = new Jar();
  await req(again, 'POST', '/api/auth/login', { email: TESTER_EMAIL, password: PW1 });
  const later = await json(await req(again, 'GET', `/api/projects/${projectId}`));
  check('persists across a fresh session', later?.project?.researchQuestion?.includes('rollups') && later?.project?.experts?.length === 2);
  const list = await json(await req(again, 'GET', '/api/projects'));
  check('project appears in the list', Array.isArray(list?.projects) && list.projects.some((p: { id: string }) => p.id === projectId));

  // ── 6. The boundary ───────────────────────────────────────────────────────
  const live = await req(fresh, 'PUT', `/api/projects/${projectId}`, { walkthrough: false });
  const liveBody = await json(live);
  check('go live → 403 activation_required', live.status === 403 && liveBody?.error === 'activation_required' && liveBody?.kind === 'trial', `status ${live.status} ${JSON.stringify(liveBody)?.slice(0, 100)}`);
  const stillWalk = await json(await req(fresh, 'GET', `/api/projects/${projectId}`));
  check('project is still walkthrough', stillWalk?.project?.walkthrough !== false);
  const forceReveal = await req(fresh, 'PUT', `/api/projects/${projectId}/experts/exp-a`, { status: 'scheduled' });
  check('client cannot set status scheduled', forceReveal.status === 403, `status ${forceReveal.status}`);
  const forceComplete = await req(fresh, 'PUT', `/api/projects/${projectId}/experts/exp-a`, { status: 'completed' });
  check('client cannot set status completed', forceComplete.status === 403, `status ${forceComplete.status}`);
  await db.from('project_experts').update({ status: 'scheduled' }).eq('project_id', projectId).eq('expert_id', 'exp-b');
  const forced = await json(await req(fresh, 'GET', `/api/projects/${projectId}`));
  const b = forced?.project?.experts?.find((e: { expert: { id: string } }) => e.expert.id === 'exp-b');
  check('status scheduled WITHOUT a booking still anonymized', b?.expert?.name === 'Dana W.', b?.expert?.name);
  await db.from('project_experts').update({ status: 'discovered' }).eq('project_id', projectId).eq('expert_id', 'exp-b');
  const inject = await req(fresh, 'POST', `/api/projects/${projectId}/experts`, { experts: [{ status: 'completed', expert: { id: 'exp-c', name: 'Injected Person', title: 'CEO', company: 'Acme', location: 'US', category: 'Operator', justification: 'x', relevance_score: 50, source_url: 'https://example.com', source_label: 'Website', source_links: [] } }] });
  const injected = await json(inject);
  const c = injected?.project?.experts?.find((e: { expert: { id: string } }) => e.expert.id === 'exp-c');
  check('an added candidate cannot start as completed', inject.status === 200 && c?.status === 'discovered', `status ${inject.status} ${c?.status}`);
  const send = await req(fresh, 'POST', `/api/projects/${projectId}/experts/exp-a/messages`, { text: 'Tuesday works.' });
  const sendBody = await json(send);
  check('client message is stored HELD, never sent', (send.status === 201 && !!sendBody?.message?.held) || (send.status >= 400 && send.status < 500), `status ${send.status} held=${sendBody?.message?.held}`);
  const approve = await req(fresh, 'POST', `/api/projects/${projectId}/experts/exp-a/outreach/approve`, {});
  check('approve outreach refused in walkthrough/trial', approve.status === 409 || approve.status === 422 || approve.status === 404, `status ${approve.status}`);
  const complete = await req(fresh, 'POST', `/api/projects/${projectId}/experts/exp-a/complete`, { callDurationMin: 60, invoiceAmount: 1600 });
  const completeBody = await json(complete);
  check('complete (charge) → 403 activation_required', complete.status === 403 && completeBody?.error === 'activation_required', `status ${complete.status} ${completeBody?.error}`);
  const propose = await req(fresh, 'POST', `/api/projects/${projectId}/experts/exp-a/propose-times`, { reason: 'initial' });
  check('propose times never books or sends', propose.status === 422 || propose.status === 200 || propose.status === 409, `status ${propose.status}`);
  const { data: peAfter } = await db.from('project_experts').select('status, data').eq('project_id', projectId).eq('expert_id', 'exp-a').maybeSingle();
  const d = (peAfter?.data ?? {}) as { booking?: unknown; zoomMeetingId?: string; scheduling?: { pickTokenHash?: string } };
  check('no booking, no Zoom, no picker token exist', !d.booking && !d.zoomMeetingId && !d.scheduling?.pickTokenHash);

  // Direct PostgREST read with the tester's own JWT (needs the publishable key).
  const jwt = fresh.accessToken();
  if (jwt) {
    const direct = await fetch(`${SUPABASE_URL}/rest/v1/project_experts?project_id=eq.${projectId}&select=expert_id,contact_email,data`, {
      headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${jwt}` },
    });
    const rows = await json(direct);
    const n = Array.isArray(rows) ? rows.length : -1;
    check('direct PostgREST read of project_experts returns 0 rows (migration 20260908 applied)', n === 0, `status ${direct.status}, rows ${n}${n > 0 ? ' — APPLY supabase/migrations/20260908000000_identity_boundary_trial_events.sql' : ''}`);
    const directProj = await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${projectId}&select=id,brief`, { headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${jwt}` } });
    const prows = await json(directProj);
    check('direct PostgREST read of projects returns 0 rows', Array.isArray(prows) && prows.length === 0, `rows ${Array.isArray(prows) ? prows.length : '?'}`);
    const directWrite = await fetch(`${SUPABASE_URL}/rest/v1/projects?id=eq.${projectId}`, {
      method: 'PATCH', headers: { apikey: PUBLISHABLE, Authorization: `Bearer ${jwt}`, 'Content-Type': 'application/json', Prefer: 'return=representation' },
      body: JSON.stringify({ brief: { walkthrough: false } }),
    });
    const wrows = await json(directWrite);
    check('direct PostgREST write to projects changes nothing', !Array.isArray(wrows) || wrows.length === 0, `status ${directWrite.status}${Array.isArray(wrows) && wrows.length > 0 ? ' — the owner JWT flipped the project live through PostgREST; APPLY migration 20260908' : ''}`);
    // Put the project back so the rest of the run is not skewed by that write.
    const { data: fixRow } = await db.from('projects').select('brief').eq('id', projectId).single();
    await db.from('projects').update({ brief: { ...((fixRow?.brief as object) ?? {}), walkthrough: true } }).eq('id', projectId);
  } else {
    note('direct PostgREST checks skipped', 'no access token in cookies');
  }

  // ── 7. Collaborator is read-only ──────────────────────────────────────────
  await createPendingUser(COLLAB_EMAIL, org.id, 'Colla', 'Borator', 'org_member');
  await db.from('organization_members').update({ status: 'active' }).eq('organization_id', org.id);
  const collabLink = await mintSetPasswordLink(COLLAB_EMAIL, ORG_NAME, { kind: 'invite', orgId: org.id });
  if (!collabLink) throw new Error('collab link');
  await db.from('organization_members').update({ status: 'pending' }).eq('organization_id', org.id).eq('profile_id', (await db.from('profiles').select('id').eq('email', COLLAB_EMAIL).single()).data!.id);
  const collab = new Jar();
  const cSet = await req(collab, 'POST', `/api/auth/set-password?token=${encodeURIComponent(collabLink.token)}&th=${encodeURIComponent(collabLink.hashedToken)}`, { password: PW1, confirmPassword: PW1 });
  check('collaborator accepted invite', cSet.status === 200, `status ${cSet.status}`);
  await db.from('profiles').update({ onboarding_complete: true }).eq('email', COLLAB_EMAIL);
  const { data: collabProfile } = await db.from('profiles').select('id').eq('email', COLLAB_EMAIL).single();
  const { data: cAuth } = await db.auth.admin.getUserById(collabProfile!.id);
  await db.auth.admin.updateUserById(collabProfile!.id, { app_metadata: { ...(cAuth?.user?.app_metadata ?? {}), onboarding_complete: true, status: 'active' } });
  const share = await req(fresh, 'POST', `/api/projects/${projectId}/collaborators`, { email: COLLAB_EMAIL });
  check('owner shares the project', share.status === 200, `status ${share.status} ${JSON.stringify(await json(share))?.slice(0, 100)}`);
  const collab2 = new Jar();
  await req(collab2, 'POST', '/api/auth/login', { email: COLLAB_EMAIL, password: PW1 });
  const cRead = await req(collab2, 'GET', `/api/projects/${projectId}`);
  check('collaborator can read', cRead.status === 200, `status ${cRead.status}`);
  const cBrief = await req(collab2, 'PUT', `/api/projects/${projectId}`, { researchQuestion: 'collab edit' });
  check('collaborator cannot edit the brief', cBrief.status === 403, `status ${cBrief.status}`);
  const cAdd = await req(collab2, 'POST', `/api/projects/${projectId}/experts`, { experts: [] });
  check('collaborator cannot add candidates', cAdd.status === 403, `status ${cAdd.status}`);
  const cStatus = await req(collab2, 'PUT', `/api/projects/${projectId}/experts/exp-a`, { status: 'rejected' });
  check('collaborator cannot change status', cStatus.status === 403, `status ${cStatus.status}`);
  const cNote = await req(collab2, 'PUT', `/api/projects/${projectId}/experts/exp-a`, { note: 'collab note' });
  check('collaborator can add a note', cNote.status === 200, `status ${cNote.status}`);
  const cDel = await req(collab2, 'DELETE', `/api/projects/${projectId}`);
  check('collaborator cannot delete the project', cDel.status === 403, `status ${cDel.status}`);
  const cLive = await req(collab2, 'PUT', `/api/projects/${projectId}`, { walkthrough: false });
  check('collaborator cannot go live', cLive.status === 403, `status ${cLive.status}`);

  // ── 8. Forgot password ────────────────────────────────────────────────────
  const reset = await req(new Jar(), 'POST', '/api/auth/reset', { email: TESTER_EMAIL });
  check('reset request answers ok', reset.status === 200 && (await json(reset))?.ok === true);
  const resetUnknown = await req(new Jar(), 'POST', '/api/auth/reset', { email: `ghost-${RUN}@e2e-trial.invalid` });
  check('reset for an unknown address answers identically', resetUnknown.status === 200 && (await json(resetUnknown))?.ok === true);
  const resetLink = await mintSetPasswordLink(TESTER_EMAIL, ORG_NAME, { kind: 'reset', orgId: org.id });
  check('reset link minted', !!resetLink);
  const rq = `token=${encodeURIComponent(resetLink!.token)}&th=${encodeURIComponent(resetLink!.hashedToken)}`;
  const doReset = await req(new Jar(), 'POST', `/api/auth/set-password?${rq}`, { password: PW2, confirmPassword: PW2 });
  check('reset sets the new password', doReset.status === 200, `status ${doReset.status} ${JSON.stringify(await json(doReset))}`);
  const resetReplay = await req(new Jar(), 'POST', `/api/auth/set-password?${rq}`, { password: PW2, confirmPassword: PW2 });
  check('reset link cannot be reused', resetReplay.status === 409 || resetReplay.status === 410, `status ${resetReplay.status}`);
  const oldLogin = await req(new Jar(), 'POST', '/api/auth/login', { email: TESTER_EMAIL, password: PW1 });
  check('old password no longer works', oldLogin.status === 401, `status ${oldLogin.status}`);
  const newLogin = new Jar();
  const nl = await req(newLogin, 'POST', '/api/auth/login', { email: TESTER_EMAIL, password: PW2 });
  check('new password works', nl.status === 200, `status ${nl.status}`);
  const meAfter = await json(await req(newLogin, 'GET', '/api/auth/me'));
  check('reset touched nothing else (still onboarded, still trial)', meAfter?.onboardingComplete === true && meAfter?.account?.kind === 'trial');
  const logout = await req(newLogin, 'POST', '/api/auth/logout');
  check('logout', logout.status === 200 || logout.status === 204 || logout.status === 302, `status ${logout.status}`);
  const afterLogout = await req(newLogin, 'GET', '/api/auth/me');
  check('session gone after logout', afterLogout.status === 401, `status ${afterLogout.status}`);

  // ── 9. Usage record ───────────────────────────────────────────────────────
  const { data: events, error: evErr } = await db.from('product_events').select('type').eq('organization_id', org.id).order('created_at');
  if (evErr) note('product_events', `table not readable (${evErr.message.slice(0, 60)}) — apply migration 20260908`);
  else {
    const types = new Set((events ?? []).map(e => e.type));
    const { data: actorEvents } = await db.from('product_events').select('type').eq('actor_id', testerId);
    for (const t of (actorEvents ?? [])) types.add(t.type);
    note('product_events recorded', Array.from(types).sort().join(', ') || '(none)');
    check('funnel events present', ['account_activated', 'signed_in', 'onboarding_completed', 'project_created', 'brief_saved', 'candidate_bookmarked', 'candidate_passed', 'restricted_action_attempted'].every(t => types.has(t)),
      Array.from(types).join(','));
  }

  if (KEEP) {
    fs.writeFileSync(path.join(ROOT, 'scripts/.e2e-trial-keep.json'), JSON.stringify({ email: TESTER_EMAIL, password: PW2, projectId, orgId: org.id, collab: COLLAB_EMAIL }, null, 2));
    console.log('KEEP=1 — credentials written to scripts/.e2e-trial-keep.json');
  }
}

main()
  .then(cleanup, async (err) => { console.error('e2e-trial crashed:', err instanceof Error ? err.message : err); failures++; await cleanup(); })
  .then(() => {
    console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
    process.exit(failures === 0 ? 0 : 1);
  });

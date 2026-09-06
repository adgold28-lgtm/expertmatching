// scripts/e2e-matchy.ts — Matchy Phase 1 end-to-end against a running app
// (local or production) using THROWAWAY users only. Sends no email: the test
// expert has no contact address, so bookmark ends in `contact_not_found` and
// the thread never starts.
//
//   SMOKE_BASE_URL=https://expertmatch.fit npx tsx scripts/e2e-matchy.ts
//
// Provisions (and deletes afterwards) via the service role: an owner and a
// collaborator in one throwaway org, an intruder in another org, one project,
// one expert. Never touches the founder's account.

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
const FIRM_DOMAIN  = `matchy-e2e-${RUN}.example`;
const OTHER_DOMAIN = `matchy-e2e-other-${RUN}.example`;
const OWNER_EMAIL  = `owner@${FIRM_DOMAIN}`;
const COLLAB_EMAIL = `collab@${FIRM_DOMAIN}`;
const INTRUDER_EMAIL = `intruder@${OTHER_DOMAIN}`;
const PW = 'E2e-pw-' + Math.random().toString(36).slice(2) + 'A1';

async function provisionUser(email: string, domain: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email, password: PW, email_confirm: true,
    app_metadata: { role: 'user', status: 'active', firm_domain: domain, onboarding_complete: true },
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

async function main(): Promise<void> {
  console.log(`e2e-matchy: target ${BASE}`);
  const cleanup: Array<() => Promise<void>> = [];
  let projectId: string | undefined;
  try {
    // ── provision ──────────────────────────────────────────────────────────
    const ownerId    = await provisionUser(OWNER_EMAIL, FIRM_DOMAIN);
    const collabId   = await provisionUser(COLLAB_EMAIL, FIRM_DOMAIN);
    const intruderId = await provisionUser(INTRUDER_EMAIL, OTHER_DOMAIN);
    cleanup.push(async () => { for (const id of [ownerId, collabId, intruderId]) await db.auth.admin.deleteUser(id).catch(() => {}); });
    const orgId   = await provisionOrg(FIRM_DOMAIN, 'Matchy E2E Firm');
    const otherId = await provisionOrg(OTHER_DOMAIN, 'Matchy E2E Other');
    cleanup.push(async () => { await db.from('organizations').delete().in('id', [orgId, otherId]); });
    await db.from('organizations').update({ firm_type: 'pe_firm', firm_size: 'mid_size' }).eq('id', orgId);
    await addMember(orgId, ownerId); await addMember(orgId, collabId); await addMember(otherId, intruderId);
    check('throwaway users + orgs provisioned', true);

    const owner = new Jar(), collab = new Jar(), intruder = new Jar();
    check('owner login', (await req(owner, 'POST', '/api/auth/login', { email: OWNER_EMAIL, password: PW })).status === 200);
    check('collaborator login', (await req(collab, 'POST', '/api/auth/login', { email: COLLAB_EMAIL, password: PW })).status === 200);
    check('intruder login', (await req(intruder, 'POST', '/api/auth/login', { email: INTRUDER_EMAIL, password: PW })).status === 200);

    // ── project ────────────────────────────────────────────────────────────
    const create = await req(owner, 'POST', '/api/projects', { name: 'Matchy E2E', industry: 'Industrial coatings', function: 'Operations', geography: 'US', seniority: 'Senior' });
    const created = await json(create);
    projectId = created?.project?.id ?? created?.id;
    check('create project', !!projectId, `status ${create.status}`);
    if (!projectId) throw new Error('no project');
    cleanup.push(async () => {
      await db.from('engagement_events').delete().eq('project_id', projectId!);
      await db.from('projects').delete().eq('id', projectId!);
    });

    // review-first + rate band via PATCH
    const badBand = await req(owner, 'PATCH', `/api/projects/${projectId}`, { clientRateMin: 1600, clientRateMax: 800 });
    check('PATCH rejects inverted band', badBand.status === 400 || badBand.status === 422, `status ${badBand.status} ${(await json(badBand))?.error ?? ''}`);
    const badStep = await req(owner, 'PATCH', `/api/projects/${projectId}`, { clientRateMin: 830 });
    check('PATCH rejects non-$50 step', badStep.status === 400 || badStep.status === 422, `status ${badStep.status}`);
    const okPatch = await req(owner, 'PATCH', `/api/projects/${projectId}`, { reviewFirst: true, clientRateMin: 800, clientRateMax: 1600 });
    const patched = await json(okPatch);
    const pj = patched?.project ?? patched;
    check('PATCH reviewFirst + band', okPatch.status === 200 && pj?.reviewFirst === true && pj?.clientRateMin === 800 && pj?.clientRateMax === 1600, `status ${okPatch.status} ${JSON.stringify({ r: pj?.reviewFirst, min: pj?.clientRateMin, max: pj?.clientRateMax })}`);
    const collabPatch = await req(collab, 'PATCH', `/api/projects/${projectId}`, { reviewFirst: false });
    check('collaborator cannot PATCH before being added (404)', collabPatch.status === 404, `status ${collabPatch.status}`);

    // ── expert (service role; no contact email → no email is ever sent) ───
    const { addExpertsToProject } = await import('../lib/projectStore');
    const expertId = `e2e-${RUN}`;
    await addExpertsToProject(projectId, [{
      status: 'shortlisted',
      expert: {
        id: expertId, name: 'Casey Testperson', title: 'Chief Operating Officer', company: 'Example Coatings Inc',
        location: 'Ohio, US', category: 'Operator', justification: 'Ran operations at a coatings manufacturer.',
        relevance_score: 88, source_url: 'https://example.com', source_label: 'example', source_links: [],
        anonymizedDescriptor: 'COO at a mid-size industrial coatings manufacturer',
      } as any,
    }]);
    check('expert added (shortlisted, no address)', true);

    // ── bookmark ───────────────────────────────────────────────────────────
    const bm = await req(owner, 'POST', `/api/projects/${projectId}/experts/${expertId}/bookmark`, {});
    const bmBody = await json(bm);
    const pe = bmBody?.projectExpert;
    check('bookmark 200', bm.status === 200, `status ${bm.status} ${JSON.stringify(bmBody)?.slice(0, 160)}`);
    check('bookmark outcome contact_not_found', bmBody?.outcome === 'contact_not_found', `outcome ${bmBody?.outcome}`);
    check('status is bookmarked', pe?.status === 'bookmarked', `status ${pe?.status}`);
    check('clientRate seeded (COO → executive → $1,600)', pe?.clientRate === 1600, `clientRate ${pe?.clientRate}`);
    check('expertRate hidden from client', pe?.expertRate === undefined, `expertRate ${pe?.expertRate}`);
    check('contactEmail hidden from client', pe?.contactEmail === undefined);
    const bm2 = await req(owner, 'POST', `/api/projects/${projectId}/experts/${expertId}/bookmark`, {});
    check('second bookmark 409', bm2.status === 409, `status ${bm2.status}`);
    const collabBm = await req(collab, 'POST', `/api/projects/${projectId}/experts/${expertId}/bookmark`, {});
    check('non-member bookmark 404', collabBm.status === 404, `status ${collabBm.status}`);

    // events (service role) — bookmarked + contact_not_found, no PII in payload
    const { data: events } = await db.from('engagement_events').select('type, payload').eq('project_id', projectId);
    const types = (events ?? []).map((e: any) => e.type);
    check('events: bookmarked + contact_not_found', types.includes('bookmarked') && types.includes('contact_not_found'), types.join(','));
    const payloadStr = JSON.stringify((events ?? []).map((e: any) => e.payload));
    check('event payloads carry no name/email', !/Casey|Testperson|@/.test(payloadStr), payloadStr.slice(0, 120));

    // ── thread ─────────────────────────────────────────────────────────────
    const th = await req(owner, 'GET', `/api/projects/${projectId}/experts/${expertId}/messages`);
    const thBody = await json(th);
    check('GET messages 200 (owner)', th.status === 200 && Array.isArray(thBody?.messages), `status ${th.status}`);
    check('thread empty before any send', (thBody?.messages ?? []).length === 0);
    check('GET messages projectExpert redacted', thBody?.projectExpert && thBody.projectExpert.expertRate === undefined && thBody.projectExpert.contactEmail === undefined);
    const thIntruder = await req(intruder, 'GET', `/api/projects/${projectId}/experts/${expertId}/messages`);
    check('GET messages non-member 404', thIntruder.status === 404, `status ${thIntruder.status}`);

    const blocked = await req(owner, 'POST', `/api/projects/${projectId}/experts/${expertId}/messages`, { text: 'Great — call me directly at 415-555-0132 or casey@example.com' });
    const blockedBody = await json(blocked);
    check('POST with phone/email → 422', blocked.status === 422, `status ${blocked.status} ${blockedBody?.error ?? ''}`);
    check('422 is message_blocked with findings OR thread_not_started', blockedBody?.error === 'thread_not_started' || (blockedBody?.error === 'message_blocked' && Array.isArray(blockedBody?.findings) && blockedBody.findings.length >= 1), JSON.stringify(blockedBody)?.slice(0, 160));
    const { count: msgCount } = await db.from('conversation_messages').select('*', { count: 'exact', head: true }).eq('project_id', projectId);
    check('blocked send stored nothing', (msgCount ?? 0) === 0, `rows ${msgCount}`);

    // collaborator: read-only
    const addCollab = await req(owner, 'POST', `/api/projects/${projectId}/collaborators`, { email: COLLAB_EMAIL });
    check('owner adds collaborator', addCollab.status === 200 || addCollab.status === 201, `status ${addCollab.status} ${JSON.stringify(await json(addCollab))?.slice(0, 120)}`);
    const thCollab = await req(collab, 'GET', `/api/projects/${projectId}/experts/${expertId}/messages`);
    check('collaborator GET messages 200', thCollab.status === 200, `status ${thCollab.status}`);
    const collabSend = await req(collab, 'POST', `/api/projects/${projectId}/experts/${expertId}/messages`, { text: 'Tuesday 2pm works.' });
    const collabSendBody = await json(collabSend);
    check('collaborator POST → 403 read_only', collabSend.status === 403 && collabSendBody?.error === 'read_only', `status ${collabSend.status} ${collabSendBody?.error ?? ''}`);
    const collabBm2 = await req(collab, 'POST', `/api/projects/${projectId}/experts/${expertId}/unbookmark`, {});
    check('collaborator unbookmark → 403', collabBm2.status === 403, `status ${collabBm2.status}`);

    // RLS direct: owner JWT can read conversation_messages (0 rows) but never engagement_events
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const { data: sess } = await anon.auth.signInWithPassword({ email: OWNER_EMAIL, password: PW });
    if (sess?.session) {
      const asOwner = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${sess.session.access_token}` } } });
      const ev = await asOwner.from('engagement_events').select('id').eq('project_id', projectId);
      check('RLS: engagement_events unreadable by a browser session', (ev.data ?? []).length === 0, `${(ev.data ?? []).length} rows`);
      const cm = await asOwner.from('conversation_messages').select('id').eq('project_id', projectId);
      check('RLS: conversation_messages select allowed for member', !cm.error, cm.error?.message ?? '');
      const ins = await asOwner.from('conversation_messages').insert({ project_id: projectId, expert_id: expertId, direction: 'outbound', author: 'client', body_clean: 'x' });
      check('RLS: conversation_messages insert denied for browser session', !!ins.error, ins.error ? 'denied' : 'INSERTED');
      await db.from('conversation_messages').delete().eq('project_id', projectId);
    } else {
      check('owner anon sign-in for RLS checks', false);
    }

    // ── unbookmark ─────────────────────────────────────────────────────────
    const ub = await req(owner, 'POST', `/api/projects/${projectId}/experts/${expertId}/unbookmark`, {});
    const ubBody = await json(ub);
    check('unbookmark 200 → shortlisted', ub.status === 200 && (ubBody?.projectExpert?.status ?? ubBody?.status) === 'shortlisted', `status ${ub.status} ${(ubBody?.projectExpert?.status ?? ubBody?.status)}`);

    for (const j of [owner, collab, intruder]) await req(j, 'POST', '/api/auth/logout');
  } catch (e) {
    check('e2e crashed', false, e instanceof Error ? e.message : String(e));
  } finally {
    for (const fn of cleanup.reverse()) await fn().catch(err => console.error('cleanup error', err instanceof Error ? err.message : err));
    console.log('cleanup: throwaway project, users and orgs deleted');
  }
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main();

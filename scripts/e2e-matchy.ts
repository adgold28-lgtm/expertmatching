// scripts/e2e-matchy.ts — Matchy Phase 1 end-to-end against a running app
// (local or production) using THROWAWAY users only. Sends no email: the test
// expert has no contact address, so bookmark enqueues contact discovery
// (`contact_discovery_started`; `contact_not_found` when QStash is absent) and
// the thread never starts.
//
//   SMOKE_BASE_URL=https://expertmatch.fit npx tsx scripts/e2e-matchy.ts
//
// Provisions (and deletes afterwards) via the service role: an owner and a
// collaborator in one throwaway org, an intruder in another org, TWO projects
// (one live, one walkthrough), one expert each. Never touches the founder's
// account.
//
// TWO PROJECTS, ON PURPOSE. Every project now starts in WALKTHROUGH mode
// (lib/walkthrough.ts) unless it explicitly asks to be live, so the main run
// creates its project with `walkthrough: false` and every existing assertion
// holds unchanged. The second project takes the default and asserts the whole
// held path: no contact discovery, a rate decision that records the money but
// sends nothing, a client reply stored as held, and 409 on both send routes.

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
    // walkthrough:false makes this the LIVE project — the one every assertion
    // below was written for. Nothing is still ever sent: the expert has no
    // address on file.
    const create = await req(owner, 'POST', '/api/projects', { name: 'Matchy E2E', industry: 'Industrial coatings', function: 'Operations', geography: 'US', seniority: 'Senior', walkthrough: false });
    const created = await json(create);
    projectId = created?.project?.id ?? created?.id;
    check('create project', !!projectId, `status ${create.status}`);
    if (!projectId) throw new Error('no project');
    check('created project is live (walkthrough:false was honored)',
      created?.project?.walkthrough === false, `walkthrough ${created?.project?.walkthrough}`);
    const badMode = await req(owner, 'POST', '/api/projects', { name: 'Matchy E2E bad mode', walkthrough: 'nope' });
    check('POST /api/projects rejects a non-boolean walkthrough',
      badMode.status === 400 && (await json(badMode))?.error === 'invalid_walkthrough', `status ${badMode.status}`);
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
    const NO_ADDRESS = new Set(['contact_discovery_started', 'contact_not_found']);
    check('bookmark outcome: discovery started or no address', NO_ADDRESS.has(bmBody?.outcome), `outcome ${bmBody?.outcome}`);
    check('status is bookmarked', pe?.status === 'bookmarked', `status ${pe?.status}`);
    check('clientRate seeded (COO → executive → $1,600)', pe?.clientRate === 1600, `clientRate ${pe?.clientRate}`);
    check('expertRate hidden from client', pe?.expertRate === undefined, `expertRate ${pe?.expertRate}`);
    check('contactEmail hidden from client', pe?.contactEmail === undefined);
    // Bookmarking again is the retry when the first attempt found no address,
    // so it succeeds and reports the same outcome rather than 409ing. Anything
    // past 'bookmarked' is the case that still 409s.
    const bm2 = await req(owner, 'POST', `/api/projects/${projectId}/experts/${expertId}/bookmark`, {});
    const bm2Body = await json(bm2);
    check('second bookmark retries the address lookup',
      bm2.status === 200 && NO_ADDRESS.has(bm2Body?.outcome),
      `status ${bm2.status} outcome ${bm2Body?.outcome}`);
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

    // ── collaborator: every owner-only action ──────────────────────────────
    // A shared project is read-only (docs/MATCHY_SPEC.md, founder answer 5).
    // The collaborator is a member by now, so these are 403 and not 404 — the
    // owner check runs after the access check, never before it.
    const collabComplete = await req(collab, 'POST', `/api/projects/${projectId}/experts/${expertId}/complete`, { callDurationMin: 45, invoiceAmount: 1200 });
    check('collaborator POST complete → 403', collabComplete.status === 403, `status ${collabComplete.status}`);

    const collabDelete = await req(collab, 'DELETE', `/api/projects/${projectId}/experts/${expertId}`);
    check('collaborator DELETE expert → 403', collabDelete.status === 403, `status ${collabDelete.status}`);

    const collabStatus = await req(collab, 'PUT', `/api/projects/${projectId}/experts/${expertId}`, { status: 'rejected' });
    check('collaborator PUT status → 403', collabStatus.status === 403, `status ${collabStatus.status}`);

    const collabNote = await req(collab, 'PUT', `/api/projects/${projectId}/experts/${expertId}`, { note: 'Reader note.' });
    check('collaborator PUT note → 200', collabNote.status === 200, `status ${collabNote.status}`);

    const collabSource = await req(collab, 'POST', `/api/projects/${projectId}/source-experts`, {});
    check('collaborator POST source-experts → 403', collabSource.status === 403, `status ${collabSource.status}`);

    // ── rate decision: the client-side number never leaves the platform ────
    // Seed a counter the way inbound-email would — through the store, so this
    // never has to know how project_experts packs its columns.
    const { updateExpertStatus } = await import('../lib/projectStore');
    const seeded = await updateExpertStatus(projectId, expertId, {
      status:            'rate_negotiation',
      expertCounterRate: 650,
      clientCounterRate: 1300,
    });
    check('counter seeded on the engagement',
      seeded.experts.find(e => e.expert.id === expertId)?.expertCounterRate === 650);

    const collabRate = await req(collab, 'POST', `/api/projects/${projectId}/experts/${expertId}/rate-decision`, { action: 'accept' });
    check('collaborator POST rate-decision → 403', collabRate.status === 403, `status ${collabRate.status}`);

    const accept = await req(owner, 'POST', `/api/projects/${projectId}/experts/${expertId}/rate-decision`, { action: 'accept' });
    const acceptBody = await json(accept);
    check('owner POST rate-decision accept → 200', accept.status === 200, `status ${accept.status} ${JSON.stringify(acceptBody)?.slice(0, 160)}`);
    check('rate-decision response carries no expertRate',
      acceptBody?.projectExpert && acceptBody.projectExpert.expertRate === undefined,
      `expertRate ${acceptBody?.projectExpert?.expertRate}`);
    check('rate-decision response carries no expertCounterRate',
      acceptBody?.projectExpert?.expertCounterRate === undefined);
    check('accepted counter became the client rate ($650 → $1,300)',
      acceptBody?.projectExpert?.clientRate === 1300, `clientRate ${acceptBody?.projectExpert?.clientRate}`);

    // The stored outbound line carries the EXPERT number and nothing else. Read
    // it service-role: the thread API masks every amount out of a Matchy
    // message on the way to a client's screen (lib/conversations), so the
    // client-facing read below asserts the absence, not the presence.
    const { data: outbound } = await db.from('conversation_messages')
      .select('author, direction, body_clean')
      .eq('project_id', projectId).eq('expert_id', expertId)
      .order('created_at', { ascending: false }).limit(1).maybeSingle();
    const row = outbound as { author?: string; direction?: string; body_clean?: string | null } | null;
    const outboundBody = row?.body_clean ?? '';
    check('rate-decision wrote an outbound Matchy message',
      row?.author === 'matchy' && row?.direction === 'outbound',
      `author ${row?.author}`);
    check('outbound line quotes the EXPERT number ($650)', outboundBody.includes('$650'), outboundBody.slice(0, 120));
    check('outbound line never quotes the CLIENT number ($1,300)',
      !outboundBody.includes('$1,300') && !outboundBody.includes('$1300'), outboundBody.slice(0, 120));

    const afterThread = await req(owner, 'GET', `/api/projects/${projectId}/experts/${expertId}/messages`);
    const afterBody = await json(afterThread);
    const newest = (afterBody?.messages ?? []).slice(-1)[0];
    check('owner reads the new outbound message', newest?.author === 'matchy', `author ${newest?.author}`);
    check('the client is shown no dollar amount at all',
      typeof newest?.body === 'string' && !/\$\s?\d/.test(newest.body), String(newest?.body).slice(0, 120));

    // The composer backstop: a client typing a rate is blocked, not relayed.
    //
    // The messages route answers `thread_not_started` before it screens
    // anything, so this needs an address on the record to reach the screen at
    // all. STILL NO EMAIL IS POSSIBLE: the screen runs before the send and this
    // message is blocked, and the address is on a reserved `.example` domain
    // that cannot resolve even if it were attempted. Both fields are cleared
    // again immediately below.
    await updateExpertStatus(projectId, expertId, {
      contactEmail:  `expert@${FIRM_DOMAIN}`,
      outreachToken: `e2e-${RUN}-token`,
    });

    const typedRate = await req(owner, 'POST', `/api/projects/${projectId}/experts/${expertId}/messages`, { text: 'can you do $1,300/hr' });
    const typedRateBody = await json(typedRate);
    check('owner POST messages with a typed rate → 422 message_blocked',
      typedRate.status === 422 && typedRateBody?.error === 'message_blocked',
      `status ${typedRate.status} ${typedRateBody?.error ?? ''}`);
    check('the blocked finding is the money rule',
      Array.isArray(typedRateBody?.findings)
        && (typedRateBody.findings as Array<{ kind?: string }>).some(f => f.kind === 'money'),
      JSON.stringify(typedRateBody?.findings)?.slice(0, 160));

    // Put the engagement back where the rest of the script expects it, and take
    // the address off again so nothing downstream can write to anybody.
    await updateExpertStatus(projectId, expertId, {
      status:        'bookmarked',
      contactEmail:  '',
      outreachToken: '',
    });
    await db.from('conversation_messages').delete().eq('project_id', projectId);

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

    // ── walkthrough mode: a second project that may not send anything ──────
    await runWalkthroughChecks(owner, cleanup);

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


/**
 * Everything walkthrough mode has to guarantee, on its own throwaway project.
 *
 * The project is created with NO walkthrough flag, so it proves the default as
 * well as the behaviour. Its expert has no address, exactly like the main run's,
 * so even a bug in the gate could not reach a real inbox.
 */
async function runWalkthroughChecks(owner: Jar, cleanup: Array<() => Promise<void>>): Promise<void> {
  const create  = await req(owner, 'POST', '/api/projects', { name: 'Matchy E2E walkthrough', industry: 'Industrial coatings', function: 'Operations', geography: 'US', seniority: 'Senior' });
  const created = await json(create);
  const wId: string | undefined = created?.project?.id ?? created?.id;
  check('walkthrough: create project without the flag', !!wId, `status ${create.status}`);
  if (!wId) return;
  cleanup.push(async () => {
    await db.from('conversation_messages').delete().eq('project_id', wId);
    await db.from('engagement_events').delete().eq('project_id', wId);
    await db.from('projects').delete().eq('id', wId);
  });

  // The default IS walkthrough: undefined or true, never false.
  const got  = await json(await req(owner, 'GET', `/api/projects/${wId}`));
  const flag = got?.project?.walkthrough;
  check('walkthrough: GET shows the project is not live',
    flag === undefined || flag === true, `walkthrough ${JSON.stringify(flag)}`);

  const { addExpertsToProject, updateExpertStatus } = await import('../lib/projectStore');
  const wExpertId = `e2e-walk-${RUN}`;
  await addExpertsToProject(wId, [{
    status: 'shortlisted',
    expert: {
      id: wExpertId, name: 'Robin Walkthrough', title: 'Chief Operating Officer', company: 'Example Coatings Inc',
      location: 'Ohio, US', category: 'Operator', justification: 'Ran operations at a coatings manufacturer.',
      relevance_score: 88, source_url: 'https://example.com', source_label: 'example', source_links: [],
      anonymizedDescriptor: 'COO at a mid-size industrial coatings manufacturer',
    } as any,
  }]);

  // Bookmark with no address: NO discovery is started, and nothing is sent.
  const bm     = await req(owner, 'POST', `/api/projects/${wId}/experts/${wExpertId}/bookmark`, {});
  const bmBody = await json(bm);
  check('walkthrough: bookmark 200', bm.status === 200, `status ${bm.status}`);
  check('walkthrough: bookmark outcome is walkthrough_held',
    bmBody?.outcome === 'walkthrough_held', `outcome ${bmBody?.outcome}`);
  check('walkthrough: status stays bookmarked',
    bmBody?.projectExpert?.status === 'bookmarked', `status ${bmBody?.projectExpert?.status}`);
  check('walkthrough: the client-safe outcome is on the record',
    bmBody?.projectExpert?.matchyOutcome === 'walkthrough_held', `matchyOutcome ${bmBody?.projectExpert?.matchyOutcome}`);

  const { data: wEvents } = await db.from('engagement_events').select('type, payload').eq('project_id', wId);
  const wPayloads = JSON.stringify((wEvents ?? []).map((e: any) => e.payload));
  check('walkthrough: the held bookmark is recorded as an event',
    (wEvents ?? []).some((e: any) => e.type === 'contact_not_found' && e.payload?.walkthrough === true), wPayloads.slice(0, 160));
  check('walkthrough: event payloads carry no name/email', !/Robin|Walkthrough person|@/.test(wPayloads), wPayloads.slice(0, 120));

  // Give the engagement a thread and a counter, the way inbound-email would.
  // The address is on a reserved .example domain that cannot resolve, and the
  // gate is what is under test — nothing here can reach a real inbox.
  await updateExpertStatus(wId, wExpertId, {
    status:            'rate_negotiation',
    contactEmail:      `expert@${FIRM_DOMAIN}`,
    outreachToken:     `e2e-walk-${RUN}-token`,
    expertCounterRate: 650,
    clientCounterRate: 1300,
  });

  const accept     = await req(owner, 'POST', `/api/projects/${wId}/experts/${wExpertId}/rate-decision`, { action: 'accept' });
  const acceptBody = await json(accept);
  check('walkthrough: rate-decision 200 with held:true',
    accept.status === 200 && acceptBody?.held === true, `status ${accept.status} held ${acceptBody?.held}`);
  check('walkthrough: the money still moved ($650 → $1,300)',
    acceptBody?.projectExpert?.clientRate === 1300, `clientRate ${acceptBody?.projectExpert?.clientRate}`);

  const thread    = await json(await req(owner, 'GET', `/api/projects/${wId}/experts/${wExpertId}/messages`));
  const lastMatchy = (thread?.messages ?? []).filter((m: any) => m.author === 'matchy').slice(-1)[0];
  check("walkthrough: the Matchy line is stored held === 'walkthrough'",
    lastMatchy?.held === 'walkthrough', `held ${JSON.stringify(lastMatchy?.held)}`);
  check('walkthrough: a held message is not pending approval',
    lastMatchy?.pendingApproval === false, `pendingApproval ${lastMatchy?.pendingApproval}`);

  // A client reply is screened, stored held, and not sent.
  const reply     = await req(owner, 'POST', `/api/projects/${wId}/experts/${wExpertId}/messages`, { text: 'Tuesday afternoon suits me.' });
  const replyBody = await json(reply);
  check('walkthrough: POST messages → 201',
    reply.status === 201, `status ${reply.status} ${JSON.stringify(replyBody)?.slice(0, 160)}`);
  check("walkthrough: the stored reply carries held === 'walkthrough'",
    replyBody?.message?.held === 'walkthrough', `held ${JSON.stringify(replyBody?.message?.held)}`);

  // The screen still runs — practising the compliance rules is the point.
  const blocked = await req(owner, 'POST', `/api/projects/${wId}/experts/${wExpertId}/messages`, { text: 'call me on 415-555-0132' });
  check('walkthrough: the compliance screen still blocks (422)',
    blocked.status === 422 && (await json(blocked))?.error === 'message_blocked', `status ${blocked.status}`);

  // Both send routes refuse outright, before any side effect.
  const messageId = replyBody?.message?.id ?? '11111111-2222-3333-4444-555555555555';
  const sendRes  = await req(owner, 'POST', `/api/projects/${wId}/experts/${wExpertId}/messages/${messageId}/send`, {});
  const sendBody = await json(sendRes);
  check('walkthrough: messages/:id/send → 409 walkthrough_mode',
    sendRes.status === 409 && sendBody?.error === 'walkthrough_mode', `status ${sendRes.status} ${sendBody?.error ?? ''}`);

  const approve     = await req(owner, 'POST', `/api/projects/${wId}/experts/${wExpertId}/outreach/approve`, {});
  const approveBody = await json(approve);
  check('walkthrough: outreach/approve → 409 walkthrough_mode',
    approve.status === 409 && approveBody?.error === 'walkthrough_mode', `status ${approve.status} ${approveBody?.error ?? ''}`);

  // Going live lands on review-first unless the owner says otherwise.
  const live     = await req(owner, 'PATCH', `/api/projects/${wId}`, { walkthrough: false });
  const liveBody = await json(live);
  const lp       = liveBody?.project ?? liveBody;
  check('walkthrough: PATCH { walkthrough:false } → 200 and the project is live',
    live.status === 200 && lp?.walkthrough === false, `status ${live.status} walkthrough ${JSON.stringify(lp?.walkthrough)}`);
  check('walkthrough: going live also turns review-first ON',
    lp?.reviewFirst === true, `reviewFirst ${lp?.reviewFirst}`);

  const badMode = await req(owner, 'PATCH', `/api/projects/${wId}`, { walkthrough: 'yes' });
  check('walkthrough: PATCH rejects a non-boolean',
    badMode.status === 400 && (await json(badMode))?.error === 'invalid_walkthrough', `status ${badMode.status}`);

  // An owner who names both gets both.
  const liveAuto = await req(owner, 'PATCH', `/api/projects/${wId}`, { walkthrough: false, reviewFirst: false });
  const lap      = (await json(liveAuto))?.project;
  check('walkthrough: an explicit reviewFirst in the same patch wins',
    liveAuto.status === 200 && lap?.reviewFirst === false, `reviewFirst ${lap?.reviewFirst}`);

  // Take the address back off, so nothing downstream could ever write to it.
  await updateExpertStatus(wId, wExpertId, { contactEmail: '', outreachToken: '' });
}

main();

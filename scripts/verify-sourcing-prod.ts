// Throwaway-user check that POST /api/projects/[id]/source-experts
// enqueues on QStash in production and the worker reaches a terminal status.
//   SMOKE_BASE_URL=https://expertmatch.fit npx tsx scripts/verify-sourcing-prod.ts
import * as dotenv from 'dotenv';
import * as path from 'path';
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env.local') });
import { createClient } from '@supabase/supabase-js';

const BASE   = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? BASE;
const WAIT_MS = Number(process.env.WAIT_MS ?? 9 * 60 * 1000);

class Jar {
  cookies = new Map<string, string>();
  absorb(res: Response): void {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = sc.split(';');
      const eq = pair.indexOf('='); const name = pair.slice(0, eq).trim(); const value = pair.slice(eq + 1).trim();
      if (attrs.some(a => /max-age=0/i.test(a.trim())) || value === '') this.cookies.delete(name); else this.cookies.set(name, value);
    }
  }
  header(): string { return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; '); }
}
async function req(jar: Jar, method: string, p: string, body?: unknown): Promise<Response> {
  const res = await fetch(BASE + p, { method, redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'Origin': ORIGIN, ...(jar.cookies.size ? { Cookie: jar.header() } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  jar.absorb(res); return res;
}
async function json(res: Response): Promise<any> { try { return await res.json(); } catch { return null; } }

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const RUN = Math.random().toString(36).slice(2, 8);
const DOMAIN = `sourcing-verify-${RUN}.example`;
const EMAIL = `owner@${DOMAIN}`;
const PW = 'Vfy-pw-' + Math.random().toString(36).slice(2) + 'A1';

async function main(): Promise<void> {
  console.log(`verify-sourcing: target ${BASE}`);
  const cleanup: Array<() => Promise<void>> = [];
  let ok = true;
  try {
    const { data: u, error: ue } = await db.auth.admin.createUser({ email: EMAIL, password: PW, email_confirm: true,
      app_metadata: { role: 'user', status: 'active', firm_domain: DOMAIN, onboarding_complete: true } });
    if (ue || !u.user) throw new Error('createUser: ' + ue?.message);
    const userId = u.user.id;
    cleanup.push(async () => { await db.auth.admin.deleteUser(userId).catch(() => {}); });
    const { data: org, error: oe } = await db.from('organizations').insert({ domain: DOMAIN, name: 'Sourcing Verify Firm', firm_type: 'pe_firm', firm_size: 'mid_size' }).select('id').single();
    if (oe || !org) throw new Error('org: ' + oe?.message);
    cleanup.push(async () => { await db.from('organizations').delete().eq('id', org.id); });
    const { error: me } = await db.from('organization_members').upsert({ organization_id: org.id, profile_id: userId, status: 'active' }, { onConflict: 'organization_id,profile_id' });
    if (me) throw new Error('member: ' + me.message);

    const jar = new Jar();
    const login = await req(jar, 'POST', '/api/auth/login', { email: EMAIL, password: PW });
    console.log('login', login.status);
    if (login.status !== 200) throw new Error('login failed');

    const create = await req(jar, 'POST', '/api/projects', { name: 'Sourcing verify', industry: 'Industrial coatings', function: 'Operations', geography: 'US', seniority: 'Senior' });
    const created = await json(create);
    const projectId: string | undefined = created?.project?.id ?? created?.id;
    console.log('create project', create.status, projectId);
    if (!projectId) throw new Error('no project');
    cleanup.push(async () => {
      await db.from('engagement_events').delete().eq('project_id', projectId);
      await db.from('project_experts').delete().eq('project_id', projectId);
      await db.from('projects').delete().eq('id', projectId);
    });

    const start = await req(jar, 'POST', `/api/projects/${projectId}/source-experts`, {
      businessProblem: 'We are evaluating a mid-size US industrial coatings manufacturer and need operators who have run plants in this segment.',
      expertType: 'Former plant or operations leaders at industrial coatings manufacturers',
    });
    const sb = await json(start);
    console.log('POST source-experts ->', start.status, JSON.stringify(sb));
    if (start.status !== 200) { ok = false; throw new Error('enqueue failed'); }

    const t0 = Date.now(); let last = '';
    while (Date.now() - t0 < WAIT_MS) {
      await new Promise(r => setTimeout(r, 15000));
      let p: any = null;
      try { p = await json(await req(jar, 'GET', `/api/projects/${projectId}`)); }
      catch (e) { console.log('poll error (transient), retrying:', e instanceof Error ? e.message : e); continue; }
      const pj = p?.project ?? p;
      const line = `${Math.round((Date.now() - t0) / 1000)}s status=${pj?.sourcingStatus} experts=${pj?.experts?.length ?? '?'} err=${pj?.sourcingError ?? ''}`;
      if (line !== last) console.log(line); last = line;
      if (pj?.sourcingStatus && pj.sourcingStatus !== 'running') {
        ok = pj.sourcingStatus === 'completed' && (pj.experts?.length ?? 0) > 0;
        break;
      }
    }
  } catch (e) { ok = false; console.log('ERROR', e instanceof Error ? e.message : e); }
  finally { for (const c of cleanup.reverse()) await c().catch(err => console.log('cleanup err', err?.message)); }
  console.log(ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  process.exit(ok ? 0 : 1);
}
main();

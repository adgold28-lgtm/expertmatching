// ExpertMatch Supabase cutover smoke test.
// Reads secrets from .env.local; never prints them.
//
// Defaults to the local dev server. To run it against a deployed environment:
//
//   SMOKE_BASE_URL=https://expertmatch.fit \
//   SMOKE_ADMIN_EMAIL=<admin@example.com> \
//   npx tsx scripts/smoke-cutover.ts
//
// It provisions and deletes its own throwaway intruder account, and deletes the
// project it creates — but it DOES sign the admin account in, so use a throwaway
// admin when pointing it at production (Supabase signOut revokes every session
// for that user, including the one in your browser).
//
// ENVIRONMENT GUARD (audit H-22): the script prints the resolved target and
// Supabase hosts before signing anyone in and REFUSES to run when either is not
// localhost or 127.0.0.1 unless ALLOW_PROD=1 is set. That is the logout hazard
// above made explicit: pointing this at production ends the founder's sessions.
import * as dotenv from 'dotenv';
import * as path from 'path';
import { requireSafeTarget } from './opsGuard';

// Run from the repo root: `npx tsx scripts/smoke-cutover.ts`.
const ROOT = process.cwd();
dotenv.config({ path: path.join(ROOT, '.env.local') });

const BASE   = (process.env.SMOKE_BASE_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
// Origin must match what the routes' same-origin guards expect.
const ORIGIN = process.env.NEXT_PUBLIC_APP_URL ?? BASE;
// SMOKE_ADMIN_EMAIL first, then SEED_ADMIN_EMAIL from .env.local (the account
// scripts/seed-admin.ts provisioned). No hardcoded address.
const ADMIN_EMAIL = process.env.SMOKE_ADMIN_EMAIL ?? process.env.SEED_ADMIN_EMAIL ?? '';
const ADMIN_PW    = process.env.SEED_ADMIN_PASSWORD ?? '';

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
  header(): string {
    return Array.from(this.cookies.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
  }
  sbCount(): number {
    return Array.from(this.cookies.keys()).filter(k => k.startsWith('sb-')).length;
  }
}

async function req(jar: Jar, method: string, p: string, body?: unknown): Promise<Response> {
  const res = await fetch(BASE + p, {
    method,
    redirect: 'manual',
    headers: {
      'Content-Type': 'application/json',
      'Origin': ORIGIN,
      ...(jar.cookies.size ? { 'Cookie': jar.header() } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  jar.absorb(res);
  return res;
}

async function main(): Promise<void> {
  requireSafeTarget('smoke-cutover', [
    { label: 'Target',   url: BASE },
    { label: 'Supabase', url: process.env.NEXT_PUBLIC_SUPABASE_URL },
  ]);

  if (!ADMIN_EMAIL) {
    console.error('SMOKE_ADMIN_EMAIL (or SEED_ADMIN_EMAIL) missing — set it to the account to sign in as');
    process.exit(1);
  }
  if (!ADMIN_PW) { console.error('SEED_ADMIN_PASSWORD missing'); process.exit(1); }
  console.log(`smoke: target ${BASE}`);

  // ── 1. Admin login ────────────────────────────────────────────────────────
  const admin = new Jar();
  const login = await req(admin, 'POST', '/api/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PW });
  check('admin login 200', login.status === 200, `status ${login.status}`);
  check('login sets sb-* cookies', admin.sbCount() > 0, `${admin.sbCount()} sb cookies`);

  // wrong password must fail
  const badJar = new Jar();
  const bad = await req(badJar, 'POST', '/api/auth/login', { email: ADMIN_EMAIL, password: 'definitely-wrong-pw-123' });
  check('wrong password rejected 401', bad.status === 401, `status ${bad.status}`);

  // ── 2. Session read ───────────────────────────────────────────────────────
  const me = await req(admin, 'GET', '/api/auth/me');
  const meBody = me.status === 200 ? await me.json() : null;
  check('GET /api/auth/me 200', me.status === 200, `status ${me.status}`);
  check('me has admin role', meBody?.role === 'admin' || meBody?.user?.role === 'admin',
        JSON.stringify(meBody)?.slice(0, 120));

  // ── 3. Create project (Postgres write) ────────────────────────────────────
  const create = await req(admin, 'POST', '/api/projects', {
    name: 'Smoke Test Project',
    industry: 'Testing', function: 'QA', geography: 'US', seniority: 'Senior',
  });
  const created = create.status === 200 || create.status === 201 ? await create.json() : null;
  const projectId: string | undefined = created?.project?.id ?? created?.id;
  check('create project', !!projectId, `status ${create.status}${projectId ? ', id ' + projectId : ', body ' + JSON.stringify(created)?.slice(0, 150)}`);

  if (projectId) {
    // reload it — proves durability (Postgres, not memory)
    const get = await req(admin, 'GET', `/api/projects/${projectId}`);
    const got = get.status === 200 ? await get.json() : null;
    check('re-read project 200', get.status === 200 && (got?.project?.name ?? got?.name) === 'Smoke Test Project');

    // list contains it
    const list = await req(admin, 'GET', '/api/projects');
    const listBody = list.status === 200 ? await list.json() : null;
    const arr = listBody?.projects ?? listBody ?? [];
    check('project in list', Array.isArray(arr) && arr.some((p: { id: string }) => p.id === projectId));
  }

  // ── 4. IDOR: a second user in another org must get 404 ────────────────────
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const testEmail = 'smoke-intruder@example-other-firm.com';
  const testPw    = 'Intruder-pw-' + Math.random().toString(36).slice(2) + 'A1';

  // provision intruder: auth user + org + active membership (role user)
  const { data: cu, error: cuErr } = await db.auth.admin.createUser({ email: testEmail, password: testPw, email_confirm: true, app_metadata: { role: 'user', status: 'active', firm_domain: 'example-other-firm.com', onboarding_complete: true } });
  let intruderId = cu?.user?.id ?? null;
  if (cuErr) { // may exist from a prior run
    const { data: prof } = await db.from('profiles').select('id').eq('email', testEmail).maybeSingle();
    intruderId = prof?.id ?? null;
    if (intruderId) await db.auth.admin.updateUserById(intruderId, { password: testPw, app_metadata: { role: 'user', status: 'active', firm_domain: 'example-other-firm.com', onboarding_complete: true } });
  }
  check('intruder provisioned', !!intruderId, cuErr?.message ?? '');

  if (intruderId) {
    let { data: org } = await db.from('organizations').select('id').eq('domain', 'example-other-firm.com').maybeSingle();
    if (!org) ({ data: org } = await db.from('organizations').insert({ domain: 'example-other-firm.com', name: 'Other Firm' }).select('id').single());
    await db.from('organization_members').upsert({ organization_id: org!.id, profile_id: intruderId, status: 'active' }, { onConflict: 'organization_id,profile_id' });

    const intruder = new Jar();
    const iLogin = await req(intruder, 'POST', '/api/auth/login', { email: testEmail, password: testPw });
    check('intruder login 200', iLogin.status === 200, `status ${iLogin.status}`);

    if (projectId) {
      const steal = await req(intruder, 'GET', `/api/projects/${projectId}`);
      check('IDOR blocked (admin project hidden from other user)', steal.status === 404 || steal.status === 403, `status ${steal.status}`);

      const stealList = await req(intruder, 'GET', '/api/projects');
      const sBody = stealList.status === 200 ? await stealList.json() : null;
      const sArr = sBody?.projects ?? sBody ?? [];
      check('IDOR blocked in list', Array.isArray(sArr) && !sArr.some((p: { id: string }) => p.id === projectId), `saw ${Array.isArray(sArr) ? sArr.length : '?'} projects`);
    }

    // RLS directly: intruder's JWT + anon-key client must see zero rows
    const anon = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, { auth: { persistSession: false } });
    const { data: sess } = await anon.auth.signInWithPassword({ email: testEmail, password: testPw });
    if (sess?.session) {
      const asIntruder = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!, {
        auth: { persistSession: false },
        global: { headers: { Authorization: `Bearer ${sess.session.access_token}` } },
      });
      const { data: rows } = await asIntruder.from('projects').select('id');
      check('RLS direct query blocked', (rows ?? []).length === 0, `${(rows ?? []).length} rows visible`);
    } else {
      check('RLS direct query blocked', false, 'could not sign in intruder via anon client');
    }

    // intruder logout + cleanup
    await req(intruder, 'POST', '/api/auth/logout');
    await db.auth.admin.deleteUser(intruderId);
    await db.from('organizations').delete().eq('domain', 'example-other-firm.com');
  }

  // ── 5. Logout fully clears the session ────────────────────────────────────
  const preLogoutSb = admin.sbCount();
  const logout = await req(admin, 'POST', '/api/auth/logout');
  check('logout 200', logout.status === 200, `status ${logout.status}`);
  check('all sb-* cookies expired', admin.sbCount() === 0, `${preLogoutSb} before → ${admin.sbCount()} after`);

  const afterLogout = await req(admin, 'GET', '/api/auth/me');
  check('session dead after logout', afterLogout.status === 401 || afterLogout.status === 403, `status ${afterLogout.status}`);

  // ── 6. Cleanup the smoke project (service role) ───────────────────────────
  if (projectId) {
    await db.from('projects').delete().eq('id', projectId);
    console.log('cleanup: smoke project deleted');
  }

  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error('smoke test crashed:', e instanceof Error ? e.message : e); process.exit(1); });

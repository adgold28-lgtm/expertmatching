import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser, getSupabaseSessionUser } from '../lib/auth';
import { middleware } from '../middleware';

// Synthetic credentials and a local fetch double: never loads an env file.
process.env.APP_AUTH_ENABLED = 'true';
process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://fixture.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'fixture-key';
const realFetch = globalThis.fetch;
let calls = 0;
let status = 'active';
let outage = false;
const user = (email: string) => ({ id: email, email, aud: 'authenticated',
  app_metadata: { role: 'user', status, onboarding_complete: true }, user_metadata: {}, created_at: '' });
function request(email = 'one@example.test', path = '/api/projects') {
  const session = { access_token: email, refresh_token: 'fixture', expires_at: Math.floor(Date.now()/1000)+3600, user: user(email) };
  return new NextRequest(`https://app.example.test${path}`, {
    headers: { cookie: `sb-fixture-auth-token=base64-${Buffer.from(JSON.stringify(session)).toString('base64url')}` },
  });
}
globalThis.fetch = async (_url, init) => {
  calls++;
  await new Promise(resolve => setTimeout(resolve, 15));
  if (outage) return Response.json({ message: 'unavailable' }, { status: 503 });
  const token = new Headers(init?.headers).get('authorization')?.replace('Bearer ', '') ?? '';
  return Response.json(user(token));
};
async function main() {
  const start = performance.now();
  const req = request();
  assert.equal(await routeAuthGuard(req), null);
  assert.equal((await getSessionUser(req)).email, 'one@example.test');
  const sequentialMs = performance.now()-start;
  const sequentialCalls = calls;
  process.stdout.write(JSON.stringify({ sequentialCalls, sequentialMs: +sequentialMs.toFixed(2) })+'\n');
  if (process.env.BASELINE === 'true') return;
  assert.equal(sequentialCalls, 1, 'guard and session share one verified request');
  calls = 0;
  const parallel = request();
  await Promise.all([getSupabaseSessionUser(parallel), getSessionUser(parallel), routeAuthGuard(parallel)]);
  assert.equal(calls, 1, 'concurrent reads share the pending promise');
  assert.equal((await getSessionUser(request('two@example.test'))).email, 'two@example.test');
  assert.equal(calls, 2, 'different requests never share users');
  status = 'disabled';
  assert.equal((await routeAuthGuard(request()))?.status, 403, 'new request observes revocation');
  status = 'pending';
  assert.equal((await middleware(request())).status, 403, 'pending cannot bypass guards through project middleware');
  // A blocked session must still be able to reach the way out. Without the
  // PUBLIC_PATHS allowance, /login redirects to /login and /api/auth/logout
  // answers 403, so the user cannot clear the cookie that blocks them.
  for (const blocked of ['pending', 'disabled'] as const) {
    status = blocked;
    const logout = await middleware(request('one@example.test', '/api/auth/logout'));
    assert.equal(logout.status, 200, `${blocked} can still sign out`);
    const login = await middleware(request('one@example.test', '/login'));
    assert.equal(login.status, 200, `${blocked} can still load /login`);
    assert.equal(login.headers.get('location'), null, `${blocked} is not redirected in a loop`);
    const app = await middleware(request('one@example.test', '/app'));
    assert.equal(app.status, 307, `${blocked} is still kept out of the app`);
  }
  status = 'active';
  assert.equal((await middleware(request())).status, 200);
  outage = true;
  assert.equal((await routeAuthGuard(request()))?.status, 401, 'outage fails closed');
  process.stdout.write('PASS auth request isolation, revocation, pending middleware, sign-out escape, concurrency, outage\n');
}
main().finally(() => { globalThis.fetch = realFetch; }).catch(err => { console.error(err); process.exitCode=1; });

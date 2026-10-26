// scripts/test-sentry-scrub.ts — unit tests for lib/sentryScrub.ts, the
// beforeSend hook every Sentry event passes through. Pure: no Sentry, no
// network. Each rule in that module's header has a check here.
//
//   npx tsx scripts/test-sentry-scrub.ts

import {
  scrubSentryEvent,
  scrubText,
  scrubUrl,
  stripSensitive,
  type ScrubbableEvent,
} from '../lib/sentryScrub';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const TOKEN = 'cHJval9maXh0dXJlOmV4cF9maXh0dXJlOjQxMTAyMjA4MDAwMDA';   // a signed-link payload
const UUID  = '4a2f6b1e-0c33-4a9d-9f6e-1c2b3d4e5f60';

// ─── 1. Free text ────────────────────────────────────────────────────────────

section('scrubText');

eq('an email address is redacted',          scrubText('bounce for dana.reyes@acme-coatings.com today'), 'bounce for [email] today');
eq('a signed token is redacted',            scrubText(`bad token ${TOKEN}`), 'bad token [redacted]');
eq('a uuid is redacted',                    scrubText(`project ${UUID} missing`), 'project [redacted] missing');
eq('a 23-character word survives',          scrubText('abcdefghijklmnopqrstuvw'), 'abcdefghijklmnopqrstuvw');
eq('a route stays readable',                scrubText('GET /api/projects/[projectId]/experts'), 'GET /api/projects/[projectId]/experts');
check('long text is cut at 500 characters', scrubText('word '.repeat(200)).length === 501 && scrubText('word '.repeat(200)).endsWith('…'));
eq('the empty string survives',             scrubText(''), '');

// ─── 2. URLs ─────────────────────────────────────────────────────────────────

section('scrubUrl');

eq('the query string is dropped',           scrubUrl('https://expertmatch.fit/opt-out?token=abc&e=1'), 'https://expertmatch.fit/opt-out');
eq('a signed-link segment is redacted',     scrubUrl(`https://expertmatch.fit/schedule/${TOKEN}`), 'https://expertmatch.fit/schedule/[redacted]');
eq('ids in an API path are redacted',       scrubUrl(`/api/projects/${UUID}/experts/${UUID}`), '/api/projects/[redacted]/experts/[redacted]');
eq('a relative URL stays relative',         scrubUrl('/settings/do-not-contact?x=1'), '/settings/do-not-contact');
eq('a long plain word survives',            scrubUrl('/expert-onboarding/connected'), '/expert-onboarding/connected');
eq('the fragment is dropped',               scrubUrl('https://expertmatch.fit/app#section'), 'https://expertmatch.fit/app');
eq('an unparseable URL is replaced',        scrubUrl('http://'), '[redacted]');

// ─── 3. Attached data ────────────────────────────────────────────────────────

section('stripSensitive');

const attached = stripSensitive({
  projectId: 'p1',
  ms:        1234,
  outcome:   'not_found',
  brief:     'Looking for former COOs of regional dental groups',
  question:  'How is pricing set?',
  email:     'dana@acme.example',
  token:     TOKEN,
  nested:    { cookie: 'session=abc', count: 3, notes: 'private', userName: 'Dana', hostname: 'vercel' },
  list:      ['dana@acme.example', 'fine'],
}) as Record<string, unknown>;

eq('counts and ids survive',                  JSON.stringify([attached.projectId, attached.ms, attached.outcome]), JSON.stringify(['p1', 1234, 'not_found']));
check('brief, question, email and token keys are gone', !('brief' in attached) && !('question' in attached) && !('email' in attached) && !('token' in attached));
const nested = attached.nested as Record<string, unknown>;
check('nested sensitive keys are gone',       !('cookie' in nested) && !('notes' in nested) && !('userName' in nested));
eq('nested counts survive',                   nested.count, 3);
eq('a plain name-like key such as hostname survives', nested.hostname, 'vercel');
eq('strings inside arrays are scrubbed',      JSON.stringify(attached.list), JSON.stringify(['[email]', 'fine']));

let deep: Record<string, unknown> = { v: 'leaf' };
for (let i = 0; i < 10; i += 1) deep = { child: deep };
const bounded = JSON.stringify(stripSensitive(deep));
check('depth is bounded', bounded.includes('[depth]') && !bounded.includes('leaf'));
eq('arrays are capped at 50 items', (stripSensitive(new Array(80).fill(1)) as unknown[]).length, 50);

const circular: Record<string, unknown> = { ok: 1 };
circular.self = circular;
check('a circular structure terminates', typeof stripSensitive(circular) === 'object');

// ─── 4. A whole event ────────────────────────────────────────────────────────

section('scrubSentryEvent');

const raw: Record<string, unknown> = {
  event_id: 'e1',
  user: { id: 'u1', email: 'dana@acme.example', ip_address: '203.0.113.9' },
  request: {
    url:          `https://expertmatch.fit/api/projects/${UUID}/experts?view=all`,
    method:       'PATCH',
    headers:      { cookie: 'sb-access-token=abc', 'user-agent': 'x' },
    cookies:      { 'sb-access-token': 'abc' },
    data:         '{"brief":"secret"}',
    query_string: 'view=all',
    env:          { REMOTE_ADDR: '203.0.113.9' },
  },
  breadcrumbs: [
    { category: 'console', message: `[hunter] error for dana@acme.example`, level: 'error' },
    { category: 'fetch',   message: 'fetch', data: { url: `/api/availability/${TOKEN}?x=1`, method: 'POST', status_code: 500, body: '{"q":1}', response: 'oops' } },
    { category: 'navigation', data: { from: '/app', to: `/schedule/${TOKEN}` } },
  ],
  extra:       { fields: { projectId: 'p1', brief: 'confidential' }, note: 'drop me' },
  contexts:    { os: { name: 'Linux' }, runtime: { name: 'node', version: '22' }, session: { id: 's' } },
  tags:        { runtime: 'server', email: 'dana@acme.example' },
  exception:   { values: [{ type: 'Error', value: `Resend rejected dana@acme.example with ${TOKEN}`, stacktrace: { frames: [{ filename: 'lib/x.ts', vars: { secret: 1 } }] } }] },
  message:     `failed for dana@acme.example`,
  logentry:    { message: `logged ${TOKEN}` },
  transaction: `GET /schedule/${TOKEN}`,
};
const event = raw as ScrubbableEvent & Record<string, unknown>;

const out = scrubSentryEvent(event);
check('the same event object comes back',     out === event);
check('user is gone',                         out !== null && !('user' in out));
eq('request keeps the method',                out?.request?.method, 'PATCH');
eq('request URL is scrubbed',                 out?.request?.url, 'https://expertmatch.fit/api/projects/[redacted]/experts');
eq('request keeps nothing else',              JSON.stringify(Object.keys(out?.request ?? {}).sort()), JSON.stringify(['method', 'url']));
eq('the console breadcrumb is dropped',       out?.breadcrumbs?.length, 2);
const fetchCrumb = out?.breadcrumbs?.[0];
eq('the fetch breadcrumb URL is scrubbed',    fetchCrumb?.data?.url, '/api/availability/[redacted]');
check('the fetch breadcrumb loses its bodies', !('body' in (fetchCrumb?.data ?? {})) && !('response' in (fetchCrumb?.data ?? {})));
eq('the fetch breadcrumb keeps its status',   fetchCrumb?.data?.status_code, 500);
eq('a navigation target is scrubbed',         out?.breadcrumbs?.[1]?.data?.to, '/schedule/[redacted]');
const extra = out?.extra as Record<string, unknown>;
check('extra loses sensitive keys at every depth', !('note' in extra) && !('brief' in (extra.fields as Record<string, unknown>)));
eq('extra keeps the rest',                    (extra.fields as Record<string, unknown>).projectId, 'p1');
const contexts = out?.contexts as Record<string, Record<string, unknown>>;
eq('contexts keep the OS name',               contexts.os?.name, 'Linux');
check('contexts lose a session',              !('session' in contexts));
check('tags lose an email',                   out !== null && !('email' in (out.tags ?? {})) && (out.tags ?? {}).runtime === 'server');
eq('the exception value is scrubbed',         out?.exception?.values?.[0]?.value, 'Resend rejected [email] with [redacted]');
const frame = (out?.exception?.values?.[0] as { stacktrace?: { frames?: Record<string, unknown>[] } }).stacktrace?.frames?.[0];
check('stack frames lose local variables',    frame !== undefined && !('vars' in frame) && frame.filename === 'lib/x.ts');
eq('the message is scrubbed',                 out?.message, 'failed for [email]');
eq('the log entry is scrubbed',               out?.logentry?.message, 'logged [redacted]');
eq('the transaction is scrubbed',             out?.transaction, 'GET /schedule/[redacted]');
eq('unrelated fields survive',                out?.event_id, 'e1');

eq('an empty event passes through',           JSON.stringify(scrubSentryEvent({})), '{}');

const hostile = new Proxy({}, {
  get()     { throw new Error('unreadable'); },
  ownKeys() { throw new Error('unreadable'); },
});
eq('an event the scrub cannot read is dropped, never sent as it is', scrubSentryEvent(hostile as ScrubbableEvent), null);

summary();

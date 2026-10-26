// scripts/test-findymail-provider.ts — unit tests for
// lib/contactProviders/findymail.ts with the network stubbed: what the provider
// sends, where the key goes, and how every answer Findymail can give is read.
// No real key, no credits, no network.
//
//   npx tsx scripts/test-findymail-provider.ts

const TEST_KEY = 'fm-test-key-not-real';
process.env.FINDYMAIL_API_KEY = TEST_KEY;

import { findymailProvider } from '../lib/contactProviders/findymail';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ─── A fetch that answers with one canned response and remembers the request ─

interface Captured { url: string; init: RequestInit }
let captured: Captured | null = null;

function answerWith(status: number, body: unknown): void {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    captured = { url: String(url), init: init ?? {} };
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
}

function lastRequest(): Captured {
  if (!captured) throw new Error('no request was made');
  return captured;
}

/** The thrown error's message and code, or null when the call returned. */
async function errorOf(p: Promise<unknown>): Promise<{ message: string; code: string | undefined } | null> {
  try {
    await p;
    return null;
  } catch (err) {
    const e = err as { message?: unknown; code?: unknown };
    return { message: String(e.message ?? err), code: typeof e.code === 'string' ? e.code : undefined };
  }
}

const input = { firstName: 'Dana', lastName: 'Reyes', domain: 'acmecoatings.example' };
const lookup = () => findymailProvider.findProfessionalEmail(input);

async function main(): Promise<void> {
  section('configuration');

  check('configured when the key is set', findymailProvider.isConfigured());
  delete process.env.FINDYMAIL_API_KEY;
  check('not configured without the key', !findymailProvider.isConfigured());
  const unconfigured = await errorOf(lookup());
  check('a lookup without the key throws, never a silent not_found', unconfigured !== null && unconfigured.code === undefined);
  process.env.FINDYMAIL_API_KEY = TEST_KEY;
  eq('one credit per lookup', findymailProvider.estimateCreditsPerLookup(input), 1);

  section('the request');

  answerWith(200, { contact: { name: 'Dana Reyes', domain: 'acmecoatings.example', email: 'dana.reyes@acmecoatings.example' } });
  const found = await lookup();
  const req     = lastRequest();
  const headers = (req.init.headers ?? {}) as Record<string, string>;
  eq('POSTs to the find-email-from-name endpoint', req.url, 'https://app.findymail.com/api/search/name');
  eq('method is POST',                            req.init.method, 'POST');
  eq('the key rides in the Authorization header',  headers['Authorization'], `Bearer ${TEST_KEY}`);
  eq('the body is JSON',                           headers['Content-Type'], 'application/json');
  check('the key is not in the URL',               !req.url.includes(TEST_KEY));
  check('the key is not in the body',              !String(req.init.body).includes(TEST_KEY));
  eq('the body is the full name and the domain',   req.init.body, JSON.stringify({ name: 'Dana Reyes', domain: 'acmecoatings.example' }));
  check('an abort signal is attached',             req.init.signal instanceof AbortSignal);

  section('a verified address');

  eq('one result',                                found.length, 1);
  eq('the address',                               found[0]?.email, 'dana.reyes@acmecoatings.example');
  eq('provider',                                  found[0]?.provider, 'findymail');
  eq('stored as verified',                        found[0]?.normalizedStatus, 'verified');
  eq('no confidence score (Findymail has none)',  found[0]?.confidence, undefined);
  check('not webmail, not disposable, valid format',
    found[0]?.isWebmail === false && found[0]?.isDisposable === false && found[0]?.isValidFormat === true);

  answerWith(200, { contact: { email: '  Dana.Reyes@acmecoatings.example  ' } });
  eq('surrounding whitespace is trimmed', (await lookup())[0]?.email, 'Dana.Reyes@acmecoatings.example');

  section('nobody found');

  answerWith(200, { contact: { name: 'Dana Reyes', domain: 'acmecoatings.example', email: null } });
  eq('200 with a null email → []',      (await lookup()).length, 0);
  answerWith(200, { contact: null });
  eq('200 with no contact → []',        (await lookup()).length, 0);
  answerWith(200, {});
  eq('200 with an empty body → []',     (await lookup()).length, 0);
  answerWith(200, { contact: { email: '   ' } });
  eq('200 with a blank email → []',     (await lookup()).length, 0);

  section('webmail never passes');

  answerWith(200, { contact: { email: 'dana.reyes@gmail.com' } });
  eq('a webmail address → []', (await lookup()).length, 0);
  answerWith(200, { contact: { email: 'dana.reyes@Outlook.com' } });
  eq('webmail is matched case-insensitively → []', (await lookup()).length, 0);

  section('errors are thrown, never read as nobody-found');

  answerWith(402, { error: 'Not enough credits' });
  eq('402 → not_enough_credits',      (await errorOf(lookup()))?.code, 'not_enough_credits');
  answerWith(429, { error: 'Too many requests' });
  eq('429 → provider_rate_limited',   (await errorOf(lookup()))?.code, 'provider_rate_limited');
  answerWith(423, { error: 'Subscription is paused' });
  const paused = await errorOf(lookup());
  check('423 → throws without a code', paused !== null && paused.code === undefined);
  answerWith(401, { error: 'Unauthenticated' });
  const unauthorized = await errorOf(lookup());
  check('401 → throws without a code', unauthorized !== null && unauthorized.code === undefined);
  answerWith(404, { error: 'Not found' });
  const missing = await errorOf(lookup());
  check('404 → throws (undocumented, so never read as nobody-found)', missing !== null && missing.code === undefined);
  answerWith(500, { error: 'boom' });
  const failed = await errorOf(lookup());
  check('500 → throws without a code', failed !== null && failed.code === undefined);
  check('the error never carries the key', ![paused, unauthorized, missing, failed].some(e => e?.message.includes(TEST_KEY)));

  section("the caller's deadline");

  globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })) as typeof fetch;
  const external = new AbortController();
  const pending  = errorOf(findymailProvider.findProfessionalEmail({ ...input, signal: external.signal }));
  external.abort();
  const aborted = await pending;
  check('an abort propagates (the chain records it as a timeout)', aborted !== null && aborted.message === 'aborted');

  section('blank input spends nothing');

  let calls = 0;
  globalThis.fetch = (async (): Promise<Response> => { calls += 1; return new Response('{}', { status: 200 }); }) as typeof fetch;
  eq('an empty name → [] without a request',
    (await findymailProvider.findProfessionalEmail({ firstName: ' ', lastName: '', domain: 'x.example' })).length, 0);
  eq('an empty domain → [] without a request',
    (await findymailProvider.findProfessionalEmail({ firstName: 'Dana', lastName: 'Reyes', domain: '' })).length, 0);
  eq('no request was made', calls, 0);

  summary();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

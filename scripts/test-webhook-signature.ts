// scripts/test-webhook-signature.ts — the two webhook signatures ExpertMatch
// trusts money to, checked against REAL HMAC fixtures (repair-plan brief W3-2).
//
// Both webhooks are unauthenticated routes that move money: the Stripe one
// writes 'paid' and releases an expert payout, the Zoom one completes a call and
// charges a card. The only thing standing between a stranger and either of those
// is the signature check plus the replay window, so both are asserted here from
// the outside — every fixture is a signature this script computes itself (the
// Stripe SDK's own generateTestHeaderString, and a hand-rolled HMAC for Zoom),
// never a value copied out of the implementation.
//
// No network, no database, no Redis, and no secret from the environment: the
// secrets below are throwaway strings created in this file. The Stripe client is
// constructed with a dummy key purely so its signature verifier can be used —
// no API call is ever made.
//
//   npx tsx scripts/test-webhook-signature.ts
//
// Exits non-zero when any assertion fails, so it can gate a deploy.

import { createHmac } from 'crypto';
import Stripe from 'stripe';
import { verifyStripeSignature } from '../app/api/webhooks/stripe/handlers';
import {
  ZOOM_TIMESTAMP_TOLERANCE_SEC,
  verifyZoomWebhook,
  zoomSignature,
  zoomUrlValidationHash,
} from '../app/api/webhooks/zoom/meetingEnd';

let failures = 0;
let checks   = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// Throwaway secrets — invented here, never read from the environment.
const STRIPE_SECRET = 'whsec_test_0123456789abcdef0123456789abcdef';
const ZOOM_SECRET   = 'zoom_test_token_0123456789abcdef';

// ── Stripe ───────────────────────────────────────────────────────────────────
// The SDK is only used for its HMAC: constructing it with a dummy key performs
// no I/O, and verifyStripeSignature takes the client as its test seam.

const sdk = new Stripe('sk_test_not_a_real_key_0000000000');

const payload = JSON.stringify({
  id:   'evt_test_1',
  type: 'payment_intent.succeeded',
  data: { object: { id: 'pi_test_1', metadata: { projectId: 'p1', expertId: 'e1' } } },
});

const nowSec = Math.floor(Date.now() / 1000);

function stripeHeader(secret: string, body: string, timestamp: number): string {
  return sdk.webhooks.generateTestHeaderString({ payload: body, secret, timestamp });
}

section('Stripe: a genuine delivery verifies');
const goodHeader = stripeHeader(STRIPE_SECRET, payload, nowSec);
const good = verifyStripeSignature(payload, goodHeader, STRIPE_SECRET, sdk);
check('valid signature → ok', good.ok === true);
if (good.ok) {
  eq('the parsed event keeps its id',   good.event.id,   'evt_test_1');
  eq('the parsed event keeps its type', good.event.type, 'payment_intent.succeeded');
} else {
  check('event parsed', false, good.error);
  check('event type read', false);
}
check('the header really is Stripe-shaped', /^t=\d+,v1=[0-9a-f]{64}$/.test(goodHeader), goodHeader);

section("Stripe: the scheme is t + v1=HMAC-SHA256(secret, `${t}.${body}`)");
// Built by hand, without the SDK, so the fixture proves the scheme rather than
// echoing whatever the SDK happens to do.
const handSig    = createHmac('sha256', STRIPE_SECRET).update(`${nowSec}.${payload}`).digest('hex');
const handHeader = `t=${nowSec},v1=${handSig}`;
check('a hand-computed header verifies', verifyStripeSignature(payload, handHeader, STRIPE_SECRET, sdk).ok === true);
check('the SDK computes the same v1',    goodHeader === handHeader, `${goodHeader} vs ${handHeader}`);
check('an unknown extra scheme is tolerated alongside a good v1',
  verifyStripeSignature(payload, `${handHeader},v0=deadbeef`, STRIPE_SECRET, sdk).ok === true);

section('Stripe: everything else is refused');
function stripeError(body: string, header: string | null | undefined, secret: string | undefined): string {
  const r = verifyStripeSignature(body, header, secret, sdk);
  return r.ok ? 'ok' : r.error;
}
eq('no signature header → missing_signature',   stripeError(payload, null, STRIPE_SECRET), 'missing_signature');
eq('empty signature header → missing_signature', stripeError(payload, '', STRIPE_SECRET), 'missing_signature');
eq('no webhook secret configured → missing_signature', stripeError(payload, goodHeader, undefined), 'missing_signature');
eq('empty webhook secret → missing_signature',  stripeError(payload, goodHeader, ''), 'missing_signature');
eq('signed with another secret → invalid_signature',
  stripeError(payload, stripeHeader('whsec_someone_elses_secret_00000000', payload, nowSec), STRIPE_SECRET),
  'invalid_signature');
eq('body tampered after signing → invalid_signature',
  stripeError(payload.replace('pi_test_1', 'pi_attacker'), goodHeader, STRIPE_SECRET), 'invalid_signature');
eq('one flipped hex digit → invalid_signature',
  stripeError(payload, `t=${nowSec},v1=${handSig.slice(0, 63)}${handSig.endsWith('0') ? '1' : '0'}`, STRIPE_SECRET),
  'invalid_signature');
eq('timestamp changed after signing → invalid_signature',
  stripeError(payload, `t=${nowSec - 1},v1=${handSig}`, STRIPE_SECRET), 'invalid_signature');
eq('header with no v1 at all → invalid_signature',
  stripeError(payload, `t=${nowSec}`, STRIPE_SECRET), 'invalid_signature');
eq('garbage header → invalid_signature', stripeError(payload, 'not-a-signature', STRIPE_SECRET), 'invalid_signature');
eq('a valid signature over a non-JSON body → invalid_signature',
  stripeError('not json', stripeHeader(STRIPE_SECRET, 'not json', nowSec), STRIPE_SECRET), 'invalid_signature');

section('Stripe: a captured delivery stops verifying once it is old (replay)');
// Stripe's SDK enforces a five-minute tolerance on `t`, so a validly signed body
// captured off the wire cannot be replayed tomorrow.
eq('one hour old → invalid_signature',
  stripeError(payload, stripeHeader(STRIPE_SECRET, payload, nowSec - 3600), STRIPE_SECRET), 'invalid_signature');
eq('ten minutes old → invalid_signature',
  stripeError(payload, stripeHeader(STRIPE_SECRET, payload, nowSec - 600), STRIPE_SECRET), 'invalid_signature');
check('one minute old → still accepted',
  verifyStripeSignature(payload, stripeHeader(STRIPE_SECRET, payload, nowSec - 60), STRIPE_SECRET, sdk).ok === true);

// ── Zoom ─────────────────────────────────────────────────────────────────────

const zoomBody = JSON.stringify({
  event:   'meeting.ended',
  payload: { object: { id: '99912345', start_time: '2026-09-09T10:00:00Z', end_time: '2026-09-09T10:47:00Z' } },
});
const nowMs = Date.now();
const zoomTs = String(Math.floor(nowMs / 1000));

section('Zoom: the v0 signature is HMAC-SHA256 over `v0:{ts}:{raw body}`');
const zoomHandSig = 'v0=' + createHmac('sha256', ZOOM_SECRET).update(`v0:${zoomTs}:${zoomBody}`).digest('hex');
eq('zoomSignature matches a hand-computed HMAC', zoomSignature(ZOOM_SECRET, zoomTs, zoomBody), zoomHandSig);
check('it is prefixed v0= and 64 hex digits', /^v0=[0-9a-f]{64}$/.test(zoomHandSig));
check('a different secret gives a different signature',
  zoomSignature('another_token', zoomTs, zoomBody) !== zoomHandSig);
check('a different timestamp gives a different signature',
  zoomSignature(ZOOM_SECRET, String(Number(zoomTs) - 1), zoomBody) !== zoomHandSig);
check('re-serialised JSON does not sign the same (raw body matters)',
  zoomSignature(ZOOM_SECRET, zoomTs, JSON.stringify(JSON.parse(zoomBody), null, 2)) !== zoomHandSig);

section('Zoom: verification outcomes');
function zoomVerify(opts: {
  secret?:    string;
  timestamp?: string | null;
  signature?: string | null;
  body?:      string;
  now?:       number;
}): string {
  const r = verifyZoomWebhook({
    secret:    'secret' in opts ? opts.secret : ZOOM_SECRET,
    timestamp: 'timestamp' in opts ? opts.timestamp : zoomTs,
    signature: 'signature' in opts ? opts.signature : zoomHandSig,
    rawBody:   opts.body ?? zoomBody,
    now:       opts.now ?? nowMs,
  });
  return r.ok ? 'ok' : r.error;
}
eq('genuine delivery → ok',                     zoomVerify({}), 'ok');
eq('no secret configured → missing_signature',  zoomVerify({ secret: undefined }), 'missing_signature');
eq('empty secret → missing_signature',          zoomVerify({ secret: '' }), 'missing_signature');
eq('no signature header → missing_signature',   zoomVerify({ signature: null }), 'missing_signature');
eq('empty signature header → missing_signature', zoomVerify({ signature: '' }), 'missing_signature');
eq('signed with another secret → invalid_signature',
  zoomVerify({ signature: zoomSignature('another_token', zoomTs, zoomBody) }), 'invalid_signature');
eq('body tampered after signing → invalid_signature',
  zoomVerify({ body: zoomBody.replace('99912345', '99999999') }), 'invalid_signature');
eq('truncated signature does not throw → invalid_signature',
  zoomVerify({ signature: zoomHandSig.slice(0, 20) }), 'invalid_signature');
eq('signature without the v0= prefix → invalid_signature',
  zoomVerify({ signature: zoomHandSig.slice(3) }), 'invalid_signature');
eq('one flipped hex digit → invalid_signature',
  zoomVerify({ signature: zoomHandSig.slice(0, -1) + (zoomHandSig.endsWith('0') ? '1' : '0') }), 'invalid_signature');
eq('timestamp changed after signing → invalid_signature',
  zoomVerify({ timestamp: String(Number(zoomTs) - 1) }), 'invalid_signature');

section('Zoom: the replay window (C-4) — a valid signature is not freshness');
const tol = ZOOM_TIMESTAMP_TOLERANCE_SEC;
function zoomAtAge(ageSeconds: number): string {
  const ts = String(Math.floor(nowMs / 1000) - ageSeconds);
  return zoomVerify({ timestamp: ts, signature: zoomSignature(ZOOM_SECRET, ts, zoomBody) });
}
eq('a correctly signed delivery from 10 minutes ago → stale_timestamp', zoomAtAge(600), 'stale_timestamp');
eq(`exactly ${tol + 1}s old → stale_timestamp`, zoomAtAge(tol + 1), 'stale_timestamp');
// The window is measured against a millisecond clock, so the exact boundary
// second is genuinely ambiguous; one second inside it must always pass.
eq(`${tol - 1}s old → still accepted`,          zoomAtAge(tol - 1), 'ok');
eq('a few seconds old → ok',                    zoomAtAge(5), 'ok');
eq(`${tol + 1}s in the FUTURE → stale_timestamp`, zoomAtAge(-(tol + 1)), 'stale_timestamp');
eq('a signed but empty timestamp → stale_timestamp',
  zoomVerify({ timestamp: '', signature: zoomSignature(ZOOM_SECRET, '', zoomBody) }), 'stale_timestamp');
eq('a signed but non-numeric timestamp → stale_timestamp',
  zoomVerify({ timestamp: 'yesterday', signature: zoomSignature(ZOOM_SECRET, 'yesterday', zoomBody) }),
  'stale_timestamp');
eq('a stale delivery with a BAD signature reports the signature first',
  zoomVerify({ timestamp: String(Number(zoomTs) - 600), signature: zoomHandSig }), 'invalid_signature');

section('Zoom: the url_validation handshake');
const plainToken = 'abc123plain';
eq('hash matches a hand-computed HMAC',
  zoomUrlValidationHash(ZOOM_SECRET, plainToken),
  createHmac('sha256', ZOOM_SECRET).update(plainToken).digest('hex'));
check('it is bare hex, with no v0= prefix', /^[0-9a-f]{64}$/.test(zoomUrlValidationHash(ZOOM_SECRET, plainToken)));
check('a different secret gives a different hash',
  zoomUrlValidationHash('another_token', plainToken) !== zoomUrlValidationHash(ZOOM_SECRET, plainToken));
check('a different token gives a different hash',
  zoomUrlValidationHash(ZOOM_SECRET, 'other') !== zoomUrlValidationHash(ZOOM_SECRET, plainToken));

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);

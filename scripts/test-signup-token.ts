// scripts/test-signup-token.ts — unit tests for lib/signupToken.ts, the HMAC
// invite/reset token every account link is built from.
//
// Pure: no Redis, no database, no network. The secret is supplied here so the
// script runs with or without a .env.local.
//
//   npx tsx scripts/test-signup-token.ts
//
// Exits non-zero on the first failing assertion, so it can gate a deploy.

process.env.SIGNUP_TOKEN_SECRET =
  process.env.SIGNUP_TOKEN_SECRET && process.env.SIGNUP_TOKEN_SECRET.length >= 32
    ? process.env.SIGNUP_TOKEN_SECRET
    : '0123456789abcdef0123456789abcdef0123456789abcdef';

import { createHmac } from 'crypto';
import {
  generateSignupToken,
  verifySignupToken,
  hashToken,
} from '../lib/signupToken';

let failures = 0;
let checks   = 0;

function check(label: string, actual: unknown, expected: unknown): void {
  checks++;
  const pass = Object.is(actual, expected);
  if (!pass) {
    failures++;
    console.error(`  FAIL  ${label}\n        expected ${String(expected)}, got ${String(actual)}`);
  } else {
    console.log(`  ok    ${label}`);
  }
}

function section(name: string): void {
  console.log(`\n${name}`);
}

/** Signs an arbitrary payload the way the library does — for legacy/expiry cases. */
function forge(payloadObj: Record<string, unknown>): string {
  const payload = Buffer.from(JSON.stringify(payloadObj)).toString('base64url');
  const sig     = createHmac('sha256', process.env.SIGNUP_TOKEN_SECRET as string)
    .update(payload)
    .digest('base64url');
  return `${payload}.${sig}`;
}

const EMAIL = 'jane@acmecapital.com';
const FIRM  = 'Acme Capital';
const ORG   = '4a2f6b1e-0c33-4a9d-9f6e-1c2b3d4e5f60';

// ── Round trip: plain invite (no options) ────────────────────────────────────
section('Round trip — invite, no orgId');
{
  const minted   = generateSignupToken(EMAIL, FIRM);
  const verified = verifySignupToken(minted.token);
  check('valid',        verified.valid,    true);
  check('not expired',  verified.expired,  false);
  check('email',        verified.email,    EMAIL);
  check('firmName',     verified.firmName, FIRM);
  check('kind',         verified.kind,     'invite');
  check('orgId is null', verified.orgId,   null);
  check('minted kind',  minted.kind,       'invite');
  check('hash matches', minted.hash,       hashToken(minted.token));
  check('24h expiry',   Math.round((minted.expiry - Date.now()) / 60000), 24 * 60);
}

// ── Round trip: invite carrying its organization ─────────────────────────────
section('Round trip — invite with orgId');
{
  const minted   = generateSignupToken(EMAIL, FIRM, { orgId: ORG });
  const verified = verifySignupToken(minted.token);
  check('valid',  verified.valid, true);
  check('orgId',  verified.orgId, ORG);
  check('kind',   verified.kind,  'invite');
}

// ── Round trip: reset ────────────────────────────────────────────────────────
section('Round trip — reset with orgId');
{
  const minted   = generateSignupToken(EMAIL, FIRM, { kind: 'reset', orgId: ORG });
  const verified = verifySignupToken(minted.token);
  check('valid',       verified.valid, true);
  check('kind',        verified.kind,  'reset');
  check('orgId',       verified.orgId, ORG);
  check('minted kind', minted.kind,    'reset');
  check('1h expiry',   Math.round((minted.expiry - Date.now()) / 60000), 60);
}

// ── Tamper detection ─────────────────────────────────────────────────────────
section('Tamper detection');
{
  const { token } = generateSignupToken(EMAIL, FIRM, { orgId: ORG });
  const [payload, sig] = token.split('.');

  // Rewritten payload (attacker swaps in their own email / another org).
  const swapped = forge({
    email:    'attacker@evil.com',
    firmName: FIRM,
    expiry:   Date.now() + 3600_000,
    nonce:    'deadbeef',
    kind:     'invite',
    orgId:    ORG,
  });
  const swappedSig = swapped.split('.')[1];
  check('a forged payload does not reuse the original signature', swappedSig === sig, false);

  const repayloaded = verifySignupToken(`${Buffer.from(JSON.stringify({
    email: 'attacker@evil.com', firmName: FIRM, expiry: Date.now() + 3600_000, nonce: 'x', kind: 'invite',
  })).toString('base64url')}.${sig}`);
  check('payload swap rejected', repayloaded.valid, false);

  check('flipped signature rejected', verifySignupToken(`${payload}.${'A'.repeat(sig.length)}`).valid, false);
  check('truncated signature rejected', verifySignupToken(`${payload}.${sig.slice(0, -4)}`).valid, false);
  check('missing signature rejected', verifySignupToken(payload).valid, false);
  check('empty token rejected', verifySignupToken('').valid, false);
  check('garbage rejected', verifySignupToken('not.a.token').valid, false);

  // A signature that is valid for a DIFFERENT payload must not carry over.
  const other = generateSignupToken('someone@else.com', FIRM);
  check(
    'cross-token signature rejected',
    verifySignupToken(`${payload}.${other.token.split('.')[1]}`).valid,
    false,
  );

  // Unknown kind is refused rather than silently downgraded to an invite.
  check(
    'unknown kind rejected',
    verifySignupToken(forge({
      email: EMAIL, firmName: FIRM, expiry: Date.now() + 3600_000, nonce: 'n', kind: 'superuser',
    })).valid,
    false,
  );
}

// ── Expiry ───────────────────────────────────────────────────────────────────
section('Expiry');
{
  const expiredToken = forge({
    email:    EMAIL,
    firmName: FIRM,
    expiry:   Date.now() - 1_000,
    nonce:    'abc123',
    kind:     'invite',
    orgId:    ORG,
  });
  const verified = verifySignupToken(expiredToken);
  check('expired token is invalid', verified.valid,   false);
  check('expired flag set',         verified.expired, true);
  check('no email leaks',           verified.email,   '');

  // An expired token that is ALSO tampered with reads as invalid, not expired.
  const tampered = `${expiredToken.split('.')[0]}.${'B'.repeat(43)}`;
  check('tampered + expired reads invalid', verifySignupToken(tampered).expired, false);
}

// ── Legacy payloads (minted before kind/orgId existed) ───────────────────────
section('Backward compatibility');
{
  const legacy = forge({
    email:    EMAIL,
    firmName: FIRM,
    expiry:   Date.now() + 3600_000,
    nonce:    'legacynonce',
  });
  const verified = verifySignupToken(legacy);
  check('legacy token still verifies', verified.valid,    true);
  check('legacy kind defaults to invite', verified.kind,  'invite');
  check('legacy orgId is null',        verified.orgId,    null);
  check('legacy email',                verified.email,    EMAIL);
  check('legacy firmName',             verified.firmName, FIRM);

  // A legacy payload with an empty orgId string is treated as "no org".
  const blankOrg = verifySignupToken(forge({
    email: EMAIL, firmName: FIRM, expiry: Date.now() + 3600_000, nonce: 'n', orgId: '',
  }));
  check('blank orgId is null', blankOrg.orgId, null);
}

// ── Required fields ──────────────────────────────────────────────────────────
section('Payload validation');
{
  check(
    'missing email rejected',
    verifySignupToken(forge({ firmName: FIRM, expiry: Date.now() + 3600_000, nonce: 'n' })).valid,
    false,
  );
  check(
    'missing firmName rejected',
    verifySignupToken(forge({ email: EMAIL, expiry: Date.now() + 3600_000, nonce: 'n' })).valid,
    false,
  );
  check(
    'non-numeric expiry rejected',
    verifySignupToken(forge({ email: EMAIL, firmName: FIRM, expiry: 'soon', nonce: 'n' })).valid,
    false,
  );
}

// ── Uniqueness ───────────────────────────────────────────────────────────────
section('Uniqueness');
{
  const a = generateSignupToken(EMAIL, FIRM);
  const b = generateSignupToken(EMAIL, FIRM);
  check('two tokens for the same invitee differ', a.token === b.token, false);
  check('their hashes differ',                    a.hash  === b.hash,  false);
}

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.error(`${failures} FAILED`);
  process.exit(1);
}

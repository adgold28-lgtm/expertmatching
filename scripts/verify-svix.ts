// Unit-style check for the Svix webhook verification used by
// app/api/inbound-email/route.ts.
//
// Signs a sample body with a throwaway whsec_ secret and asserts that
// Webhook.verify() accepts the genuine signature and rejects a tampered body,
// a wrong secret, a stale timestamp, and missing headers.
//
// Run: npx tsx scripts/verify-svix.ts
// No network, no env vars, no secrets printed.

import { randomBytes } from 'crypto';
import { Webhook } from 'svix';

const SECRET = 'whsec_' + randomBytes(24).toString('base64');
const OTHER  = 'whsec_' + randomBytes(24).toString('base64');

const BODY  = JSON.stringify({
  to:   [{ email: 'reply+abc.def@expertmatch.fit' }],
  from: 'expert@example.com',
  text: 'Happy to talk. What times work?',
});
const MSG_ID = 'msg_2example';

let failures = 0;
function check(name: string, ok: boolean): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failures++;
}

function verifies(secret: string, body: string, headers: Record<string, string>): boolean {
  try {
    new Webhook(secret).verify(body, headers);
    return true;
  } catch {
    return false;
  }
}

function headersFor(secret: string, body: string, when: Date): Record<string, string> {
  const signature = new Webhook(secret).sign(MSG_ID, when, body);
  return {
    'svix-id':        MSG_ID,
    'svix-timestamp': String(Math.floor(when.getTime() / 1000)),
    'svix-signature': signature,
  };
}

const now   = new Date();
const fresh = headersFor(SECRET, BODY, now);

check('genuine signature verifies',        verifies(SECRET, BODY, fresh) === true);
check('tampered body is rejected',         verifies(SECRET, BODY + ' ', fresh) === false);
check('wrong secret is rejected',          verifies(OTHER,  BODY, fresh) === false);
check('missing headers are rejected',      verifies(SECRET, BODY, { 'svix-id': '', 'svix-timestamp': '', 'svix-signature': '' }) === false);

// Svix enforces a 5-minute tolerance on svix-timestamp (replay protection).
const stale = headersFor(SECRET, BODY, new Date(now.getTime() - 10 * 60 * 1000));
check('stale timestamp is rejected',       verifies(SECRET, BODY, stale) === false);

// A signature that is valid for a different message id must not transfer.
const swapped = { ...fresh, 'svix-id': 'msg_other' };
check('mismatched message id is rejected', verifies(SECRET, BODY, swapped) === false);

console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);

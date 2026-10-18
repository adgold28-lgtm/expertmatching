// Payout-onboarding token — the link in the "set up your payout" email
// (lib/expertPayout.ts), redeemed by GET /api/expert-onboarding/[token].
//
// Format: base64url(payout:projectId:expertId:expiry_ms:nonce_hex) + "." + base64url(HMAC)
//
// WHY ITS OWN SHAPE. The payout link used to be an ordinary availability token
// (lib/availabilityToken.ts), the same kind Matchy mints for every "pick a
// time" round. The picker routes compare the token against the hash stored on
// the row, so a superseded picker link dies when the next round is minted; the
// payout route has no stored hash, so ANY expert availability token ever
// minted for that engagement — every old picker link in the expert's inbox,
// for seven days — opened the Stripe Connect onboarding and let its holder
// enter bank details. The `payout:` marker and the separate purpose make the
// two kinds non-interchangeable: a picker link no longer verifies here and a
// payout link no longer verifies there.
//
// Secret: AVAILABILITY_TOKEN_SECRET, like every other token (lib/hmacToken.ts).

import { randomBytes } from 'crypto';
import { sign, verify } from './hmacToken';

const EXPIRY_MS   = 7 * 24 * 60 * 60 * 1000; // 7 days, matching the old link
const NONCE_BYTES = 16;
const KIND        = 'payout';

export interface GeneratedPayoutToken {
  token:  string;
  expiry: number;
}

export function generatePayoutToken(projectId: string, expertId: string): GeneratedPayoutToken {
  const expiry = Date.now() + EXPIRY_MS;
  const nonce  = randomBytes(NONCE_BYTES).toString('hex');
  return { token: sign(`${KIND}:${projectId}:${expertId}:${expiry}:${nonce}`, 'payout'), expiry };
}

export type PayoutVerifyResult =
  | { ok: true;  data: { projectId: string; expertId: string } }
  | { ok: false; reason: 'malformed' | 'expired' | 'invalid_signature' };

export function verifyPayoutToken(token: string): PayoutVerifyResult {
  const verified = verify(token, 'payout');
  if (!verified.ok) return { ok: false, reason: verified.reason };

  const segments = verified.payload.split(':');
  if (segments.length !== 5 || segments[0] !== KIND) return { ok: false, reason: 'malformed' };
  const [, projectId, expertId, expiryStr] = segments;
  const expiry = parseInt(expiryStr, 10);
  if (!projectId || !expertId || isNaN(expiry)) return { ok: false, reason: 'malformed' };
  if (Date.now() > expiry) return { ok: false, reason: 'expired' };
  return { ok: true, data: { projectId, expertId } };
}

// Stripe Connect Express — expert payout accounts.
//
// Creates and manages Stripe Connect Express accounts for experts.
// Redis key: expert-connect:[hmac(email)] → accountId
//
// Security rules:
//   - NEVER log accountId, transferId, or email
//   - Log only expertId and projectId for transfer operations
//   - Redis keys use HMAC-hashed email (no PII in key names)

import { stripe } from './stripe';
import { getUpstashClient } from './upstashRedis';
import { createHmac } from 'crypto';

// ─── Redis key helper (no PII) ────────────────────────────────────────────────

function connectRedisKey(email: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  const hash   = createHmac('sha256', secret).update(email).digest('hex').slice(0, 24);
  return `expert-connect:${hash}`;
}

// ─── Account storage ──────────────────────────────────────────────────────────

export async function getConnectAccountId(email: string): Promise<string | null> {
  const redis = getUpstashClient();
  if (!redis) return null;
  return redis.get(connectRedisKey(email));
}

export async function setConnectAccountId(email: string, accountId: string): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) throw new Error('[stripeConnect] Redis not available');
  // Store indefinitely — no expiry on Connect accounts
  await redis.set(connectRedisKey(email), accountId);
}

// ─── Account creation ─────────────────────────────────────────────────────────

export async function createConnectAccount(email: string): Promise<string> {
  const account = await stripe.accounts.create({
    type:  'express',
    email,
    capabilities: {
      transfers: { requested: true },
    },
  });
  return account.id;
}

// ─── Onboarding link ──────────────────────────────────────────────────────────

export async function createOnboardingLink(
  accountId:  string,
  returnUrl:  string,
  refreshUrl: string,
): Promise<string> {
  const link = await stripe.accountLinks.create({
    account:     accountId,
    type:        'account_onboarding',
    return_url:  returnUrl,
    refresh_url: refreshUrl,
  });
  return link.url;
}

// ─── Onboarding status check ──────────────────────────────────────────────────

export async function isOnboardingComplete(accountId: string): Promise<boolean> {
  const account = await stripe.accounts.retrieve(accountId);
  return account.details_submitted === true;
}

// ─── Expert payout transfer ───────────────────────────────────────────────────

export async function transferExpertPayout(
  accountId:   string,
  amountCents: number,
  projectId:   string,
  expertId:    string,
): Promise<string> {
  if (amountCents < 50) {
    throw new Error(`[stripeConnect] payout too small: ${amountCents} cents`);
  }

  const transfer = await stripe.transfers.create({
    amount:      amountCents,
    currency:    'usd',
    destination: accountId,
    metadata:    { projectId, expertId }, // no PII in metadata
  });

  // Log only safe identifiers — never log accountId or transferId
  console.log('[stripe-connect] transfer-initiated', { expertId, projectId });

  return transfer.id;
}

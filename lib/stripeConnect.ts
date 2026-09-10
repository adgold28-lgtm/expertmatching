// Stripe Connect Express — expert payout accounts.
//
// Creates and manages Stripe Connect Express accounts for experts.
// Redis key: expert-connect:[hmac(email)] → accountId
//
// Security rules:
//   - NEVER log accountId, transferId, or email
//   - Log only expertId and projectId for transfer operations
//   - Redis keys use HMAC-hashed email (no PII in key names)
//
// TEST SEAM: isOnboardingComplete() and transferExpertPayout() take an optional
// trailing Stripe client, defaulting to the real one, so
// scripts/test-stripe-flows.ts can assert the transferred amount and the
// idempotency key without a Stripe account. Every caller in the app is
// unchanged.

import type Stripe from 'stripe';
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

// ─── Test seam ────────────────────────────────────────────────────────────────

/**
 * The slice of the Stripe SDK the payout path uses. Narrow on purpose: the real
 * client satisfies it structurally and a stub implements two calls.
 */
export interface ConnectStripeClient {
  accounts:  { retrieve(id: string): Promise<{ details_submitted?: boolean | null }> };
  transfers: {
    create(
      params:   Stripe.TransferCreateParams,
      options?: { idempotencyKey?: string },
    ): Promise<{ id: string }>;
  };
}

// ─── Onboarding status check ──────────────────────────────────────────────────

// `details_submitted` means the expert finished the hosted onboarding form — it
// is NOT the same as `payouts_enabled` (Stripe may still be verifying). The
// webhook's account.updated branch treats either signal as worth a retry sweep
// and lets the transfer itself be the final arbiter.
export async function isOnboardingComplete(
  accountId: string,
  /** Test seam only — see the header. */
  client:    ConnectStripeClient = stripe,
): Promise<boolean> {
  const account = await client.accounts.retrieve(accountId);
  return account.details_submitted === true;
}

// ─── Expert payout transfer ───────────────────────────────────────────────────

/**
 * Idempotency key for one expert payout. Keyed on the CALL, not just on
 * (project, expert): a repeat consultation with the same expert on the same
 * project is a second, genuine payout and must not replay the first one's
 * transfer. `null` (a call nothing identifies) keeps the legacy per-engagement
 * key, which is the fail-closed choice — it can only ever suppress a second
 * transfer, never cause one. Pure.
 */
export function payoutIdempotencyKey(
  projectId: string,
  expertId:  string,
  callId:    string | null,
): string {
  const base = `expert-payout:${projectId}:${expertId}`;
  return callId ? `${base}:${callId}` : base;
}

export async function transferExpertPayout(
  accountId:   string,
  amountCents: number,
  projectId:   string,
  expertId:    string,
  /** The call this payout is for; see payoutIdempotencyKey. */
  callId:      string | null = null,
  /** Test seam only — see the header. */
  client:      ConnectStripeClient = stripe,
): Promise<string> {
  if (amountCents < 50) {
    throw new Error(`[stripeConnect] payout too small: ${amountCents} cents`);
  }

  // Deterministic key per project+expert+call: a webhook retry, or the
  // account.updated retry sweep, replays the ORIGINAL transfer instead of
  // sending the expert's money twice. Note the limit — Stripe only remembers an
  // idempotency key for ~24 hours, so this guard covers the racing/replay
  // window, NOT "forever". The durable guard is the stored paidCallIds list
  // that lib/expertPayout.ts checks before it ever gets here, and which is now
  // written in its own database call the moment the transfer returns.
  const transfer = await client.transfers.create(
    {
      amount:      amountCents,
      currency:    'usd',
      destination: accountId,
      metadata:    { projectId, expertId }, // no PII in metadata
    },
    { idempotencyKey: payoutIdempotencyKey(projectId, expertId, callId) },
  );

  // Log only safe identifiers — never log accountId or transferId
  console.log('[stripe-connect] transfer-initiated', { expertId, projectId });

  return transfer.id;
}

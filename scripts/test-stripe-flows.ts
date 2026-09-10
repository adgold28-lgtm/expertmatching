// scripts/test-stripe-flows.ts — the money paths, end to end, with Stripe
// stubbed (repair-plan brief W3-2).
//
// scripts/test-billing-guard.ts and scripts/test-payout-state.ts assert the pure
// DECISIONS. This script asserts what the code actually DOES with them: it calls
// chargeSavedCard, createAndSendInvoice, runExpertPayout, handleStripeEvent and
// syncOrgSeatQuantity for real, through the injectable deps each of them gained
// for this purpose, and checks the Stripe requests that come out — the amount,
// the metadata, the idempotency key — and the row writes that follow, in order.
//
// Nothing here touches the network, a database, Redis or an environment
// variable: every dependency is a stub declared in this file, and the stubs are
// asserted against, not just satisfied.
//
//   npx tsx scripts/test-stripe-flows.ts
//
// Exits non-zero when any assertion fails, so it can gate a deploy.

import type Stripe from 'stripe';
import type { UpdateExpertInput } from '../lib/projectStore';
import {
  chargeSavedCard,
  chargeIdempotencyKey,
  type ChargeDeps,
  type ChargeStripeClient,
} from '../lib/chargeSavedCard';
import {
  createAndSendInvoice,
  type InvoiceDeps,
  type InvoiceProjectView,
  type InvoiceStripeClient,
} from '../lib/createAndSendInvoice';
import {
  runExpertPayout,
  type PayoutDeps,
  type PayoutProjectView,
} from '../lib/expertPayout';
import {
  isOnboardingComplete,
  payoutIdempotencyKey,
  transferExpertPayout,
  type ConnectStripeClient,
} from '../lib/stripeConnect';
import {
  syncOrgSeatQuantity,
  type SeatSyncBillingRow,
  type SeatSyncDeps,
  type SeatSubscriptionView,
  type SeatSyncStripeClient,
} from '../lib/orgBilling';
import {
  handleStripeEvent,
  type StripeWebhookDeps,
} from '../app/api/webhooks/stripe/handlers';
import { NO_ORG_ENTITLEMENTS } from '../lib/entitlements';
import { callChargeDollars, expertPayoutDollars } from '../lib/pricing';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// Everything below runs inside main(): tsx compiles these scripts to CommonJS,
// where top-level await is not available.
async function main(): Promise<void> {
  // The engagement every section bills: $500/hour to the expert, one hour.
  const PROJECT_ID  = 'proj_1';
  const EXPERT_ID   = 'exp_1';
  const CALL_ID     = 'ics-uid-call-1';
  const EXPERT_RATE = 500;
  const DURATION    = 60;
  const CHARGE_USD  = callChargeDollars(EXPERT_RATE, DURATION);
  const PAYOUT_CENTS = Math.round(expertPayoutDollars(EXPERT_RATE, DURATION) * 100);

  // ── 1. chargeSavedCard: the off-session charge ───────────────────────────────

  interface ChargeEnv {
    deps:    Partial<ChargeDeps>;
    intents: Array<{ params: Stripe.PaymentIntentCreateParams; key?: string }>;
    listed:  string[];
  }

  function chargeEnv(opts: {
    customer?:     string | null;
    defaultPm?:    string | null;
    listedPm?:     string | null;
    deleted?:      boolean;
    legacyUser?:   { stripeCustomerId?: string | null; billingComplete?: boolean } | null;
    createThrows?: unknown;
    status?:       string;
  }): ChargeEnv {
    const intents: ChargeEnv['intents'] = [];
    const listed:  string[] = [];
    const stripe: ChargeStripeClient = {
      customers: {
        retrieve: async (id: string) => {
          if (opts.deleted) return { id, object: 'customer', deleted: true } as Stripe.DeletedCustomer;
          return {
            id,
            invoice_settings: { default_payment_method: opts.defaultPm ?? null },
          } as Stripe.Customer;
        },
      },
      paymentMethods: {
        list: async (params: Stripe.PaymentMethodListParams) => {
          listed.push(String(params.customer ?? ''));
          return { data: opts.listedPm ? [{ id: opts.listedPm }] : [] };
        },
      },
      paymentIntents: {
        create: async (params: Stripe.PaymentIntentCreateParams, options?: { idempotencyKey?: string }) => {
          intents.push({ params, key: options?.idempotencyKey });
          if (opts.createThrows) throw opts.createThrows;
          return { id: 'pi_new_1', status: opts.status ?? 'succeeded' };
        },
      },
    };
    return {
      intents,
      listed,
      deps: {
        stripe,
        getBillingCustomerForProject: async () => opts.customer ?? null,
        getUser: async () => opts.legacyUser ?? null,
      },
    };
  }

  section('chargeSavedCard charges the firm card off-session');
  {
    const env = chargeEnv({ customer: 'cus_org', defaultPm: 'pm_default' });
    const res = await chargeSavedCard(
      { projectId: PROJECT_ID, expertId: EXPERT_ID, ownerEmail: 'owner@firm.com', amount: CHARGE_USD, callId: CALL_ID },
      env.deps,
    );
    eq('outcome is charged',          res.outcome, 'charged');
    eq('the intent id is returned',   res.outcome === 'charged' ? res.paymentIntentId : '', 'pi_new_1');
    eq('exactly one intent created',  env.intents.length, 1);
    const p = env.intents[0]!.params;
    eq('amount is the dollar amount in cents', p.amount, CHARGE_USD * 100);
    eq('currency is usd',             p.currency, 'usd');
    eq('the org customer is charged', p.customer, 'cus_org');
    eq('the default card is used',    p.payment_method, 'pm_default');
    eq('off_session',                 p.off_session, true);
    eq('confirmed in the same call',  p.confirm, true);
    eq('metadata carries the project', p.metadata?.projectId, PROJECT_ID);
    eq('metadata carries the expert',  p.metadata?.expertId, EXPERT_ID);
    check('metadata carries nothing else', Object.keys(p.metadata ?? {}).sort().join(',') === 'expertId,projectId');
    eq('the idempotency key is per CALL', env.intents[0]!.key, chargeIdempotencyKey(PROJECT_ID, EXPERT_ID, CALL_ID));
    eq('...which is the documented shape', env.intents[0]!.key, `charge:${PROJECT_ID}:${EXPERT_ID}:${CALL_ID}`);
    eq('no payment-method list call was needed', env.listed.length, 0);
  }
  {
    const env = chargeEnv({ customer: 'cus_org', defaultPm: null, listedPm: 'pm_saved' });
    const res = await chargeSavedCard(
      { projectId: PROJECT_ID, expertId: EXPERT_ID, ownerEmail: '', amount: CHARGE_USD, callId: CALL_ID },
      env.deps,
    );
    eq('no default → the saved card is found', res.outcome, 'charged');
    eq('the listed card is charged', env.intents[0]!.params.payment_method, 'pm_saved');
    eq('the list was scoped to the customer', env.listed[0], 'cus_org');
  }
  {
    const env = chargeEnv({ customer: null, legacyUser: { stripeCustomerId: 'cus_legacy', billingComplete: true }, defaultPm: 'pm_x' });
    const res = await chargeSavedCard(
      { projectId: PROJECT_ID, expertId: EXPERT_ID, ownerEmail: 'owner@firm.com', amount: CHARGE_USD },
      env.deps,
    );
    eq('no org card → the legacy per-user customer pays', env.intents[0]!.params.customer, 'cus_legacy');
    eq('and it charges', res.outcome, 'charged');
    eq('a call nothing identifies still gets a key', env.intents[0]!.key, `charge:${PROJECT_ID}:${EXPERT_ID}:nocall`);
  }
  {
    const env = chargeEnv({ customer: null, legacyUser: { stripeCustomerId: 'cus_legacy', billingComplete: false } });
    const res = await chargeSavedCard(
      { projectId: PROJECT_ID, expertId: EXPERT_ID, ownerEmail: 'owner@firm.com', amount: CHARGE_USD },
      env.deps,
    );
    eq('a legacy customer without billingComplete is not charged', res.outcome, 'no_saved_card');
    eq('and no intent was created', env.intents.length, 0);
  }
  {
    const env = chargeEnv({ customer: 'cus_org', deleted: true });
    eq('a deleted customer → no_saved_card',
      (await chargeSavedCard({ projectId: PROJECT_ID, expertId: EXPERT_ID, ownerEmail: '', amount: CHARGE_USD }, env.deps)).outcome,
      'no_saved_card');
    eq('and no intent was created', env.intents.length, 0);
  }
  {
    const env = chargeEnv({ customer: 'cus_org', defaultPm: null, listedPm: null });
    eq('a customer with no card at all → no_saved_card',
      (await chargeSavedCard({ projectId: PROJECT_ID, expertId: EXPERT_ID, ownerEmail: '', amount: CHARGE_USD }, env.deps)).outcome,
      'no_saved_card');
  }
  {
    const env = chargeEnv({ customer: 'cus_org', defaultPm: 'pm_1' });
    eq('an amount below Stripe\'s minimum is refused before any call',
      (await chargeSavedCard({ projectId: PROJECT_ID, expertId: EXPERT_ID, ownerEmail: '', amount: 0 }, env.deps)).outcome,
      'no_saved_card');
    eq('and Stripe was never called', env.intents.length, 0);
  }

  section('chargeSavedCard reports declines instead of throwing');
  {
    const env = chargeEnv({
      customer: 'cus_org', defaultPm: 'pm_1',
      createThrows: { code: 'card_declined', payment_intent: { id: 'pi_declined' } },
    });
    const res = await chargeSavedCard(
      { projectId: PROJECT_ID, expertId: EXPERT_ID, ownerEmail: '', amount: CHARGE_USD, callId: CALL_ID },
      env.deps,
    );
    eq('a card_declined error → declined', res.outcome, 'declined');
    eq('the failed intent id is kept', res.outcome === 'declined' ? res.paymentIntentId : '', 'pi_declined');
  }
  {
    const env = chargeEnv({
      customer: 'cus_org', defaultPm: 'pm_1',
      createThrows: { code: 'authentication_required', payment_intent: { id: 'pi_sca' } },
    });
    const res = await chargeSavedCard(
      { projectId: PROJECT_ID, expertId: EXPERT_ID, ownerEmail: '', amount: CHARGE_USD },
      env.deps,
    );
    eq('SCA required → requires_action', res.outcome, 'requires_action');
  }
  {
    const env = chargeEnv({ customer: 'cus_org', defaultPm: 'pm_1', createThrows: new Error('stripe is down') });
    eq('an unexpected Stripe error → error (never a throw)',
      (await chargeSavedCard({ projectId: PROJECT_ID, expertId: EXPERT_ID, ownerEmail: '', amount: CHARGE_USD }, env.deps)).outcome,
      'error');
  }
  {
    const env = chargeEnv({ customer: 'cus_org', defaultPm: 'pm_1', status: 'requires_payment_method' });
    eq('an unconfirmed intent → declined',
      (await chargeSavedCard({ projectId: PROJECT_ID, expertId: EXPERT_ID, ownerEmail: '', amount: CHARGE_USD }, env.deps)).outcome,
      'declined');
  }

  // ── 2. createAndSendInvoice: charge, skip, re-bill, payment link ─────────────

  type InvoiceExpert = InvoiceProjectView['experts'][number];

  interface InvoiceEnv {
    deps:      Partial<InvoiceDeps>;
    row:       InvoiceExpert;
    patches:   UpdateExpertInput[];
    emails:    Array<{ to: string; subject: string }>;
    charges:   Array<{ callId?: string | null; amount: number }>;
    links:     Array<{ params: Stripe.PaymentLinkCreateParams }>;
    prices:    Array<{ params: Stripe.PriceCreateParams }>;
    products:  Array<{ params: Stripe.ProductCreateParams }>;
    customers: Array<{ params: Stripe.CustomerCreateParams }>;
    projectPatches: Array<{ stripeCustomerId?: string | null }>;
    restricted: number;
  }

  function invoiceEnv(opts: {
    expert?:     Partial<InvoiceExpert>;
    charge?:     'charged' | 'declined' | 'no_saved_card';
    canCharge?:  boolean;
    clientEmail?: string | null;
    stripeCustomerId?: string | null;
  }): InvoiceEnv {
    const row: InvoiceExpert = {
      expert: { id: EXPERT_ID, name: 'Dr Example' },
      booking: { icsUid: CALL_ID } as InvoiceExpert['booking'],
      ...opts.expert,
    };
    const env: InvoiceEnv = {
      row,
      patches: [], emails: [], charges: [], links: [], prices: [], products: [],
      customers: [], projectPatches: [], restricted: 0,
      deps: {},
    };
    const stripe: InvoiceStripeClient = {
      customers:    { create: async params => { env.customers.push({ params }); return { id: 'cus_project' }; } },
      products:     { create: async params => { env.products.push({ params }); return { id: 'prod_1' }; } },
      prices:       { create: async params => { env.prices.push({ params }); return { id: 'price_1' }; } },
      paymentLinks: { create: async params => { env.links.push({ params }); return { id: 'plink_1', url: 'https://pay.stripe.test/plink_1' }; } },
    };
    env.deps = {
      stripe,
      getProject: async () => ({
        name:             'Project Alpha',
        ownerEmail:       'owner@firm.com',
        clientName:       'Dana',
        clientEmail:      opts.clientEmail === undefined ? 'client@firm.com' : opts.clientEmail,
        stripeCustomerId: opts.stripeCustomerId ?? null,
        experts:          [row],
      }),
      updateExpertStatus: async (_p, _e, patch) => { env.patches.push(patch); Object.assign(row, patch); return row; },
      updateProjectFields: async (_p, patch) => { env.projectPatches.push(patch); return null; },
      chargeSavedCard: async params => {
        env.charges.push({ callId: params.callId, amount: params.amount });
        if (opts.charge === 'declined')      return { outcome: 'declined', paymentIntentId: 'pi_declined' };
        if (opts.charge === 'no_saved_card') return { outcome: 'no_saved_card' };
        return { outcome: 'charged', paymentIntentId: 'pi_new_1' };
      },
      getEntitlementsForProject: async () => ({ ...NO_ORG_ENTITLEMENTS, canCharge: opts.canCharge !== false }),
      recordRestrictedAttempt: async () => { env.restricted++; },
      sendEmail: async params => { env.emails.push({ to: params.to, subject: params.subject }); },
    };
    return env;
  }

  section('createAndSendInvoice: the charged path writes the intent AND the call id');
  {
    const env = invoiceEnv({ charge: 'charged' });
    const res = await createAndSendInvoice(PROJECT_ID, EXPERT_ID, CHARGE_USD, DURATION, undefined, env.deps);
    check('a result is returned', res !== null);
    eq('charged',                    res?.charged, true);
    eq('the intent id is reported',  res?.paymentIntentId, 'pi_new_1');
    eq('no payment link',            res?.paymentLinkUrl, null);
    eq('the call id came from the booking uid', env.charges[0]?.callId, CALL_ID);
    eq('the charged amount is the caller\'s amount', env.charges[0]?.amount, CHARGE_USD);
    eq('exactly one row write',      env.patches.length, 1);
    eq('it stores the intent id',    env.patches[0]?.stripePaymentIntentId, 'pi_new_1');
    eq('it stores the billed call',  env.patches[0]?.billedCallId, CALL_ID);
    check('it does NOT write paymentStatus (the webhook does)', env.patches[0]?.paymentStatus === undefined);
    eq('a receipt is sent',          env.emails[0]?.subject, 'Receipt for your expert call');
    eq('...to the client contact',   env.emails[0]?.to, 'client@firm.com');
    eq('no payment link was created', env.links.length, 0);
    eq('no product was created',     env.products.length, 0);
  }
  {
    const env = invoiceEnv({ charge: 'charged', expert: { booking: null, zoomMeetingId: 'zoom-9912' } });
    await createAndSendInvoice(PROJECT_ID, EXPERT_ID, CHARGE_USD, DURATION, undefined, env.deps);
    eq('no booking → the Zoom meeting id identifies the call', env.charges[0]?.callId, 'zoom-9912');
  }
  {
    const env = invoiceEnv({ charge: 'charged', expert: { booking: null } });
    await createAndSendInvoice(PROJECT_ID, EXPERT_ID, CHARGE_USD, DURATION, 'manual:proj_1:exp_1:999', env.deps);
    eq('an explicit callId wins', env.charges[0]?.callId, 'manual:proj_1:exp_1:999');
    eq('and it is what is stored', env.patches[0]?.billedCallId, 'manual:proj_1:exp_1:999');
  }

  section('createAndSendInvoice: the durable guard');
  {
    const env = invoiceEnv({ charge: 'charged', expert: { paymentStatus: 'paid', billedCallId: CALL_ID } });
    const res = await createAndSendInvoice(PROJECT_ID, EXPERT_ID, CHARGE_USD, DURATION, CALL_ID, env.deps);
    eq('the same call, completed twice, is not charged again', env.charges.length, 0);
    eq('and nothing is written',                               env.patches.length, 0);
    eq('and no receipt is re-sent',                            env.emails.length, 0);
    check('a result is still returned', res !== null);
  }
  {
    const env = invoiceEnv({
      charge: 'charged',
      expert: { paymentStatus: 'paid', billedCallId: 'old-call', stripePaymentIntentId: 'pi_old', booking: { icsUid: 'new-call' } as InvoiceExpert['booking'] },
    });
    await createAndSendInvoice(PROJECT_ID, EXPERT_ID, CHARGE_USD, DURATION, undefined, env.deps);
    eq('a SECOND genuine call is charged',        env.charges.length, 1);
    eq('the stale paid is cleared first',          env.patches[0]?.paymentStatus, 'unpaid');
    eq('then the new intent is stored',            env.patches[1]?.stripePaymentIntentId, 'pi_new_1');
    eq('with the new call id',                     env.patches[1]?.billedCallId, 'new-call');
    eq('the charge carried the new call id',       env.charges[0]?.callId, 'new-call');
  }
  {
    const env = invoiceEnv({ charge: 'charged', expert: { paymentStatus: 'paid' } });
    await createAndSendInvoice(PROJECT_ID, EXPERT_ID, CHARGE_USD, DURATION, CALL_ID, env.deps);
    eq('a legacy paid row with no billedCallId is never re-charged', env.charges.length, 0);
  }
  {
    const env = invoiceEnv({ charge: 'charged', canCharge: false });
    const res = await createAndSendInvoice(PROJECT_ID, EXPERT_ID, CHARGE_USD, DURATION, CALL_ID, env.deps);
    eq('an org that may not be charged returns null', res, null);
    eq('nothing is charged',                          env.charges.length, 0);
    eq('and the refusal is recorded',                 env.restricted, 1);
  }

  section('createAndSendInvoice: declined → payment link');
  {
    const env = invoiceEnv({ charge: 'declined' });
    const res = await createAndSendInvoice(PROJECT_ID, EXPERT_ID, CHARGE_USD, DURATION, CALL_ID, env.deps);
    eq('not charged',                     res?.charged, false);
    eq('a link is returned',              res?.paymentLinkUrl, 'https://pay.stripe.test/plink_1');
    eq('no intent id is claimed',         res?.paymentIntentId, null);
    eq('a product was created',           env.products.length, 1);
    check('the product names the project, never the expert',
      String(env.products[0]?.params.name).includes('Project Alpha')
      && !String(env.products[0]?.params.name).includes('Dr Example'));
    eq('the price is the amount in cents', env.prices[0]?.params.unit_amount, CHARGE_USD * 100);
    eq('the link carries the project',     env.links[0]?.params.metadata?.projectId, PROJECT_ID);
    eq('the link carries the expert',      env.links[0]?.params.metadata?.expertId, EXPERT_ID);
    eq('the row records the link id',      env.patches[0]?.stripePaymentLinkId, 'plink_1');
    eq('the row records the link url',     env.patches[0]?.stripePaymentLinkUrl, 'https://pay.stripe.test/plink_1');
    eq('the row goes to invoice_sent',     env.patches[0]?.paymentStatus, 'invoice_sent');
    eq('the row records the call billed',  env.patches[0]?.billedCallId, CALL_ID);
    eq('an invoice email is sent',         env.emails[0]?.subject, 'Invoice for your expert call');
    eq('a project Stripe customer is created', env.customers.length, 1);
    eq('...and persisted on the project',  env.projectPatches[0]?.stripeCustomerId, 'cus_project');
  }
  {
    const env = invoiceEnv({ charge: 'no_saved_card', stripeCustomerId: 'cus_existing' });
    await createAndSendInvoice(PROJECT_ID, EXPERT_ID, CHARGE_USD, DURATION, CALL_ID, env.deps);
    eq('no saved card → the link path too', env.links.length, 1);
    eq('an existing project customer is reused', env.customers.length, 0);
  }
  {
    const env = invoiceEnv({ charge: 'declined', clientEmail: null });
    await createAndSendInvoice(PROJECT_ID, EXPERT_ID, CHARGE_USD, DURATION, CALL_ID, env.deps);
    eq('a project with no client email still gets a link', env.links.length, 1);
    eq('but no invoice email is sent',                     env.emails.length, 0);
  }

  // ── 3. The payout: transfer amount, key, and the two writes ──────────────────

  type PayoutRow = PayoutProjectView['experts'][number];

  interface PayoutEnv {
    deps:      Partial<PayoutDeps>;
    row:       PayoutRow;
    patches:   UpdateExpertInput[];
    transfers: Array<{ params: Stripe.TransferCreateParams; key?: string }>;
    failures:  string[];
    reminders: Array<{ email: string; cents: number; url: string }>;
    onboardingComplete: { value: boolean };
  }

  function payoutEnv(opts: { expert?: Partial<PayoutRow>; onboarded?: boolean; account?: string | null } = {}): PayoutEnv {
    const row: PayoutRow = {
      expert:            { id: EXPERT_ID, name: 'Dana Example' },
      contactEmail:      'expert@example.com',
      expertRate:        EXPERT_RATE,
      actualDurationMin: DURATION,
      billedCallId:      CALL_ID,
      booking:           { icsUid: CALL_ID } as PayoutRow['booking'],
      ...opts.expert,
    };
    const env: PayoutEnv = {
      row, patches: [], transfers: [], failures: [], reminders: [],
      onboardingComplete: { value: opts.onboarded !== false },
      deps: {},
    };
    const connect: ConnectStripeClient = {
      accounts:  { retrieve: async () => ({ details_submitted: env.onboardingComplete.value }) },
      transfers: {
        create: async (params: Stripe.TransferCreateParams, options?: { idempotencyKey?: string }) => {
          env.transfers.push({ params, key: options?.idempotencyKey });
          return { id: 'tr_1' };
        },
      },
    };
    env.deps = {
      getProject: async () => ({ experts: [row] }),
      updateExpertStatus: async (_p, _e, patch) => { env.patches.push(patch); Object.assign(row, patch); return row; },
      getConnectAccountId: async () => (opts.account === undefined ? 'acct_expert' : opts.account),
      // The real functions, driven through their own Stripe seam, so the amount
      // guard and the idempotency key under test are the production ones.
      isOnboardingComplete: accountId => isOnboardingComplete(accountId, connect),
      transferExpertPayout: (accountId, cents, projectId, expertId, callId) =>
        transferExpertPayout(accountId, cents, projectId, expertId, callId, connect),
      recordSystemFailure: async input => { env.failures.push(String(input.reason)); },
      generateAvailabilityToken: () => ({ token: 'tok_test' }),
      sendPayoutOnboardingEmail: async (email, _first, cents, url) => { env.reminders.push({ email, cents, url }); },
      now: () => 1_700_000_000_000,
    };
    return env;
  }

  section('runExpertPayout transfers the expert\'s own rate, keyed on the call');
  {
    const env = payoutEnv();
    await runExpertPayout(PROJECT_ID, EXPERT_ID, env.deps);
    eq('exactly one transfer',        env.transfers.length, 1);
    eq('the amount is expertPayoutDollars, in cents', env.transfers[0]?.params.amount, PAYOUT_CENTS);
    check('...which is NOT what the client was charged', PAYOUT_CENTS !== CHARGE_USD * 100);
    eq('currency usd',                env.transfers[0]?.params.currency, 'usd');
    eq('destination is the Connect account', env.transfers[0]?.params.destination, 'acct_expert');
    eq('metadata carries the project', env.transfers[0]?.params.metadata?.projectId, PROJECT_ID);
    eq('metadata carries the expert',  env.transfers[0]?.params.metadata?.expertId, EXPERT_ID);
    check('metadata carries no PII', Object.keys(env.transfers[0]?.params.metadata ?? {}).sort().join(',') === 'expertId,projectId');
    eq('the idempotency key is per call', env.transfers[0]?.key, payoutIdempotencyKey(PROJECT_ID, EXPERT_ID, CALL_ID));
    eq('...which is the documented shape', env.transfers[0]?.key, `expert-payout:${PROJECT_ID}:${EXPERT_ID}:${CALL_ID}`);
    eq('two writes follow the transfer', env.patches.length, 2);
    eq('the FIRST carries the transfer id', env.patches[0]?.stripeTransferId, 'tr_1');
    eq('...and the call it paid for',       env.patches[0]?.paidCallIds?.join(','), CALL_ID);
    check('...and nothing else', Object.keys(env.patches[0] ?? {}).sort().join(',') === 'paidCallIds,stripeTransferId');
    eq('the SECOND is the bookkeeping',     env.patches[1]?.expertOnboardingStatus, 'complete');
    eq('...stamped with the injected clock', env.patches[1]?.expertPaidAt, 1_700_000_000_000);
  }
  {
    const env = payoutEnv({ expert: { paidCallIds: [CALL_ID], stripeTransferId: 'tr_old' } });
    await runExpertPayout(PROJECT_ID, EXPERT_ID, env.deps);
    eq('a call already in paidCallIds is not paid twice', env.transfers.length, 0);
    eq('and nothing is written',                          env.patches.length, 0);
  }
  {
    const env = payoutEnv({ expert: { stripeTransferId: 'tr_legacy', paidCallIds: undefined } });
    await runExpertPayout(PROJECT_ID, EXPERT_ID, env.deps);
    eq('a legacy transferred row with no paidCallIds is not re-paid', env.transfers.length, 0);
  }
  {
    const env = payoutEnv({ expert: { paidCallIds: ['old-call'], stripeTransferId: 'tr_old', billedCallId: 'new-call', booking: null } });
    await runExpertPayout(PROJECT_ID, EXPERT_ID, env.deps);
    eq('a SECOND call is paid again',        env.transfers.length, 1);
    eq('under its own idempotency key',      env.transfers[0]?.key, `expert-payout:${PROJECT_ID}:${EXPERT_ID}:new-call`);
    eq('and the list grows rather than resets', env.patches[0]?.paidCallIds?.join(','), 'old-call,new-call');
  }
  {
    const env = payoutEnv({ expert: { contactEmail: undefined } });
    await runExpertPayout(PROJECT_ID, EXPERT_ID, env.deps);
    eq('an expert with no contact email is not paid', env.transfers.length, 0);
  }
  {
    const env = payoutEnv({ expert: { expertRate: 1, actualDurationMin: 1, callDurationMin: null } });
    await runExpertPayout(PROJECT_ID, EXPERT_ID, env.deps);
    eq('a payout under Stripe\'s 50c minimum is not transferred', env.transfers.length, 0);
  }

  section('account.updated: a payout left pending is retried, not lost');
  {
    const env = payoutEnv({ onboarded: false });
    await runExpertPayout(PROJECT_ID, EXPERT_ID, env.deps);
    eq('unfinished onboarding transfers nothing', env.transfers.length, 0);
    eq('the row is marked pending',               env.patches[0]?.expertOnboardingStatus, 'pending');
    eq('the Connect account is remembered',       env.patches[0]?.stripeConnectAccountId, 'acct_expert');
    eq('one onboarding email is sent',            env.reminders.length, 1);
    eq('...for the expert\'s own share',          env.reminders[0]?.cents, PAYOUT_CENTS);
    check('...with the tokenised link',           (env.reminders[0]?.url ?? '').endsWith('/expert-onboarding/tok_test'));
    eq('the reminder is counted on the row',      env.patches[1]?.payoutReminderCount, 1);

    // The expert finishes Stripe onboarding; account.updated sweeps them up.
    env.onboardingComplete.value = true;
    let sweptAccount = '';
    const webhookDeps: Partial<StripeWebhookDeps> = {
      claimEvent: async () => 'process',
      retryPendingPayoutsForAccount: async accountId => {
        sweptAccount = accountId;
        await runExpertPayout(PROJECT_ID, EXPERT_ID, env.deps);
        return { attempted: 1, paid: 1 };
      },
    };
    await handleStripeEvent(
      stripeEvent('evt_acct_1', 'account.updated', { id: 'acct_expert', payouts_enabled: true }),
      webhookDeps,
    );
    eq('the sweep is asked about the right account', sweptAccount, 'acct_expert');
    eq('and the pending payout now transfers',       env.transfers.length, 1);
    eq('for the right amount',                       env.transfers[0]?.params.amount, PAYOUT_CENTS);
  }
  {
    let swept = 0;
    const deps: Partial<StripeWebhookDeps> = {
      claimEvent: async () => 'process',
      retryPendingPayoutsForAccount: async () => { swept++; return { attempted: 0, paid: 0 }; },
    };
    await handleStripeEvent(stripeEvent('evt_a', 'account.updated', { id: 'acct_x', payouts_enabled: false, details_submitted: false }), deps);
    eq('an account that cannot receive money sweeps nothing', swept, 0);
    await handleStripeEvent(stripeEvent('evt_b', 'account.updated', { id: 'acct_x', details_submitted: true, charges_enabled: true }), deps);
    eq('details_submitted + charges_enabled is enough', swept, 1);
    await handleStripeEvent(stripeEvent('evt_c', 'account.updated', { id: '', payouts_enabled: true }), deps);
    eq('an account with no id sweeps nothing', swept, 1);
  }

  // ── 4. The webhook: paid → payout, and de-duplication ────────────────────────

  /** A Stripe event fixture. Only the fields the branches read are present. */
  function stripeEvent(id: string, type: string, object: unknown): Stripe.Event {
    return { id, type, data: { object } } as unknown as Stripe.Event;
  }

  interface WebhookEnv {
    deps:      Partial<StripeWebhookDeps>;
    patches:   UpdateExpertInput[];
    payouts:   string[];
    failures:  string[];
    mirrored:  Array<{ id: string; status: string }>;
    claimed:   Set<string>;
  }

  function webhookEnv(opts: {
    paymentStatus?: 'paid' | 'refunded' | null;
    intentMetadata?: Record<string, string>;
    redisDown?: boolean;
    onPayout?: (projectId: string, expertId: string) => Promise<void>;
  } = {}): WebhookEnv {
    const claimed = new Set<string>();
    const env: WebhookEnv = { deps: {}, patches: [], payouts: [], failures: [], mirrored: [], claimed };
    env.deps = {
      stripe: {
        paymentIntents: {
          retrieve: async () => ({ metadata: opts.intentMetadata ?? null }),
        },
      },
      // A faithful stand-in for SET NX EX: first claim wins, later ones are
      // duplicates. redisDown models the documented fail-OPEN.
      claimEvent: async eventId => {
        if (opts.redisDown) return 'process';
        if (claimed.has(eventId)) return 'duplicate';
        claimed.add(eventId);
        return 'process';
      },
      updateExpertStatus: async (_p, _e, patch) => { env.patches.push(patch); return null; },
      getProject: async () => ({ experts: [{ expert: { id: EXPERT_ID }, paymentStatus: opts.paymentStatus ?? null }] }),
      runExpertPayout: async (projectId, expertId) => {
        env.payouts.push(`${projectId}:${expertId}`);
        if (opts.onPayout) await opts.onPayout(projectId, expertId);
      },
      retryPendingPayoutsForAccount: async () => ({ attempted: 0, paid: 0 }),
      recordSubscriptionStatus: async (id, status) => { env.mirrored.push({ id, status }); },
      recordSystemFailure: async input => { env.failures.push(String(input.reason)); },
      now: () => 1_700_000_000_000,
    };
    return env;
  }

  const paidIntent = (id = 'pi_new_1') =>
    stripeEvent('evt_paid_1', 'payment_intent.succeeded', { id, metadata: { projectId: PROJECT_ID, expertId: EXPERT_ID } });

  section('payment_intent.succeeded → paid → payout');
  {
    const env = webhookEnv();
    const out = await handleStripeEvent(paidIntent(), env.deps);
    eq('the route answers received',   out.received, true);
    check('and not as a duplicate',    out.duplicate === undefined);
    eq('one row write',                env.patches.length, 1);
    eq('paymentStatus becomes paid',   env.patches[0]?.paymentStatus, 'paid');
    eq('paidAt is stamped',            env.patches[0]?.paidAt, 1_700_000_000_000);
    eq('the intent id is recorded',    env.patches[0]?.stripePaymentIntentId, 'pi_new_1');
    eq('the payout runs once',         env.payouts.join(','), `${PROJECT_ID}:${EXPERT_ID}`);
  }
  {
    const env = webhookEnv();
    const first  = await handleStripeEvent(paidIntent(), env.deps);
    const second = await handleStripeEvent(paidIntent(), env.deps);
    check('the first delivery is processed', first.duplicate === undefined);
    eq('the redelivery is answered as a duplicate', second.duplicate, true);
    eq('and nothing is written a second time',      env.patches.length, 1);
    eq('and the payout does NOT run again',         env.payouts.length, 1);
  }
  {
    // The whole point, stated as money: a redelivered event moves nothing.
    const payout = payoutEnv();
    const env = webhookEnv({ onPayout: async (p, e) => { await runExpertPayout(p, e, payout.deps); } });
    await handleStripeEvent(paidIntent(), env.deps);
    await handleStripeEvent(paidIntent(), env.deps);
    eq('a duplicate event transfers nothing a second time', payout.transfers.length, 1);
  }
  {
    // Fail-open: with Redis down the same event runs twice, and the payout guard
    // is what keeps the expert from being paid twice.
    const payout = payoutEnv();
    const env = webhookEnv({ redisDown: true, onPayout: async (p, e) => { await runExpertPayout(p, e, payout.deps); } });
    await handleStripeEvent(paidIntent(), env.deps);
    await handleStripeEvent(paidIntent(), env.deps);
    eq('with no Redis both deliveries are processed', env.payouts.length, 2);
    eq('but the row guard still allows only one transfer', payout.transfers.length, 1);
  }
  {
    const env = webhookEnv();
    await handleStripeEvent(stripeEvent('evt_x', 'payment_intent.succeeded', { id: 'pi_other', metadata: {} }), env.deps);
    eq('an intent with no engagement metadata is ignored', env.patches.length, 0);
    eq('and no payout runs',                               env.payouts.length, 0);
  }
  {
    const env = webhookEnv();
    await handleStripeEvent(stripeEvent('evt_cs', 'checkout.session.completed', {
      metadata: { projectId: PROJECT_ID, expertId: EXPERT_ID },
      payment_intent: 'pi_link_1',
    }), env.deps);
    eq('the payment-link path also records paid', env.patches[0]?.paymentStatus, 'paid');
    eq('with the session\'s intent id',           env.patches[0]?.stripePaymentIntentId, 'pi_link_1');
    eq('and pays the expert',                     env.payouts.length, 1);
  }
  {
    const env = webhookEnv();
    await handleStripeEvent(stripeEvent('evt_pf', 'payment_intent.payment_failed', {
      id: 'pi_f', metadata: { projectId: PROJECT_ID, expertId: EXPERT_ID },
    }), env.deps);
    eq('a failed payment marks the row failed', env.patches[0]?.paymentStatus, 'failed');
    eq('no payout runs',                        env.payouts.length, 0);
    eq('and it reaches the attention list',     env.failures[0], 'client_payment_failed');
  }

  section('refunds and disputes');
  {
    const env = webhookEnv({ paymentStatus: 'paid' });
    await handleStripeEvent(stripeEvent('evt_ref', 'charge.refunded', {
      id: 'ch_1', metadata: { projectId: PROJECT_ID, expertId: EXPERT_ID },
    }), env.deps);
    eq('the engagement becomes refunded', env.patches[0]?.paymentStatus, 'refunded');
    eq('and a system event is recorded',  env.failures[0], 'refund_or_dispute:refund');
    eq('the payout is NOT reversed',      env.payouts.length, 0);
  }
  {
    const env = webhookEnv({ paymentStatus: 'paid' });
    await handleStripeEvent(stripeEvent('evt_dis', 'charge.dispute.created', {
      id: 'dp_1', metadata: { projectId: PROJECT_ID, expertId: EXPERT_ID },
    }), env.deps);
    eq('a dispute also moves the row to refunded', env.patches[0]?.paymentStatus, 'refunded');
    eq('with its own reason',                      env.failures[0], 'refund_or_dispute:dispute');
  }
  {
    const env = webhookEnv({ paymentStatus: 'refunded' });
    await handleStripeEvent(stripeEvent('evt_ref2', 'charge.refunded', {
      id: 'ch_2', metadata: { projectId: PROJECT_ID, expertId: EXPERT_ID },
    }), env.deps);
    eq('an already-refunded row is not written again', env.patches.length, 0);
    eq('but the alert still fires',                    env.failures.length, 1);
  }
  {
    const env = webhookEnv({ paymentStatus: 'paid', intentMetadata: { projectId: PROJECT_ID, expertId: EXPERT_ID } });
    await handleStripeEvent(stripeEvent('evt_ref3', 'charge.refunded', { id: 'ch_3', payment_intent: 'pi_link_1' }), env.deps);
    eq('a charge with no metadata is resolved through its intent', env.patches[0]?.paymentStatus, 'refunded');
  }
  {
    const env = webhookEnv({ intentMetadata: {} });
    await handleStripeEvent(stripeEvent('evt_ref4', 'charge.refunded', { id: 'ch_4', payment_intent: 'pi_someone_else' }), env.deps);
    eq('a refund on somebody else\'s charge writes nothing', env.patches.length, 0);
    eq('and raises no alert',                                env.failures.length, 0);
  }

  section('subscription mirroring');
  {
    const env = webhookEnv();
    await handleStripeEvent(stripeEvent('evt_su', 'customer.subscription.updated', { id: 'sub_1', status: 'past_due' }), env.deps);
    eq('an update mirrors the status', env.mirrored[0]?.status, 'past_due');
    await handleStripeEvent(stripeEvent('evt_sd', 'customer.subscription.deleted', { id: 'sub_1', status: 'active' }), env.deps);
    eq('a delete is terminal whatever Stripe says', env.mirrored[1]?.status, 'canceled');
    await handleStripeEvent(stripeEvent('evt_inv', 'invoice.payment_failed', {
      id: 'in_1', parent: { subscription_details: { subscription: 'sub_1' } },
    }), env.deps);
    eq('a failed seat invoice mirrors past_due', env.mirrored[2]?.status, 'past_due');
    eq('...for the right subscription',          env.mirrored[2]?.id, 'sub_1');
    await handleStripeEvent(stripeEvent('evt_inv2', 'invoice.payment_failed', { id: 'in_2' }), env.deps);
    eq('a one-off invoice mirrors nothing', env.mirrored.length, 3);
  }

  // ── 5. Seat sync: create once, adopt, resize, cancel at zero ─────────────────

  const PRICE_ID = 'price_seat_v1';
  const ORG_ID   = 'org_1';

  interface SeatEnv {
    deps:     Partial<SeatSyncDeps>;
    created:  Array<{ params: Stripe.SubscriptionCreateParams; key?: string }>;
    updated:  Array<{ id: string; params: Stripe.SubscriptionUpdateParams }>;
    items:    Array<{ id: string; params: Stripe.SubscriptionItemUpdateParams }>;
    listed:   number;
    patches:  Array<Record<string, unknown>>;
    failures: string[];
  }

  function seatSubscription(opts: {
    id?: string; status?: string; itemId?: string; quantity?: number; priceId?: string; cancelAtPeriodEnd?: boolean;
  }): SeatSubscriptionView {
    return {
      id:     opts.id ?? 'sub_1',
      status: opts.status ?? 'active',
      cancel_at_period_end: opts.cancelAtPeriodEnd ?? false,
      items:  { data: [{ id: opts.itemId ?? 'si_1', price: { id: opts.priceId ?? PRICE_ID }, quantity: opts.quantity ?? 1 }] },
    };
  }

  function seatEnv(opts: {
    seats:      number;
    row?:       Partial<SeatSyncBillingRow> | null;
    existing?:  SeatSubscriptionView | null;   // what subscriptions.retrieve returns
    atCustomer?: SeatSubscriptionView[];       // what subscriptions.list returns
    listThrows?: boolean;
    recordFails?: boolean;
  }): SeatEnv {
    const env: SeatEnv = { deps: {}, created: [], updated: [], items: [], listed: 0, patches: [], failures: [] };
    const stripe: SeatSyncStripeClient = {
      subscriptions: {
        retrieve: async () => {
          if (!opts.existing) throw Object.assign(new Error('No such subscription'), { code: 'resource_missing' });
          return opts.existing;
        },
        list: async () => {
          env.listed++;
          if (opts.listThrows) throw new Error('stripe list failed for sub_secret');
          return { data: opts.atCustomer ?? [] };
        },
        create: async (params, options) => {
          env.created.push({ params, key: options?.idempotencyKey });
          return seatSubscription({ id: 'sub_new', quantity: Number(params.items?.[0]?.quantity ?? 0) });
        },
        update: async (id, params) => {
          env.updated.push({ id, params });
          return seatSubscription({ id, cancelAtPeriodEnd: params.cancel_at_period_end === true });
        },
      },
      subscriptionItems: { update: async (id, params) => { env.items.push({ id, params }); return null; } },
    };
    const row: SeatSyncBillingRow | null = opts.row === null ? null : {
      billing_complete:            true,
      stripe_customer_id:          'cus_org',
      stripe_subscription_id:      null,
      stripe_subscription_item_id: null,
      seat_quantity_synced:        0,
      subscription_status:         null,
      ...opts.row,
    };
    env.deps = {
      stripe,
      countActiveSeats:        async () => opts.seats,
      getOrgBillingRow:        async () => row,
      ensureSeatPrice:         async () => PRICE_ID,
      patchBillingRow:         async (_o, patch) => { env.patches.push(patch as Record<string, unknown>); return true; },
      patchBillingRowWithRetry: async (_o, patch) => {
        env.patches.push(patch as Record<string, unknown>);
        return !opts.recordFails;
      },
      recordSystemFailure:     async input => { env.failures.push(input.reason); },
    };
    return env;
  }

  section('seat sync creates one subscription, never two');
  {
    const env = seatEnv({ seats: 3 });
    const res = await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('outcome updated',            res.outcome, 'updated');
    eq('active seats reported',      res.activeSeats, 3);
    eq('Stripe was asked what the customer already has', env.listed, 1);
    eq('one subscription created',   env.created.length, 1);
    eq('at the seat price',          env.created[0]?.params.items?.[0]?.price, PRICE_ID);
    eq('with the seat count',        env.created[0]?.params.items?.[0]?.quantity, 3);
    eq('billed automatically',       env.created[0]?.params.collection_method, 'charge_automatically');
    const createdMetadata = env.created[0]?.params.metadata;
  eq('the org is on the metadata',
    typeof createdMetadata === 'object' && createdMetadata !== null ? createdMetadata.organizationId : undefined,
    ORG_ID);
    eq('under a deterministic key',  env.created[0]?.key, `seat-sub:${ORG_ID}`);
    eq('the row records the subscription', env.patches[0]?.stripe_subscription_id, 'sub_new');
    eq('...and the item',                  env.patches[0]?.stripe_subscription_item_id, 'si_1');
    eq('...and the synced quantity',       env.patches[0]?.seat_quantity_synced, 3);
    eq('no failure recorded',        env.failures.length, 0);
  }
  {
    const env = seatEnv({ seats: 3, recordFails: true });
    await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('a subscription created but unrecorded is escalated', env.failures.length, 1);
    check('...naming only the last four characters of the id',
      env.failures[0] === 'subscription_created_but_unrecorded:_new', env.failures[0]);
  }
  {
    const env = seatEnv({ seats: 2, row: { stripe_subscription_id: 'sub_gone' } });
    await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('a subscription Stripe no longer knows is re-created', env.created.length, 1);
    eq('under a DIFFERENT key, so the cancelled one is not replayed',
      env.created[0]?.key, `seat-sub:${ORG_ID}:sub_gone`);
  }

  section('seat sync adopts a subscription the customer already has (H-23)');
  {
    const existing = seatSubscription({ id: 'sub_orphan', quantity: 1 });
    const env = seatEnv({ seats: 4, atCustomer: [existing] });
    const res = await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('nothing is created',            env.created.length, 0);
    eq('the orphan is recorded',        env.patches[0]?.stripe_subscription_id, 'sub_orphan');
    eq('and resized to the seat count', env.items[0]?.params.quantity, 4);
    eq('on its own item',               env.items[0]?.id, 'si_1');
    eq('outcome updated',               res.outcome, 'updated');
  }
  {
    const env = seatEnv({ seats: 4, atCustomer: [seatSubscription({ id: 'sub_dead', status: 'canceled' })] });
    await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('a canceled subscription is not adopted', env.created.length, 1);
  }
  {
    const env = seatEnv({ seats: 4, atCustomer: [seatSubscription({ id: 'sub_other', priceId: 'price_something_else' })] });
    await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('a subscription for another product is not adopted', env.created.length, 1);
  }
  {
    const env = seatEnv({ seats: 4, listThrows: true });
    const res = await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('if Stripe cannot be listed, nothing is created', env.created.length, 0);
    eq('outcome error',                                  res.outcome, 'error');
    eq('and it reaches the attention list',              env.failures.length, 1);
    check('with Stripe ids stripped from the reason', !env.failures[0]!.includes('sub_secret'), env.failures[0]);
  }

  section('seat sync resizes, and stops billing at zero seats');
  {
    const env = seatEnv({
      seats: 7,
      row:      { stripe_subscription_id: 'sub_1', stripe_subscription_item_id: 'si_1', seat_quantity_synced: 2 },
      existing: seatSubscription({ quantity: 2 }),
    });
    const res = await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('the item quantity is updated', env.items[0]?.params.quantity, 7);
    eq('prorated',                     env.items[0]?.params.proration_behavior, 'create_prorations');
    eq('nothing is created',           env.created.length, 0);
    eq('the mirror is updated',        env.patches[0]?.seat_quantity_synced, 7);
    eq('outcome updated',              res.outcome, 'updated');
  }
  {
    const env = seatEnv({
      seats: 5,
      row:      { stripe_subscription_id: 'sub_1', stripe_subscription_item_id: 'si_1', seat_quantity_synced: 5, subscription_status: 'active' },
      existing: seatSubscription({ quantity: 5 }),
    });
    const res = await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('a quantity that already matches changes nothing at Stripe', env.items.length, 0);
    eq('outcome unchanged', res.outcome, 'unchanged');
    eq('and the mirror is left alone', env.patches.length, 0);
  }
  {
    const env = seatEnv({
      seats: 0,
      row:      { stripe_subscription_id: 'sub_1', stripe_subscription_item_id: 'si_1', seat_quantity_synced: 3 },
      existing: seatSubscription({ quantity: 3 }),
    });
    const res = await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('the last seat cancels at period end', env.updated[0]?.params.cancel_at_period_end, true);
    eq('...without a proration',              env.updated[0]?.params.proration_behavior, 'none');
    check('the quantity is never set to zero', env.items.length === 0);
    eq('the mirror records zero seats',        env.patches[0]?.seat_quantity_synced, 0);
    eq('outcome updated',                      res.outcome, 'updated');
  }
  {
    const env = seatEnv({
      seats: 0,
      row:      { stripe_subscription_id: 'sub_1', stripe_subscription_item_id: 'si_1' },
      existing: seatSubscription({ quantity: 3, cancelAtPeriodEnd: true }),
    });
    const res = await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('an already-winding-down subscription is left alone', env.updated.length, 0);
    eq('outcome unchanged', res.outcome, 'unchanged');
  }
  {
    const env = seatEnv({
      seats: 2,
      row:      { stripe_subscription_id: 'sub_1', stripe_subscription_item_id: 'si_1' },
      existing: seatSubscription({ quantity: 3, cancelAtPeriodEnd: true }),
    });
    const res = await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('a seat returning resumes the subscription', env.updated[0]?.params.cancel_at_period_end, false);
    eq('...with the new quantity in the same call', env.updated[0]?.params.items?.[0]?.quantity, 2);
    eq('outcome updated', res.outcome, 'updated');
  }
  {
    const env = seatEnv({ seats: 0 });
    const res = await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('zero seats and no subscription creates nothing', env.created.length, 0);
    eq('outcome skipped', res.outcome, 'skipped');
  }
  {
    const env = seatEnv({ seats: 3, row: { billing_complete: false } });
    const res = await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('an org with no card on file is never subscribed', env.created.length, 0);
    eq('outcome skipped', res.outcome, 'skipped');
  }
  {
    const env = seatEnv({ seats: 3, row: null });
    const res = await syncOrgSeatQuantity(ORG_ID, env.deps);
    eq('an org with no billing row is skipped', res.outcome, 'skipped');
    eq('and Stripe is never called',            env.listed, 0);
  }

}

// ── Result ───────────────────────────────────────────────────────────────────

main()
  .then(() => {
    summary();
  })
  .catch(err => {
    console.error('FAIL — the script itself threw:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });

// scripts/test-mismatch-guarantee.ts — the ten-minute mismatch guarantee, from
// the window rule to the money (launch pack item 8).
//
//   npx tsx scripts/test-mismatch-guarantee.ts
//
// The offer: "The first ten minutes of every call are on us. Flag a mismatch
// inside ten minutes and nothing is charged; the expert is still paid." Costed
// as: the client is charged nothing, the expert is paid 15 minutes at their own
// agreed rate from platform funds. What this proves:
//
//   the window       start .. start + 10 min + 60 s grace, both ends
//                    inclusive; before is 'not_started', after is
//                    'window_closed'; an unreadable start fails closed.
//   eligibility      scheduled, or completed by a meeting that ended inside the
//                    window; a live booking with an ICS uid; one flag per row;
//                    a replay of the same call is ok-already.
//   the decision     client 0, 'waived', expert 15 minutes; which charges are
//                    "for" the flagged call; what settling a flag does in each
//                    money state.
//   the payout       'waived' releases the payout for exactly the flagged call,
//                    for exactly 15 minutes, once, through the real
//                    runExpertPayout and the real Connect transfer seam.
//   flag after charge the full refund (params, per-call idempotency key), the
//                    'waived' write, the payout, then the webhooks: a late
//                    payment_intent.succeeded is refunded rather than recorded,
//                    and the charge.refunded is expected (no alarm, no hold).
//   no charge        through the Zoom meeting.ended path and the staff override
//                    (both are applyAttendanceOutcome), a cancel after the flag,
//                    the billing backstop in createAndSendInvoice, and the
//                    manual POST …/complete (source order + backstop).
//   the route        POST …/mismatch end to end on the in-memory store: 200 and
//                    the flag, a replay is the same state, each refusal is a
//                    409 with a written line, and the staff attendance route
//                    answers waived for a flagged call.
//   the guard        a collaborator gets 403, an outsider never sees the
//                    project (404), and the route checks access before owner
//                    before it writes.
//
// Nothing here reaches the network: Supabase, Stripe, Upstash and Resend are
// scrubbed from the environment before anything runs, the project store falls
// back to its in-memory implementation, and every Stripe call is a stub that is
// asserted against.

import * as fs from 'fs';
import * as path from 'path';
import type Stripe from 'stripe';
import { NextRequest } from 'next/server';
import type { BookingState, Project, ProjectExpert } from '../types';
import {
  MISMATCH_GRACE_MS,
  MISMATCH_PAYOUT_MINUTES,
  MISMATCH_WINDOW_MS,
  chargeIsForFlaggedCall,
  endedInsideMismatchWindow,
  isWaivedMismatchPayout,
  mismatchBillingDecision,
  mismatchEligibility,
  mismatchPayoutMinutes,
  mismatchRefundIdempotencyKey,
  mismatchSettlement,
  mismatchWindowBounds,
  mismatchWindowState,
  paymentIsForFlaggedCall,
  refundIsForFlaggedCall,
} from '../lib/mismatchGuarantee';
import {
  applyAttendanceOutcome,
  applyClientLateCancelMoney,
  lateCancelCallId,
  recordMismatchRefund,
  settleMismatchFlag,
  type LateCancelDeps,
} from '../lib/lateCancelBilling';
import {
  createAndSendInvoice,
  shouldSkipBilling,
  type InvoiceDeps,
  type InvoiceProjectView,
} from '../lib/createAndSendInvoice';
import { payoutMinutesFor, runExpertPayout, type PayoutDeps } from '../lib/expertPayout';
import { isOnboardingComplete, transferExpertPayout, type ConnectStripeClient } from '../lib/stripeConnect';
import {
  decideRefundTransition,
  handleStripeEvent,
  type MismatchWebhookDeps,
  type StripeWebhookDeps,
} from '../app/api/webhooks/stripe/handlers';
import { NO_ORG_ENTITLEMENTS } from '../lib/entitlements';
import { callChargeDollars, expertPayoutDollars } from '../lib/pricing';
import { requireProjectOwner } from '../lib/projectsGuard';
import {
  addCollaborator,
  createProject,
  getProject,
  getProjectForUser,
  mutateExpert,
  updateExpertStatus,
} from '../lib/projectStore';
import { POST as flagRoute } from '../app/api/projects/[projectId]/experts/[expertId]/mismatch/route';
import { POST as attendanceRoute } from '../app/api/admin/attendance/route';
import { check, eq, summary } from './testHarness';

// No credentials, no network. Every module reads these lazily, at call time.
for (const key of [
  'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'STRIPE_SECRET_KEY',
  'UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN', 'RESEND_API_KEY',
  'APP_AUTH_ENABLED', 'PROJECTS_ADMIN_TOKEN', 'PROJECTS_ENABLED',
]) {
  delete process.env[key];
}
process.env.DISABLE_EMAILS = 'true';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const MIN  = 60_000;
const DAY  = 24 * 60 * MIN;

const PROJECT_ID  = 'proj_1';
const EXPERT_ID   = 'exp_1';
const CALL_ID     = 'ics-uid-call-1';
const EXPERT_RATE = 500;
const START       = '2026-10-14T15:00:00.000Z';
const startMs     = Date.parse(START);
const NOW         = 1_700_000_000_000;

const PAYOUT_15_CENTS = Math.round(expertPayoutDollars(EXPERT_RATE, 15) * 100);
const PAYOUT_60_CENTS = Math.round(expertPayoutDollars(EXPERT_RATE, 60) * 100);

function booking(over: Partial<BookingState> = {}, start = START): BookingState {
  const s = Date.parse(start);
  return {
    startUtc:         start,
    endUtc:           new Date(s + 60 * MIN).toISOString(),
    durationMin:      60,
    zoomMeetingId:    'zm-1',
    icsUid:           CALL_ID,
    icsSequence:      0,
    bookedAt:         s - 5 * DAY,
    rescheduledCount: 0,
    history:          [],
    ...over,
  };
}

function row(over: Partial<ProjectExpert> = {}): ProjectExpert {
  return {
    expert:       { id: EXPERT_ID, name: 'Dana Example' },
    status:       'scheduled',
    contactEmail: 'expert@example.com',
    expertRate:   EXPERT_RATE,
    booking:      booking(),
    ...over,
  } as ProjectExpert;
}

async function main(): Promise<void> {
  // ── 1. The window ──────────────────────────────────────────────────────────

  section('the window: start to ten minutes after, plus a minute of grace');
  eq('the window is ten minutes', MISMATCH_WINDOW_MS, 10 * MIN);
  eq('the grace is sixty seconds', MISMATCH_GRACE_MS, 60_000);
  eq('bounds open at the start',  mismatchWindowBounds(START)?.opensAt, startMs);
  eq('bounds close ten minutes later (no grace)', mismatchWindowBounds(START)?.closesAt, startMs + 10 * MIN);
  eq('one ms before the start',   mismatchWindowState(startMs - 1, START), 'not_started');
  eq('a day before',              mismatchWindowState(startMs - DAY, START), 'not_started');
  eq('the start itself is open',  mismatchWindowState(startMs, START), 'open');
  eq('minute five is open',       mismatchWindowState(startMs + 5 * MIN, START), 'open');
  eq('minute ten exactly is open', mismatchWindowState(startMs + 10 * MIN, START), 'open');
  eq('inside the grace is open',  mismatchWindowState(startMs + 10 * MIN + 30_000, START), 'open');
  eq('the last ms of grace is open', mismatchWindowState(startMs + 10 * MIN + 60_000, START), 'open');
  eq('one ms past the grace is closed', mismatchWindowState(startMs + 10 * MIN + 60_001, START), 'window_closed');
  eq('an hour in is closed',      mismatchWindowState(startMs + 60 * MIN, START), 'window_closed');

  section('the window with no grace (what the browser shows)');
  eq('minute ten exactly is open',  mismatchWindowState(startMs + 10 * MIN, START, 0), 'open');
  eq('one ms after minute ten is closed', mismatchWindowState(startMs + 10 * MIN + 1, START, 0), 'window_closed');
  eq('a negative grace is no grace', mismatchWindowState(startMs + 10 * MIN + 1, START, -5_000), 'window_closed');

  section('the window fails closed');
  eq('an unreadable start is closed', mismatchWindowState(startMs, 'not-a-date'), 'window_closed');
  eq('an empty start is closed',      mismatchWindowState(startMs, ''), 'window_closed');
  eq('a null start is closed',        mismatchWindowState(startMs, null), 'window_closed');
  eq('NaN now is closed',             mismatchWindowState(Number.NaN, START), 'window_closed');
  eq('Infinity now is closed',        mismatchWindowState(Number.POSITIVE_INFINITY, START), 'window_closed');
  eq('unreadable start has no bounds', mismatchWindowBounds('garbage'), null);

  section('a meeting that ended inside the window');
  check('ended at minute 7 is inside',        endedInsideMismatchWindow(startMs + 7 * MIN, START));
  check('ended at minute 10 plus grace is inside', endedInsideMismatchWindow(startMs + 11 * MIN, START));
  check('ended one ms after that is outside', !endedInsideMismatchWindow(startMs + 11 * MIN + 1, START));
  check('no end stamp is outside',            !endedInsideMismatchWindow(null, START));
  check('no grace: minute 10 plus 1 ms is outside', !endedInsideMismatchWindow(startMs + 10 * MIN + 1, START, 0));

  // ── 2. Eligibility ─────────────────────────────────────────────────────────

  section('eligibility');
  {
    const at = startMs + 4 * MIN;
    const ok = mismatchEligibility(row(), at);
    check('a scheduled call inside the window may be flagged', ok.ok);
    eq('...naming the booking uid as the call', ok.ok ? ok.callId : '', CALL_ID);
    eq('...and it is not a replay', ok.ok ? ok.already : true, false);

    const r = (pe: ProjectExpert, now = at) => { const e = mismatchEligibility(pe, now); return e.ok ? 'ok' : e.reason; };
    eq('no booking',                 r(row({ booking: null })), 'not_booked');
    eq('a cancelled booking',        r(row({ booking: booking({ cancelledAt: at - MIN, cancelledBy: 'client' }) })), 'not_booked');
    eq('a booking with no uid',      r(row({ booking: booking({ icsUid: '' }) })), 'not_booked');
    eq('before the start',           r(row(), startMs - MIN), 'not_started');
    eq('after the window',           r(row(), startMs + 12 * MIN), 'window_closed');
    eq('inside the grace still ok',  r(row(), startMs + 10 * MIN + 59_000), 'ok');
    eq('completed by a meeting that ended at minute 7',
      r(row({ status: 'completed', zoomMeetingEndedAt: startMs + 7 * MIN }), startMs + 9 * MIN), 'ok');
    eq('completed with no meeting end (a manual completion)',
      r(row({ status: 'completed', zoomMeetingEndedAt: null })), 'call_not_eligible');
    eq('completed by a meeting that ended after the window',
      r(row({ status: 'completed', zoomMeetingEndedAt: startMs + 11 * MIN + 1 }), startMs + 10 * MIN), 'call_not_eligible');
    eq('an ended engagement (no-show, cancel, removal)',
      r(row({ status: 'rejected_after_outreach' })), 'call_not_eligible');
    eq('another call already flagged on this row',
      r(row({ mismatchCallId: 'an-earlier-call', mismatchFlaggedAt: at - DAY })), 'flagged_other_call');

    const replay = mismatchEligibility(row({ mismatchCallId: CALL_ID, mismatchFlaggedAt: at }), startMs + 30 * MIN);
    check('the same call flagged again is a replay, even after the window', replay.ok && replay.already);
  }

  // ── 3. The billing decision ────────────────────────────────────────────────

  section('the billing decision for a flagged call');
  {
    const d = mismatchBillingDecision();
    eq('the client is charged nothing', d.clientAmount, 0);
    eq('the row says waived',           d.paymentStatus, 'waived');
    eq('the expert is paid 15 minutes', d.expertMinutes, 15);
    eq('...which is the platform minimum', MISMATCH_PAYOUT_MINUTES, 15);

    const flagged = { mismatchCallId: CALL_ID };
    check('the call itself is the flagged call',      chargeIsForFlaggedCall(flagged, CALL_ID));
    check('its late-cancel fee is too',               chargeIsForFlaggedCall(flagged, `${CALL_ID}:late-cancel`));
    check('...which is what lateCancelCallId builds', chargeIsForFlaggedCall(flagged, lateCancelCallId(row())));
    check('another call is not',                      !chargeIsForFlaggedCall(flagged, 'ics-uid-call-2'));
    check('a uid that merely starts the same is not', !chargeIsForFlaggedCall(flagged, `${CALL_ID}0`));
    check('no call id is not',                        !chargeIsForFlaggedCall(flagged, null));
    check('a row with no flag covers nothing',        !chargeIsForFlaggedCall({}, CALL_ID));

    check('waived + the flagged call releases the payout',
      isWaivedMismatchPayout({ paymentStatus: 'waived', mismatchCallId: CALL_ID }, CALL_ID));
    check('waived for a different call does not',
      !isWaivedMismatchPayout({ paymentStatus: 'waived', mismatchCallId: CALL_ID }, 'ics-uid-call-2'));
    check('waived with no flag does not',
      !isWaivedMismatchPayout({ paymentStatus: 'waived' }, CALL_ID));
    check('a flag that is not waived does not',
      !isWaivedMismatchPayout({ paymentStatus: 'unpaid', mismatchCallId: CALL_ID }, CALL_ID));

    eq('the flagged call pays 15 minutes', mismatchPayoutMinutes(flagged, CALL_ID), 15);
    eq('any other call: no opinion',      mismatchPayoutMinutes(flagged, 'other'), null);
    eq('payoutMinutesFor a flagged hour-long call is 15',
      payoutMinutesFor({ actualDurationMin: 60, callDurationMin: 60, mismatchCallId: CALL_ID }, CALL_ID), 15);
    eq('payoutMinutesFor an unflagged hour is 60',
      payoutMinutesFor({ actualDurationMin: 60, callDurationMin: 60 }, CALL_ID), 60);
    eq('the refund key is per call',
      mismatchRefundIdempotencyKey(PROJECT_ID, EXPERT_ID, CALL_ID), `mismatch-refund:${PROJECT_ID}:${EXPERT_ID}:${CALL_ID}`);
  }

  section('settling a flag: what to do in each money state');
  {
    const s = (over: Partial<ProjectExpert>, opts: { callEnded?: boolean } = {}) =>
      mismatchSettlement(row({ mismatchCallId: CALL_ID, ...over }), opts);
    eq('no flag',                        mismatchSettlement(row()).kind, 'not_flagged');
    eq('still running: wait for the end', s({}).kind, 'await_call_end');
    eq('attendance under review: wait',  s({ attendanceReviewPending: true, zoomMeetingEndedAt: startMs + 5 * MIN }).kind, 'await_call_end');
    eq('completed, nothing charged: waive', s({ status: 'completed' }).kind, 'waive');
    eq('ended on another branch: waive',  s({ status: 'rejected_after_outreach' }, { callEnded: true }).kind, 'waive');
    const refund = s({ status: 'completed', billedCallId: CALL_ID, stripePaymentIntentId: 'pi_call', paymentStatus: 'paid' });
    eq('charged and paid: refund',       refund.kind, 'refund');
    eq('...that PaymentIntent',          refund.kind === 'refund' ? refund.paymentIntentId : '', 'pi_call');
    eq('charged, webhook not in yet: refund',
      s({ status: 'completed', billedCallId: CALL_ID, stripePaymentIntentId: 'pi_call', paymentStatus: 'unpaid' }).kind, 'refund');
    eq('a charged fee for the call: refund',
      s({ billedCallId: `${CALL_ID}:late-cancel`, stripePaymentIntentId: 'pi_fee' }, { callEnded: true }).kind, 'refund');
    const link = s({ status: 'completed', billedCallId: CALL_ID, stripePaymentLinkId: 'plink_1', paymentStatus: 'invoice_sent' });
    eq('a payment link sent: cancel it', link.kind, 'cancel_link');
    eq('...that link',                   link.kind === 'cancel_link' ? link.linkId : '', 'plink_1');
    eq('a failed charge: nothing to refund, waive',
      s({ status: 'completed', billedCallId: CALL_ID, stripePaymentIntentId: 'pi_failed', paymentStatus: 'failed' }).kind, 'waive');
    eq('paid with nothing to refund through: a person',
      s({ status: 'completed', billedCallId: CALL_ID, paymentStatus: 'paid' }).kind, 'manual_refund');
    eq('already waived: settled',
      s({ status: 'completed', billedCallId: CALL_ID, paymentStatus: 'waived', stripePaymentIntentId: 'pi_call' }).kind, 'settled');
    eq('a previous call\'s payment on the row: waive this one',
      s({ status: 'completed', billedCallId: 'old-call', stripePaymentIntentId: 'pi_old', paymentStatus: 'paid' }).kind, 'waive');
  }

  section('the webhook\'s view of a flagged call');
  {
    const r = (over: Partial<ProjectExpert>) => row({ mismatchCallId: CALL_ID, billedCallId: CALL_ID, ...over });
    check('a payment on the row\'s own intent is the flagged call\'s', paymentIsForFlaggedCall(r({ stripePaymentIntentId: 'pi_call' }), 'pi_call'));
    check('a link payment not yet on the row is too',  paymentIsForFlaggedCall(r({}), 'pi_link'));
    check('a different intent is not',                 !paymentIsForFlaggedCall(r({ stripePaymentIntentId: 'pi_call' }), 'pi_other'));
    check('a row billed for another call is not',      !paymentIsForFlaggedCall(r({ billedCallId: 'old-call' }), 'pi_call'));
    check('an unflagged row is not',                   !paymentIsForFlaggedCall(row({ billedCallId: CALL_ID }), 'pi_call'));
    check('the refund of the flagged charge is expected', refundIsForFlaggedCall(r({ stripePaymentIntentId: 'pi_call' }), 'pi_call'));
    check('a refund of any other intent is not',       !refundIsForFlaggedCall(r({ stripePaymentIntentId: 'pi_call' }), 'pi_old'));
    check('a refund with no intent is not',            !refundIsForFlaggedCall(r({ stripePaymentIntentId: 'pi_call' }), null));

    const expected = decideRefundTransition('waived', 'refund', true);
    eq('decideRefundTransition: the flagged refund stays waived', expected.paymentStatus, 'waived');
    eq('...writes nothing when already waived',  expected.write, false);
    eq('...and raises no alarm',                 expected.alarm, false);
    eq('...from paid it writes waived',          decideRefundTransition('paid', 'refund', true).write, true);
    const dispute = decideRefundTransition('waived', 'dispute', true);
    eq('a DISPUTE on a flagged call is still a dispute', dispute.paymentStatus, 'refunded');
    eq('...with its alarm',                      dispute.alarm, true);
    eq('an ordinary refund still alarms',        decideRefundTransition('paid', 'refund').alarm, true);
  }

  // ── 4. Stub environments for the money paths ───────────────────────────────

  interface MoneyEnv {
    deps:      Partial<LateCancelDeps>;
    project:   Project;
    pe:        ProjectExpert;
    invoices:  Array<{ amount: number; minutes: number; callId?: string | null }>;
    refunds:   Array<{ params: Stripe.RefundCreateParams; key?: string }>;
    links:     Array<{ id: string; params: Stripe.PaymentLinkUpdateParams }>;
    payouts:   number;
    failures:  string[];
    events:    unknown[];
    removals:  string[];
    transfers: Array<{ params: Stripe.TransferCreateParams; key?: string }>;
  }

  /**
   * The late-cancel / mismatch deps over ONE fixture row, with the real
   * runExpertPayout behind them (and the real Connect transfer, through its own
   * Stripe seam), so a payout assertion is about the production arithmetic.
   */
  function moneyEnv(opts: {
    expert?:        Partial<ProjectExpert>;
    refundThrows?:  unknown;
    refundStatus?:  string;
    linkThrows?:    boolean;
    /** The biller finds the call flagged (the flag landed after the caller's read). */
    flagDuringInvoice?: boolean;
    canCharge?:     boolean;
  } = {}): MoneyEnv {
    const pe = row(opts.expert);
    const project = { id: PROJECT_ID, ownerEmail: 'owner@firm.example', experts: [pe] } as Project;
    const env: MoneyEnv = {
      deps: {}, project, pe, invoices: [], refunds: [], links: [], payouts: 0,
      failures: [], events: [], removals: [], transfers: [],
    };
    const connect: ConnectStripeClient = {
      accounts:  { retrieve: async () => ({ details_submitted: true }) },
      transfers: {
        create: async (params, options) => { env.transfers.push({ params, key: options?.idempotencyKey }); return { id: `tr_${env.transfers.length}` }; },
        createReversal: async () => ({ id: 'trr_1' }),
      },
    };
    const payoutDeps: Partial<PayoutDeps> = {
      getProject: async () => ({ experts: [pe] }),
      getEntitlementsForProject: async () => ({ canCharge: opts.canCharge !== false }),
      updateExpertStatus: async (_p, _e, patch) => { Object.assign(pe, patch); return pe; },
      getConnectAccountId: async () => 'acct_expert',
      isOnboardingComplete: accountId => isOnboardingComplete(accountId, connect),
      transferExpertPayout: (accountId, cents, projectId, expertId, callId) =>
        transferExpertPayout(accountId, cents, projectId, expertId, callId, connect),
      recordSystemFailure: async input => { env.failures.push(String(input.reason)); },
      generateAvailabilityToken: () => ({ token: 'tok_test' }),
      sendPayoutOnboardingEmail: async () => {},
      now: () => NOW,
    };
    env.deps = {
      getEntitlementsForProject: async () => ({ ...NO_ORG_ENTITLEMENTS, canCharge: true }),
      createAndSendInvoice: async (_p, _e, amount, minutes, callId) => {
        env.invoices.push({ amount, minutes, callId });
        if (opts.flagDuringInvoice) {
          pe.mismatchCallId    = CALL_ID;
          pe.mismatchFlaggedAt = startMs + 9 * MIN;
          return { charged: false, paymentLinkUrl: null, paymentIntentId: null, waived: true };
        }
        return { charged: true, paymentLinkUrl: null, paymentIntentId: 'pi_new' };
      },
      patchExpert: async (_p, _e, patch) => { Object.assign(pe, patch); },
      emitEngagementEvent: async input => { env.events.push(input.payload?.who ?? null); },
      recordSystemFailure: async input => { env.failures.push(input.reason); },
      removeExpertForFault: async (_pr, _pe, fault) => { env.removals.push(fault); return { ok: true }; },
      getProject: async () => ({ experts: [pe] }),
      mutateExpert: async (_p, _e, mutate) => { Object.assign(pe, mutate(pe)); },
      mismatchStripe: {
        refunds: {
          create: async (params, options) => {
            env.refunds.push({ params, key: options?.idempotencyKey });
            if (opts.refundThrows) throw opts.refundThrows;
            return { id: 're_1', status: opts.refundStatus ?? 'succeeded' };
          },
        },
        paymentLinks: {
          update: async (id, params) => {
            env.links.push({ id, params });
            if (opts.linkThrows) throw new Error('stripe is down');
            return { id };
          },
        },
      },
      runExpertPayout: async (projectId, expertId) => {
        env.payouts++;
        await runExpertPayout(projectId, expertId, payoutDeps);
      },
      now: () => NOW,
    };
    return env;
  }

  // ── 5. The payout ──────────────────────────────────────────────────────────

  section('a waived flagged call pays the expert exactly 15 minutes, once');
  {
    const env = moneyEnv({ expert: {
      status: 'completed', mismatchCallId: CALL_ID, mismatchFlaggedAt: startMs + 4 * MIN,
      actualDurationMin: 60, callDurationMin: 60,
    } });
    const first = await settleMismatchFlag(PROJECT_ID, EXPERT_ID, {}, env.deps);
    eq('the settlement waives the call',     first.action, 'waive');
    check('...successfully',                 first.ok);
    eq('the row says waived',                env.pe.paymentStatus, 'waived');
    eq('...billed under the flagged call',   env.pe.billedCallId, CALL_ID);
    eq('no refund, no link, no invoice',     env.refunds.length + env.links.length + env.invoices.length, 0);
    eq('one transfer',                       env.transfers.length, 1);
    eq('for 15 minutes at the expert rate',  env.transfers[0]?.params.amount, PAYOUT_15_CENTS);
    check('...not the hour the meeting ran', env.transfers[0]?.params.amount !== PAYOUT_60_CENTS);
    eq('keyed on the flagged call',          env.transfers[0]?.key, `expert-payout:${PROJECT_ID}:${EXPERT_ID}:${CALL_ID}`);
    eq('and the call is recorded as paid out', env.pe.paidCallIds?.join(','), CALL_ID);

    const second = await settleMismatchFlag(PROJECT_ID, EXPERT_ID, {}, env.deps);
    eq('a second settlement finds it settled', second.action, 'settled');
    await runExpertPayout(PROJECT_ID, EXPERT_ID, {
      getProject: async () => ({ experts: [env.pe] }),
      getEntitlementsForProject: async () => ({ canCharge: true }),
      transferExpertPayout: async () => { throw new Error('must not be called'); },
    });
    eq('and a replayed payout transfers nothing more', env.transfers.length, 1);
  }
  {
    // The waived exception covers exactly the flagged call.
    const env = moneyEnv({ expert: {
      status: 'completed', paymentStatus: 'waived', mismatchCallId: 'another-call',
      billedCallId: CALL_ID, actualDurationMin: 30,
    } });
    await env.deps.runExpertPayout!(PROJECT_ID, EXPERT_ID);
    eq('waived for a different call releases nothing', env.transfers.length, 0);
  }
  {
    const env = moneyEnv({ expert: { status: 'completed', paymentStatus: 'waived', billedCallId: CALL_ID } });
    await env.deps.runExpertPayout!(PROJECT_ID, EXPERT_ID);
    eq('waived with no flag releases nothing', env.transfers.length, 0);
  }
  {
    // The entitlement gate still applies to a waived payout.
    const env = moneyEnv({ canCharge: false, expert: { status: 'completed', mismatchCallId: CALL_ID } });
    await settleMismatchFlag(PROJECT_ID, EXPERT_ID, {}, env.deps);
    eq('an account that cannot be charged: no transfer', env.transfers.length, 0);
    eq('...the payout is held where the sweeps see it',  env.pe.expertOnboardingStatus, 'pending');
    check('...and it reaches the attention list', env.failures.includes('payout_held:account_not_chargeable'));
  }
  {
    // Idempotency runs before the entitlement gate: an already-paid flagged
    // call is a no-op even while entitlements fail closed.
    const env = moneyEnv({ canCharge: false, expert: {
      status: 'completed', paymentStatus: 'waived', mismatchCallId: CALL_ID, billedCallId: CALL_ID,
      paidCallIds: [CALL_ID], stripeTransferId: 'tr_done', expertOnboardingStatus: 'complete',
    } });
    await env.deps.runExpertPayout!(PROJECT_ID, EXPERT_ID);
    eq('paid flagged call + closed entitlement: no transfer', env.transfers.length, 0);
    eq('...and the row is not re-held', env.pe.expertOnboardingStatus, 'complete');
  }

  // ── 6. The flag lands after the charge ─────────────────────────────────────

  section('flag after charge: full refund, waived, payout once');
  {
    // The meeting ended at minute 7 and was charged; payment_intent.succeeded
    // has not arrived yet. The client flags at minute 9.
    const env = moneyEnv({ expert: {
      status: 'completed', zoomMeetingEndedAt: startMs + 7 * MIN, actualDurationMin: 7,
      billedCallId: CALL_ID, stripePaymentIntentId: 'pi_call', paymentStatus: 'unpaid',
      mismatchCallId: CALL_ID, mismatchFlaggedAt: startMs + 9 * MIN,
    } });
    const res = await settleMismatchFlag(PROJECT_ID, EXPERT_ID, {}, env.deps);
    eq('the settlement refunds',            res.action, 'refund');
    check('...successfully',                res.ok);
    eq('one refund request',                env.refunds.length, 1);
    eq('...on the call\'s PaymentIntent',   env.refunds[0]?.params.payment_intent, 'pi_call');
    check('...in full (no amount)',         env.refunds[0]?.params.amount === undefined);
    eq('...as requested by the customer',   env.refunds[0]?.params.reason, 'requested_by_customer');
    check('...with no PII in metadata',
      Object.keys(env.refunds[0]?.params.metadata ?? {}).sort().join(',') === 'expertId,projectId');
    eq('...keyed per call',                 env.refunds[0]?.key, mismatchRefundIdempotencyKey(PROJECT_ID, EXPERT_ID, CALL_ID));
    eq('the row says waived',               env.pe.paymentStatus, 'waived');
    eq('...and keeps the refunded intent',  env.pe.stripePaymentIntentId, 'pi_call');
    eq('the expert is paid once',           env.transfers.length, 1);
    eq('...15 minutes',                     env.transfers[0]?.params.amount, PAYOUT_15_CENTS);

    // Now the webhooks arrive, wired to the real settlement over the same row.
    const hookFailures: string[] = [];
    const statusWrites: unknown[] = [];
    const hookDeps: Partial<StripeWebhookDeps & MismatchWebhookDeps> = {
      stripe: { paymentIntents: { retrieve: async () => ({ metadata: { projectId: PROJECT_ID, expertId: EXPERT_ID } }) } },
      claimEvent: async () => 'process',
      completeEvent: async () => {},
      releaseEvent: async () => {},
      getProject: async () => ({ experts: [env.pe] }),
      updateExpertStatus: async (_p, _e, patch) => { statusWrites.push(patch); Object.assign(env.pe, patch); return null; },
      runExpertPayout: env.deps.runExpertPayout,
      recordSystemFailure: async input => { hookFailures.push(input.reason); },
      settleMismatchPayment: async (p, e, intentId) => {
        await settleMismatchFlag(p, e, { paymentIntentId: intentId }, env.deps);
      },
      recordMismatchRefund: (p, e, intentId) => recordMismatchRefund(p, e, intentId, env.deps),
      now: () => NOW,
    };
    await handleStripeEvent({ id: 'evt_paid', type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_call', metadata: { projectId: PROJECT_ID, expertId: EXPERT_ID } } } } as unknown as Stripe.Event, hookDeps);
    eq('the late payment_intent.succeeded is never recorded as paid', env.pe.paymentStatus, 'waived');
    eq('...nothing went through updateExpertStatus', statusWrites.length, 0);
    eq('...the refund was replayed under the same key', env.refunds[1]?.key, env.refunds[0]?.key);
    eq('...and the expert is still paid only once', env.transfers.length, 1);

    await handleStripeEvent({ id: 'evt_refund', type: 'charge.refunded',
      data: { object: { id: 'ch_1', payment_intent: 'pi_call', metadata: { projectId: PROJECT_ID, expertId: EXPERT_ID } } } } as unknown as Stripe.Event, hookDeps);
    eq('charge.refunded keeps waived',        env.pe.paymentStatus, 'waived');
    eq('...raises no alarm',                  hookFailures.length, 0);
    eq('...and never pays twice',             env.transfers.length, 1);
  }
  {
    // payment_intent.succeeded had already run and paid the expert before the
    // flag: the refund still goes out, the payout is not repeated.
    const env = moneyEnv({ expert: {
      status: 'completed', zoomMeetingEndedAt: startMs + 7 * MIN, actualDurationMin: 7,
      billedCallId: CALL_ID, stripePaymentIntentId: 'pi_call', paymentStatus: 'paid',
      paidCallIds: [CALL_ID], stripeTransferId: 'tr_before', expertOnboardingStatus: 'complete',
      mismatchCallId: CALL_ID,
    } });
    const res = await settleMismatchFlag(PROJECT_ID, EXPERT_ID, {}, env.deps);
    eq('paid then flagged: refunded',      res.action, 'refund');
    eq('...the row is waived',             env.pe.paymentStatus, 'waived');
    eq('...and no second transfer',        env.transfers.length, 0);
  }
  {
    const env = moneyEnv({
      refundThrows: Object.assign(new Error('Charge ch_1 has already been refunded.'), { code: 'charge_already_refunded' }),
      expert: { status: 'completed', billedCallId: CALL_ID, stripePaymentIntentId: 'pi_call', paymentStatus: 'paid', mismatchCallId: CALL_ID },
    });
    const res = await settleMismatchFlag(PROJECT_ID, EXPERT_ID, {}, env.deps);
    check('an already-refunded charge counts as refunded', res.ok);
    eq('...and the row is waived', env.pe.paymentStatus, 'waived');
  }
  {
    const env = moneyEnv({
      refundThrows: Object.assign(new Error('api down'), { code: 'api_error' }),
      expert: { status: 'completed', billedCallId: CALL_ID, stripePaymentIntentId: 'pi_call', paymentStatus: 'paid', mismatchCallId: CALL_ID },
    });
    const res = await settleMismatchFlag(PROJECT_ID, EXPERT_ID, {}, env.deps);
    eq('a refund that fails is reported',   res.reason, 'refund_failed');
    eq('...the row is NOT marked waived',   env.pe.paymentStatus, 'paid');
    eq('...nobody is paid on its account',  env.payouts, 0);
    check('...and it is on the attention list', env.failures.includes('mismatch_refund_failed'));
  }
  {
    const env = moneyEnv({
      refundStatus: 'failed',
      expert: { status: 'completed', billedCallId: CALL_ID, stripePaymentIntentId: 'pi_call', paymentStatus: 'paid', mismatchCallId: CALL_ID },
    });
    const res = await settleMismatchFlag(PROJECT_ID, EXPERT_ID, {}, env.deps);
    eq('a refund Stripe answers "failed" is not a refund', res.reason, 'refund_failed');
    eq('...the row stays as it was', env.pe.paymentStatus, 'paid');
  }
  {
    const env = moneyEnv({ expert: {
      status: 'completed', billedCallId: CALL_ID, stripePaymentLinkId: 'plink_1',
      stripePaymentLinkUrl: 'https://pay.stripe.test/plink_1', paymentStatus: 'invoice_sent', mismatchCallId: CALL_ID,
    } });
    const res = await settleMismatchFlag(PROJECT_ID, EXPERT_ID, {}, env.deps);
    eq('an unpaid payment link: cancelled', res.action, 'cancel_link');
    eq('...the link is switched off',       env.links[0]?.params.active, false);
    eq('...that link',                      env.links[0]?.id, 'plink_1');
    eq('...nothing refunded',               env.refunds.length, 0);
    eq('...the row is waived',              env.pe.paymentStatus, 'waived');
    eq('...and the expert is paid 15 minutes', env.transfers[0]?.params.amount, PAYOUT_15_CENTS);
  }
  {
    const env = moneyEnv({ linkThrows: true, expert: {
      status: 'completed', billedCallId: CALL_ID, stripePaymentLinkId: 'plink_1', paymentStatus: 'invoice_sent', mismatchCallId: CALL_ID,
    } });
    await settleMismatchFlag(PROJECT_ID, EXPERT_ID, {}, env.deps);
    check('a link that will not switch off is reported', env.failures.includes('mismatch_payment_link_still_active'));
    eq('...and the call is still waived (a later payment is refunded)', env.pe.paymentStatus, 'waived');
  }
  {
    // The webhook never refunds a payment that is not for a flagged call.
    const env = moneyEnv({ expert: { status: 'completed', billedCallId: CALL_ID, stripePaymentIntentId: 'pi_call' } });
    const res = await settleMismatchFlag(PROJECT_ID, EXPERT_ID, { paymentIntentId: 'pi_call' }, env.deps);
    eq('an unflagged payment is left alone', res.action, 'not_flagged');
    eq('...no refund',                       env.refunds.length, 0);
  }
  {
    const env = moneyEnv({ expert: { status: 'completed', billedCallId: 'old-call', stripePaymentIntentId: 'pi_old', mismatchCallId: CALL_ID } });
    const res = await settleMismatchFlag(PROJECT_ID, EXPERT_ID, { paymentIntentId: 'pi_old' }, env.deps);
    eq('a payment for an earlier call on a flagged row is left alone', res.action, 'not_flagged');
    eq('...no refund', env.refunds.length, 0);
  }

  // ── 7. No charge through any path ──────────────────────────────────────────

  section('the Zoom meeting.ended path and the staff override never charge a flagged call');
  {
    const env = moneyEnv({ expert: { mismatchCallId: CALL_ID, mismatchFlaggedAt: startMs + 4 * MIN } });
    const res = await applyAttendanceOutcome(env.project, env.pe, 'both', { durationMin: 9, endedAt: startMs + 9 * MIN }, env.deps);
    eq('both attended, flagged: nothing charged', env.invoices.length, 0);
    eq('...and nothing claimed',            res.charged, false);
    eq('...waived',                         res.waived, true);
    eq('the row completes',                 env.pe.status, 'completed');
    eq('...with the measured duration',     env.pe.actualDurationMin, 9);
    eq('...and paymentStatus waived',       env.pe.paymentStatus, 'waived');
    eq('the payout ran directly, once',     env.payouts, 1);
    eq('...for 15 minutes',                 env.transfers[0]?.params.amount, PAYOUT_15_CENTS);
    check('a short flagged call raises no extra alarm', !env.failures.includes('mismatch_flagged_call_ran_long'));

    const replay = await applyAttendanceOutcome(env.project, env.pe, 'both', { durationMin: 9 }, env.deps);
    eq('a staff re-run charges nothing either', env.invoices.length, 0);
    eq('...and pays nobody twice',              env.transfers.length, 1);
    eq('...it is still waived',                 replay.waived, true);
  }
  {
    const env = moneyEnv({ expert: { mismatchCallId: CALL_ID } });
    await applyAttendanceOutcome(env.project, env.pe, 'both', { durationMin: 47 }, env.deps);
    eq('a flagged call that ran 47 minutes is still free', env.invoices.length, 0);
    eq('...the expert still gets 15 minutes',  env.transfers[0]?.params.amount, PAYOUT_15_CENTS);
    check('...and staff are told it ran long', env.failures.includes('mismatch_flagged_call_ran_long'));
  }
  {
    const env = moneyEnv({ expert: { mismatchCallId: CALL_ID } });
    const res = await applyAttendanceOutcome(env.project, env.pe, 'client_no_show', { durationMin: 60 }, env.deps);
    eq('client no-show on a flagged call: no fee', env.invoices.length, 0);
    eq('...the engagement still ends',           env.pe.status, 'rejected_after_outreach');
    eq('...the no_show event still names the client', env.events[0], 'client');
    eq('...waived',                              res.waived, true);
    eq('...and the expert who waited is paid 15 minutes', env.transfers[0]?.params.amount, PAYOUT_15_CENTS);
  }
  {
    const env = moneyEnv({ expert: { mismatchCallId: CALL_ID } });
    await applyAttendanceOutcome(env.project, env.pe, 'expert_no_show', { durationMin: 60 }, env.deps);
    eq('expert no-show on a flagged call: no charge', env.invoices.length, 0);
    eq('...no payout',                              env.transfers.length, 0);
    eq('...and the expert is removed as before',    env.removals[0], 'no_show');
  }
  {
    // The flag lands between the attendance read and the biller's read: the
    // backstop refuses and the waiver settles it.
    const env = moneyEnv({ flagDuringInvoice: true });
    const res = await applyAttendanceOutcome(env.project, env.pe, 'both', { durationMin: 9 }, env.deps);
    eq('the biller was asked once',            env.invoices.length, 1);
    eq('...and refused: nothing charged',      res.charged, false);
    eq('...so the result is waived',           res.waived, true);
    eq('...the row is waived',                 env.pe.paymentStatus, 'waived');
    eq('...and the expert is paid 15 minutes', env.transfers[0]?.params.amount, PAYOUT_15_CENTS);
  }
  {
    // Unflagged control: the same call is charged as before.
    const env = moneyEnv();
    const res = await applyAttendanceOutcome(env.project, env.pe, 'both', { durationMin: 47 }, env.deps);
    eq('an unflagged call is charged',     env.invoices[0]?.amount, callChargeDollars(EXPERT_RATE, 47));
    eq('...and reported charged',          res.charged, true);
    check('...and not waived',             res.waived !== true);
  }

  section('a cancel after the flag charges no late-cancel fee');
  {
    const env = moneyEnv({ expert: { mismatchCallId: CALL_ID, booking: booking({ cancelledAt: startMs + 5 * MIN, cancelledBy: 'client', lateCancel: true }), status: 'rejected_after_outreach' } });
    const res = await applyClientLateCancelMoney(env.project, env.pe, env.deps);
    eq('the fee is refused as waived',  res.reason, 'waived');
    eq('nothing was billed',            env.invoices.length, 0);
    eq('the fee was never recorded',    env.pe.lateCancelCallId, undefined);
    eq('the expert is paid 15 minutes', env.transfers[0]?.params.amount, PAYOUT_15_CENTS);
  }

  section('the billing backstop in createAndSendInvoice');
  {
    type InvoiceExpert = InvoiceProjectView['experts'][number];
    const charges: Array<string | null | undefined> = [];
    const links: unknown[] = [];
    const writes: unknown[] = [];
    const invoiceRow: InvoiceExpert = {
      expert: { id: EXPERT_ID, name: 'Dana Example' },
      booking: booking(),
      mismatchCallId: CALL_ID,
    };
    const deps: Partial<InvoiceDeps> = {
      getProject: async () => ({ name: 'P', ownerEmail: 'owner@firm.example', clientEmail: 'c@firm.example', experts: [invoiceRow] }),
      getEntitlementsForProject: async () => ({ ...NO_ORG_ENTITLEMENTS, canCharge: true }),
      recordRestrictedAttempt: async () => {},
      chargeSavedCard: async params => { charges.push(params.callId); return { outcome: 'charged', paymentIntentId: 'pi_x' }; },
      updateExpertStatus: async (_p, _e, patch) => { writes.push(patch); return null; },
      updateProjectFields: async () => null,
      sendEmail: async () => {},
      stripe: {
        customers:    { create: async () => ({ id: 'cus' }) },
        products:     { create: async () => ({ id: 'prod' }) },
        prices:       { create: async () => ({ id: 'price' }) },
        paymentLinks: { create: async () => { links.push(1); return { id: 'plink', url: 'https://pay.stripe.test/x' }; } },
      },
    };
    const res = await createAndSendInvoice(PROJECT_ID, EXPERT_ID, 1000, 60, undefined, deps);
    eq('a flagged call is never charged',      charges.length, 0);
    eq('...no payment link is created',        links.length, 0);
    eq('...nothing is written',                writes.length, 0);
    eq('...and the caller is told why',        res?.waived, true);
    eq('...not charged',                       res?.charged, false);

    const fee = await createAndSendInvoice(PROJECT_ID, EXPERT_ID, 250, 15, `${CALL_ID}:late-cancel`, deps);
    eq('the flagged call\'s fee is not charged either', charges.length, 0);
    eq('...waived',                                      fee?.waived, true);

    invoiceRow.booking = booking({ icsUid: 'ics-uid-call-2' });
    invoiceRow.paymentStatus = 'waived';
    invoiceRow.billedCallId = CALL_ID;
    await createAndSendInvoice(PROJECT_ID, EXPERT_ID, 1000, 60, undefined, deps);
    eq('a genuine second call on the waived row IS charged', charges[0], 'ics-uid-call-2');
    eq('...after the stale waived is cleared',              (writes[0] as { paymentStatus?: string }).paymentStatus, 'unpaid');

    check('the per-call guard treats waived as billed for its own call',
      shouldSkipBilling({ paymentStatus: 'waived', billedCallId: CALL_ID }, CALL_ID));
    check('...and not for another call',
      !shouldSkipBilling({ paymentStatus: 'waived', billedCallId: CALL_ID }, 'ics-uid-call-2'));
  }

  section('the manual POST …/complete checks the flag before it bills');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app/api/projects/[projectId]/experts/[expertId]/complete/route.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function POST'));
    const flagAt    = body.indexOf('chargeIsForFlaggedCall(pe, callId)');
    const replayAt  = body.indexOf('completionReplay(pe, callId');
    const invoiceAt = body.indexOf('createAndSendInvoice(params.projectId');
    check('the complete route checks the flag', flagAt > 0);
    check('...before the replay guard',         flagAt > 0 && flagAt < replayAt);
    check('...before it bills',                 flagAt > 0 && flagAt < invoiceAt);
    check('...and settles the waiver instead',  body.slice(flagAt, replayAt).includes('settleMismatchFlag('));
    check('...answering waived with no link',   body.slice(flagAt, replayAt).includes('waived: true'));
  }

  // ── 8. The Stripe webhook branches, in isolation ───────────────────────────

  section('the webhook: payments and refunds on a flagged call');
  {
    function hook(over: Partial<ProjectExpert>) {
      const pe = row({ mismatchCallId: CALL_ID, billedCallId: CALL_ID, ...over });
      const out = { pe, writes: [] as unknown[], settles: [] as Array<string | null>, recorded: [] as string[], payouts: 0, failures: [] as string[] };
      const deps: Partial<StripeWebhookDeps & MismatchWebhookDeps> = {
        stripe: { paymentIntents: { retrieve: async () => ({ metadata: { projectId: PROJECT_ID, expertId: EXPERT_ID } }) } },
        claimEvent: async () => 'process', completeEvent: async () => {}, releaseEvent: async () => {},
        getProject: async () => ({ experts: [pe] }),
        updateExpertStatus: async (_p, _e, patch) => { out.writes.push(patch); return null; },
        runExpertPayout: async () => { out.payouts++; },
        recordSystemFailure: async input => { out.failures.push(input.reason); },
        settleMismatchPayment: async (_p, _e, intentId) => { out.settles.push(intentId); },
        recordMismatchRefund: async (_p, _e, intentId) => { out.recorded.push(intentId); },
        now: () => NOW,
      };
      return { ...out, deps, get: () => out };
    }
    const evt = (type: string, object: unknown) => ({ id: `evt_${type}_${Math.random()}`, type, data: { object } }) as unknown as Stripe.Event;
    const meta = { projectId: PROJECT_ID, expertId: EXPERT_ID };

    {
      const h = hook({ stripePaymentIntentId: 'pi_call' });
      await handleStripeEvent(evt('payment_intent.succeeded', { id: 'pi_call', metadata: meta }), h.deps);
      eq('payment_intent.succeeded on a flagged call is settled, not paid', h.get().settles.join(','), 'pi_call');
      eq('...no paid write',  h.get().writes.length, 0);
    }
    {
      const h = hook({});
      await handleStripeEvent(evt('checkout.session.completed', { metadata: meta, payment_intent: 'pi_link', payment_status: 'paid' }), h.deps);
      eq('a payment link paid after the flag is settled too', h.get().settles.join(','), 'pi_link');
      eq('...no paid write',  h.get().writes.length, 0);
    }
    {
      const h = hook({ mismatchCallId: null, stripePaymentIntentId: 'pi_call' });
      await handleStripeEvent(evt('payment_intent.succeeded', { id: 'pi_call', metadata: meta }), h.deps);
      eq('an unflagged call is recorded paid as before', (h.get().writes[0] as { paymentStatus?: string })?.paymentStatus, 'paid');
      eq('...and nothing is settled', h.get().settles.length, 0);
    }
    {
      const h = hook({ stripePaymentIntentId: 'pi_call', paymentStatus: 'paid' });
      await handleStripeEvent(evt('charge.refunded', { id: 'ch_1', payment_intent: 'pi_call', metadata: meta }), h.deps);
      eq('the flagged refund is recorded as waived', h.get().recorded.join(','), 'pi_call');
      eq('...no refunded write',                     h.get().writes.length, 0);
      eq('...no alarm',                              h.get().failures.length, 0);
      eq('...and the payout is run, not held',       h.get().payouts, 1);
    }
    {
      const h = hook({ stripePaymentIntentId: 'pi_call', paymentStatus: 'waived' });
      await handleStripeEvent(evt('charge.refunded', { id: 'ch_1', payment_intent: 'pi_call', metadata: meta }), h.deps);
      eq('a refund on an already-waived row writes nothing', h.get().recorded.length + h.get().writes.length, 0);
      eq('...still no alarm', h.get().failures.length, 0);
    }
    {
      const h = hook({ stripePaymentIntentId: 'pi_call', paymentStatus: 'waived' });
      await handleStripeEvent(evt('charge.dispute.created', { id: 'dp_1', payment_intent: 'pi_call', metadata: meta }), h.deps);
      eq('a dispute on a flagged call is still refunded + alarm', (h.get().writes[0] as { paymentStatus?: string })?.paymentStatus, 'refunded');
      eq('...with the dispute reason', h.get().failures[0], 'refund_or_dispute:dispute');
    }
    {
      const h = hook({ stripePaymentIntentId: 'pi_call', paymentStatus: 'paid' });
      await handleStripeEvent(evt('charge.refunded', { id: 'ch_9', payment_intent: 'pi_someone_else', metadata: meta }), h.deps);
      eq('a refund of a different charge on a flagged row is an ordinary refund',
        (h.get().writes[0] as { paymentStatus?: string })?.paymentStatus, 'refunded');
      eq('...with its alarm', h.get().failures[0], 'refund_or_dispute:refund');
    }
    {
      const h = hook({ stripePaymentIntentId: 'pi_call', paymentStatus: 'waived' });
      await handleStripeEvent(evt('payment_intent.payment_failed', { id: 'pi_call', metadata: meta }), h.deps);
      eq('a charge that failed on its own after the waiver writes nothing', h.get().writes.length, 0);
      eq('...and raises no payment-failed alarm', h.get().failures.length, 0);
    }
  }

  // ── 9. The route, end to end, on the in-memory store ───────────────────────
  //
  // With no Supabase credentials and auth off (no APP_AUTH_ENABLED, not
  // production) the routes run as platform staff, which requireProjectOwner
  // lets through exactly as it lets the owner through. The collaborator refusal
  // is proved in section 10.

  async function fixtureProject(over: Partial<ProjectExpert>): Promise<{ projectId: string; expertId: string }> {
    const expertId = `exp-${Math.random().toString(36).slice(2, 10)}`;
    const project = await createProject({
      name: 'Mismatch fixture',
      researchQuestion: 'Who runs the line?',
      experts: [{ expert: {
        id: expertId, name: 'Casey Testperson', title: 'Head of Operations', company: 'Acme Industrial',
        location: 'Boston, MA', category: 'Operator', justification: 'ran the line', relevance_score: 9,
        source_url: 'https://example.com/casey', source_label: 'Example', source_links: [],
      } }],
    }, 'owner@firm.example');
    await mutateExpert(project.id, expertId, current => ({ ...current, ...over, updatedAt: Date.now() }));
    return { projectId: project.id, expertId };
  }

  function flagRequest(projectId: string, expertId: string): NextRequest {
    return new NextRequest(`http://localhost/api/projects/${projectId}/experts/${expertId}/mismatch`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
  }

  async function flag(projectId: string, expertId: string): Promise<{ status: number; body: Record<string, unknown> }> {
    const res = await flagRoute(flagRequest(projectId, expertId), { params: { projectId, expertId } });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  }

  async function rowOf(projectId: string, expertId: string): Promise<ProjectExpert | undefined> {
    return (await getProject(projectId))?.experts.find(e => e.expert.id === expertId);
  }

  section('POST …/mismatch: the flag');
  {
    const liveStart = new Date(Date.now() - 3 * MIN).toISOString();
    const { projectId, expertId } = await fixtureProject({
      status: 'scheduled', expertRate: EXPERT_RATE, booking: booking({ icsUid: 'uid-live-1' }, liveStart),
    });
    const first = await flag(projectId, expertId);
    eq('a call three minutes in is flagged: 200', first.status, 200);
    eq('...the answer says flagged',              first.body.flagged, true);
    const after = await rowOf(projectId, expertId);
    eq('the row names the call',                  after?.mismatchCallId, 'uid-live-1');
    check('...and when',                          typeof after?.mismatchFlaggedAt === 'number');
    eq('the call is still running: nothing billed yet', after?.paymentStatus, undefined);
    const returned = first.body.projectExpert as ProjectExpert | undefined;
    eq('the answer carries the flagged engagement', returned?.mismatchCallId, 'uid-live-1');

    const second = await flag(projectId, expertId);
    eq('a second flag for the same call: 200',    second.status, 200);
    eq('...with the same state',                  (await rowOf(projectId, expertId))?.mismatchFlaggedAt, after?.mismatchFlaggedAt);
  }
  {
    // Two clicks racing: both answer 200, one flag is written.
    const liveStart = new Date(Date.now() - 2 * MIN).toISOString();
    const { projectId, expertId } = await fixtureProject({
      status: 'scheduled', booking: booking({ icsUid: 'uid-race' }, liveStart),
    });
    const [a, b] = await Promise.all([flag(projectId, expertId), flag(projectId, expertId)]);
    eq('racing clicks: the first is 200',  a.status, 200);
    eq('racing clicks: the second is 200', b.status, 200);
    const after = await rowOf(projectId, expertId);
    eq('...one flag, on the call',         after?.mismatchCallId, 'uid-race');
    const third = await flag(projectId, expertId);
    eq('...and a later click is the same state', third.status, 200);
    eq('...the stamp never moves', (await rowOf(projectId, expertId))?.mismatchFlaggedAt, after?.mismatchFlaggedAt);
  }
  {
    const { projectId, expertId } = await fixtureProject({
      status: 'scheduled', booking: booking({ icsUid: 'uid-future' }, new Date(Date.now() + 30 * MIN).toISOString()),
    });
    const res = await flag(projectId, expertId);
    eq('before the call: 409',            res.status, 409);
    eq('...not_started',                  res.body.error, 'not_started');
    check('...with a written line',       typeof res.body.message === 'string' && (res.body.message as string).length > 0);
    eq('...and nothing written',          (await rowOf(projectId, expertId))?.mismatchCallId, undefined);
  }
  {
    const { projectId, expertId } = await fixtureProject({
      status: 'scheduled', booking: booking({ icsUid: 'uid-late' }, new Date(Date.now() - 12 * MIN).toISOString()),
    });
    const res = await flag(projectId, expertId);
    eq('twelve minutes in: 409 window_closed', res.body.error, 'window_closed');
    eq('...and nothing written',               (await rowOf(projectId, expertId))?.mismatchCallId, undefined);
  }
  {
    const s = new Date(Date.now() - 4 * MIN).toISOString();
    const { projectId, expertId } = await fixtureProject({
      status: 'scheduled', booking: booking({ icsUid: 'uid-new' }, s),
      mismatchCallId: 'uid-earlier', mismatchFlaggedAt: Date.now() - DAY,
    });
    const res = await flag(projectId, expertId);
    eq('a second call on a row that used its flag: 409', res.body.error, 'flagged_other_call');
  }
  {
    const s = new Date(Date.now() - 4 * MIN).toISOString();
    const { projectId, expertId } = await fixtureProject({
      status: 'rejected_after_outreach', booking: booking({ icsUid: 'uid-cancelled', cancelledAt: Date.now() - MIN, cancelledBy: 'client' }, s),
    });
    const res = await flag(projectId, expertId);
    eq('a cancelled booking: 409 not_booked', res.body.error, 'not_booked');
  }
  {
    // The meeting ended at minute 5; the client flags at minute 7. Nothing was
    // charged, so the waiver is written on the spot.
    const sMs = Date.now() - 7 * MIN;
    const { projectId, expertId } = await fixtureProject({
      status: 'completed', expertRate: EXPERT_RATE, actualDurationMin: 5,
      zoomMeetingEndedAt: sMs + 5 * MIN, booking: booking({ icsUid: 'uid-ended' }, new Date(sMs).toISOString()),
    });
    const res = await flag(projectId, expertId);
    eq('a call that ended inside the window: 200', res.status, 200);
    const after = await rowOf(projectId, expertId);
    eq('...flagged',                 after?.mismatchCallId, 'uid-ended');
    eq('...and waived on the spot',  after?.paymentStatus, 'waived');
    eq('...under the flagged call',  after?.billedCallId, 'uid-ended');
    // No Supabase: entitlements fail closed, so the payout is parked for the
    // sweeps rather than lost. In production the transfer runs here.
    eq('...the payout is parked where the sweeps look', after?.expertOnboardingStatus, 'pending');
  }
  {
    // Completed by hand, with no meeting end on record: past the guarantee.
    const sMs = Date.now() - 6 * MIN;
    const { projectId, expertId } = await fixtureProject({
      status: 'completed', zoomMeetingEndedAt: null,
      booking: booking({ icsUid: 'uid-manual' }, new Date(sMs).toISOString()),
    });
    const res = await flag(projectId, expertId);
    eq('a call completed with no meeting end: 409', res.body.error, 'call_not_eligible');
    eq('...and nothing written', (await rowOf(projectId, expertId))?.mismatchCallId, undefined);
  }
  {
    // The flag lands after the charge, and there is no Stripe key here: the
    // refund fails CLOSED. The flag stands, the row is not marked waived, and
    // a second click retries the settlement.
    const sMs = Date.now() - 9 * MIN;
    const { projectId, expertId } = await fixtureProject({
      status: 'completed', expertRate: EXPERT_RATE, actualDurationMin: 7, zoomMeetingEndedAt: sMs + 7 * MIN,
      booking: booking({ icsUid: 'uid-charged' }, new Date(sMs).toISOString()),
      billedCallId: 'uid-charged', stripePaymentIntentId: 'pi_live', paymentStatus: 'paid',
    });
    const res = await flag(projectId, expertId);
    eq('flag after charge with Stripe unreachable: still 200', res.status, 200);
    const after = await rowOf(projectId, expertId);
    eq('...the flag stands',                  after?.mismatchCallId, 'uid-charged');
    eq('...the row is not claimed as waived', after?.paymentStatus, 'paid');
    const again = await flag(projectId, expertId);
    eq('...a second click is the same 200',   again.status, 200);
  }

  section('POST /api/admin/attendance respects the flag');
  {
    const sMs = Date.now() - 20 * MIN;
    const { projectId, expertId } = await fixtureProject({
      status: 'scheduled', expertRate: EXPERT_RATE, attendanceReviewPending: true,
      zoomMeetingEndedAt: sMs + 9 * MIN, actualDurationMin: 9,
      booking: booking({ icsUid: 'uid-review' }, new Date(sMs).toISOString()),
      mismatchCallId: 'uid-review', mismatchFlaggedAt: sMs + 4 * MIN,
    });
    const res = await attendanceRoute(new NextRequest('http://localhost/api/admin/attendance', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, expertId, outcome: 'both' }),
    }));
    const body = await res.json() as { ok?: boolean; charged?: boolean; waived?: boolean };
    eq('staff confirm both attended: 200',  res.status, 200);
    eq('...nothing charged',                body.charged, false);
    eq('...waived',                         body.waived, true);
    const after = await rowOf(projectId, expertId);
    eq('the row completes',                 after?.status, 'completed');
    eq('...waived',                         after?.paymentStatus, 'waived');
    eq('...and the review is over',         after?.attendanceReviewPending, false);
  }
  {
    // Control: the same staff answer on an unflagged call attempts the charge.
    const sMs = Date.now() - 20 * MIN;
    const { projectId, expertId } = await fixtureProject({
      status: 'scheduled', expertRate: EXPERT_RATE, attendanceReviewPending: true, actualDurationMin: 30,
      booking: booking({ icsUid: 'uid-plain' }, new Date(sMs).toISOString()),
    });
    const res = await attendanceRoute(new NextRequest('http://localhost/api/admin/attendance', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ projectId, expertId, outcome: 'both' }),
    }));
    const body = await res.json() as { charged?: boolean; waived?: boolean };
    eq('an unflagged call goes to billing as before', body.charged, true);
    eq('...and is not waived', body.waived, false);
  }

  // ── 10. Who may flag ───────────────────────────────────────────────────────

  section('only the owner (or staff) may flag');
  {
    const { projectId } = await fixtureProject({ status: 'scheduled' });
    await addCollaborator(projectId, 'owner@firm.example', 'collab@firm.example');
    const asCollab = await getProjectForUser(projectId, 'collab@firm.example', 'user');
    check('a collaborator can read the project', asCollab !== null);
    const refused = requireProjectOwner(asCollab as Project, { email: 'collab@firm.example', role: 'user' });
    eq('...and is refused the flag: 403', refused?.status, 403);
    eq('...forbidden', (await refused?.json() as { error?: string } | undefined)?.error, 'forbidden');
    const outsider = await getProjectForUser(projectId, 'someone@other.example', 'user');
    eq('an outsider never sees the project (404)', outsider, null);
    const owner = await getProjectForUser(projectId, 'owner@firm.example', 'user');
    eq('the owner passes', requireProjectOwner(owner as Project, { email: 'owner@firm.example', role: 'user' }), null);
    eq('staff pass',       requireProjectOwner(owner as Project, { email: 'staff@expertmatch.example', role: 'admin' }), null);

    const src = fs.readFileSync(path.join(__dirname, '..', 'app/api/projects/[projectId]/experts/[expertId]/mismatch/route.ts'), 'utf8');
    const body = src.slice(src.indexOf('export async function POST'));
    const accessAt = body.indexOf('getProjectForUser(');
    const ownerAt  = body.indexOf('requireProjectOwner(');
    const writeAt  = body.indexOf('mutateExpert(');
    check('the route checks access first (404 for outsiders)', accessAt > 0 && accessAt < ownerAt);
    check('...then the owner (403 for collaborators)',       ownerAt > 0 && ownerAt < writeAt);
    check('...before it writes anything',                    writeAt > ownerAt);
  }

  section('the copy keeps the house rules');
  {
    const ui = fs.readFileSync(path.join(__dirname, '..', 'components/ConversationThread.tsx'), 'utf8');
    for (const line of [
      "Not the right expert? Flag it in the first ten minutes and you won't be charged.",
      "You won't be charged for this call. The expert is still paid for their time.",
      "Flagged. You won't be charged for this call.",
      'Flag a mismatch',
    ]) {
      check(`the card says "${line}"`, ui.includes(line));
      check(`"${line}" has no em dash`, !line.includes('—'));
    }
    const route = fs.readFileSync(path.join(__dirname, '..', 'app/api/projects/[projectId]/experts/[expertId]/mismatch/route.ts'), 'utf8');
    const copy  = route.slice(route.indexOf('const REFUSAL_COPY'), route.indexOf('};', route.indexOf('const REFUSAL_COPY')));
    check('the refusal lines have no em dash', copy.length > 0 && !copy.includes('—'));
    check('the refusal lines name no machinery', !/stripe|refund|payout|webhook|zoom/i.test(copy));
  }
}

main()
  .then(() => summary('mismatch guarantee'))
  .catch(err => {
    console.error('FAIL — the script itself threw:', err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  });

'use client';

// Step 2 of /onboarding — put the FIRM's card on file. Required: the stepper
// will not advance until POST /api/onboarding/billing/confirm returns ok, which
// is what flips organization_billing.billing_complete.
//
// The organization is the paying entity, so the first person from a firm to
// reach this step saves the card and everyone after them sees the
// "already set up" state and continues without entering anything. That state
// comes from the server (POST /api/onboarding/billing → { alreadyComplete }),
// never from client state — a colleague may have saved the card seconds ago.
//
// Stripe is driven through @stripe/stripe-js only (@stripe/react-stripe-js is
// not a dependency of this project), so Elements is mounted imperatively. This
// is the PAYMENT ELEMENT, not the legacy Card Element, so Stripe Link is
// offered and a returning Link user can save a card in two clicks:
//   POST /api/onboarding/billing → { clientSecret, publishableKey, … }
//   loadStripe → elements({ clientSecret, appearance }) → create('payment') → mount(ref)
//   confirmSetup({ elements, redirect: 'if_required' }) → POST /confirm { setupIntentId }
//
// redirect: 'if_required' keeps the in-page flow: card and Link never redirect,
// so confirmSetup resolves here with the SetupIntent and the stepper advances
// without leaving the page. return_url is still supplied because Stripe
// requires one for any method that *could* redirect; it lands back on this step.
//
// The mount target is rendered unconditionally and covered by a skeleton while
// loading — a ref inside a `loading ? … : …` branch is null at the moment the
// async init finishes, which would leave the payment element unmounted forever.
//
// 503 billing_unavailable (NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY unset) is its own
// state, not an error toast: nothing the end user does can fix it. So is 409
// no_organization — the account is not attached to a firm yet, and so is
// 403 champion_required (Wave 5): the firm's FIRST card is the champion's to
// add, so a member is told who to ask instead of being shown a card field they
// are not allowed to use.
//
// champion_required does NOT dead-end onboarding. The step is marked done with
// the 'trial' context, which is the truth of the account until a card exists:
// lib/entitlements keeps the organization in walkthrough — briefs, sourcing and
// bookmarks work, outreach and billing do not — so the member continues to the
// profile step and into the product, and the firm converts when the champion
// adds the card. Nothing here can create a SetupIntent, so nothing is orphaned.

import { useState, useEffect, useRef } from 'react';
import type {
  Stripe, StripeElements, StripePaymentElement, Appearance,
} from '@stripe/stripe-js';
import { formatUsdFromCents } from '../../lib/pricing';
import {
  GOLD, NAVY, MUTED, FAINT,
  MICRO_LS, LABEL_CLASS, BUTTON_CLASS, NOTE_CLASS,
} from './shared';

type InitState =
  | 'loading' | 'ready' | 'unavailable' | 'no_organization' | 'champion_required' | 'failed';

/** Where a blocked customer can reach a human. */
const SUPPORT_EMAIL = 'ashergoldsteinbusiness@gmail.com';

/** Payment Element styling — the house palette, not Stripe's default blue. */
const STRIPE_APPEARANCE: Appearance = {
  theme: 'stripe',
  variables: {
    colorPrimary:    NAVY,
    colorText:       NAVY,
    colorTextPlaceholder: FAINT,
    colorDanger:     '#BE3A2B',
    fontFamily:      'inherit',
    fontSizeBase:    '14px',
    borderRadius:    '0px',
    spacingUnit:     '4px',
  },
};

interface BillingStepProps {
  complete:   boolean;
  /** Firm name from /api/auth/me, so the resumed state can name the firm. */
  orgName?:   string;
  /** 'saved' — this user entered the card; 'already_set_up' — a colleague had. */
  onComplete: (context: 'saved' | 'already_set_up' | 'trial') => void;
  onContinue: () => void;
}

/** Shape of POST /api/onboarding/billing. */
interface BillingInitResponse {
  clientSecret?:       string;
  publishableKey?:     string;
  alreadyComplete?:    boolean;
  /** lib/entitlements.ts: a trial organization skips the card here. */
  trial?:              boolean;
  /** 403 champion_required — who to ask (null when the firm has no champion). */
  championEmail?:      string | null;
  orgName?:            string;
  activeSeats?:        number;
  seatUnitPriceCents?: number;
  error?:              string;
}

interface SeatInfo {
  orgName:            string;
  activeSeats:        number;
  seatUnitPriceCents: number;
}

export default function BillingStep({ complete, orgName, onComplete, onContinue }: BillingStepProps) {
  const [initState, setInitState] = useState<InitState>(complete ? 'ready' : 'loading');
  const [saving,    setSaving]    = useState(false);
  const [error,     setError]     = useState<string | null>(null);
  // True when this firm's card was already on file when the step loaded — the
  // user saves nothing and simply continues.
  const [firmAlreadySetUp, setFirmAlreadySetUp] = useState(false);
  // True when THIS user just entered the card, so the confirmation can say so.
  const [savedByYou,       setSavedByYou]       = useState(false);
  // True for a trial organization: no card is asked for; outreach stays closed.
  const [trialAccount,     setTrialAccount]     = useState(false);
  const [seatInfo,         setSeatInfo]         = useState<SeatInfo | null>(null);
  // Set with initState 'champion_required': the org_admin who can add the card.
  const [championEmail,    setChampionEmail]    = useState<string | null>(null);
  // Set when Stripe confirmed the card but our own confirm call did not land —
  // the card IS saved, so the retry must not re-run confirmSetup.
  const [pendingConfirmId, setPendingConfirmId] = useState<string | null>(null);
  const [attempt,          setAttempt]          = useState(0);

  const cardMountRef    = useRef<HTMLDivElement>(null);
  const stripeRef       = useRef<Stripe | null>(null);
  const elementsRef     = useRef<StripeElements | null>(null);
  const clientSecretRef = useRef<string | null>(null);
  // onComplete identity is not stable across renders; a ref keeps the init
  // effect from re-running (and re-creating SetupIntents) because of it.
  const onCompleteRef = useRef(onComplete);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);

  // ── Create the SetupIntent and mount the payment element ───────────────────
  useEffect(() => {
    // A user resuming with billing already done needs no new SetupIntent.
    if (complete) return;

    let active = true;
    let paymentEl: StripePaymentElement | null = null;

    async function init(): Promise<void> {
      setInitState('loading');
      setError(null);
      try {
        const res = await fetch('/api/onboarding/billing', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({}),
        });
        const data = await res.json().catch(() => ({})) as BillingInitResponse;

        if (res.status === 503 || data.error === 'billing_unavailable') {
          if (active) setInitState('unavailable');
          return;
        }
        if (res.status === 409 || data.error === 'no_organization') {
          if (active) setInitState('no_organization');
          return;
        }
        // The firm's first card is the champion's decision. Read the seat
        // summary first (the refusal carries it) so the firm can be named.
        if (res.status === 403 && data.error === 'champion_required') {
          if (!active) return;
          if (data.orgName) {
            setSeatInfo({
              orgName:            data.orgName,
              activeSeats:        data.activeSeats ?? 0,
              seatUnitPriceCents: data.seatUnitPriceCents ?? 0,
            });
          }
          setChampionEmail(data.championEmail ?? null);
          setInitState('champion_required');
          // Not a dead end — see the header. The account behaves as a trial
          // until the champion adds the card.
          onCompleteRef.current('trial');
          return;
        }

        if (active && data.orgName) {
          setSeatInfo({
            orgName:            data.orgName,
            activeSeats:        data.activeSeats ?? 0,
            seatUnitPriceCents: data.seatUnitPriceCents ?? 0,
          });
        }

        // ── Trial: no card at onboarding ─────────────────────────────────
        if (data.trial) {
          if (!active) return;
          setTrialAccount(true);
          setInitState('ready');
          onCompleteRef.current('trial');
          return;
        }

        // ── A colleague already saved the firm's card ─────────────────────
        if (data.alreadyComplete) {
          if (!active) return;
          setFirmAlreadySetUp(true);
          setInitState('ready');
          // Mark the step done immediately so the stepper unlocks step 3.
          onCompleteRef.current('already_set_up');
          return;
        }

        if (!res.ok || !data.clientSecret || !data.publishableKey) {
          if (active) {
            setInitState('failed');
            setError('We could not start the payment setup. Please try again.');
          }
          return;
        }

        clientSecretRef.current = data.clientSecret;

        const { loadStripe } = await import('@stripe/stripe-js');
        const stripe = await loadStripe(data.publishableKey);
        if (!active) return;
        if (!stripe || !cardMountRef.current) {
          setInitState('failed');
          setError('The payment form could not be loaded. Check that your browser is not blocking Stripe, then try again.');
          return;
        }

        stripeRef.current = stripe;
        // clientSecret on the Elements group is what makes this the
        // Payment Element flow: Stripe reads the SetupIntent and renders every
        // method it allows (card + Link) instead of a bare card field.
        const elements = stripe.elements({
          clientSecret: data.clientSecret,
          appearance:   STRIPE_APPEARANCE,
        });
        paymentEl = elements.create('payment', {
          layout: { type: 'tabs', defaultCollapsed: false },
        });
        paymentEl.mount(cardMountRef.current);
        elementsRef.current = elements;
        setInitState('ready');
      } catch {
        if (active) {
          setInitState('failed');
          setError('We could not reach ExpertMatch. Check your connection and try again.');
        }
      }
    }

    void init();

    return () => {
      active = false;
      paymentEl?.destroy();
      elementsRef.current = null;
    };
  }, [complete, attempt]);

  // ── Actions ────────────────────────────────────────────────────────────────

  /** Tells the server the SetupIntent succeeded; it verifies with Stripe. */
  async function confirmWithServer(setupIntentId: string): Promise<void> {
    try {
      const res = await fetch('/api/onboarding/billing/confirm', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ setupIntentId }),
      });
      const data = await res.json().catch(() => ({})) as { ok?: boolean };
      if (res.ok && data.ok) {
        setPendingConfirmId(null);
        setSavedByYou(true);
        // The card element is torn down by the effect cleanup when `complete`
        // flips — destroying it here too would double-destroy and throw.
        onCompleteRef.current('saved');
      } else {
        setPendingConfirmId(setupIntentId);
        setError('Your card was saved with Stripe, but we could not finish activating it. Retry below — you will not be charged twice.');
      }
    } catch {
      setPendingConfirmId(setupIntentId);
      setError('Your card was saved with Stripe, but we lost the connection before finishing. Retry below — your card will not be entered again.');
    }
  }

  async function handleSave(): Promise<void> {
    const stripe       = stripeRef.current;
    const elements     = elementsRef.current;
    const clientSecret = clientSecretRef.current;
    if (!stripe || !elements || !clientSecret || saving) return;

    setSaving(true);
    setError(null);

    try {
      // redirect: 'if_required' keeps card and Link in-page; return_url is only
      // used by a method that insists on redirecting, and brings the user back
      // to this onboarding step.
      const { setupIntent, error: stripeError } = await stripe.confirmSetup({
        elements,
        confirmParams: { return_url: `${window.location.origin}/onboarding` },
        redirect:      'if_required',
      });

      if (stripeError) {
        setError(stripeError.message ?? 'That card could not be verified. Check the details and try again.');
        return;
      }
      if (!setupIntent?.id) {
        setError('Stripe did not return a confirmation for that card. Please try again.');
        return;
      }

      await confirmWithServer(setupIntent.id);
    } catch {
      setError('Something went wrong while saving your card. Please try again.');
    } finally {
      setSaving(false);
    }
  }

  async function handleRetryConfirm(): Promise<void> {
    if (!pendingConfirmId || saving) return;
    setSaving(true);
    setError(null);
    await confirmWithServer(pendingConfirmId);
    setSaving(false);
  }

  // ── Derived copy ───────────────────────────────────────────────────────────

  const firmLabel = seatInfo?.orgName || orgName || 'your firm';
  const seatLine =
    seatInfo && seatInfo.activeSeats > 0 && seatInfo.seatUnitPriceCents > 0
      ? `Your firm currently has ${seatInfo.activeSeats} ${seatInfo.activeSeats === 1 ? 'seat' : 'seats'} at ` +
        `${formatUsdFromCents(seatInfo.seatUnitPriceCents)}/seat/month — the rate drops as your team grows.`
      : null;

  // `complete` (resumed from the server) and `firmAlreadySetUp` (discovered on
  // this load) render the same "nothing to do" state.
  const showSetUpState = complete || firmAlreadySetUp || trialAccount;

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div>
      <h2 className="font-display mb-2" style={{ color: NAVY, fontSize: '1.25rem', fontWeight: 500 }}>
        {showSetUpState ? 'Billing' : 'Add Your Firm’s Payment Method'}
      </h2>
      <p className="mb-2 leading-relaxed" style={{ color: MUTED, fontSize: '14px', fontWeight: 300 }}>
        {trialAccount
          ? 'No card is needed during your trial. Calls are billed after they happen — 15-minute minimum, then per minute — once your firm adds a card.'
          : 'One card covers your whole firm. Calls are billed after they happen — 15-minute minimum, then per minute. Your seat subscription is billed monthly. This step is required.'}
      </p>
      {seatLine && (
        <p className="mb-6 leading-relaxed" style={{ color: FAINT, fontSize: '12px' }}>
          {seatLine}
        </p>
      )}
      {!seatLine && <div className="mb-6" />}

      {showSetUpState ? (
        <div
          className={`${NOTE_CLASS} mb-6`}
          style={{ borderColor: GOLD, background: 'rgba(198,167,94,0.06)' }}
        >
          <span aria-hidden="true" style={{ color: GOLD }}>✓</span>
          <div>
            <p className="font-medium text-navy">
              {trialAccount
                ? 'Trial account — nothing to add here'
                : savedByYou ? 'Payment method saved' : `Billing is set up for ${firmLabel}`}
            </p>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: MUTED }}>
              {trialAccount
                ? 'You can write a brief, source candidates and bookmark them. Outreach, scheduling and billing unlock when your firm adds a card in Settings → Payment method.'
                : 'Calls and seats are billed to your firm’s card on file. You do not need to enter one.'}
            </p>
          </div>
        </div>
      ) : initState === 'unavailable' ? (
        <div
          className={`${NOTE_CLASS} mb-6`}
          style={{ borderColor: '#B45309', background: 'rgba(180,83,9,0.05)' }}
        >
          <span aria-hidden="true" style={{ color: '#B45309' }}>!</span>
          <div>
            <p className="font-medium" style={{ color: '#B45309' }}>Card setup is temporarily unavailable</p>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: MUTED }}>
              We’ve been notified. Please try again shortly — or contact us and we’ll set this up
              for you. You can’t finish setup until a card is on file.
            </p>
          </div>
        </div>
      ) : initState === 'no_organization' ? (
        <div
          className={`${NOTE_CLASS} mb-6`}
          style={{ borderColor: '#B45309', background: 'rgba(180,83,9,0.05)' }}
        >
          <span aria-hidden="true" style={{ color: '#B45309' }}>!</span>
          <div>
            <p className="font-medium" style={{ color: '#B45309' }}>Your account is not linked to a firm yet</p>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: MUTED }}>
              Billing is charged to the firm, so we cannot set it up until your account is attached to one.
              Contact your ExpertMatch representative — this is fixed on our side, not yours.
            </p>
          </div>
        </div>
      ) : initState === 'champion_required' ? (
        <div
          className={`${NOTE_CLASS} mb-6`}
          style={{ borderColor: GOLD, background: 'rgba(198,167,94,0.06)' }}
        >
          <span aria-hidden="true" style={{ color: GOLD }}>✓</span>
          <div>
            <p className="font-medium text-navy">
              {championEmail
                ? `Ask your champion (${championEmail}) to add a card`
                : `${firmLabel} does not have a card on file yet`}
            </p>
            <p className="mt-1 text-xs leading-relaxed" style={{ color: MUTED }}>
              {championEmail
                ? 'One card covers the whole firm, and it is your firm’s ExpertMatch champion who puts it on file. You can continue now — write a brief, source candidates and bookmark them. Outreach, scheduling and billing unlock the moment they add it.'
                : 'Your firm has no champion set up yet, so nobody here can add the card. Continue for now and contact us — we will sort it out with your team.'}
            </p>
          </div>
        </div>
      ) : (
        <div className="mb-6">
          <label className={LABEL_CLASS} style={MICRO_LS}>Payment details</label>
          <div className="relative">
            {/* Always in the DOM — the Stripe element mounts into this node.
                The Payment Element draws its own bordered fields, so this
                wrapper only reserves space while it loads. */}
            <div ref={cardMountRef} style={{ minHeight: '5.5rem' }} />
            {initState === 'loading' && (
              <div className="absolute inset-0 skeleton" aria-hidden="true" />
            )}
          </div>
          <p className="mt-1.5 text-[11px]" style={{ color: FAINT }}>
            {initState === 'loading'
              ? 'Loading the secure payment form…'
              : 'Handled entirely by Stripe. ExpertMatch never sees your card number.'}
          </p>
        </div>
      )}

      {error && <p role="alert" className="text-xs text-red-600 mb-4 leading-relaxed">{error}</p>}

      {showSetUpState || initState === 'champion_required' ? (
        <button
          type="button"
          onClick={onContinue}
          className={BUTTON_CLASS}
          style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
        >
          Continue
        </button>
      ) : initState === 'unavailable' || initState === 'no_organization' ? (
        // Neither state is the user's fault, but both used to leave the step
        // with no button at all — and onboarding cannot be skipped. Give them
        // the two things that can actually move it: retry, or reach a human.
        <div className="space-y-3">
          <button
            type="button"
            onClick={() => setAttempt(n => n + 1)}
            className={BUTTON_CLASS}
            style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
          >
            Try again
          </button>
          <a
            href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('ExpertMatch billing setup')}`}
            className="block w-full py-3 text-[11px] uppercase font-medium text-center border border-frame transition-colors hover:bg-cream"
            style={{ color: NAVY, letterSpacing: '0.14em' }}
          >
            Contact us
          </a>
        </div>
      ) : pendingConfirmId ? (
        <button
          type="button"
          onClick={() => void handleRetryConfirm()}
          disabled={saving}
          className={BUTTON_CLASS}
          style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
        >
          {saving ? 'Retrying…' : 'Retry activation'}
        </button>
      ) : initState === 'failed' ? (
        <button
          type="button"
          onClick={() => setAttempt(n => n + 1)}
          className={BUTTON_CLASS}
          style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
        >
          Try again
        </button>
      ) : (
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={saving || initState !== 'ready'}
          className={BUTTON_CLASS}
          style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
        >
          {saving ? 'Saving…' : 'Save payment method'}
        </button>
      )}

      {!showSetUpState
        && initState !== 'unavailable'
        && initState !== 'no_organization'
        && initState !== 'champion_required' && (
        <p className="mt-4 text-[11px] text-center leading-relaxed" style={{ color: FAINT }}>
          Your card is stored by Stripe. Calls are charged only after they happen; seats are billed monthly.
        </p>
      )}
    </div>
  );
}

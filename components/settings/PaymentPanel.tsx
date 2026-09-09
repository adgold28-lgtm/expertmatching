'use client';

// /settings → Payment method. Organization-level, like the rest of billing.
//
// READ: GET /api/settings/payment-method. Card details (brand, last4, expiry,
// who added it) go ONLY to the firm's champion (org_role 'org_admin') or a
// platform admin; every other member gets { restricted: true, orgName } and is
// rendered the 'restricted' state below — the firm's economics are not the
// whole team's business.
//
// REPLACE: the firm champion (org_admin) only, reusing the onboarding routes rather than a
// second copy of the Stripe logic:
//   POST /api/onboarding/billing { replace: true } → { clientSecret, publishableKey }
//   stripe.confirmCardSetup(clientSecret, card)
//   POST /api/onboarding/billing/confirm { setupIntentId }
//     → promotes the new payment method to the org customer's default
// The server half of card handling lives in exactly one place; what is here is
// only the browser half — mounting Elements — which cannot live on the server.
//
// Stripe is driven through @stripe/stripe-js only (@stripe/react-stripe-js is
// not a dependency of this project), so Elements is mounted imperatively. The
// mount target is rendered unconditionally while the form is open and covered
// by its own label, because a ref inside a conditional branch is null at the
// moment the async init finishes — which would leave the card field invisible
// forever.
//
// NEVER rendered: the Stripe customer id or payment method id. They never
// reach this component.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Stripe, StripeCardElement } from '@stripe/stripe-js';
import SettingsPanel, { PanelSkeleton, PanelError } from './SettingsPanel';

const NAVY  = '#0B1F3B';
const MUTED = '#5A6B7A';
const FAINT = '#8A9BAD';

const FIELD_BOX =
  'w-full border border-frame bg-cream px-3 py-2.5 transition-colors';

interface CardSummary {
  brand:    string;
  last4:    string;
  expMonth: number;
  expYear:  number;
}

interface PaymentMethodResponse {
  /** Set for members who are not the firm's champion — no card details follow. */
  restricted?:         boolean;
  /** lib/entitlements.ts — 'trial' until a card is on file. */
  accountKind?:        'trial' | 'customer';
  hasCard?:            boolean;
  canReplace?:         boolean;
  orgName?:            string;
  subscriptionStatus?: string | null;
  card?:               CardSummary;
  addedBy?:            string | null;
  error?:              string;
}

type LoadState = 'loading' | 'ready' | 'restricted' | 'no_organization' | 'unavailable' | 'failed';

/** A subscription status worth telling the user about, in their words. */
function subscriptionNotice(status: string | null | undefined): string | null {
  switch (status) {
    case 'past_due':
      return 'A seat payment failed and Stripe is retrying. Replacing the card usually clears it.';
    case 'unpaid':
      return 'Seat payments have stopped after repeated failures. Replace the card to restart them.';
    case 'canceled':
      return 'The seat subscription is canceled. Contact us to restart it.';
    default:
      return null;
  }
}

export default function PaymentPanel() {
  const [state,      setState]      = useState<LoadState>('loading');
  const [data,       setData]       = useState<PaymentMethodResponse>({});
  const [replacing,  setReplacing]  = useState(false);
  const [initing,    setIniting]    = useState(false);
  const [saving,     setSaving]     = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  const [saved,      setSaved]      = useState(false);
  // Set when Stripe confirmed the card but our confirm call did not land — the
  // card IS saved, so a retry must not re-run confirmCardSetup.
  const [pendingConfirmId, setPendingConfirmId] = useState<string | null>(null);

  const cardMountRef  = useRef<HTMLDivElement>(null);
  const stripeRef     = useRef<Stripe | null>(null);
  const cardElRef     = useRef<StripeCardElement | null>(null);
  const clientSecretRef = useRef<string | null>(null);

  // ── Read the current card ──────────────────────────────────────────────────

  const load = useCallback(async (): Promise<void> => {
    setState('loading');
    setError(null);
    try {
      const res  = await fetch('/api/settings/payment-method');
      const body = await res.json().catch(() => ({})) as PaymentMethodResponse;

      if (res.status === 409 || body.error === 'no_organization') {
        setState('no_organization');
        return;
      }
      if (res.status === 503 || body.error === 'billing_unavailable') {
        setState('unavailable');
        return;
      }
      if (!res.ok) { setState('failed'); return; }

      setData(body);
      setState(body.restricted ? 'restricted' : 'ready');
    } catch {
      setState('failed');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // ── Mount the card element while the replace form is open ──────────────────

  useEffect(() => {
    if (!replacing) return;

    let active = true;
    let cardEl: StripeCardElement | null = null;

    async function init(): Promise<void> {
      setIniting(true);
      setError(null);
      try {
        const res = await fetch('/api/onboarding/billing', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ replace: true }),
        });
        const body = await res.json().catch(() => ({})) as {
          clientSecret?: string; publishableKey?: string; error?: string;
        };

        if (!active) return;

        if (res.status === 403) {
          setError('Only your firm’s champion can change the card.');
          setReplacing(false);
          return;
        }
        if (res.status === 503 || body.error === 'billing_unavailable') {
          setError('Card payments are not available right now. Try again shortly.');
          setReplacing(false);
          return;
        }
        if (!res.ok || !body.clientSecret || !body.publishableKey) {
          setError('We could not start the card update. Please try again.');
          return;
        }

        clientSecretRef.current = body.clientSecret;

        const { loadStripe } = await import('@stripe/stripe-js');
        const stripe = await loadStripe(body.publishableKey);
        if (!active) return;

        if (!stripe || !cardMountRef.current) {
          setError('The payment form could not be loaded. Check that your browser is not blocking Stripe, then try again.');
          return;
        }

        stripeRef.current = stripe;
        cardEl = stripe.elements().create('card', {
          style: {
            base: {
              color:      NAVY,
              fontFamily: 'inherit',
              fontSize:   '14px',
              '::placeholder': { color: FAINT },
            },
            invalid: { color: '#DC2626' },
          },
        });
        cardEl.mount(cardMountRef.current);
        cardElRef.current = cardEl;
      } catch {
        if (active) setError('We could not reach ExpertMatch. Check your connection and try again.');
      } finally {
        if (active) setIniting(false);
      }
    }

    void init();

    return () => {
      active = false;
      cardEl?.unmount();
      cardEl?.destroy();
      cardElRef.current = null;
    };
  }, [replacing]);

  // ── Save the new card ──────────────────────────────────────────────────────

  async function confirmWithServer(setupIntentId: string): Promise<boolean> {
    const res = await fetch('/api/onboarding/billing/confirm', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ setupIntentId }),
    });
    return res.ok;
  }

  async function submit(): Promise<void> {
    setSaving(true);
    setError(null);
    try {
      // A previous attempt already got the card into Stripe; only our own
      // confirm call failed. Retry that half alone.
      if (pendingConfirmId) {
        if (await confirmWithServer(pendingConfirmId)) {
          setPendingConfirmId(null);
          finish();
        } else {
          setError('Your card was saved, but we could not finish updating it. Try once more.');
        }
        return;
      }

      const stripe = stripeRef.current;
      const card   = cardElRef.current;
      const secret = clientSecretRef.current;
      if (!stripe || !card || !secret) {
        setError('The payment form is not ready yet. Give it a moment and try again.');
        return;
      }

      const result = await stripe.confirmCardSetup(secret, { payment_method: { card } });

      if (result.error) {
        setError(result.error.message ?? 'That card could not be saved. Check the details and try again.');
        return;
      }

      const setupIntentId = result.setupIntent?.id;
      if (!setupIntentId) {
        setError('That card could not be saved. Check the details and try again.');
        return;
      }

      if (await confirmWithServer(setupIntentId)) {
        finish();
      } else {
        // The card IS on the customer — remember it so the retry skips Stripe.
        setPendingConfirmId(setupIntentId);
        setError('Your card was saved, but we could not finish updating it. Try once more.');
      }
    } catch {
      setError('We could not reach ExpertMatch. Check your connection and try again.');
    } finally {
      setSaving(false);
    }
  }

  function finish(): void {
    setReplacing(false);
    setSaved(true);
    clientSecretRef.current = null;
    void load();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  const notice = subscriptionNotice(data.subscriptionStatus);

  return (
    <SettingsPanel
      title="Payment method"
      description={
        state === 'ready'
          ? `One card covers everyone at ${data.orgName ?? 'your firm'} — seats and expert calls.`
          : undefined
      }
    >
      {state === 'loading' && <PanelSkeleton lines={2} />}

      {state === 'failed' && (
        <PanelError
          message="We could not load the firm’s payment method."
          onRetry={() => { void load(); }}
        />
      )}

      {state === 'restricted' && (
        <p className="text-xs leading-relaxed" style={{ color: MUTED }}>
          One card covers everyone at {data.orgName ?? 'your firm'}. Billing is handled by your
          firm’s champion — ask them if a call could not be billed.
        </p>
      )}

      {state === 'no_organization' && (
        <p className="text-xs leading-relaxed" style={{ color: MUTED }}>
          This account is not attached to a firm yet, so there is no billing to show.
        </p>
      )}

      {state === 'unavailable' && (
        <p className="text-xs leading-relaxed" style={{ color: MUTED }}>
          Card payments are not available right now. Nothing is wrong with your account —
          try again shortly.
        </p>
      )}

      {state === 'ready' && (
        <>
          {/* ── Current card ────────────────────────────────────────────── */}
          {data.hasCard && data.card ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1 text-sm">
              <span className="text-ink">Card on file</span>
              <span aria-hidden="true" style={{ color: FAINT }}>·</span>
              <span className="text-ink font-medium">
                {data.card.brand} ····{data.card.last4}
              </span>
              {data.addedBy && (
                <>
                  <span aria-hidden="true" style={{ color: FAINT }}>·</span>
                  <span style={{ color: MUTED }}>added by {data.addedBy}</span>
                </>
              )}
            </div>
          ) : (
            <p className="text-sm text-ink">
              No card on file. Expert calls cannot be billed until there is one.
            </p>
          )}

          {data.hasCard && data.card && data.card.expMonth > 0 && (
            <p className="mt-1 text-[11px]" style={{ color: FAINT }}>
              Expires {String(data.card.expMonth).padStart(2, '0')}/{data.card.expYear}
            </p>
          )}

          {notice && (
            <p role="alert" className="mt-3 text-xs leading-relaxed text-red-600">{notice}</p>
          )}

          {saved && !replacing && (
            <p role="status" className="mt-3 text-xs" style={{ color: NAVY }}>
              Card updated.
            </p>
          )}

          {/* ── Replace ─────────────────────────────────────────────────── */}
          {data.accountKind === 'trial' && !data.hasCard && (
            <p className="mt-3 text-xs leading-relaxed" style={{ color: MUTED }}>
              Trial account. Adding a card activates the firm: Matchy can then write to experts, book
              calls and bill them, and the monthly seat subscription starts.
            </p>
          )}

          {!data.canReplace ? (
            <p className="mt-4 text-[11px] leading-relaxed" style={{ color: FAINT }}>
              Only your firm’s champion can change the card.
            </p>
          ) : !replacing ? (
            <button
              type="button"
              onClick={() => { setReplacing(true); setSaved(false); setError(null); }}
              className="mt-4 w-full sm:w-auto px-5 py-2.5 text-[10px] uppercase font-medium border transition-colors hover:bg-navy hover:text-white"
              style={{ color: NAVY, borderColor: NAVY, letterSpacing: '0.14em' }}
            >
              {data.hasCard ? 'Replace card' : data.accountKind === 'trial' ? 'Add a card to activate' : 'Add a card'}
            </button>
          ) : (
            <div className="mt-4">
              <label
                htmlFor="settings-card"
                className="block text-[10px] uppercase tracking-widest text-muted mb-1.5"
                style={{ letterSpacing: '0.14em' }}
              >
                New card
              </label>
              {/* Mounted unconditionally while open — see the file header. */}
              <div id="settings-card" ref={cardMountRef} className={FIELD_BOX} />
              {initing && (
                <p className="mt-1.5 text-[11px]" style={{ color: FAINT }}>
                  Loading the secure card field…
                </p>
              )}
              <p className="mt-1.5 text-[11px] leading-relaxed" style={{ color: FAINT }}>
                Card details go straight to Stripe. ExpertMatch never sees the number.
              </p>

              <div className="flex flex-col sm:flex-row gap-2 mt-4">
                <button
                  type="button"
                  onClick={() => { void submit(); }}
                  disabled={saving || initing}
                  className="flex-1 py-2.5 px-5 text-[10px] uppercase font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
                >
                  {saving ? 'Saving…' : 'Save card'}
                </button>
                <button
                  type="button"
                  onClick={() => { setReplacing(false); setError(null); setPendingConfirmId(null); }}
                  disabled={saving}
                  className="flex-1 py-2.5 px-5 text-[10px] uppercase font-medium border transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  style={{ color: MUTED, borderColor: '#DDE2E8', letterSpacing: '0.14em' }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {error && (
            <p role="alert" className="mt-3 text-xs leading-relaxed text-red-600">{error}</p>
          )}
        </>
      )}
    </SettingsPanel>
  );
}

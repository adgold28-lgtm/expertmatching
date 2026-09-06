'use client';

// /onboarding — the three required setup steps: calendar → billing → profile.
//
// The step is NOT client state that survives only until the next reload. Both
// prerequisites are server-verified and re-read on every mount:
//   GET /api/onboarding/calendar/status  → { connected, provider }
//   GET /api/auth/me                     → { billingComplete, firstName, … }
// so a refresh, or the Google OAuth round-trip that leaves and re-enters this
// page, lands on the first genuinely incomplete step instead of step 1.
//
// Google returns here as /onboarding?calendar=connected or ?calendar_error=<code>.
// Those params are read once on mount, translated into a banner, and stripped
// with router.replace so a later refresh cannot resurrect a stale message.
//
// Forward navigation is gated on the same server state; the profile route
// re-checks it again server-side (409 onboarding_steps_incomplete), so a user
// who edits client state cannot unlock the app early.

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import CalendarStep, { type CalendarProvider } from '../../components/onboarding/CalendarStep';
import BillingStep from '../../components/onboarding/BillingStep';
import ProfileStep, { type ProfileSeed } from '../../components/onboarding/ProfileStep';
import { GOLD, NAVY, MUTED, FAINT } from '../../components/onboarding/shared';

type Step = 1 | 2 | 3;

const STEP_LABELS: Record<Step, string> = {
  1: 'Connect Calendar',
  2: 'Add Billing',
  3: 'Your Profile',
};

interface Banner {
  kind: 'success' | 'error';
  text: string;
}

interface ServerState {
  calendarConnected: boolean;
  calendarProvider:  CalendarProvider | null;
  /** Firm-level: true as soon as any colleague saved the firm's card. */
  billingComplete:   boolean;
  orgName:           string;
  seed:              ProfileSeed;
}

const EMPTY_SEED: ProfileSeed = { firstName: '', lastName: '', title: '', firmName: '' };

// ─── Google OAuth error copy ──────────────────────────────────────────────────

/**
 * Maps the codes emitted by /api/onboarding/calendar/google[/callback] onto
 * copy that tells the user what to actually do. Three families:
 *   deployment misconfiguration → nothing they can fix; offer the other options
 *   they cancelled / mismatched → retry, with the reason named
 *   transient                   → retry now, fall back if it persists
 */
function messageForCalendarError(code: string): string {
  switch (code) {
    case 'oauth_not_configured':
      return 'Google Calendar is not enabled on this deployment yet. Use Calendly or enter your availability manually to continue, and let your ExpertMatch contact know.';
    case 'access_denied':
      return 'You cancelled the Google permission screen, so nothing was connected. Try again, or pick one of the other options.';
    case 'missing_refresh_token':
      return 'Google did not grant the long-lived permission we need to check your availability later. Remove ExpertMatch from your Google account’s connected apps, then connect again.';
    case 'unauthorized':
      return 'Your session expired while you were with Google. Sign in again, then reconnect your calendar.';
    case 'session_mismatch':
      return 'That connection was started from a different ExpertMatch account. Make sure you are signed in as the right user, then try again.';
    case 'invalid_state':
    case 'invalid_callback':
      return 'Google’s reply did not match the request we started — usually an old tab or an expired link. Start the connection again from this page.';
    case 'token_exchange_failed':
      return 'Google accepted the sign-in but would not issue access. This is normally temporary — try again in a moment.';
    case 'server_error':
      return 'Something went wrong on our side while connecting Google. Try again, or use Calendly or manual availability instead.';
    default:
      return 'We could not finish connecting Google Calendar. Try again, or use one of the other options.';
  }
}

// ─── Data loading ─────────────────────────────────────────────────────────────

function narrowProvider(value: unknown): CalendarProvider | null {
  return value === 'google' || value === 'calendly' || value === 'manual' ? value : null;
}

/** Reads both prerequisites. Returns null if either request fails. */
async function loadServerState(): Promise<ServerState | null> {
  try {
    const [meRes, calendarRes] = await Promise.all([
      fetch('/api/auth/me'),
      fetch('/api/onboarding/calendar/status'),
    ]);
    if (!meRes.ok || !calendarRes.ok) return null;

    const me = await meRes.json() as {
      firstName?: string; lastName?: string; title?: string;
      firmName?: string; orgName?: string; billingComplete?: boolean;
    };
    const calendar = await calendarRes.json() as { connected?: boolean; provider?: unknown };

    return {
      calendarConnected: calendar.connected === true,
      calendarProvider:  narrowProvider(calendar.provider),
      billingComplete:   me.billingComplete === true,
      orgName:           me.orgName || me.firmName || '',
      seed: {
        firstName: me.firstName ?? '',
        lastName:  me.lastName  ?? '',
        title:     me.title     ?? '',
        firmName:  me.firmName  ?? '',
      },
    };
  } catch {
    return null;
  }
}

function firstIncompleteStep(calendarConnected: boolean, billingComplete: boolean): Step {
  if (!calendarConnected) return 1;
  if (!billingComplete)   return 2;
  return 3;
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OnboardingPage() {
  const router = useRouter();

  const [resolving, setResolving] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [step,      setStep]      = useState<Step>(1);
  const [banner,    setBanner]    = useState<Banner | null>(null);

  const [calendarConnected, setCalendarConnected] = useState(false);
  const [calendarProvider,  setCalendarProvider]  = useState<CalendarProvider | null>(null);
  const [billingComplete,   setBillingComplete]   = useState(false);
  const [orgName,           setOrgName]           = useState('');
  const [seed,              setSeed]              = useState<ProfileSeed>(EMPTY_SEED);

  /** Re-reads server state and moves to the first incomplete step. */
  const resync = useCallback(async (): Promise<ServerState | null> => {
    const state = await loadServerState();
    if (!state) {
      setLoadError(true);
      return null;
    }
    setLoadError(false);
    setCalendarConnected(state.calendarConnected);
    setCalendarProvider(state.calendarProvider);
    setBillingComplete(state.billingComplete);
    setOrgName(state.orgName);
    setSeed(state.seed);
    setStep(firstIncompleteStep(state.calendarConnected, state.billingComplete));
    return state;
  }, []);

  // Mount: consume the OAuth round-trip params, then resolve the real state.
  useEffect(() => {
    let active = true;

    const params    = new URLSearchParams(window.location.search);
    const success   = params.get('calendar') === 'connected';
    const errorCode = params.get('calendar_error');
    if (success || errorCode !== null) {
      // Strip the params so a refresh cannot re-show a stale banner.
      router.replace('/onboarding', { scroll: false });
    }

    void (async () => {
      const state = await resync();
      if (!active) return;

      if (errorCode !== null) {
        setBanner({ kind: 'error', text: messageForCalendarError(errorCode) });
      } else if (success) {
        setBanner(
          state?.calendarConnected
            ? { kind: 'success', text: 'Google Calendar connected.' }
            : {
                kind: 'error',
                text: 'Google reported success, but we still cannot see the connection. Please connect again.',
              },
        );
      }
      setResolving(false);
    })();

    return () => { active = false; };
  }, [resync, router]);

  // ── Step gating ────────────────────────────────────────────────────────────

  function stepUnlocked(target: Step): boolean {
    if (target === 1) return true;
    if (target === 2) return calendarConnected;
    return calendarConnected && billingComplete;
  }

  function goTo(target: Step): void {
    if (!stepUnlocked(target)) return;
    setBanner(null);
    setStep(target);
  }

  function stepDone(target: Step): boolean {
    if (target === 1) return calendarConnected;
    if (target === 2) return billingComplete;
    return false;
  }

  async function handleRetryLoad(): Promise<void> {
    setResolving(true);
    setBanner(null);
    await resync();
    setResolving(false);
  }

  function handleFinish(): void {
    router.push('/app?welcome=1');
    router.refresh();
  }

  async function handleStepsIncomplete(): Promise<void> {
    setBanner({
      kind: 'error',
      text: 'Setup could not be completed because a required step is still outstanding.',
    });
    await resync();
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>

      <header style={{ background: NAVY, borderBottom: `2px solid ${GOLD}` }}>
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between">
          <span
            className="font-display text-cream font-semibold"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </span>
          <span className="text-[10px] uppercase" style={{ color: GOLD, letterSpacing: '0.18em' }}>
            Account Setup
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-start justify-center px-4 py-10 sm:py-14">
        <div className="w-full max-w-md">

          {/* Step indicator */}
          <div className="mb-8">
            <p
              className="text-[10px] uppercase text-muted text-center mb-3"
              style={{ letterSpacing: '0.2em' }}
            >
              Step {step} of 3
            </p>
            <div className="flex gap-1.5 mb-2">
              {([1, 2, 3] as Step[]).map(s => (
                <div
                  key={s}
                  className="flex-1 h-1 rounded-full transition-colors duration-300"
                  style={{ background: s <= step || stepDone(s) ? GOLD : 'rgba(11,31,59,0.12)' }}
                />
              ))}
            </div>
            <div className="flex gap-1.5">
              {([1, 2, 3] as Step[]).map((s, index) => {
                const unlocked = stepUnlocked(s) && !resolving;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => goTo(s)}
                    disabled={!unlocked || s === step}
                    aria-current={s === step ? 'step' : undefined}
                    className={
                      'flex-1 text-[9px] uppercase leading-tight transition-opacity ' +
                      (index === 0 ? 'text-left ' : index === 1 ? 'text-center ' : 'text-right ') +
                      (unlocked && s !== step ? 'hover:opacity-70 cursor-pointer ' : 'cursor-default ')
                    }
                    style={{
                      color:         s <= step || stepDone(s) ? NAVY : FAINT,
                      letterSpacing: '0.1em',
                      fontWeight:    s === step ? 600 : 400,
                    }}
                  >
                    {stepDone(s) && <span aria-hidden="true" style={{ color: GOLD }}>✓ </span>}
                    {STEP_LABELS[s]}
                    {stepDone(s) && <span className="sr-only"> (completed)</span>}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Banner */}
          {banner && (
            <div
              role={banner.kind === 'error' ? 'alert' : 'status'}
              className="mb-4 border p-3.5 text-xs leading-relaxed"
              style={
                banner.kind === 'success'
                  ? { borderColor: GOLD, background: 'rgba(198,167,94,0.06)', color: NAVY }
                  : { borderColor: '#BE3A2B', background: 'rgba(190,58,43,0.05)', color: '#8F2C20' }
              }
            >
              {banner.text}
            </div>
          )}

          {/* Card */}
          <div className="bg-white border border-frame p-6 sm:p-8 shadow-sm">
            {resolving ? (
              <div aria-busy="true" aria-live="polite">
                <span className="sr-only">Loading your setup progress…</span>
                <div className="skeleton h-5 w-1/2 mb-3" />
                <div className="skeleton h-3 w-full mb-2" />
                <div className="skeleton h-3 w-4/5 mb-8" />
                <div className="skeleton h-16 w-full mb-3" />
                <div className="skeleton h-16 w-full mb-3" />
                <div className="skeleton h-11 w-full" />
              </div>
            ) : loadError ? (
              <div>
                <h2
                  className="font-display mb-2"
                  style={{ color: NAVY, fontSize: '1.25rem', fontWeight: 500 }}
                >
                  We could not load your setup
                </h2>
                <p className="mb-6 leading-relaxed" style={{ color: MUTED, fontSize: '14px', fontWeight: 300 }}>
                  Your progress is safe. This is usually a connection problem — try again in a moment.
                </p>
                <button
                  type="button"
                  onClick={() => void handleRetryLoad()}
                  className="w-full py-3 text-[11px] uppercase font-medium transition-colors disabled:opacity-40"
                  style={{ background: NAVY, color: '#FFFFFF', letterSpacing: '0.14em' }}
                >
                  Try again
                </button>
              </div>
            ) : step === 1 ? (
              <CalendarStep
                connected={calendarConnected}
                provider={calendarProvider}
                onConnected={provider => {
                  setCalendarProvider(provider);
                  setCalendarConnected(true);
                  setBanner({ kind: 'success', text: 'Calendar connected.' });
                }}
                onContinue={() => goTo(2)}
              />
            ) : step === 2 ? (
              <BillingStep
                complete={billingComplete}
                orgName={orgName}
                onComplete={context => {
                  setBillingComplete(true);
                  setBanner({
                    kind: 'success',
                    text: context === 'already_set_up'
                      ? `Billing is already set up for ${orgName || 'your firm'}.`
                      : 'Payment method saved.',
                  });
                }}
                onContinue={() => goTo(3)}
              />
            ) : (
              <ProfileStep
                seed={seed}
                onComplete={handleFinish}
                onStepsIncomplete={() => void handleStepsIncomplete()}
              />
            )}
          </div>

          {!resolving && !loadError && (
            <p className="mt-4 text-center text-[11px]" style={{ color: FAINT }}>
              Calendar and billing are both required before you can start a brief.
            </p>
          )}

        </div>
      </main>
    </div>
  );
}

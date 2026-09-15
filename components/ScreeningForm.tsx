'use client';

// The expert's screening form — six taps and a sentence, on a phone, in about a
// minute (docs/SCREENING_FLOW_PLAN.md, build step 4).
//
// THE PRODUCT CLAIM RESTS ON THIS SCREEN. The client will see, before booking,
// exactly which of their questions this person can speak to — in this person's
// own words, unsummarised. So the form asks the smallest honest thing: one
// yes/no per question, and one sentence of proof behind each yes. No essays, no
// scoring, no free-text catch-all nobody reads.
//
// ONE-HANDED BY CONSTRUCTION. Single column at every width, every control at
// least 44px tall, the segmented answers split the full width three ways, and
// nothing is more than a thumb from the last thing. A No or an Unsure expands
// nothing — only a Yes asks for more, so the fast path is genuinely fast.
//
// WHAT THIS COMPONENT NEVER RECEIVES: the client's name, the client's firm, the
// client-side rate, the request id, the other candidates, or its own row id.
// GET /api/s/[token] builds its payload field by field for exactly that reason,
// and the shape below mirrors it (a route file cannot export a type).
//
// Every state is real: a skeleton on mount, an honest page for a dead link, a
// rate-limit sentence, an error with a retry, a disabled submit that says what
// is still missing, a busy button, and two terminal pages — already sent, and
// thanks.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

// ─── Shapes (mirrors the payload in app/api/s/[token]/route.ts) ───────────────

interface Item {
  id:          string;
  stem:        string;
  proofPrompt: string;
}

interface Payload {
  topic:         string;
  /** EXPERT-side dollars per hour. */
  expertRate:    number;
  callLengthMin: number;
  firmPhrase:    string;
  deadline:      string;
  items:         Item[];
  state:         'open' | 'submitted';
}

type Answer       = 'yes' | 'no' | 'unsure';
type Availability = 'this_week' | 'next_week' | 'later';

interface Props {
  token: string;
}

// ─── Copy ─────────────────────────────────────────────────────────────────────

const MAX_PROOF    = 400;
const RATE_MIN     = 50;
const RATE_MAX     = 5000;
const RATE_STEP    = 25;

const ANSWER_OPTIONS: ReadonlyArray<{ value: Answer; label: string }> = [
  { value: 'yes',    label: 'Yes' },
  { value: 'no',     label: 'No' },
  { value: 'unsure', label: 'Unsure' },
];

const AVAILABILITY_OPTIONS: ReadonlyArray<{ value: Availability; label: string }> = [
  { value: 'this_week', label: 'This week' },
  { value: 'next_week', label: 'Next week' },
  { value: 'later',     label: 'Later' },
];

const LOAD_ERROR = 'We could not load these questions. Please try again.';

// ─── Formatting ───────────────────────────────────────────────────────────────

/** "Sep 28, 2026", in the reader's own locale. */
function formatDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return iso;
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', year: 'numeric',
  }).format(new Date(ms));
}

function usd(amount: number): string {
  return `$${amount.toLocaleString('en-US')}`;
}

/** Grows the proof box with the sentence instead of scrolling it. */
function autoGrow(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ScreeningForm({ token }: Props) {
  const [payload,   setPayload]   = useState<Payload | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState('');

  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [proofs,  setProofs]  = useState<Record<string, string>>({});

  const [rateAccepted, setRateAccepted] = useState<boolean | null>(null);
  const [rateAsk,      setRateAsk]      = useState('');
  const [availability, setAvailability] = useState<Availability | null>(null);

  const [busy,         setBusy]         = useState(false);
  const [submitError,  setSubmitError]  = useState('');
  const [fieldErrors,  setFieldErrors]  = useState<string[]>([]);

  const [sentCoverage, setSentCoverage] = useState<{ yes: number; total: number } | null>(null);
  const [alreadySent,  setAlreadySent]  = useState(false);
  const [expired,      setExpired]      = useState(false);

  const base = `/api/s/${encodeURIComponent(token)}`;

  // ── Load ────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    try {
      const res = await fetch(base, { cache: 'no-store' });
      if (res.status === 410) { setLoadError('expired'); return; }
      if (res.status === 429) { setLoadError('Too many attempts. Wait a few minutes.'); return; }
      if (!res.ok)            { setLoadError(LOAD_ERROR); return; }
      const data = await res.json() as Payload;
      setPayload(data);
      if (data.state === 'submitted') setAlreadySent(true);
    } catch {
      setLoadError(LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, [base]);

  useEffect(() => { void load(); }, [load]);

  // ── What is still missing ───────────────────────────────────────────────
  // One sentence, and only the FIRST thing missing: a list of everything wrong
  // at once reads as a telling-off on a form that takes a minute.
  const missing = useMemo<string | null>(() => {
    if (!payload) return null;

    const unanswered = payload.items.filter(item => !answers[item.id]).length;
    if (unanswered > 0) {
      return unanswered === 1 ? '1 question left' : `${unanswered} questions left`;
    }

    const blankProof = payload.items.findIndex(
      item => answers[item.id] === 'yes' && !(proofs[item.id] ?? '').trim(),
    );
    if (blankProof !== -1) return `Add your sentence for question ${blankProof + 1}`;

    if (rateAccepted === null) return 'Say whether the rate works';
    if (rateAccepted === false) {
      const asked = parseInt(rateAsk, 10);
      if (!Number.isInteger(asked)) return 'Add the rate you would need';
      if (asked < RATE_MIN || asked > RATE_MAX) {
        return `Enter an hourly rate between ${usd(RATE_MIN)} and ${usd(RATE_MAX)}`;
      }
    }

    if (availability === null) return 'Say when you could take a call';

    return null;
  }, [payload, answers, proofs, rateAccepted, rateAsk, availability]);

  // ── Submit ──────────────────────────────────────────────────────────────
  async function submit(): Promise<void> {
    if (!payload || missing !== null || busy) return;

    setBusy(true);
    setSubmitError('');
    setFieldErrors([]);

    const body = {
      answers: payload.items.map(item => ({
        objectiveId: item.id,
        answer:      answers[item.id],
        proofText:   answers[item.id] === 'yes' ? (proofs[item.id] ?? '').trim() : null,
      })),
      rateAccepted: rateAccepted === true,
      rateAsk:      rateAccepted === false ? parseInt(rateAsk, 10) : null,
      availability,
    };

    try {
      const res = await fetch(base, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });

      if (res.status === 409) { setAlreadySent(true); return; }
      if (res.status === 410) { setExpired(true);     return; }
      if (res.status === 429) {
        setSubmitError('Too many attempts. Wait a few minutes and send again.');
        return;
      }
      if (res.status === 400) {
        const data = await res.json().catch(() => null) as { errors?: Array<{ message?: string }> } | null;
        const sentences = (data?.errors ?? [])
          .map(e => (typeof e.message === 'string' ? e.message : ''))
          .filter((message, index, all) => message !== '' && all.indexOf(message) === index);
        setFieldErrors(sentences.length > 0 ? sentences : ['Please check your answers and send again.']);
        return;
      }
      if (!res.ok) {
        setSubmitError('We could not send your answers. Please try again.');
        return;
      }

      const data = await res.json() as { coverage: { yes: number; total: number } };
      setSentCoverage({ yes: data.coverage.yes, total: data.coverage.total });
    } catch {
      setSubmitError('We could not reach the server. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  // ── Terminal states ─────────────────────────────────────────────────────

  if (expired || loadError === 'expired') {
    return (
      <Shell>
        <h1 className="font-display text-2xl text-navy mb-3">This link has expired</h1>
        <p className="text-sm text-muted leading-relaxed">
          Reply to the email and I will send a new one.
        </p>
      </Shell>
    );
  }

  if (sentCoverage) {
    return (
      <Shell>
        <div className="w-12 h-12 rounded-full bg-gold-pale border border-gold flex items-center justify-center mb-6"
             aria-hidden="true">
          <span className="text-navy text-xl">✓</span>
        </div>
        <h1 className="font-display text-2xl text-navy mb-3">
          Thanks — {sentCoverage.yes} of {sentCoverage.total} sent.
        </h1>
        <p className="text-sm text-muted leading-relaxed">
          The client sees exactly what you wrote, in your words.
        </p>
      </Shell>
    );
  }

  if (alreadySent) {
    return (
      <Shell>
        <h1 className="font-display text-2xl text-navy mb-3">Already sent.</h1>
        <p className="text-sm text-muted leading-relaxed">
          You already answered these. Nothing more to do.
        </p>
      </Shell>
    );
  }

  // ── Loading and load errors ─────────────────────────────────────────────

  if (loading) {
    return (
      <Shell>
        <div className="animate-pulse space-y-4 w-full" aria-busy="true" aria-live="polite">
          <div className="h-6 w-3/4 bg-cream-dark" />
          <div className="h-3 w-1/2 bg-cream-dark" />
          <div className="h-28 w-full bg-cream-dark" />
          <div className="h-28 w-full bg-cream-dark" />
          <div className="h-28 w-full bg-cream-dark" />
        </div>
        <span className="sr-only">Loading your questions</span>
      </Shell>
    );
  }

  if (loadError || !payload) {
    return (
      <Shell>
        <h1 className="font-display text-2xl text-navy mb-3">Something went wrong</h1>
        <p className="text-sm text-muted leading-relaxed mb-6">{loadError || LOAD_ERROR}</p>
        <button type="button" onClick={() => void load()}
                className="min-h-[44px] bg-navy text-gold px-6 py-3 text-sm font-semibold tracking-wide">
          Try again
        </button>
      </Shell>
    );
  }

  // ── The form ────────────────────────────────────────────────────────────

  const rate = usd(payload.expertRate);

  return (
    <Shell>
      <h1 className="font-display text-2xl sm:text-3xl text-navy leading-snug mb-3">
        {payload.topic}
      </h1>
      <p className="text-sm text-ink leading-relaxed">
        Asked by {payload.firmPhrase} · {rate}/hr · {payload.callLengthMin}-minute call
      </p>
      <p className="text-xs text-muted mt-1 mb-8">
        Link works until {formatDate(payload.deadline)}
      </p>

      <ol className="list-none p-0 m-0 space-y-4">
        {payload.items.map((item, index) => {
          const answer = answers[item.id] ?? null;
          const proof  = proofs[item.id] ?? '';
          return (
            <li key={item.id} className="border border-frame bg-surface px-4 py-5 sm:px-5">
              <p id={`stem-${item.id}`} className="text-base text-navy leading-relaxed mb-4">
                <span className="text-muted text-xs block mb-1">Question {index + 1}</span>
                {item.stem}
              </p>

              <Segmented
                labelledBy={`stem-${item.id}`}
                options={ANSWER_OPTIONS}
                value={answer}
                onChange={value => {
                  setAnswers(prev => ({ ...prev, [item.id]: value }));
                  setFieldErrors([]);
                }}
              />

              {answer === 'yes' && (
                <div className="mt-4">
                  <label htmlFor={`proof-${item.id}`} className="block text-sm text-muted leading-relaxed mb-2">
                    {item.proofPrompt}
                  </label>
                  <textarea
                    id={`proof-${item.id}`}
                    value={proof}
                    rows={2}
                    maxLength={MAX_PROOF}
                    placeholder="One sentence: role and when."
                    ref={autoGrow}
                    onInput={e => autoGrow(e.currentTarget)}
                    onChange={e => {
                      const next = e.target.value.slice(0, MAX_PROOF);
                      setProofs(prev => ({ ...prev, [item.id]: next }));
                    }}
                    className="w-full resize-none overflow-hidden border border-frame bg-cream px-3.5 py-2.5
                               text-sm text-ink leading-relaxed focus:outline-none focus:border-navy
                               placeholder-[#9AABB8]"
                  />
                  <p className="text-xs text-muted mt-1">{proof.length} of {MAX_PROOF}</p>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {/* Rate */}
      <div className="border border-frame bg-surface px-4 py-5 sm:px-5 mt-4">
        <p id="rate-question" className="text-base text-navy leading-relaxed mb-4">
          Does {rate}/hr work for you?
        </p>
        <Segmented
          labelledBy="rate-question"
          options={[
            { value: 'yes', label: 'Yes' },
            { value: 'no',  label: "I'd need a different rate" },
          ]}
          value={rateAccepted === null ? null : rateAccepted ? 'yes' : 'no'}
          onChange={value => {
            setRateAccepted(value === 'yes');
            setFieldErrors([]);
          }}
        />

        {rateAccepted === false && (
          <div className="mt-4">
            <label htmlFor="rate-ask" className="block text-sm text-muted leading-relaxed mb-2">
              What would work?
            </label>
            <div className="flex items-center border border-frame bg-cream focus-within:border-navy">
              <span className="pl-3.5 text-sm text-muted" aria-hidden="true">$</span>
              <input
                id="rate-ask"
                type="number"
                inputMode="numeric"
                min={RATE_MIN}
                max={RATE_MAX}
                step={RATE_STEP}
                value={rateAsk}
                onChange={e => setRateAsk(e.target.value)}
                className="w-full min-h-[44px] bg-transparent px-2 py-2.5 text-sm text-ink
                           focus:outline-none placeholder-[#9AABB8]"
                placeholder={String(payload.expertRate)}
              />
              <span className="pr-3.5 text-sm text-muted">/hr</span>
            </div>
          </div>
        )}
      </div>

      {/* Availability */}
      <div className="border border-frame bg-surface px-4 py-5 sm:px-5 mt-4">
        <p id="availability-question" className="text-base text-navy leading-relaxed mb-4">
          When could you take a call?
        </p>
        <Segmented
          labelledBy="availability-question"
          options={AVAILABILITY_OPTIONS}
          value={availability}
          onChange={value => {
            setAvailability(value);
            setFieldErrors([]);
          }}
        />
      </div>

      {/* Errors */}
      {fieldErrors.length > 0 && (
        <ul role="alert"
            className="mt-6 list-none p-0 border border-status-danger/40 bg-status-danger/5
                       text-status-danger text-sm px-4 py-3 space-y-1">
          {fieldErrors.map(sentence => <li key={sentence}>{sentence}</li>)}
        </ul>
      )}

      {submitError && (
        <p role="alert"
           className="mt-6 border border-status-danger/40 bg-status-danger/5 text-status-danger text-sm px-4 py-3">
          {submitError}
        </p>
      )}

      {/* Submit */}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={missing !== null || busy}
        className="mt-6 w-full min-h-[44px] bg-navy text-gold px-6 py-3.5 text-sm font-semibold
                   tracking-wide disabled:opacity-50 disabled:cursor-not-allowed transition-opacity"
      >
        {busy ? 'Sending…' : 'Send answers'}
      </button>

      {missing !== null && (
        <p className="mt-3 text-xs text-muted text-center" aria-live="polite">{missing}</p>
      )}
    </Shell>
  );
}

// ─── Pieces ───────────────────────────────────────────────────────────────────

/**
 * The three-way control. Buttons carry `role="radio"` and `aria-checked` rather
 * than `aria-pressed`: inside a radiogroup, "checked" is the state a screen
 * reader announces, and only one of them can hold it.
 */
function Segmented<T extends string>({ labelledBy, options, value, onChange }: {
  labelledBy: string;
  options:    ReadonlyArray<{ value: T; label: string }>;
  value:      T | null;
  onChange:   (value: T) => void;
}) {
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex w-full">
      {options.map((option, index) => {
        const selected = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={selected}
            onClick={() => onChange(option.value)}
            className={[
              'flex-1 min-h-[44px] px-2 py-2.5 text-sm transition-colors',
              index > 0 ? '-ml-px' : '',
              selected
                ? 'bg-navy text-cream border border-navy font-semibold'
                : 'bg-cream text-ink border border-frame hover:border-navy',
            ].join(' ')}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

/** The one frame every state renders inside. Mobile first, 375px safe. */
function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="min-h-screen bg-cream flex flex-col items-center px-4 py-12 sm:py-16">
      <div className="w-full max-w-lg">
        <p className="text-[10px] font-bold tracking-widest-3 text-navy uppercase mb-8">
          EXPERTMATCH
        </p>
        {children}
      </div>
    </main>
  );
}

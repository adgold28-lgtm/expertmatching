'use client';

// /requests/new — the intake for a structured request
// (docs/SCREENING_FLOW_PLAN.md, step 2 of the build order).
//
// THE WHOLE DESIGN IS THE NINETY-SECOND RULE. Two fields are required — a
// one-line topic and three to six learning objectives — and everything else
// either has a default or lives behind a collapsed <details> that a client can
// finish the request without ever opening. The topic autofocuses, Enter walks
// down the objective rows and opens the next one, and the submit button is the
// only other thing to press. Targeting is a sourcing hint, not a form to fill.
//
// CONSTANTS ARE MIRRORED, NOT IMPORTED. lib/screeningValidation is the source
// of truth for every rule below, but it imports node:crypto (normalizeExpertId)
// and so cannot be pulled into a browser bundle. The values here are copies —
// change LIMITS and change these too.
//
// THE SERVER IS STILL THE AUTHORITY. The pre-check mirrors only the two rules a
// client can break by accident (a missing topic, too few objectives) so nobody
// waits on a round trip to learn they left a row blank; every other rule is the
// server's, and its 400 carries the full list of problems, which is mapped back
// onto the exact fields — including per-row objective errors, by way of the
// index map built when the body was assembled. Anything that cannot be matched
// to a field is shown as a sentence above the button rather than swallowed.
//
// DEADLINE DATES ARE UTC. lib/screeningValidation reads 'YYYY-MM-DD' as the end
// of that day in UTC and measures the window against UTC today, so the default
// and the min/max bounds are computed the same way — otherwise a client in the
// Americas could pick a date the server then calls too soon. They are also set
// on mount rather than during render: a date computed at render time differs
// between the server pass and the browser pass and would hydrate dirty.

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import RequestsShell from '../../../components/requests/RequestsShell';
import TagInput from '../../../components/requests/TagInput';

// ─── Rules mirrored from lib/screeningValidation.LIMITS ───────────────────────

const TOPIC_MAX             = 300;
const OBJECTIVES_MIN        = 3;
const OBJECTIVES_MAX        = 6;
const OBJECTIVE_MAX         = 500;
const TARGETING_LIST_MAX    = 30;
const TARGETING_ENTRY_MAX   = 120;
const TARGETING_TEXT_MAX    = 200;
const CALL_COUNT_MIN        = 1;
const CALL_COUNT_MAX        = 50;
const DEADLINE_MIN_DAYS     = 1;
const DEADLINE_MAX_DAYS     = 90;
const DEADLINE_DEFAULT_DAYS = 14;
const DEFAULT_CALL_COUNT    = 1;
const DEFAULT_CLIENT_RATE   = 1300;
const RATE_MIN              = 100;
const RATE_STEP             = 50;
const CALL_LENGTHS          = [30, 45, 60] as const;
const DEFAULT_CALL_LENGTH   = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The 'YYYY-MM-DD' a date input wants, in UTC — see the header. */
function utcDateInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// Each row shows the SHAPE of an objective rather than a vague instruction: a
// specific, answerable question an expert can say yes or no to.
const OBJECTIVE_PLACEHOLDERS = [
  'What we need to learn… e.g. How did cycle time change after go-live?',
  'e.g. Which order-to-cash steps still needed manual work afterwards?',
  'e.g. What did the migration cost, and where did it overrun?',
];

function objectivePlaceholder(index: number): string {
  return OBJECTIVE_PLACEHOLDERS[index] ?? 'e.g. What would you do differently a second time?';
}

// ─── Styling ──────────────────────────────────────────────────────────────────

const LABEL_CLASS = 'mb-1.5 block text-[10px] font-medium uppercase tracking-widest text-muted';
const LABEL_STYLE = { letterSpacing: '0.18em' } as const;
const INPUT_BASE  = 'w-full min-h-[44px] px-3.5 py-2.5 text-sm text-ink border bg-cream focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]';
const INPUT_STYLE = { fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 } as const;

function inputClass(invalid: boolean): string {
  return `${INPUT_BASE} ${invalid ? 'border-red-300' : 'border-frame'}`;
}

function FieldError({ id, message }: { id: string; message?: string }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1 text-[11px] leading-relaxed text-red-600">
      {message}
    </p>
  );
}

function FieldHelper({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <p id={id} className="mt-1 text-[11px] leading-relaxed text-muted" style={{ fontWeight: 300 }}>
      {children}
    </p>
  );
}

// ─── Server responses ─────────────────────────────────────────────────────────

interface ApiValidationError {
  field:   string;
  error:   string;
  message: string;
}

interface CreateRequestResponse {
  request?: { id?: string };
  error?:   string;
  field?:   string;
  message?: string;
  errors?:  ApiValidationError[];
}

/** Fields this form can point at. Anything else becomes a form-level sentence. */
const MAPPED_FIELDS = new Set([
  'topicStatement', 'learningObjectives', 'deadline', 'clientRate', 'callCount', 'callLengthMin',
]);

/** Of those, the ones inside the collapsed panel — an error there has to open it. */
const DETAILS_FIELDS = new Set(['deadline', 'clientRate', 'callCount', 'callLengthMin']);

// Sentences for the failures that are not about a field. A raw code is never
// shown; anything not listed falls back to the last line.
const GENERIC_ERRORS: Record<string, string> = {
  unauthorized:             'Your session has expired. Sign in again, then create the request.',
  forbidden:                'This account is not allowed to create requests. Ask your firm admin.',
  service_unavailable:      'Requests are temporarily unavailable. Please try again shortly.',
  payload_too_large:        'That is more text than we can take. Shorten the objectives and try again.',
  failed_to_create_request: 'We could not create the request. Nothing was saved — try again.',
};

const FALLBACK_ERROR = 'We could not create the request. Nothing was saved — try again.';

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function NewRequestPage() {
  const router = useRouter();

  const [topic,      setTopic]      = useState('');
  const [objectives, setObjectives] = useState<string[]>(['', '', '']);

  const [targetCompanies,  setTargetCompanies]  = useState<string[]>([]);
  const [seniority,        setSeniority]        = useState('');
  const [functionArea,     setFunctionArea]     = useState('');
  const [tenureWindow,     setTenureWindow]     = useState('');
  const [geography,        setGeography]        = useState('');
  const [excludeCompanies, setExcludeCompanies] = useState<string[]>([]);
  const [excludeExperts,   setExcludeExperts]   = useState<string[]>([]);

  // Number fields are held as strings so a cleared box stays cleared; an empty
  // one is simply left out of the body and the server applies its default.
  const [callCount,     setCallCount]     = useState(String(DEFAULT_CALL_COUNT));
  const [clientRate,    setClientRate]    = useState(String(DEFAULT_CLIENT_RATE));
  const [callLengthMin, setCallLengthMin] = useState<number>(DEFAULT_CALL_LENGTH);
  const [deadline,      setDeadline]      = useState('');
  const [dateBounds,    setDateBounds]    = useState<{ min: string; max: string } | null>(null);

  const [detailsOpen,     setDetailsOpen]     = useState(false);
  const [fieldErrors,     setFieldErrors]     = useState<Record<string, string>>({});
  const [formError,       setFormError]       = useState('');
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const [submitting,      setSubmitting]      = useState(false);

  const topicRef      = useRef<HTMLInputElement | null>(null);
  const objectiveRefs = useRef<Array<HTMLInputElement | null>>([]);
  const [pendingFocus, setPendingFocus] = useState<number | null>(null);

  // Dates on mount, never during render — see the header.
  useEffect(() => {
    const now = Date.now();
    setDeadline(utcDateInput(now + DEADLINE_DEFAULT_DAYS * DAY_MS));
    setDateBounds({
      min: utcDateInput(now + DEADLINE_MIN_DAYS * DAY_MS),
      max: utcDateInput(now + DEADLINE_MAX_DAYS * DAY_MS),
    });
  }, []);

  useEffect(() => {
    if (pendingFocus === null) return;
    objectiveRefs.current[pendingFocus]?.focus();
    setPendingFocus(null);
  }, [pendingFocus]);

  const filledCount   = objectives.filter(text => text.trim().length > 0).length;
  const atMinRows     = objectives.length <= OBJECTIVES_MIN;
  const atMaxRows     = objectives.length >= OBJECTIVES_MAX;
  const topicLeft     = TOPIC_MAX - topic.length;

  // ── Field plumbing ─────────────────────────────────────────────────────────

  function clearError(field: string) {
    setFieldErrors(prev => {
      if (!(field in prev)) return prev;
      const next = { ...prev };
      delete next[field];
      return next;
    });
  }

  /** Row indexes shift when a row is added or removed, so drop them all. */
  function clearObjectiveErrors() {
    setFieldErrors(prev => {
      const next: Record<string, string> = {};
      let changed = false;
      for (const [field, message] of Object.entries(prev)) {
        if (field.startsWith('learningObjectives')) { changed = true; continue; }
        next[field] = message;
      }
      return changed ? next : prev;
    });
  }

  function setObjectiveAt(index: number, value: string) {
    setObjectives(prev => prev.map((text, i) => (i === index ? value : text)));
    clearError(`learningObjectives[${index}]`);
    clearError('learningObjectives');
  }

  function addObjective() {
    if (atMaxRows) return;
    clearObjectiveErrors();
    setObjectives(prev => [...prev, '']);
    setPendingFocus(objectives.length);
  }

  function removeObjective(index: number) {
    if (atMinRows) return;
    clearObjectiveErrors();
    setObjectives(prev => prev.filter((_, i) => i !== index));
  }

  // Enter in the topic walks into the first objective. Pressing it there can
  // only mean "next", never "create" — no request is complete with one field.
  function handleTopicKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    setPendingFocus(0);
  }

  // Enter walks to the next row and opens one when standing on the last, up to
  // six. It never submits — the button is the only way to create a request.
  function handleObjectiveKeyDown(event: React.KeyboardEvent<HTMLInputElement>, index: number) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (index < objectives.length - 1) { setPendingFocus(index + 1); return; }
    if (atMaxRows) return;
    clearObjectiveErrors();
    setObjectives(prev => [...prev, '']);
    setPendingFocus(objectives.length);
  }

  // ── Server errors → fields ─────────────────────────────────────────────────

  function applyServerErrors(list: ApiValidationError[], sentIndexToRow: number[]) {
    const next: Record<string, string> = {};
    const unmapped: string[] = [];

    for (const item of list) {
      if (!item || typeof item.field !== 'string' || typeof item.message !== 'string') continue;

      // The server indexes the array it RECEIVED (blank rows were dropped
      // before sending), so walk the map back to the row the client sees.
      const perRow = /^learningObjectives\[(\d+)\]$/.exec(item.field);
      if (perRow) {
        const rowIndex = sentIndexToRow[Number(perRow[1])];
        if (rowIndex === undefined) unmapped.push(item.message);
        else next[`learningObjectives[${rowIndex}]`] = item.message;
        continue;
      }

      if (MAPPED_FIELDS.has(item.field)) next[item.field] = item.message;
      else unmapped.push(item.message);
    }

    setFieldErrors(next);
    setFormError(unmapped.join(' '));
    // A marked field inside a closed panel is an invisible error.
    if (Object.keys(next).some(field => DETAILS_FIELDS.has(field))) setDetailsOpen(true);
  }

  // ── Submit ─────────────────────────────────────────────────────────────────

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting) return;

    const trimmedTopic = topic.trim();

    // Blank rows are dropped, and the map remembers which row each sent
    // objective came from so a server error lands on the right input.
    const sentIndexToRow: number[]   = [];
    const learningObjectives: string[] = [];
    objectives.forEach((raw, rowIndex) => {
      const text = raw.trim();
      if (!text) return;
      sentIndexToRow.push(rowIndex);
      learningObjectives.push(text);
    });

    const preErrors: Record<string, string> = {};
    if (!trimmedTopic) {
      preErrors.topicStatement = 'Add a one-line topic so an expert knows what the call is about.';
    }
    if (learningObjectives.length < OBJECTIVES_MIN) {
      preErrors.learningObjectives =
        `Fill in at least ${OBJECTIVES_MIN} learning objectives — that is what the expert is screened against.`;
    }

    if (Object.keys(preErrors).length > 0) {
      setFieldErrors(preErrors);
      setFormError('');
      setNeedsOnboarding(false);
      if (preErrors.topicStatement) {
        topicRef.current?.focus();
      } else {
        const blank = objectives.findIndex(raw => raw.trim() === '');
        setPendingFocus(blank >= 0 ? blank : 0);
      }
      return;
    }

    // Empty targeting keys are left out entirely, so `{}` in the stored column
    // means "no targeting given" and a present key always means something.
    const exclusions: Record<string, string[]> = {};
    if (excludeCompanies.length > 0) exclusions.companies = excludeCompanies;
    if (excludeExperts.length   > 0) exclusions.experts   = excludeExperts;

    const targeting: Record<string, unknown> = {};
    if (targetCompanies.length > 0) targeting.targetCompanies = targetCompanies;
    if (seniority.trim())           targeting.seniority       = seniority.trim();
    if (functionArea.trim())        targeting.function        = functionArea.trim();
    if (tenureWindow.trim())        targeting.tenureWindow    = tenureWindow.trim();
    if (geography.trim())           targeting.geography       = geography.trim();
    if (Object.keys(exclusions).length > 0) targeting.exclusions = exclusions;

    const body: Record<string, unknown> = {
      topicStatement: trimmedTopic,
      learningObjectives,
      targeting,
      callLengthMin,
    };
    if (callCount.trim())  body.callCount  = Number(callCount);
    if (clientRate.trim()) body.clientRate = Number(clientRate);
    if (deadline)          body.deadline   = deadline;

    setSubmitting(true);
    setFieldErrors({});
    setFormError('');
    setNeedsOnboarding(false);

    try {
      const res = await fetch('/api/requests', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({})) as CreateRequestResponse;

      const newId = data.request?.id;
      if (res.ok && newId) {
        // Stays disabled and busy through the navigation — there is nothing
        // left to press on this page.
        router.push(`/requests/${newId}`);
        return;
      }

      if (res.status === 400) {
        const list: ApiValidationError[] = Array.isArray(data.errors) && data.errors.length > 0
          ? data.errors
          : (data.field && data.message
              ? [{ field: data.field, error: data.error ?? 'invalid_input', message: data.message }]
              : []);
        if (list.length > 0) applyServerErrors(list, sentIndexToRow);
        else setFormError(data.message || FALLBACK_ERROR);
      } else if (res.status === 403 && data.error === 'no_organization') {
        setNeedsOnboarding(true);
        setFormError(data.message || 'Your account is not attached to a firm yet. Finish onboarding first.');
      } else {
        const known = data.error ? GENERIC_ERRORS[data.error] : undefined;
        setFormError(known || FALLBACK_ERROR);
      }
    } catch {
      setFormError('We could not reach the server. Check your connection and try again.');
    }
    setSubmitting(false);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  return (
    <RequestsShell title="New request" description="Two fields. Under two minutes.">
      <form onSubmit={handleSubmit} noValidate className="space-y-8">

        {/* ── Topic ── */}
        <section className="border border-frame bg-white px-5 py-5 sm:px-6">
          <label htmlFor="topicStatement" className={LABEL_CLASS} style={LABEL_STYLE}>
            Topic <span className="text-red-400">*</span>
          </label>
          <input
            ref={topicRef}
            id="topicStatement"
            name="topicStatement"
            type="text"
            autoFocus
            value={topic}
            maxLength={TOPIC_MAX}
            onChange={event => { setTopic(event.target.value); clearError('topicStatement'); }}
            onKeyDown={handleTopicKeyDown}
            placeholder="How the 2024 SAP migration changed order-to-cash at mid-market distributors"
            aria-invalid={Boolean(fieldErrors.topicStatement)}
            aria-describedby={`topicStatement-helper${fieldErrors.topicStatement ? ' topicStatement-error' : ''}`}
            className={inputClass(Boolean(fieldErrors.topicStatement))}
            style={INPUT_STYLE}
          />
          <div className="flex items-baseline justify-between gap-3">
            <FieldHelper id="topicStatement-helper">
              One line, and it is what the expert is shown — leave your firm&apos;s name out of it.
            </FieldHelper>
            {topicLeft <= 60 && (
              <span className="mt-1 shrink-0 text-[11px] text-muted" style={{ fontWeight: 300 }}>
                {topicLeft} left
              </span>
            )}
          </div>
          <FieldError id="topicStatement-error" message={fieldErrors.topicStatement} />
        </section>

        {/* ── Learning objectives ── */}
        <section className="border border-frame bg-white px-5 py-5 sm:px-6">
          <fieldset>
            <legend className={LABEL_CLASS} style={LABEL_STYLE}>
              Learning objectives <span className="text-red-400">*</span>
            </legend>
            <p id="learningObjectives-helper" className="mb-3 text-[11px] leading-relaxed text-muted" style={{ fontWeight: 300 }}>
              {OBJECTIVES_MIN} to {OBJECTIVES_MAX} objectives. We turn each one into a yes/no question the
              expert answers before you book. <span className="text-navy">{filledCount} written.</span>
            </p>

            <div className="space-y-2.5">
              {objectives.map((value, index) => {
                const rowError = fieldErrors[`learningObjectives[${index}]`];
                return (
                  <div key={index}>
                    <div className="flex items-start gap-2">
                      <input
                        ref={element => { objectiveRefs.current[index] = element; }}
                        id={`learningObjective-${index}`}
                        type="text"
                        value={value}
                        maxLength={OBJECTIVE_MAX}
                        onChange={event => setObjectiveAt(index, event.target.value)}
                        onKeyDown={event => handleObjectiveKeyDown(event, index)}
                        placeholder={objectivePlaceholder(index)}
                        aria-label={`Learning objective ${index + 1}`}
                        aria-invalid={Boolean(rowError)}
                        aria-describedby={rowError ? `learningObjective-${index}-error` : 'learningObjectives-helper'}
                        className={inputClass(Boolean(rowError))}
                        style={INPUT_STYLE}
                      />
                      <button
                        type="button"
                        onClick={() => removeObjective(index)}
                        disabled={atMinRows}
                        aria-label={
                          atMinRows
                            ? `Remove objective ${index + 1} — a request needs at least ${OBJECTIVES_MIN}`
                            : `Remove objective ${index + 1}`
                        }
                        title={atMinRows ? `A request needs at least ${OBJECTIVES_MIN} objectives.` : 'Remove this objective'}
                        className="flex min-h-[44px] min-w-[44px] shrink-0 items-center justify-center border border-frame text-muted transition-colors hover:border-navy hover:text-navy disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:border-frame disabled:hover:text-muted"
                      >
                        <span aria-hidden="true" className="text-base leading-none">×</span>
                      </button>
                    </div>
                    <FieldError id={`learningObjective-${index}-error`} message={rowError} />
                  </div>
                );
              })}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-3 gap-y-1">
              <button
                type="button"
                onClick={addObjective}
                disabled={atMaxRows}
                className="min-h-[44px] border border-navy px-4 py-2 text-[10px] font-medium uppercase text-navy transition-colors hover:bg-navy hover:text-cream disabled:cursor-not-allowed disabled:border-frame disabled:text-muted disabled:opacity-50 disabled:hover:bg-transparent disabled:hover:text-muted"
                style={{ letterSpacing: '0.14em' }}
              >
                Add another
              </button>
              {atMaxRows && (
                <span className="text-[11px] text-muted" style={{ fontWeight: 300 }}>
                  {OBJECTIVES_MAX} is the maximum — beyond that the screening form stops being answerable.
                </span>
              )}
            </div>

            <FieldError id="learningObjectives-error" message={fieldErrors.learningObjectives} />
          </fieldset>
        </section>

        {/* ── Optional targeting ── */}
        <details
          open={detailsOpen}
          onToggle={event => setDetailsOpen(event.currentTarget.open)}
          className="border border-frame bg-white"
        >
          <summary
            className="cursor-pointer select-none px-5 py-4 text-[11px] font-medium uppercase text-navy sm:px-6"
            style={{ letterSpacing: '0.16em' }}
          >
            Add targeting details (optional)
          </summary>

          <div className="space-y-6 border-t border-frame px-5 py-5 sm:px-6">
            <p className="text-[11px] leading-relaxed text-muted" style={{ fontWeight: 300 }}>
              Sourcing hints for our team. None of this is shown to an expert, and every field can be left empty.
            </p>

            <TagInput
              id="targetCompanies"
              label="Target companies"
              values={targetCompanies}
              onChange={setTargetCompanies}
              placeholder="e.g. Acme Distribution"
              helper="Companies whose people you want to hear from."
              max={TARGETING_LIST_MAX}
              maxEntry={TARGETING_ENTRY_MAX}
            />

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="seniority" className={LABEL_CLASS} style={LABEL_STYLE}>Seniority</label>
                <input
                  id="seniority"
                  type="text"
                  value={seniority}
                  maxLength={TARGETING_TEXT_MAX}
                  onChange={event => setSeniority(event.target.value)}
                  placeholder="e.g. Director and above"
                  className={inputClass(false)}
                  style={INPUT_STYLE}
                />
              </div>
              <div>
                <label htmlFor="function" className={LABEL_CLASS} style={LABEL_STYLE}>Function</label>
                <input
                  id="function"
                  type="text"
                  value={functionArea}
                  maxLength={TARGETING_TEXT_MAX}
                  onChange={event => setFunctionArea(event.target.value)}
                  placeholder="e.g. Finance operations"
                  className={inputClass(false)}
                  style={INPUT_STYLE}
                />
              </div>
              <div>
                <label htmlFor="tenureWindow" className={LABEL_CLASS} style={LABEL_STYLE}>Tenure window</label>
                <input
                  id="tenureWindow"
                  type="text"
                  value={tenureWindow}
                  maxLength={TARGETING_TEXT_MAX}
                  onChange={event => setTenureWindow(event.target.value)}
                  placeholder="e.g. 2019 to 2024"
                  className={inputClass(false)}
                  style={INPUT_STYLE}
                />
              </div>
              <div>
                <label htmlFor="geography" className={LABEL_CLASS} style={LABEL_STYLE}>Geography</label>
                <input
                  id="geography"
                  type="text"
                  value={geography}
                  maxLength={TARGETING_TEXT_MAX}
                  onChange={event => setGeography(event.target.value)}
                  placeholder="e.g. US Midwest"
                  className={inputClass(false)}
                  style={INPUT_STYLE}
                />
              </div>
            </div>

            <div className="space-y-5 border-t border-frame pt-5">
              <p className="text-[10px] font-medium uppercase text-muted" style={LABEL_STYLE}>Exclusions</p>
              <TagInput
                id="excludeCompanies"
                label="Companies to exclude"
                values={excludeCompanies}
                onChange={setExcludeCompanies}
                placeholder="e.g. a portfolio company"
                helper="Nobody currently or recently at these will be approached."
                max={TARGETING_LIST_MAX}
                maxEntry={TARGETING_ENTRY_MAX}
              />
              <TagInput
                id="excludeExperts"
                label="Experts you have already used"
                values={excludeExperts}
                onChange={setExcludeExperts}
                placeholder="names or ids"
                helper="So we do not send you back to someone you have already spoken to."
                max={TARGETING_LIST_MAX}
                maxEntry={TARGETING_ENTRY_MAX}
              />
            </div>

            <div className="grid grid-cols-1 gap-4 border-t border-frame pt-5 sm:grid-cols-2">
              <div>
                <label htmlFor="callCount" className={LABEL_CLASS} style={LABEL_STYLE}>Number of calls</label>
                <input
                  id="callCount"
                  type="number"
                  inputMode="numeric"
                  value={callCount}
                  min={CALL_COUNT_MIN}
                  max={CALL_COUNT_MAX}
                  step={1}
                  onChange={event => { setCallCount(event.target.value); clearError('callCount'); }}
                  aria-invalid={Boolean(fieldErrors.callCount)}
                  aria-describedby={fieldErrors.callCount ? 'callCount-error' : undefined}
                  className={inputClass(Boolean(fieldErrors.callCount))}
                  style={INPUT_STYLE}
                />
                <FieldError id="callCount-error" message={fieldErrors.callCount} />
              </div>

              <div>
                <label htmlFor="deadline" className={LABEL_CLASS} style={LABEL_STYLE}>Deadline</label>
                <input
                  id="deadline"
                  type="date"
                  value={deadline}
                  min={dateBounds?.min}
                  max={dateBounds?.max}
                  onChange={event => { setDeadline(event.target.value); clearError('deadline'); }}
                  aria-invalid={Boolean(fieldErrors.deadline)}
                  aria-describedby={`deadline-helper${fieldErrors.deadline ? ' deadline-error' : ''}`}
                  className={inputClass(Boolean(fieldErrors.deadline))}
                  style={INPUT_STYLE}
                />
                <FieldHelper id="deadline-helper">Used only to expire the screening links.</FieldHelper>
                <FieldError id="deadline-error" message={fieldErrors.deadline} />
              </div>

              <div>
                <label htmlFor="clientRate" className={LABEL_CLASS} style={LABEL_STYLE}>Rate per hour</label>
                <input
                  id="clientRate"
                  type="number"
                  inputMode="numeric"
                  value={clientRate}
                  min={RATE_MIN}
                  step={RATE_STEP}
                  onChange={event => { setClientRate(event.target.value); clearError('clientRate'); }}
                  aria-invalid={Boolean(fieldErrors.clientRate)}
                  aria-describedby={`clientRate-helper${fieldErrors.clientRate ? ' clientRate-error' : ''}`}
                  className={inputClass(Boolean(fieldErrors.clientRate))}
                  style={INPUT_STYLE}
                />
                <FieldHelper id="clientRate-helper">
                  What you pay per hour, billed per minute after a 15-minute minimum.
                </FieldHelper>
                <FieldError id="clientRate-error" message={fieldErrors.clientRate} />
              </div>

              <div>
                <label htmlFor="callLengthMin" className={LABEL_CLASS} style={LABEL_STYLE}>Call length</label>
                <select
                  id="callLengthMin"
                  value={callLengthMin}
                  onChange={event => { setCallLengthMin(Number(event.target.value)); clearError('callLengthMin'); }}
                  aria-invalid={Boolean(fieldErrors.callLengthMin)}
                  aria-describedby={fieldErrors.callLengthMin ? 'callLengthMin-error' : undefined}
                  className={inputClass(Boolean(fieldErrors.callLengthMin))}
                  style={INPUT_STYLE}
                >
                  {CALL_LENGTHS.map(length => (
                    <option key={length} value={length}>{length} minutes</option>
                  ))}
                </select>
                <FieldError id="callLengthMin-error" message={fieldErrors.callLengthMin} />
              </div>
            </div>
          </div>
        </details>

        {/* ── Submit ── */}
        {formError && (
          <div role="alert" className="border border-red-200 bg-red-50 px-5 py-4 text-sm leading-relaxed text-red-700">
            <p>{formError}</p>
            {needsOnboarding && (
              <Link
                href="/onboarding"
                className="mt-2 inline-block text-[10px] uppercase text-navy underline underline-offset-2 hover:opacity-70"
                style={{ letterSpacing: '0.14em' }}
              >
                Finish onboarding →
              </Link>
            )}
          </div>
        )}

        <div className="flex flex-col-reverse items-stretch gap-3 sm:flex-row sm:items-center sm:justify-end">
          <Link
            href="/requests"
            className="flex min-h-[44px] items-center justify-center px-4 py-2 text-[10px] uppercase text-muted transition-colors hover:text-navy"
            style={{ letterSpacing: '0.14em' }}
          >
            Cancel
          </Link>
          <button
            type="submit"
            disabled={submitting}
            className="min-h-[44px] px-6 py-3 text-[10px] font-medium uppercase transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
            style={{ background: '#C6A75E', color: '#0B1F3B', letterSpacing: '0.14em' }}
          >
            {submitting ? 'Creating…' : 'Create request'}
          </button>
        </div>
      </form>
    </RequestsShell>
  );
}

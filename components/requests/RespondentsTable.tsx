'use client';

// The approved state of /requests/[id]: who answered, how much of the client's
// set they said they can speak to, and — expanded — their own words
// (docs/SCREENING_FLOW_PLAN.md, build step 5).
//
// WHAT THIS SCREEN REFUSES TO DO. No score, no rank, no "strong match", no
// stars, no model commentary, and nothing hidden or filtered on a model output.
// The whole product claim is that the client sees which of THEIR questions an
// expert can speak to, in the expert's own sentences, before booking. A summary
// would be the platform putting itself back between the two of them, which is
// the thing an expert network gets paid for doing badly today.
//
// ORDER COMES FROM THE SERVER AND IS NOT TOUCHED HERE. lib/screeningView sorts
// (submitted first, coverage descending) and labels ("Candidate N", by mint
// order, stable for the life of the request) before the rows are sent. This
// component renders `request.respondents` in the order it was handed. Re-sorting
// in the browser would make the label mean one thing on the page and another in
// an email, and filtering would break the rule above.
//
// NULL COVERAGE IS NOT ZERO COVERAGE. A respondent who has not replied has no
// ratio; they read as a dash and a line saying what is actually true — waiting,
// expired or revoked — rather than 0 of 6 in red, which would state something
// false about someone who has said nothing.
//
// REDACTION IS THE SERVER'S JOB, not this component's. `name` simply is not on
// the wire for a client (lib/screeningView), so the name is rendered whenever it
// is present and there is no `isAdmin` check guarding it — one boundary, in one
// file, checked by scripts/test-screening-redaction.ts.
//
// Mobile-first: stacked cards below `sm`, a table above it, same content in
// both. Every action has a busy state, every failure a sentence.

import { useCallback, useEffect, useRef, useState } from 'react';
import CoverageBadge, { coverageSentence } from './CoverageBadge';
import type { RespondentView, ScreeningRequestView } from '../../lib/screeningView';
import type {
  CallOutcomeValue,
  ExpertBackgroundLine,
  ScreeningAnswer,
  ScreeningAvailability,
  ScreeningObjective,
} from '../../types';

// ─── Copy and tokens ──────────────────────────────────────────────────────────

const NETWORK_MESSAGE = 'We could not reach the server. Check your connection and try again.';

const LABEL_STYLE = { letterSpacing: '0.16em' } as const;
const MICRO_LABEL = 'text-[10px] uppercase text-muted';

const AVAILABILITY_LABEL: Record<ScreeningAvailability, string> = {
  this_week: 'This week',
  next_week: 'Next week',
  later:     'Later',
};

const ANSWER_LABEL: Record<ScreeningAnswer, string> = {
  yes:    'Yes',
  no:     'No',
  unsure: 'Unsure',
};

// Same three tints as the coverage badge, for the same reason: they are a
// reading aid on a word that is already there, never a verdict on the person.
const ANSWER_TINT: Record<ScreeningAnswer, { bg: string; text: string; border: string }> = {
  yes:    { bg: '#EDFAF3', text: '#2E7D52', border: 'rgba(46,125,82,0.30)' },
  no:     { bg: '#FDF2F0', text: '#BE3A2B', border: 'rgba(190,58,43,0.30)' },
  unsure: { bg: '#FFF7ED', text: '#B45309', border: 'rgba(180,83,9,0.30)' },
};

const OUTCOME_CHOICES: ReadonlyArray<{ value: CallOutcomeValue; label: string }> = [
  { value: 'answered',   label: 'Answered'   },
  { value: 'partial',    label: 'Partial'    },
  { value: 'unanswered', label: 'Unanswered' },
];

// ─── Wire shapes ──────────────────────────────────────────────────────────────

interface RespondentEnvelope {
  respondent?: RespondentView;
  error?:      string;
  message?:    string;
}

// ─── Formatting ───────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "Northwind Foods · VP Supply Chain · 2019–2023", with the blanks left out. */
function backgroundLine(line: ExpertBackgroundLine): string {
  return [line.company, line.role, line.dates].filter(part => part.trim() !== '').join(' · ');
}

function isExpired(iso: string): boolean {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.getTime() < Date.now();
}

/** The one line that says what is true about a link nobody can act on yet. */
function stateLine(respondent: RespondentView): string | null {
  if (respondent.revokedAt) return 'Link revoked';
  if (respondent.submittedAt) return null;
  if (isExpired(respondent.expiresAt)) return 'Link expired';
  const expires = formatDate(respondent.expiresAt);
  return expires ? `Waiting on a reply · link expires ${expires}` : 'Waiting on a reply';
}

// ─── Cell pieces, shared by the table and the cards ───────────────────────────

function ExpandButton({
  open, onToggle, controls, label,
}: {
  open:     boolean;
  onToggle: () => void;
  controls: string;
  label:    string;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={controls}
      aria-label={open ? `Hide ${label}'s answers` : `Show ${label}'s answers`}
      className="shrink-0 w-7 h-7 inline-flex items-center justify-center border border-frame bg-white text-navy hover:bg-cream transition-colors"
    >
      <svg
        width="10" height="10" viewBox="0 0 10 10" aria-hidden="true"
        className="transition-transform"
        style={{ transform: open ? 'rotate(90deg)' : 'none' }}
      >
        <path d="M3 1 L7 5 L3 9" fill="none" stroke="currentColor" strokeWidth="1.5" />
      </svg>
    </button>
  );
}

/** "Candidate 3", the staff-only name, the headline and the background lines. */
function Identity({ respondent }: { respondent: RespondentView }) {
  return (
    <div className="min-w-0">
      <p className="flex items-baseline gap-2 flex-wrap">
        <span className="text-[10px] uppercase text-navy" style={LABEL_STYLE}>
          {respondent.label}
        </span>
        {respondent.name && (
          <span className="text-xs text-ink">{respondent.name}</span>
        )}
      </p>
      {respondent.headline && (
        <p className="mt-1 text-xs leading-relaxed text-ink-light">{respondent.headline}</p>
      )}
      {respondent.background.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {respondent.background.map((line, i) => (
            <li key={i} className="text-[11px] leading-relaxed text-muted">{backgroundLine(line)}</li>
          ))}
        </ul>
      ) : (
        <p className="mt-1.5 text-[11px] leading-relaxed text-muted">No background recorded</p>
      )}
    </div>
  );
}

function RateCell({ respondent }: { respondent: RespondentView }) {
  if (!respondent.rate) return <span className="text-xs text-muted">—</span>;

  return (
    <div className="min-w-0">
      <p className="text-xs text-ink whitespace-nowrap tabular-nums">
        ${respondent.rate.clientRate.toLocaleString('en-US')}/hr
      </p>
      <p className={`mt-1 ${MICRO_LABEL}`} style={LABEL_STYLE}>
        {respondent.rate.accepted ? 'accepted' : 'asked'}
      </p>
      {/* STAFF ONLY — absent from the wire for a client (lib/screeningView). */}
      {respondent.rate.expertAsk !== undefined && (
        <p className="mt-1 text-[11px] text-muted whitespace-nowrap tabular-nums">
          expert ask ${respondent.rate.expertAsk.toLocaleString('en-US')}
        </p>
      )}
    </div>
  );
}

function AvailabilityCell({ respondent }: { respondent: RespondentView }) {
  return (
    <span className="text-xs text-ink whitespace-nowrap">
      {respondent.availability ? AVAILABILITY_LABEL[respondent.availability] : '—'}
    </span>
  );
}

function AnswerPill({ answer }: { answer: ScreeningAnswer }) {
  const tint = ANSWER_TINT[answer];
  return (
    <span
      className="inline-block border px-2 py-0.5 text-[10px] uppercase"
      style={{ background: tint.bg, color: tint.text, borderColor: tint.border, letterSpacing: '0.12em' }}
    >
      {ANSWER_LABEL[answer]}
    </span>
  );
}

/**
 * The client's one action on a respondent, identical in both layouts.
 *
 * Disabled rather than hidden while the expert has not answered: the row exists
 * because a link went out, and a button that is simply absent reads as "this
 * person cannot be booked" instead of "not yet". The reason is on the button,
 * for a pointer and for a screen reader.
 */
function Action({
  respondent, canEdit, working, onRequestCall,
}: {
  respondent:    RespondentView;
  canEdit:       boolean;
  working:       boolean;
  onRequestCall: () => void;
}) {
  if (!canEdit)             return null;
  if (respondent.revokedAt) return null;

  if (respondent.callRequestedAt) {
    return (
      <p className="text-[11px] leading-relaxed text-muted whitespace-nowrap">
        Call requested {formatDate(respondent.callRequestedAt)}
      </p>
    );
  }

  const waiting = !respondent.submittedAt;
  const reason  = waiting ? 'This expert has not answered the screening yet.' : undefined;

  return (
    <button
      type="button"
      onClick={onRequestCall}
      disabled={waiting || working}
      title={reason}
      aria-label={reason ? `Request call — ${reason}` : undefined}
      className="w-full sm:w-auto text-[10px] uppercase tracking-widest text-navy bg-gold border border-gold px-3 py-2 hover:bg-gold/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
      style={LABEL_STYLE}
    >
      {working ? 'Requesting…' : 'Request call'}
    </button>
  );
}

/**
 * The expanded row: every objective the client asked, what this expert said,
 * and — once a call has been requested — what it covered.
 *
 * `proofText` is rendered EXACTLY as the expert typed it: not trimmed, not
 * clipped, not summarised, whitespace preserved. It is the one sentence the
 * client is buying a decision on.
 *
 * Module level, not an inner function, and that is load-bearing: a component
 * defined inside the render body gets a new identity on every keystroke of
 * state, so React would unmount and remount this subtree each time a verdict is
 * picked and the button the client just pressed would lose focus.
 */
function Breakdown({
  respondent, id, objectives, chosen, onPick, onSave, working, notice, flash,
}: {
  respondent: RespondentView;
  id:         string;
  objectives: ScreeningObjective[];
  chosen:     (objectiveId: string) => CallOutcomeValue | undefined;
  onPick:     (objectiveId: string, outcome: CallOutcomeValue) => void;
  onSave:     () => void;
  working:    boolean;
  notice?:    string;
  flash?:     string;
}) {
  const marking   = respondent.callRequestedAt !== null;
  const anyChosen = objectives.some(o => chosen(o.id) !== undefined);

  return (
    <div id={id} className="bg-cream/60 border-t border-frame px-4 sm:px-5 py-5">
      <ol className="space-y-5">
        {objectives.map((objective, index) => {
          const answer = respondent.answers.find(a => a.objectiveId === objective.id);
          return (
            <li key={objective.id}>
              <p className={MICRO_LABEL} style={LABEL_STYLE}>Objective {index + 1}</p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink">{objective.objectiveText}</p>

              <div className="mt-2">
                {answer
                  ? <AnswerPill answer={answer.answer} />
                  : <span className="text-[11px] text-muted">Not asked</span>}
              </div>

              {/* The expert's own sentence, exactly as they typed it. */}
              {answer?.answer === 'yes' && answer.proofText !== null && (
                <blockquote className="mt-2 border-l-2 border-frame pl-3 text-xs leading-relaxed text-ink-light italic whitespace-pre-wrap">
                  {answer.proofText}
                </blockquote>
              )}

              {marking && (
                <div className="mt-3">
                  <p className={MICRO_LABEL} style={LABEL_STYLE}>After the call</p>
                  <div className="mt-1.5 flex flex-wrap gap-1.5">
                    {OUTCOME_CHOICES.map(choice => {
                      const active = chosen(objective.id) === choice.value;
                      return (
                        <button
                          key={choice.value}
                          type="button"
                          onClick={() => onPick(objective.id, choice.value)}
                          disabled={working}
                          aria-pressed={active}
                          className={`text-[10px] uppercase px-2.5 py-1.5 border transition-colors disabled:opacity-40 disabled:cursor-not-allowed
                            ${active
                              ? 'bg-navy text-cream border-navy'
                              : 'bg-white text-navy border-frame hover:bg-cream'}`}
                          style={LABEL_STYLE}
                        >
                          {choice.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </li>
          );
        })}
      </ol>

      {marking && (
        <div className="mt-5 pt-4 border-t border-frame flex flex-col sm:flex-row sm:items-center gap-3">
          <button
            type="button"
            onClick={onSave}
            disabled={working || !anyChosen}
            className="w-full sm:w-auto text-[10px] uppercase tracking-widest text-navy border border-frame bg-white px-3 py-2 hover:bg-cream disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={LABEL_STYLE}
          >
            {working ? 'Saving…' : 'Save what the call covered'}
          </button>
          {flash && <p role="status" className="text-[11px] leading-relaxed text-muted">{flash}</p>}
        </div>
      )}

      {notice && (
        <p role="alert" className="mt-3 text-[11px] leading-relaxed text-red-600">{notice}</p>
      )}
    </div>
  );
}

// ─── The component ────────────────────────────────────────────────────────────

interface RespondentsTableProps {
  request:  ScreeningRequestView;
  onChange: (next: ScreeningRequestView) => void;
}

type Busy = 'call' | 'outcomes';

export default function RespondentsTable({ request, onChange }: RespondentsTableProps) {
  const [open,   setOpen]   = useState<Record<string, boolean>>({});
  const [busy,   setBusy]   = useState<Record<string, Busy | undefined>>({});
  const [notice, setNotice] = useState<Record<string, string | undefined>>({});
  const [flash,  setFlash]  = useState<Record<string, string | undefined>>({});
  // objectiveId → the verdict this client has picked but not yet saved.
  const [drafts, setDrafts] = useState<Record<string, Record<string, CallOutcomeValue>>>({});

  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  useEffect(() => {
    const held = timers.current;
    return () => { for (const timer of Object.values(held)) clearTimeout(timer); };
  }, []);

  const replace = useCallback((next: RespondentView) => {
    // Order is the server's (see the header) — the row is swapped in place.
    onChange({
      ...request,
      respondents: request.respondents.map(r => (r.id === next.id ? next : r)),
    });
  }, [request, onChange]);

  const toggle = useCallback((id: string) => {
    setOpen(current => ({ ...current, [id]: !current[id] }));
  }, []);

  /** The verdict shown on a control: what this client just picked, else what is stored. */
  const chosen = useCallback((
    respondent: RespondentView,
    objectiveId: string,
  ): CallOutcomeValue | undefined => {
    const draft = drafts[respondent.id]?.[objectiveId];
    if (draft) return draft;
    return respondent.outcomes.find(o => o.objectiveId === objectiveId)?.outcome;
  }, [drafts]);

  const pick = useCallback((
    respondentId: string,
    objectiveId:  string,
    outcome:      CallOutcomeValue,
  ) => {
    setDrafts(current => ({
      ...current,
      [respondentId]: { ...(current[respondentId] ?? {}), [objectiveId]: outcome },
    }));
    setNotice(current => ({ ...current, [respondentId]: undefined }));
    setFlash(current => ({ ...current, [respondentId]: undefined }));
  }, []);

  const showFlash = useCallback((id: string, message: string) => {
    setFlash(current => ({ ...current, [id]: message }));
    clearTimeout(timers.current[id]);
    timers.current[id] = setTimeout(() => {
      setFlash(current => ({ ...current, [id]: undefined }));
    }, 2500);
  }, []);

  // ── Request call ─────────────────────────────────────────────────────────
  const requestCall = useCallback(async (respondent: RespondentView) => {
    setBusy(current => ({ ...current, [respondent.id]: 'call' }));
    setNotice(current => ({ ...current, [respondent.id]: undefined }));
    try {
      const res = await fetch(
        `/api/requests/${request.id}/tokens/${respondent.id}/request-call`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      const data: RespondentEnvelope | null = await res.json().catch(() => null);

      if (!res.ok || !data?.respondent) {
        setNotice(current => ({
          ...current,
          [respondent.id]: data?.message ?? 'We could not request that call. Try again.',
        }));
        return;
      }
      replace(data.respondent);
      setOpen(current => ({ ...current, [respondent.id]: true }));
    } catch {
      setNotice(current => ({ ...current, [respondent.id]: NETWORK_MESSAGE }));
    } finally {
      setBusy(current => ({ ...current, [respondent.id]: undefined }));
    }
  }, [request.id, replace]);

  // ── Save what the call covered ───────────────────────────────────────────
  const saveOutcomes = useCallback(async (respondent: RespondentView) => {
    // Only objectives with a choice: an unmarked one is a question the client
    // has not judged yet, not a verdict of "unanswered".
    const outcomes = request.objectives
      .map(objective => ({ objectiveId: objective.id, outcome: chosen(respondent, objective.id) }))
      .filter((entry): entry is { objectiveId: string; outcome: CallOutcomeValue } =>
        entry.outcome !== undefined);

    if (outcomes.length === 0) return;

    setBusy(current => ({ ...current, [respondent.id]: 'outcomes' }));
    setNotice(current => ({ ...current, [respondent.id]: undefined }));
    try {
      const res = await fetch(
        `/api/requests/${request.id}/tokens/${respondent.id}/outcomes`,
        {
          method:  'POST',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({ outcomes }),
        },
      );
      const data: RespondentEnvelope | null = await res.json().catch(() => null);

      if (!res.ok || !data?.respondent) {
        setNotice(current => ({
          ...current,
          [respondent.id]: data?.message ?? 'We could not save what that call covered. Try again.',
        }));
        return;
      }
      replace(data.respondent);
      // The server's rows are now the truth; the local picks would only shadow them.
      setDrafts(current => ({ ...current, [respondent.id]: {} }));
      showFlash(respondent.id, 'Saved.');
    } catch {
      setNotice(current => ({ ...current, [respondent.id]: NETWORK_MESSAGE }));
    } finally {
      setBusy(current => ({ ...current, [respondent.id]: undefined }));
    }
  }, [request.id, request.objectives, chosen, replace, showFlash]);

  // ── Empty ────────────────────────────────────────────────────────────────
  if (request.respondents.length === 0) {
    return (
      <div>
        <p className="text-xs leading-relaxed text-muted">No screening links have been sent yet.</p>
        {!request.isAdmin && (
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            We&apos;ll invite experts against your approved set and their answers will appear here.
          </p>
        )}
      </div>
    );
  }

  const columns = request.canEdit ? 5 : 4;

  // ── Desktop table ────────────────────────────────────────────────────────
  // One <tbody> PER RESPONDENT rather than one for the table: a breakdown is a
  // second <tr> belonging to the row above it, and a tbody per respondent is
  // the only way to key that pair without an invalid element between rows.
  const desktop = (
    <div className="hidden sm:block overflow-x-auto">
      <table className="w-full border-collapse text-left">
        <thead>
          <tr className="border-b border-frame">
            {['Coverage', 'Background', 'Rate', 'Availability'].map(heading => (
              <th
                key={heading}
                scope="col"
                className={`px-3 py-2.5 font-medium ${MICRO_LABEL}`}
                style={LABEL_STYLE}
              >
                {heading}
              </th>
            ))}
            {request.canEdit && (
              <th scope="col" className="px-3 py-2.5">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        {request.respondents.map(respondent => {
          const expanded = open[respondent.id] === true;
          const line     = stateLine(respondent);
          const bodyId   = `breakdown-d-${respondent.id}`;
          const rowBusy  = busy[respondent.id];
          const rowError = notice[respondent.id];

          return (
            <tbody key={respondent.id} className="border-b border-frame">
              <tr className="align-top">
                <td className="px-3 py-4">
                  <div className="flex items-center gap-2">
                    {respondent.submittedAt ? (
                      <ExpandButton
                        open={expanded}
                        onToggle={() => toggle(respondent.id)}
                        controls={bodyId}
                        label={respondent.label}
                      />
                    ) : (
                      <span className="w-7 shrink-0 inline-block" aria-hidden="true" />
                    )}
                    <CoverageBadge coverage={respondent.coverage} />
                  </div>
                  {line && <p className="mt-2 text-[11px] leading-relaxed text-muted">{line}</p>}
                </td>
                <td className="px-3 py-4"><Identity respondent={respondent} /></td>
                <td className="px-3 py-4"><RateCell respondent={respondent} /></td>
                <td className="px-3 py-4"><AvailabilityCell respondent={respondent} /></td>
                {request.canEdit && (
                  <td className="px-3 py-4 text-right">
                    <Action
                      respondent={respondent}
                      canEdit={request.canEdit}
                      working={rowBusy === 'call'}
                      onRequestCall={() => void requestCall(respondent)}
                    />
                    {!expanded && rowError && rowBusy === undefined && (
                      <p role="alert" className="mt-2 text-[11px] leading-relaxed text-red-600">
                        {rowError}
                      </p>
                    )}
                  </td>
                )}
              </tr>
              {expanded && (
                <tr>
                  <td colSpan={columns} className="p-0">
                    <Breakdown
                      respondent={respondent}
                      id={bodyId}
                      objectives={request.objectives}
                      chosen={objectiveId => chosen(respondent, objectiveId)}
                      onPick={(objectiveId, outcome) => pick(respondent.id, objectiveId, outcome)}
                      onSave={() => void saveOutcomes(respondent)}
                      working={rowBusy === 'outcomes'}
                      notice={rowError}
                      flash={flash[respondent.id]}
                    />
                  </td>
                </tr>
              )}
            </tbody>
          );
        })}
      </table>
    </div>
  );

  // ── Mobile cards ─────────────────────────────────────────────────────────
  const mobile = (
    <ul className="sm:hidden space-y-3">
      {request.respondents.map(respondent => {
        const expanded = open[respondent.id] === true;
        const line     = stateLine(respondent);
        const bodyId   = `breakdown-m-${respondent.id}`;
        const rowBusy  = busy[respondent.id];
        const rowError = notice[respondent.id];

        return (
          <li key={respondent.id} className="border border-frame bg-white">
            <div className="px-4 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <CoverageBadge coverage={respondent.coverage} size="sm" />
                  <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                    {coverageSentence(respondent.coverage)}
                  </p>
                </div>
                {respondent.submittedAt && (
                  <ExpandButton
                    open={expanded}
                    onToggle={() => toggle(respondent.id)}
                    controls={bodyId}
                    label={respondent.label}
                  />
                )}
              </div>

              <div className="mt-3"><Identity respondent={respondent} /></div>

              <dl className="mt-3 grid grid-cols-2 gap-3">
                <div className="min-w-0">
                  <dt className={MICRO_LABEL} style={LABEL_STYLE}>Rate</dt>
                  <dd className="mt-1"><RateCell respondent={respondent} /></dd>
                </div>
                <div className="min-w-0">
                  <dt className={MICRO_LABEL} style={LABEL_STYLE}>Availability</dt>
                  <dd className="mt-1"><AvailabilityCell respondent={respondent} /></dd>
                </div>
              </dl>

              {line && <p className="mt-3 text-[11px] leading-relaxed text-muted">{line}</p>}

              {request.canEdit && (
                <div className="mt-4">
                  <Action
                      respondent={respondent}
                      canEdit={request.canEdit}
                      working={rowBusy === 'call'}
                      onRequestCall={() => void requestCall(respondent)}
                    />
                  {!expanded && rowError && rowBusy === undefined && (
                    <p role="alert" className="mt-2 text-[11px] leading-relaxed text-red-600">
                      {rowError}
                    </p>
                  )}
                </div>
              )}
            </div>

            {expanded && <Breakdown
                      respondent={respondent}
                      id={bodyId}
                      objectives={request.objectives}
                      chosen={objectiveId => chosen(respondent, objectiveId)}
                      onPick={(objectiveId, outcome) => pick(respondent.id, objectiveId, outcome)}
                      onSave={() => void saveOutcomes(respondent)}
                      working={rowBusy === 'outcomes'}
                      notice={rowError}
                      flash={flash[respondent.id]}
                    />}
          </li>
        );
      })}
    </ul>
  );

  return (
    <div>
      {desktop}
      {mobile}
    </div>
  );
}

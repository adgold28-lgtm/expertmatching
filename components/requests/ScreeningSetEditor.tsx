'use client';

// The draft state of /requests/[id]: the client reads the questions an expert
// will be asked, rewrites any of them inline, and approves the set
// (docs/SCREENING_FLOW_PLAN.md, build step 3).
//
// THE ONE THING THIS SCREEN HAS TO GET RIGHT is that nothing leaves the
// platform until the client has read it. Generation runs on mount because the
// alternative is an empty page with a button on it; approval is always an
// explicit press; and the line under the actions says so in as many words.
//
// GENERATION IS NEVER A DEAD END. POST /generate always returns a complete,
// editable set — model text when the model behaved, plain deterministic text
// when it did not. When it fell back, the client is told WHICH of those two
// things happened in one honest sentence, because "we replaced a draft that
// asked for your findings" and "the model was unreachable" call for different
// reactions from them.
//
// EDITING IS ALLOWED; TURNING A PROOF PROMPT INTO A SUBSTANCE QUESTION IS NOT.
// PATCH /api/requests/[id] runs the same validator the model's output has to
// pass and answers 422 invalid_item; that message lands under the offending
// field, next to the text that caused it. Same for the compliance screen at
// approval: every finding is rendered under the field it came from, with the
// exact substring to remove.
//
// Mobile-first: one column of cards, textareas that grow with their content,
// full-width actions that sit side by side only when there is room.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScreeningRequestView } from '../../lib/screeningView';

// ─── Wire shapes this component reads ─────────────────────────────────────────

type GenerationSource = 'model' | 'fallback';
type GenerationReason = 'no_api_key' | 'model_error' | 'refusal' | 'unparseable' | 'validation';

interface GenerationInfo {
  source:  GenerationSource;
  reason?: GenerationReason;
}

interface RequestEnvelope {
  request:     ScreeningRequestView;
  generation?: GenerationInfo;
}

interface ApiErrorBody {
  error?:        string;
  message?:      string;
  errors?:       Array<{ field?: string; message?: string }>;
  objectiveId?:  string;
  field?:        string;
  objectiveIds?: string[];
  findings?:     Array<{ objectiveId: string | null; field: string; match: string; hint: string }>;
}

type Field = 'stem' | 'proofPrompt';

interface Draft {
  stem:        string;
  proofPrompt: string;
}

type Issues = Record<string, Partial<Record<Field, string[]>>>;

interface ScreeningSetEditorProps {
  request:  ScreeningRequestView;
  onChange: (next: ScreeningRequestView) => void;
}

// ─── Copy ─────────────────────────────────────────────────────────────────────

const MAX_CHARS = 300;

const NETWORK_MESSAGE = 'We could not reach the server. Check your connection and try again.';

/** One honest sentence about why the set is not what the model wrote. */
function fallbackSentence(reason: GenerationReason | undefined): string {
  if (reason === 'validation') {
    return 'One or more drafts asked for findings instead of role and timeframe, so we replaced them with a plain version. Edit as you like.';
  }
  return 'We could not draft these automatically. Edit them below and approve when they read right.';
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

const LABEL_CLASS = 'block text-[10px] uppercase text-muted';
const LABEL_STYLE = { letterSpacing: '0.16em' } as const;

/** A textarea that grows with its content instead of scrolling inside itself. */
function GrowingTextarea({
  id, value, onChange, disabled, invalid, describedBy,
}: {
  id:          string;
  value:       string;
  onChange:    (next: string) => void;
  disabled:    boolean;
  invalid:     boolean;
  describedBy?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  return (
    <textarea
      id={id}
      ref={ref}
      rows={2}
      value={value}
      maxLength={MAX_CHARS}
      disabled={disabled}
      aria-invalid={invalid || undefined}
      aria-describedby={describedBy}
      onChange={e => onChange(e.target.value)}
      className={`input-search w-full resize-none bg-white px-3 py-2 text-sm leading-relaxed text-ink border
        ${invalid ? 'border-red-300' : 'border-frame'}
        disabled:bg-cream-dark disabled:text-muted`}
      style={{ minHeight: '2.75rem' }}
    />
  );
}

function FieldIssues({ id, messages }: { id: string; messages: string[] | undefined }) {
  if (!messages || messages.length === 0) return null;
  return (
    <ul id={id} className="mt-1.5 space-y-1" role="alert">
      {messages.map((message, i) => (
        <li key={i} className="text-[11px] leading-relaxed text-red-600">{message}</li>
      ))}
    </ul>
  );
}

function GeneratingState() {
  return (
    <section className="border border-frame bg-white px-5 sm:px-6 py-6">
      <h2 className="text-[11px] uppercase font-medium text-navy" style={LABEL_STYLE}>
        Turning your objectives into screening questions…
      </h2>
      <p className="mt-1.5 text-xs leading-relaxed text-muted">
        This takes a few seconds. Nothing is sent to an expert.
      </p>
      <div className="mt-5 space-y-4" aria-hidden="true">
        {[0, 1, 2].map(i => (
          <div key={i} className="space-y-2">
            <div className="skeleton h-3 w-1/3" />
            <div className="skeleton h-10 w-full" />
            <div className="skeleton h-10 w-full" />
          </div>
        ))}
      </div>
    </section>
  );
}

// ─── The editor ───────────────────────────────────────────────────────────────

export default function ScreeningSetEditor({ request, onChange }: ScreeningSetEditorProps) {
  const [drafts,      setDrafts]      = useState<Record<string, Draft>>({});
  const [saved,       setSaved]       = useState<Record<string, Draft>>({});
  const [generating,  setGenerating]  = useState(false);
  const [generation,  setGeneration]  = useState<GenerationInfo | null>(null);
  const [busy,        setBusy]        = useState<'approve' | 'regenerate' | null>(null);
  const [notice,      setNotice]      = useState<string | null>(null);
  const [issues,      setIssues]      = useState<Issues>({});
  const [topicIssues, setTopicIssues] = useState<string[]>([]);
  const [confirming,  setConfirming]  = useState(false);

  // The generation this component started, at most once per request. A ref
  // rather than state: it must not re-trigger the effect it guards.
  const autoGenerated = useRef<string | null>(null);

  // ── Keep the local text in step with whatever the server last returned ────
  // `request` only changes identity after a save or a generation, so typing is
  // never overwritten mid-sentence.
  useEffect(() => {
    const next: Record<string, Draft> = {};
    for (const objective of request.objectives) {
      next[objective.id] = {
        stem:        objective.stem        ?? '',
        proofPrompt: objective.proofPrompt ?? '',
      };
    }
    setDrafts(next);
    setSaved(next);
  }, [request]);

  const setField = useCallback((objectiveId: string, field: Field, value: string) => {
    setDrafts(current => ({
      ...current,
      [objectiveId]: { ...current[objectiveId], [field]: value },
    }));
    // The message under a field described the text that was there a moment ago.
    setIssues(current => {
      const forObjective = current[objectiveId];
      if (!forObjective || !forObjective[field]) return current;
      return { ...current, [objectiveId]: { ...forObjective, [field]: undefined } };
    });
  }, []);

  const isDirty = useCallback((objectiveId: string): boolean => {
    const draft = drafts[objectiveId];
    const base  = saved[objectiveId];
    if (!draft || !base) return false;
    return draft.stem.trim() !== base.stem.trim()
      || draft.proofPrompt.trim() !== base.proofPrompt.trim();
  }, [drafts, saved]);

  const hasUnsavedEdits = request.objectives.some(o => isDirty(o.id));
  const hasClientEdits  = request.objectives.some(o => o.clientEdited);

  // ── Generation ───────────────────────────────────────────────────────────
  const generate = useCallback(async () => {
    setGenerating(true);
    setNotice(null);
    setIssues({});
    setTopicIssues([]);
    try {
      const res  = await fetch(`/api/requests/${request.id}/generate`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    '{}',
      });
      const data: (RequestEnvelope & ApiErrorBody) | null = await res.json().catch(() => null);

      if (!res.ok) {
        if (res.status === 429) {
          setNotice(data?.message
            ?? 'You have redrafted a lot of screening sets in the last hour. Try again shortly.');
        } else {
          setNotice(data?.message ?? 'We could not draft the screening questions. Try again.');
        }
        return;
      }
      if (!data?.request) {
        setNotice('We could not draft the screening questions. Try again.');
        return;
      }
      setGeneration(data.generation ?? null);
      onChange(data.request);
    } catch {
      setNotice(NETWORK_MESSAGE);
    } finally {
      setGenerating(false);
    }
  }, [request.id, onChange]);

  // A request whose objectives have no stems has never been generated. Doing it
  // on mount rather than behind a button is the plan's call: the client just
  // submitted a brief and an empty page with one button on it is a worse answer
  // than a five-second wait with a real loading state.
  useEffect(() => {
    if (autoGenerated.current === request.id) return;
    if (!request.objectives.some(o => o.stem === null)) return;
    autoGenerated.current = request.id;
    void generate();
  }, [request.id, request.objectives, generate]);

  // ── Errors, placed under the field that caused them ──────────────────────
  const addIssue = useCallback((objectiveId: string, field: Field, message: string) => {
    setIssues(current => {
      const forObjective = current[objectiveId] ?? {};
      const existing     = forObjective[field] ?? [];
      return { ...current, [objectiveId]: { ...forObjective, [field]: [...existing, message] } };
    });
  }, []);

  const asField = (value: string | undefined): Field | null =>
    value === 'stem' || value === 'proofPrompt' ? value : null;

  /** Turns `objectives[2].stem` from a 400 back into the objective it belongs to. */
  const applyValidationErrors = useCallback((
    errors: Array<{ field?: string; message?: string }>,
    sent:   Array<{ id: string }>,
  ) => {
    let unplaced = false;
    for (const error of errors) {
      const match = /^objectives\[(\d+)\]\.(stem|proofPrompt)$/.exec(error.field ?? '');
      const id    = match ? sent[parseInt(match[1], 10)]?.id : undefined;
      const field = match ? asField(match[2]) : null;
      if (id && field && error.message) addIssue(id, field, error.message);
      else unplaced = true;
    }
    if (unplaced) setNotice('Some of those edits could not be saved. Check the questions below.');
  }, [addIssue]);

  // ── Approve ──────────────────────────────────────────────────────────────
  const approve = useCallback(async () => {
    setBusy('approve');
    setNotice(null);
    setIssues({});
    setTopicIssues([]);

    const pending = request.objectives
      .filter(o => isDirty(o.id))
      .map(o => ({
        id:          o.id,
        stem:        (drafts[o.id]?.stem ?? '').trim(),
        proofPrompt: (drafts[o.id]?.proofPrompt ?? '').trim(),
      }));

    try {
      // 1. Save the edits. Only what changed is sent — an unchanged item is not
      //    a client edit and must not be tagged as one.
      if (pending.length > 0) {
        const res  = await fetch(`/api/requests/${request.id}`, {
          method:  'PATCH',
          headers: { 'content-type': 'application/json' },
          body:    JSON.stringify({ objectives: pending }),
        });
        const data: (RequestEnvelope & ApiErrorBody) | null = await res.json().catch(() => null);

        if (!res.ok) {
          if (res.status === 400 && Array.isArray(data?.errors)) {
            applyValidationErrors(data.errors, pending);
          } else if (res.status === 422 && data?.error === 'invalid_item') {
            const field = asField(data.field);
            if (data.objectiveId && field && data.message) addIssue(data.objectiveId, field, data.message);
            else setNotice(data?.message ?? 'One of those edits cannot be sent to an expert.');
          } else if (res.status === 409) {
            setNotice(data?.message ?? 'This screening set has already been approved.');
          } else {
            setNotice(data?.message ?? 'We could not save those edits. Try again.');
          }
          return;
        }
        if (data?.request) onChange(data.request);
      }

      // 2. Approve.
      const res  = await fetch(`/api/requests/${request.id}/approve`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    '{}',
      });
      const data: (RequestEnvelope & ApiErrorBody) | null = await res.json().catch(() => null);

      if (!res.ok) {
        if (res.status === 422 && data?.error === 'incomplete_items') {
          for (const id of data.objectiveIds ?? []) {
            if (!(drafts[id]?.stem ?? '').trim())        addIssue(id, 'stem', 'Write the question an expert answers.');
            if (!(drafts[id]?.proofPrompt ?? '').trim()) addIssue(id, 'proofPrompt', 'Write what we ask for when they say yes.');
          }
          setNotice(data.message ?? 'Every objective needs a question and a proof prompt.');
        } else if (res.status === 422 && data?.error === 'screen_blocked') {
          const topic: string[] = [];
          for (const finding of data.findings ?? []) {
            const line  = `Remove ${finding.match}: ${finding.hint}`;
            const field = asField(finding.field);
            if (finding.objectiveId && field) addIssue(finding.objectiveId, field, line);
            else topic.push(line);
          }
          if (topic.length > 0) setTopicIssues(topic);
          setNotice(data.message
            ?? 'An expert must not be able to work out who is asking. Fix the lines below and approve again.');
        } else if (res.status === 429) {
          setNotice(data?.message ?? 'Too many attempts just now. Try again shortly.');
        } else if (res.status === 409) {
          setNotice(data?.message ?? 'This screening set has already been approved.');
        } else {
          setNotice(data?.message ?? 'We could not approve that screening set. Try again.');
        }
        return;
      }
      if (data?.request) onChange(data.request);
    } catch {
      setNotice(NETWORK_MESSAGE);
    } finally {
      setBusy(null);
    }
  }, [request.id, request.objectives, drafts, isDirty, onChange, addIssue, applyValidationErrors]);

  const onRegeneratePressed = useCallback(() => {
    if (hasUnsavedEdits || hasClientEdits) {
      setConfirming(true);
      return;
    }
    setBusy('regenerate');
    void generate().finally(() => setBusy(null));
  }, [hasUnsavedEdits, hasClientEdits, generate]);

  const confirmRegenerate = useCallback(() => {
    setConfirming(false);
    setBusy('regenerate');
    void generate().finally(() => setBusy(null));
  }, [generate]);

  // ── Generating ───────────────────────────────────────────────────────────
  if (generating) return <GeneratingState />;

  const working = busy !== null;

  return (
    <div className="space-y-5">

      {/* ── Why these are not the model's words ── */}
      {generation?.source === 'fallback' && (
        <p className="border border-gold/40 bg-gold/5 px-4 py-3 text-xs leading-relaxed text-ink-light">
          {fallbackSentence(generation.reason)}
        </p>
      )}

      {/* ── Page-level problem ── */}
      {notice && (
        <div role="alert" className="border border-red-200 bg-red-50 px-4 py-3">
          <p className="text-xs leading-relaxed text-red-700">{notice}</p>
        </div>
      )}

      {/* ── A finding on the topic itself belongs to no card ── */}
      {topicIssues.length > 0 && (
        <div role="alert" className="border border-red-200 bg-white px-4 py-3">
          <p className={LABEL_CLASS} style={LABEL_STYLE}>Topic</p>
          <ul className="mt-1.5 space-y-1">
            {topicIssues.map((line, i) => (
              <li key={i} className="text-[11px] leading-relaxed text-red-600">{line}</li>
            ))}
          </ul>
        </div>
      )}

      {/* ── One card per objective ── */}
      {request.objectives.map((objective, index) => {
        const draft   = drafts[objective.id] ?? { stem: '', proofPrompt: '' };
        const dirty   = isDirty(objective.id);
        const edited  = objective.clientEdited || dirty;
        const forThis = issues[objective.id] ?? {};

        return (
          <section key={objective.id} className="border border-frame bg-white">
            <header className="px-5 sm:px-6 py-4 border-b border-frame">
              <div className="flex items-start justify-between gap-3">
                <p className={LABEL_CLASS} style={LABEL_STYLE}>Objective {index + 1}</p>
                {edited && (
                  <span className="shrink-0 text-[10px] uppercase text-navy border border-gold/50 bg-gold/10 px-1.5 py-0.5"
                    style={LABEL_STYLE}>
                    Edited
                  </span>
                )}
              </div>
              <p className="mt-2 text-sm leading-relaxed text-ink">{objective.objectiveText}</p>
              {objective.source === 'fallback' && (
                <p className="mt-2 text-[11px] leading-relaxed text-muted">
                  Replaced with a plain version.
                </p>
              )}
            </header>

            <div className="px-5 sm:px-6 py-5 space-y-5">
              <div>
                <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor={`stem-${objective.id}`}>
                  Question the expert answers
                </label>
                <div className="mt-1.5">
                  <GrowingTextarea
                    id={`stem-${objective.id}`}
                    value={draft.stem}
                    onChange={value => setField(objective.id, 'stem', value)}
                    disabled={working}
                    invalid={(forThis.stem?.length ?? 0) > 0}
                    describedBy={forThis.stem ? `stem-issues-${objective.id}` : undefined}
                  />
                </div>
                <FieldIssues id={`stem-issues-${objective.id}`} messages={forThis.stem} />
              </div>

              <div>
                <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor={`proof-${objective.id}`}>
                  If yes, we ask
                </label>
                <div className="mt-1.5">
                  <GrowingTextarea
                    id={`proof-${objective.id}`}
                    value={draft.proofPrompt}
                    onChange={value => setField(objective.id, 'proofPrompt', value)}
                    disabled={working}
                    invalid={(forThis.proofPrompt?.length ?? 0) > 0}
                    describedBy={forThis.proofPrompt ? `proof-issues-${objective.id}` : undefined}
                  />
                </div>
                <FieldIssues id={`proof-issues-${objective.id}`} messages={forThis.proofPrompt} />
                <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
                  This asks for their role and the years only — never what they found. That is the call.
                </p>
              </div>
            </div>
          </section>
        );
      })}

      {/* ── Actions ── */}
      <div className="border border-frame bg-white px-5 sm:px-6 py-5">
        {confirming ? (
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <p className="text-xs leading-relaxed text-ink flex-1">This replaces your edits.</p>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={confirmRegenerate}
                className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-2 hover:bg-navy/90 transition-colors"
                style={LABEL_STYLE}
              >
                Regenerate
              </button>
              <button
                type="button"
                onClick={() => setConfirming(false)}
                className="text-[10px] uppercase tracking-widest text-navy border border-frame px-3 py-2 hover:bg-cream transition-colors"
                style={LABEL_STYLE}
              >
                Keep
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col sm:flex-row-reverse sm:items-center gap-3">
            <button
              type="button"
              onClick={approve}
              disabled={working}
              className="w-full sm:w-auto text-[10px] uppercase tracking-widest text-navy bg-gold border border-gold px-4 py-2.5 hover:bg-gold/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              style={LABEL_STYLE}
            >
              {busy === 'approve' ? 'Approving…' : 'Approve screening set'}
            </button>
            <button
              type="button"
              onClick={onRegeneratePressed}
              disabled={working}
              className="w-full sm:w-auto text-[10px] uppercase tracking-widest text-navy border border-frame px-4 py-2.5 hover:bg-cream disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              style={LABEL_STYLE}
            >
              {busy === 'regenerate' ? 'Regenerating…' : 'Regenerate'}
            </button>
          </div>
        )}
        <p className="mt-4 text-[11px] leading-relaxed text-muted">
          Nothing is sent to an expert until you approve.
        </p>
      </div>
    </div>
  );
}

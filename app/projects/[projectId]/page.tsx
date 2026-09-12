'use client';

import { useCallback, useEffect, useRef, useState, Suspense } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { Project, ProjectExpert, ExpertStatus, Expert, SeniorityTier } from '../../../types';
import {
  classifySeniority,
  expertComparator,
  RATE_DISCLAIMER,
  SORT_LABELS,
  TIER_ORDER,
  TIER_PRICING,
  type ExpertSortKey,
} from '../../../lib/seniorityClassifier';
import ProjectExpertCard from '../../../components/ProjectExpertCard';
import { downloadProjectBriefPdf } from '../../../lib/exportBrief';
import ConversationsPanel from '../../../components/ConversationsPanel';
import { useFocusTrap } from '../../../lib/useFocusTrap';
import { hasConversation } from '../../../components/matchyStatus';
import { isWalkthrough } from '../../../lib/walkthrough';

// -----------------------------------------------------------------------------
// /projects/:projectId — the single project workspace. One client component
// covering all three client-facing steps (Brief / Matches / Conversations,
// docs/MATCHY_SPEC.md); see the section banners below for where each lives.
// All server calls go through `fetch(...)` against /api/projects/:projectId
// and its subroutes (this file does not use lib/matchyClient.ts directly for
// project-level reads/writes, only ConversationsPanel/ConversationThread do
// for the relay itself). `refreshProject()` polls every 5s while sourcing or
// an engagement is in flight so async server work (contact discovery,
// scoring) shows up without a manual reload — see the polling effect further
// down. `currentUserRole`/`currentUserEmail` (from /api/auth/me) gate a few
// UI affordances (the admin-only Staff panel inside a thread, owner-only
// send/bookmark buttons) but every one of those actions is re-checked
// server-side; nothing here is the actual authorization boundary.
// -----------------------------------------------------------------------------

// ─── Workflow step config ─────────────────────────────────────────────────────

// The client's workflow is Brief -> Matches -> Conversations
// (docs/MATCHY_SPEC.md, "The idea in one paragraph"). The pre-Matchy staff
// steps — Outreach, Screen, Deliver — are gone; the status detail they carried
// lives in the admin-only Staff panel at the top of a thread
// (components/ConversationThread.tsx).
type WorkflowStep = 'brief' | 'matches' | 'conversations';

const VALID_STEPS = new Set<string>(['brief', 'matches', 'conversations']);

/** Old ?tab= values still in bookmarks and shared links. */
const LEGACY_TABS: Record<string, WorkflowStep> = {
  source:   'matches',
  outreach: 'conversations',
  screen:   'conversations',
  deliver:  'conversations',
};

const STEPS: Array<{ id: WorkflowStep; label: string }> = [
  { id: 'brief',         label: 'Brief'         },
  { id: 'matches',       label: 'Matches'       },
  { id: 'conversations', label: 'Conversations' },
];

// ─── Step summary & next action ───────────────────────────────────────────────

interface StepSummary { text: string; done: boolean }

function stepSummary(project: Project, step: WorkflowStep): StepSummary {
  const experts = project.experts;
  switch (step) {
    case 'brief':
      return { text: 'Research question defined', done: true };
    case 'matches': {
      const n = experts.filter(e => e.status !== 'rejected').length;
      return { text: `${n} candidate${n !== 1 ? 's' : ''}`, done: n > 0 };
    }
    case 'conversations': {
      const n = experts.filter(e => hasConversation(e.status)).length;
      return { text: `${n} conversation${n !== 1 ? 's' : ''}`, done: n > 0 };
    }
  }
}

type NextActionId = 'complete_brief' | 'bookmark_experts';
interface NextAction { id: NextActionId; step: WorkflowStep; message: string; cta: string }

/**
 * The one thing worth doing next — navigation only.
 *
 * Nothing here starts sourcing: the two sourcing entry points are "Find
 * experts →" on Brief and the SourcePanel button on Matches. The banner that
 * used to duplicate them ("No candidates yet. Run sourcing…") is gone, so a
 * client cannot fire the same run from three places.
 */
function getNextAction(project: Project): NextAction | null {
  const { researchQuestion, experts } = project;
  const briefComplete = !!researchQuestion || experts.length > 0;
  if (!briefComplete) {
    return { id: 'complete_brief', step: 'brief', message: 'Describe the business problem and the type of expert you need.', cta: 'Complete brief' };
  }
  const active = experts.filter(e => e.status !== 'rejected');
  if (active.length === 0) return null;
  const engaged = active.filter(e => hasConversation(e.status));
  if (engaged.length === 0) {
    return {
      id: 'bookmark_experts', step: 'matches',
      message: "Bookmark the candidates worth talking to — we'll reach out for you.",
      cta: 'Go to Matches',
    };
  }
  return null;
}

/**
 * The seniority tier for an expert, preferring the value persisted at sourcing
 * time. lib/redactExpert.ts blanks `title` for anonymized experts, so deriving
 * the tier from the title alone would read every one of them as "Mid-Level".
 */
function tierOf(expert: Expert): SeniorityTier {
  return expert.seniorityTier ?? classifySeniority(expert.title ?? '');
}

// ─── Interview Guide Modal ────────────────────────────────────────────────────

interface GuideData {
  opening_script: string;
  must_ask: string[];
  questions: string[];
  diligence_risks: string[];
}

function InterviewGuideModal({ projectId, expertId, expertName, onClose }: {
  projectId: string;
  expertId: string;
  expertName: string;
  onClose: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  const [guide,   setGuide]   = useState<GuideData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useFocusTrap(modalRef, onClose);

  useEffect(() => {
    fetch(`/api/projects/${projectId}/interview-guide`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ expertId }),
    })
      .then(r => r.json())
      .then((d: { guide?: GuideData; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setGuide(d.guide ?? null);
      })
      .catch(() => setError('Failed to generate guide.'))
      .finally(() => setLoading(false));
  }, [projectId, expertId]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(11,31,59,0.55)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={modalRef}
        className="bg-cream border border-frame w-full max-w-2xl max-h-[85vh] flex flex-col shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={`Interview Guide — ${expertName}`}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-frame shrink-0">
          <div>
            <p className="text-[11px] uppercase tracking-widest text-navy font-medium" style={{ letterSpacing: '0.18em' }}>Interview Guide</p>
            <p className="text-xs text-muted mt-0.5">{expertName}</p>
          </div>
          <button onClick={onClose} className="text-muted hover:text-navy transition-colors p-1" aria-label="Close">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto px-6 py-5 space-y-6">
          {loading && (
            <div className="flex items-center gap-2 text-sm text-muted py-6">
              <span className="inline-block w-3.5 h-3.5 border border-navy border-t-transparent rounded-full animate-spin" />
              Generating interview guide…
            </div>
          )}
          {error && <p className="text-sm text-red-600">{error}</p>}
          {guide && (
            <>
              <section>
                <h3 className="text-[10px] uppercase tracking-widest text-muted font-medium mb-2" style={{ letterSpacing: '0.18em' }}>Opening Script</h3>
                <p className="text-sm text-ink leading-relaxed italic">{guide.opening_script}</p>
              </section>
              <section>
                <h3 className="text-[10px] uppercase tracking-widest text-muted font-medium mb-2" style={{ letterSpacing: '0.18em' }}>Must-Ask Questions</h3>
                <ol className="space-y-2">
                  {guide.must_ask.map((q, i) => (
                    <li key={i} className="flex gap-3 text-sm text-ink leading-relaxed">
                      <span className="shrink-0 font-display text-navy font-semibold">{i + 1}.</span>{q}
                    </li>
                  ))}
                </ol>
              </section>
              <section>
                <h3 className="text-[10px] uppercase tracking-widest text-muted font-medium mb-2" style={{ letterSpacing: '0.18em' }}>Tailored Questions</h3>
                <ol className="space-y-2">
                  {guide.questions.map((q, i) => (
                    <li key={i} className="flex gap-3 text-sm text-ink leading-relaxed">
                      <span className="shrink-0 text-muted text-xs">{i + 1}.</span>{q}
                    </li>
                  ))}
                </ol>
              </section>
              <section>
                <h3 className="text-[10px] uppercase tracking-widest text-muted font-medium mb-2" style={{ letterSpacing: '0.18em' }}>Diligence Risks</h3>
                <ul className="space-y-2">
                  {guide.diligence_risks.map((r, i) => (
                    <li key={i} className="flex gap-3 text-sm text-ink leading-relaxed">
                      <span className="shrink-0 text-amber-600">◆</span>{r}
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Perspective options ──────────────────────────────────────────────────────

// ─── Brief section ────────────────────────────────────────────────────────────

/** The two brief fields as typed, held by the PAGE so a tab switch keeps them. */
interface BriefDraft {
  businessProblem: string;
  expertType:      string;
}

function draftFromProject(project: Project): BriefDraft {
  return { businessProblem: project.researchQuestion ?? '', expertType: project.expertType ?? '' };
}

function BriefSection({
  project,
  draft,
  onDraftChange,
  readOnly,
  onSave,
  onStepChange,
  onDeleteStart,
  onStartSourcing,
  sourcingActive,
  sourcingError,
}: {
  project: Project;
  /** Lifted to the page: BriefSection unmounts on every tab switch. */
  draft: BriefDraft;
  onDraftChange: (draft: BriefDraft) => void;
  /** Collaborators read the brief; only the owner (or staff) edits it. */
  readOnly: boolean;
  onSave: (updates: Partial<Project>) => void;
  onStepChange: (step: WorkflowStep) => void;
  onDeleteStart: () => void;
  /** Starts the server-side run. Resolves to an error message, or null on success. */
  onStartSourcing: (overrides: { businessProblem?: string; expertType?: string }) => Promise<string | null>;
  sourcingActive: boolean;
  sourcingError:  string | null;
}) {
  const businessProblem = draft.businessProblem;
  const expertType      = draft.expertType;
  const setBusinessProblem = (v: string) => onDraftChange({ ...draft, businessProblem: v });
  const setExpertType      = (v: string) => onDraftChange({ ...draft, expertType: v });
  const dirty =
    businessProblem !== (project.researchQuestion ?? '') || expertType !== (project.expertType ?? '');
  // The other person's version, when a save was refused as stale (409 brief_conflict).
  const [conflict,        setConflict]        = useState<Project | null>(null);
  const [saving,          setSaving]          = useState(false);
  const [saveError,       setSaveError]       = useState('');

  // Typed text must not vanish with the tab. Same guard a document editor uses.
  useEffect(() => {
    if (!dirty || readOnly) return;
    const warn = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, readOnly]);

  /**
   * One PUT for the two fields: only the ones that CHANGED, plus the version
   * of the brief this screen loaded, so two people cannot overwrite each other
   * unknowingly. An empty string clears a field on the server.
   */
  async function putBrief(): Promise<{ ok: true; project: Project } | { ok: false; message: string; conflict?: Project }> {
    const changes: Record<string, unknown> = { briefVersion: project.briefUpdatedAt ?? 0 };
    if (businessProblem !== (project.researchQuestion ?? '')) changes.researchQuestion = businessProblem;
    if (expertType      !== (project.expertType ?? ''))      changes.expertType       = expertType;
    if (Object.keys(changes).length === 1) return { ok: true, project };

    const res = await fetch(`/api/projects/${project.id}`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(changes),
    });
    const d = await res.json().catch(() => null) as { project?: Project; message?: string; error?: string } | null;
    if (res.status === 409 && d?.error === 'brief_conflict' && d.project) {
      return { ok: false, message: d.message ?? 'This brief changed since you opened it.', conflict: d.project };
    }
    if (!res.ok || !d?.project) {
      return { ok: false, message: d?.message ?? (res.status === 403 ? 'Only the project owner can edit the brief.' : "Couldn't save the brief. Try again.") };
    }
    return { ok: true, project: d.project };
  }
  const [starting,        setStarting]        = useState(false);
  const [sourceError,     setSourceError]     = useState('');
  const [parsing,         setParsing]         = useState(false);
  const [parseError,      setParseError]      = useState('');
  const [parseSuccess,    setParseSuccess]    = useState('');

  async function handleBriefUpload(file: File) {
    setParsing(true);
    setParseError('');
    setParseSuccess('');
    try {
      if (file.size > 5 * 1024 * 1024) {
        throw new Error('Document is too large — 5 MB max.');
      }
      const mediaType = file.type === 'application/pdf' ? 'application/pdf'
        : file.name.toLowerCase().endsWith('.md') ? 'text/markdown'
        : file.type.startsWith('text/') || file.name.toLowerCase().endsWith('.txt') ? 'text/plain'
        : file.type;

      const buf  = await file.arrayBuffer();
      const data = btoa(Array.from(new Uint8Array(buf), b => String.fromCharCode(b)).join(''));

      const res  = await fetch('/api/parse-brief', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ filename: file.name, mediaType, data }),
      });
      const d = await res.json() as { brief?: Record<string, string>; error?: string; message?: string };
      if (!res.ok || !d.brief) throw new Error(d.message ?? 'Could not read the document.');

      const brief = d.brief;
      // Fill the two on-screen fields immediately.
      onDraftChange({
        businessProblem: brief.researchQuestion ?? businessProblem,
        expertType:      brief.expertType       ?? expertType,
      });

      // Persist everything (including the extended brief fields) in one PUT.
      const putRes = await fetch(`/api/projects/${project.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ ...brief, briefVersion: project.briefUpdatedAt ?? 0 }),
      });
      const saved = await putRes.json().catch(() => null) as { project?: Project; message?: string } | null;
      if (!putRes.ok || !saved?.project) {
        // The fields above are filled in; nothing is saved yet. Say so.
        throw new Error(saved?.message ?? 'The document was read, but the brief could not be saved. Click Save brief to try again.');
      }
      onSave(saved.project);
      onDraftChange(draftFromProject(saved.project));

      const extraCount = Object.keys(brief).filter(k => !['researchQuestion', 'expertType'].includes(k)).length;
      setParseSuccess(
        `Brief imported${extraCount > 0 ? ` — ${extraCount} additional field${extraCount === 1 ? '' : 's'} saved to the full brief` : ''}. Review and edit before sourcing.`,
      );
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Could not read the document.');
    } finally {
      setParsing(false);
    }
  }

  // Moving to Matches is the reward for a saved brief — a failed PUT must not
  // look like a success, so the step only changes when the server took it.
  async function handleCompleteBrief() {
    setSaving(true);
    setSaveError('');
    setConflict(null);
    try {
      const result = await putBrief();
      if (!result.ok) {
        setSaveError(result.message);
        if (result.conflict) setConflict(result.conflict);
        return;
      }
      onSave(result.project);
      onDraftChange(draftFromProject(result.project));
      onStepChange('matches');
    } catch {
      setSaveError("Couldn't save the brief. Try again.");
    } finally {
      setSaving(false);
    }
  }

  /** Takes the other person's version: replaces the draft and clears the conflict. */
  function acceptConflict() {
    if (!conflict) return;
    onSave(conflict);
    onDraftChange(draftFromProject(conflict));
    setConflict(null);
    setSaveError('');
  }

  // Kicks off the server-side sourcing run. The run itself survives navigation
  // and refresh — progress is reflected by project.sourcingStatus, polled by the
  // page, so this only has to save the brief and hand the job over.
  async function handleSourceExperts() {
    if (starting || sourcingActive) return;
    setStarting(true);
    setSourceError('');
    setConflict(null);
    try {
      // Save first — sourcing reads the stored brief. A refused save stops here
      // so the run never starts on text the server does not have.
      const saved = await putBrief();
      if (!saved.ok) {
        setSourceError(saved.message);
        if (saved.conflict) setConflict(saved.conflict);
        return;
      }
      onSave(saved.project);
      onDraftChange(draftFromProject(saved.project));

      const startErr = await onStartSourcing({
        businessProblem: businessProblem || project.researchQuestion || undefined,
        expertType:      expertType      || project.expertType      || undefined,
      });
      if (startErr) {
        setSourceError(startErr);
        return;
      }

      // Switch to Source tab — the run continues in the background either way.
      onStepChange('matches');
    } catch (err) {
      setSourceError(err instanceof Error ? err.message : 'Sourcing failed. Please try again.');
    } finally {
      setStarting(false);
    }
  }

  const fieldClass = 'w-full px-3 py-2.5 text-sm border border-frame bg-cream focus:outline-none focus:border-navy text-ink resize-y';
  const labelClass = 'block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5';

  return (
    <div className="space-y-8 max-w-3xl">

      {/* ── Upload a brief document ── */}
      <div className="border border-dashed border-frame bg-cream/50 px-4 py-3 flex items-center justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-0.5">Have a brief document?</p>
          <p className="text-xs text-muted">
            Upload a PDF or text file and we&apos;ll fill in the fields below. Word docs: export to PDF first.
          </p>
          {parseError   && <p className="text-xs text-red-700 mt-1">{parseError}</p>}
          {parseSuccess && <p className="text-xs text-navy mt-1 font-medium">{parseSuccess}</p>}
        </div>
        <label
          className={`shrink-0 flex items-center gap-2 text-[10px] uppercase tracking-widest px-4 py-2.5 border border-navy transition-colors ${parsing ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer hover:bg-navy hover:text-cream'}`}
          style={{ letterSpacing: '0.14em', color: '#0B1F3B' }}
        >
          {parsing && <span className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin shrink-0" />}
          {parsing ? 'Reading document…' : 'Upload Brief'}
          <input
            type="file"
            accept=".pdf,.txt,.md,application/pdf,text/plain,text/markdown"
            className="hidden"
            disabled={parsing}
            onChange={e => {
              const f = e.target.files?.[0];
              if (f) void handleBriefUpload(f);
              e.target.value = '';
            }}
          />
        </label>
      </div>

      {/* ── Brief fields ── */}
      <div className="space-y-6">
        <div>
          <label className={labelClass}>What&apos;s the business problem?</label>
          <textarea
            value={businessProblem}
            onChange={e => setBusinessProblem(e.target.value)}
            rows={5}
            readOnly={readOnly}
            placeholder="e.g. We're evaluating entry into cold chain logistics in the Southeast"
            className={fieldClass}
          />
        </div>

        <div>
          <label className={labelClass}>What type of person do you want to talk to?</label>
          <textarea
            value={expertType}
            onChange={e => setExpertType(e.target.value)}
            rows={5}
            readOnly={readOnly}
            placeholder="e.g. Someone with 20+ years in the poultry industry, former VP or Director level at a major integrator like Tyson, Pilgrim's, or Koch Foods"
            className={fieldClass}
          />
        </div>

      </div>

      {/* ── Complete Brief / Source Experts ── */}
      {readOnly ? (
        <p className="border-t border-frame pt-6 text-xs text-muted">
          Shared with you — read-only. Only the project owner can edit the brief or source experts.
        </p>
      ) : (
      <div className="border-t border-frame pt-6 space-y-3">
        {dirty && !saving && (
          <p className="text-[10px] uppercase tracking-widest text-amber-700" style={{ letterSpacing: '0.12em' }}>
            Unsaved changes
          </p>
        )}
        <div className="flex items-center gap-4 flex-wrap">
          <button
            onClick={handleCompleteBrief}
            disabled={saving}
            className="text-[10px] uppercase tracking-widest px-5 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.14em', minHeight: '40px' }}
          >
            {saving ? 'Saving…' : 'Save brief'}
          </button>
          <button
            onClick={handleSourceExperts}
            disabled={starting || sourcingActive}
            className="flex items-center gap-2.5 text-[10px] uppercase tracking-widest px-5 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: '#C6A75E', color: '#0B1F3B', letterSpacing: '0.14em', minHeight: '40px' }}
          >
            {starting || sourcingActive ? (
              <>
                <span className="inline-block w-3 h-3 border border-[#0B1F3B] border-t-transparent rounded-full animate-spin shrink-0" />
                Sourcing experts…
              </>
            ) : (
              <>Find experts →</>
            )}
          </button>
        </div>
        <p className="text-[10px] text-muted" style={{ fontWeight: 300 }}>
          We&apos;ll keep looking in the background — close the tab and come back whenever.
        </p>
        {(saveError || sourceError || sourcingError) && (
          <div className="text-xs text-red-600 border border-red-200 bg-red-50 px-3 py-2 space-y-2">
            <p>{saveError || sourceError || sourcingError}</p>
            {conflict && (
              <button
                type="button"
                onClick={acceptConflict}
                className="text-[10px] uppercase tracking-widest border border-red-300 hover:border-red-500 px-3 py-1 transition-colors"
                style={{ letterSpacing: '0.12em' }}
              >
                Load the latest version
              </button>
            )}
          </div>
        )}
      </div>
      )}

      {/* ── Danger zone (owner only) ── */}
      {!readOnly && (
        <div className="pt-6 border-t border-frame">
          <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-3" style={{ letterSpacing: '0.14em' }}>
            Delete this project
          </p>
          <button
            onClick={onDeleteStart}
            className="text-[10px] uppercase tracking-widest text-red-600 border border-red-200 hover:bg-red-50 px-4 py-2 transition-colors"
            style={{ letterSpacing: '0.1em' }}
          >
            Delete Project
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Source panel ─────────────────────────────────────────────────────────────

// Brief context and rejection feedback are now assembled server-side by
// lib/sourcingJob.ts, so the browser no longer builds a generation payload.

// Count how many brief context fields have content
function briefContextDepth(project: Project): number {
  return [project.researchQuestion, project.expertType].filter(v => v?.trim()).length;
}

// A server-side sourcing run still marked 'running' after this long is treated
// as dead (worker crash, deploy mid-run). Mirrors SOURCING_STALE_MS in
// lib/sourcingJob.ts, which is what the API enforces.
const SOURCING_STALE_MS = 15 * 60 * 1000;

type SourcingView = 'idle' | 'running' | 'stale' | 'failed';

function sourcingView(project: Project | null): SourcingView {
  if (!project) return 'idle';
  if (project.sourcingStatus === 'running') {
    return Date.now() - (project.sourcingStartedAt ?? 0) >= SOURCING_STALE_MS ? 'stale' : 'running';
  }
  return project.sourcingStatus === 'failed' ? 'failed' : 'idle';
}

// The first line is the honest one and always shows first. The rest are
// Matchy-as-mascot — a little fun, but none of them claim a capability we
// don't have or narrate the machinery. Order after the first is shuffled per
// visit so a long wait doesn't read as a loop.
const SOURCING_MESSAGES = [
  "Finding people who've actually done this — usually a few minutes.",
  'Matchy is out asking around. The digital version, anyway.',
  'Matchy is reading the résumés so you don’t have to.',
  'Still looking. Matchy doesn’t do “close enough”.',
  'Matchy is checking who has actually done this, not who says they have.',
  'Skipping the people who only read about it. Matchy is picky on purpose.',
  'Matchy is ranking by who has been in the room, not who has the best title.',
  'Still working — we only surface people with direct, verifiable experience.',
  'Almost there. Matchy is putting the strongest matches up top.',
];

/** The honest line first, then the rest in a fresh order for this visit. */
function shuffledSourcingMessages(): string[] {
  const [first, ...rest] = SOURCING_MESSAGES;
  for (let i = rest.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [rest[i], rest[j]] = [rest[j], rest[i]];
  }
  return [first, ...rest];
}

function RotatingLoadingMessage() {
  const [messages]            = useState(shuffledSourcingMessages);
  const [index,   setIndex]   = useState(0);
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    const interval = setInterval(() => {
      setVisible(false);
      const timer = setTimeout(() => {
        setIndex(i => (i + 1) % messages.length);
        setVisible(true);
      }, 400);
      return () => clearTimeout(timer);
    }, 5000);
    return () => clearInterval(interval);
  }, [messages.length]);

  return (
    <span style={{ transition: 'opacity 0.4s ease', opacity: visible ? 1 : 0 }}>
      {messages[index]}
    </span>
  );
}

function SourcePanel({
  project,
  onStartSourcing,
  sourcingActive,
  sourcingStale,
  sourcingError,
}: {
  project: Project;
  /** Starts the server-side run. Resolves to an error message, or null on success. */
  onStartSourcing: (overrides: { businessProblem?: string; expertType?: string }) => Promise<string | null>;
  sourcingActive: boolean;
  sourcingStale:  boolean;
  sourcingError:  string | null;
}) {
  const [starting,    setStarting]    = useState(false);
  const [startError,  setStartError]  = useState('');
  const depth = briefContextDepth(project);

  // Core experts are persisted by the worker straight into the discovery pool below.
  const limitedPool = project.sourcingLimitedPool === true;

  const srcError = startError || (sourcingStale ? 'Sourcing timed out — try again.' : sourcingError) || '';

  const stage: 'idle' | 'loading' | 'results' | 'error' =
    starting || sourcingActive ? 'loading'
    : srcError                 ? 'error'
    : project.sourcingStatus === 'completed' ? 'results'
    : 'idle';

  // Hands the run to the server. It keeps going across tab flips and refreshes;
  // the page polls project.sourcingStatus until it lands.
  async function runSourcing() {
    if (starting || sourcingActive) return;
    setStarting(true);
    setStartError('');
    try {
      const err = await onStartSourcing({});
      if (err) setStartError(err);
    } finally {
      setStarting(false);
    }
  }

  // Core experts sourced by the last completed run, already in the pool below.
  const sourcedCoreCount = project.experts.filter(pe => pe.status === 'discovered').length;

  return (
    <div className="border border-frame bg-cream">
      {/* Header */}
      <div className="px-5 py-4 border-b border-frame flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-navy font-semibold" style={{ letterSpacing: '0.16em' }}>
            Find experts
          </p>
          <p className="text-[11px] text-muted mt-1 leading-relaxed">
            We work from your brief — the business problem and the kind of person you want to talk to.
          </p>
        </div>
        {stage === 'idle' || stage === 'error' ? (
          <button
            onClick={runSourcing}
            className="shrink-0 bg-navy text-cream text-[10px] uppercase tracking-widest px-4 py-2 hover:bg-navy/90 transition-colors flex items-center gap-2 whitespace-nowrap"
            style={{ letterSpacing: '0.12em' }}
          >
            <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            {stage === 'error' ? 'Retry' : 'Find experts'}
          </button>
        ) : stage === 'results' ? (
          <button
            onClick={runSourcing}
            className="shrink-0 text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-4 py-2 transition-colors whitespace-nowrap"
            style={{ letterSpacing: '0.12em' }}
          >
            Look again
          </button>
        ) : null}
      </div>

      {/* Brief context chips (idle only, shows what will be used) */}
      {stage === 'idle' && depth > 0 && (
        <div className="px-5 py-3 flex flex-wrap gap-1.5 border-b border-frame/60 bg-navy/2">
          {project.researchQuestion?.trim() && (
            <span className="text-[10px] border border-navy/15 bg-navy/5 text-navy/70 px-2 py-0.5">Business problem</span>
          )}
          {project.expertType?.trim() && (
            <span className="text-[10px] border border-gold/30 bg-gold/5 text-amber-700 px-2 py-0.5">Expert type</span>
          )}
        </div>
      )}

      {/* Loading — the run is server-side, so leaving this tab is safe */}
      {stage === 'loading' && (
        <div className="px-5 py-10 flex flex-col items-center gap-4 text-sm text-muted">
          <span className="inline-block w-4 h-4 border border-navy border-t-transparent rounded-full animate-spin shrink-0" />
          <RotatingLoadingMessage />
          <p className="text-[10px] text-muted/70 text-center max-w-xs leading-relaxed">
            This takes a few minutes. Close the tab if you like — we&apos;ll keep going.
          </p>
        </div>
      )}

      {/* Error */}
      {stage === 'error' && srcError && (
        <div className="px-5 py-4 text-sm text-red-600">{srcError}</div>
      )}

      {/* Results */}
      {stage === 'results' && (
        <div>
          {/* Limited pool notice */}
          {limitedPool && (
            <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-100 flex items-start gap-2">
              <svg className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <p className="text-[11px] text-amber-700 leading-relaxed">
                Few exact matches for this one. The closest fits are listed first.
              </p>
            </div>
          )}
          {/* Core experts — persisted straight into the discovery pool below */}
          <div className="px-5 py-3 border-b border-frame/60">
            <p className="text-[10px] text-muted">
              {sourcedCoreCount > 0
                ? `${sourcedCoreCount} direct match${sourcedCoreCount !== 1 ? 'es' : ''} below.`
                : 'No direct matches this time.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function EmptyStep({ message, action }: { message: string; action?: React.ReactNode }) {
  return (
    <div className="py-16 text-center max-w-md mx-auto">
      <p className="text-sm text-muted">{message}</p>
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

// ─── Source list controls (sort + filters) ────────────────────────────────────

type ExpertCategory     = Expert['category'];
/**
 * 'new' is anything not yet bookmarked; 'bookmarked' is anything engaged.
 * 'passed' is the one chip that steps outside the default pool — passed experts
 * are hidden everywhere else, and without it they are unreachable.
 */
type SourceStatusFilter = 'all' | 'new' | 'bookmarked' | 'passed';

/** Per-browser memory of the discovery-pool sort choice. */
const SOURCE_SORT_KEY = 'expertmatch.source.sort';

const CATEGORY_OPTIONS: readonly ExpertCategory[]     = ['Operator', 'Advisor', 'Outsider'];
const STATUS_OPTIONS:   readonly SourceStatusFilter[] = ['all', 'new', 'bookmarked', 'passed'];
const STATUS_LABELS: Record<SourceStatusFilter, string> = {
  all:        'All',
  new:        'New',
  bookmarked: 'Bookmarked',
  passed:     'Passed',
};

/** Whether an expert belongs in the chosen chip. */
function matchesStatusFilter(status: ExpertStatus, filter: SourceStatusFilter): boolean {
  if (filter === 'all')        return true;
  if (filter === 'passed')     return status === 'rejected';
  if (filter === 'bookmarked') return hasConversation(status);
  return status === 'discovered' || status === 'shortlisted';
}

const SOURCE_SELECT_CLASS =
  'border border-frame bg-cream px-2.5 py-1.5 pr-7 text-xs text-ink appearance-none cursor-pointer focus:outline-none focus:border-navy hover:border-navy/40 transition-colors';

/** Micro-label + native dropdown. One per control so the strip reads as a row of four. */
function FilterSelect<T extends string>({
  id,
  label,
  value,
  options,
  onChange,
}: {
  id:       string;
  label:    string;
  value:    T;
  options:  readonly { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex items-center gap-2 min-w-0">
      <label
        htmlFor={id}
        className="text-[10px] uppercase tracking-widest text-muted font-medium shrink-0"
        style={{ letterSpacing: '0.12em' }}
      >
        {label}
      </label>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={e => onChange(e.target.value as T)}
          className={SOURCE_SELECT_CLASS}
        >
          {options.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
        <span
          aria-hidden
          className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[9px] text-muted"
        >
          ▼
        </span>
      </div>
    </div>
  );
}

/**
 * Sort + filter strip above the Source discovery pool.
 *
 * Purely presentational: every count is passed in, already derived from the
 * live project on each render, so a card's status change moves the numbers
 * without any local copy of state here.
 */
function SourceListControls({
  tierCounts,
  total,
  visibleCount,
  tierFilter,
  categoryFilter,
  statusFilter,
  sortKey,
  onTierChange,
  onCategoryChange,
  onStatusChange,
  onSortChange,
  onClearFilters,
}: {
  tierCounts:       Record<SeniorityTier | 'all', number>;
  total:            number;
  visibleCount:     number;
  tierFilter:       SeniorityTier | 'all';
  categoryFilter:   ExpertCategory | 'all';
  statusFilter:     SourceStatusFilter;
  sortKey:          ExpertSortKey;
  onTierChange:     (t: SeniorityTier | 'all') => void;
  onCategoryChange: (c: ExpertCategory | 'all') => void;
  onStatusChange:   (s: SourceStatusFilter) => void;
  onSortChange:     (k: ExpertSortKey) => void;
  onClearFilters:   () => void;
}) {
  const filtersActive = tierFilter !== 'all' || categoryFilter !== 'all' || statusFilter !== 'all';

  const tierOptions = (['all', ...TIER_ORDER] as const).map(t => ({
    value: t,
    label: `${t === 'all' ? 'All' : TIER_PRICING[t].label} (${tierCounts[t]})`,
  }));
  const categoryOptions = [
    { value: 'all' as const, label: 'All' },
    ...CATEGORY_OPTIONS.map(c => ({ value: c, label: c })),
  ];
  const statusOptions = STATUS_OPTIONS.map(s => ({ value: s, label: STATUS_LABELS[s] }));
  const sortOptions = (Object.keys(SORT_LABELS) as ExpertSortKey[]).map(k => ({
    value: k,
    label: SORT_LABELS[k],
  }));

  return (
    <div className="space-y-2">
      <div className="border border-frame bg-surface px-3 py-2.5 flex flex-wrap items-center gap-x-6 gap-y-3">
        <FilterSelect
          id="source-tier"
          label="Tier"
          value={tierFilter}
          options={tierOptions}
          onChange={onTierChange}
        />
        <FilterSelect
          id="source-category"
          label="Category"
          value={categoryFilter}
          options={categoryOptions}
          onChange={onCategoryChange}
        />
        <FilterSelect
          id="source-status"
          label="Status"
          value={statusFilter}
          options={statusOptions}
          onChange={onStatusChange}
        />
        <div className="lg:ml-auto">
          <FilterSelect
            id="source-sort"
            label="Sort"
            value={sortKey}
            options={sortOptions}
            onChange={onSortChange}
          />
        </div>
      </div>

      {/* Result count + clear affordance */}
      <div className="flex items-center gap-x-3 gap-y-1 flex-wrap">
        <p
          className="text-[10px] uppercase tracking-widest text-muted font-medium"
          style={{ letterSpacing: '0.12em' }}
        >
          {visibleCount} of {total} expert{total !== 1 ? 's' : ''}
        </p>
        {filtersActive && (
          <button
            type="button"
            onClick={onClearFilters}
            className="text-[10px] uppercase tracking-widest text-muted border border-frame hover:border-navy hover:text-navy px-2 py-0.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-gold"
            style={{ letterSpacing: '0.12em' }}
          >
            Clear filters ✕
          </button>
        )}
      </div>

      {/* Rates are an opening position, not a price list */}
      <p className="text-[11px] text-muted/80" style={{ fontWeight: 300 }}>
        {RATE_DISCLAIMER}
      </p>
    </div>
  );
}

// ─── Delete confirmation overlay ─────────────────────────────────────────────

function DeleteConfirmOverlay({
  projectId,
  onCancel,
  onDeleted,
}: {
  projectId: string;
  onCancel: () => void;
  onDeleted: () => void;
}) {
  const [deleting, setDeleting] = useState(false);
  const [error,    setError]    = useState('');

  async function handleConfirm() {
    setDeleting(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}`, { method: 'DELETE' });
      if (res.ok) {
        onDeleted();
      } else {
        setError('Failed to delete project. Please try again.');
        setDeleting(false);
      }
    } catch {
      setError('Network error. Please try again.');
      setDeleting(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(11,31,59,0.6)', backdropFilter: 'blur(2px)' }}
    >
      <div className="bg-cream border border-frame w-full max-w-sm p-8 space-y-5 shadow-2xl">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-red-600 font-medium mb-2" style={{ letterSpacing: '0.16em' }}>
            Delete Project
          </p>
          <p className="text-sm text-ink leading-relaxed">
            Delete this project? All experts, notes, and screening data will be permanently removed. This cannot be undone.
          </p>
        </div>
        {error && <p className="text-xs text-red-600">{error}</p>}
        <div className="flex gap-3">
          <button
            onClick={handleConfirm}
            disabled={deleting}
            className="flex-1 bg-red-600 text-white text-[10px] uppercase tracking-widest py-2.5 hover:bg-red-700 disabled:opacity-50 transition-colors"
            style={{ letterSpacing: '0.1em' }}
          >
            {deleting ? 'Deleting…' : 'Delete Project'}
          </button>
          <button
            onClick={onCancel}
            disabled={deleting}
            className="flex-1 border border-frame text-muted text-[10px] uppercase tracking-widest py-2.5 hover:border-navy hover:text-navy disabled:opacity-50 transition-colors"
            style={{ letterSpacing: '0.1em' }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Share modal ─────────────────────────────────────────────────────────────

function ShareModal({
  projectId,
  collaborators,
  onUpdate,
  onClose,
}: {
  projectId:     string;
  collaborators: string[];
  onUpdate:      (updated: Project) => void;
  onClose:       () => void;
}) {
  const [email,   setEmail]   = useState('');
  const [loading, setLoading] = useState(false);
  const [error,   setError]   = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed || loading) return;
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/collaborators`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: trimmed }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? 'Failed to add collaborator');
      onUpdate(data.project);
      setEmail('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  async function remove(collaboratorEmail: string) {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/collaborators`, {
        method:  'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: collaboratorEmail }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.message ?? data.error ?? 'Failed to remove collaborator');
      onUpdate(data.project);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: 'rgba(11,31,59,0.55)' }}>
      <div
        ref={ref}
        className="bg-white border border-frame w-full max-w-md shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-label="Share project"
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-frame">
          <p className="text-[10px] uppercase tracking-widest text-navy font-medium" style={{ letterSpacing: '0.2em' }}>
            Share Project
          </p>
          <button
            onClick={onClose}
            className="text-muted hover:text-navy transition-colors"
            aria-label="Close"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="px-6 py-5 space-y-5">
          <form onSubmit={add} className="flex items-end gap-2">
            <div className="flex-1">
              <label className="block text-[10px] uppercase tracking-widest text-muted mb-1.5" style={{ letterSpacing: '0.14em' }}>
                Add by email
              </label>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="colleague@firm.com"
                disabled={loading}
                className="w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50"
              />
            </div>
            <button
              type="submit"
              disabled={!email.trim() || loading}
              className="text-[10px] uppercase tracking-widest px-4 py-2.5 transition-colors disabled:opacity-40 shrink-0"
              style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.12em' }}
            >
              Add
            </button>
          </form>

          {/* Not an invitation — the route only attaches an existing account. */}
          <p className="text-[11px] text-muted leading-relaxed -mt-3">
            They must already have an ExpertMatch account at your firm.
          </p>

          {error && <p className="text-[11px] text-red-600">{error}</p>}

          {/* What sharing actually grants — a collaborator who does not know
              they are read-only will try to message an expert and fail
              (docs/COPY_AUDIT.md 7.101). */}
          <p className="text-[11px] text-muted leading-relaxed">
            Collaborators can see everything and add notes. Only you can bookmark or pass on experts,
            write to them, run sourcing, or complete a call.
          </p>

          {collaborators.length > 0 ? (
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.14em' }}>
                Collaborators
              </p>
              {collaborators.map(c => (
                <div key={c} className="flex items-center justify-between px-3 py-2 bg-cream border border-frame">
                  <span className="text-xs text-ink">{c}</span>
                  <button
                    onClick={() => remove(c)}
                    disabled={loading}
                    className="text-[10px] text-muted hover:text-red-600 transition-colors disabled:opacity-40"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted">No collaborators yet.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Inner page (uses useSearchParams) ───────────────────────────────────────

function ProjectPageInner() {
  const params    = useParams();
  const router    = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;

  // Derive initial step from ?tab= param, default to 'brief'
  const tabParam     = searchParams.get('tab') ?? '';
  // Staff-only preview: `?view=client` asks the server to redact the project
  // exactly as a client receives it (anonymized experts, no contact paths) and
  // hides the admin-only controls. The server ignores it for non-admins.
  const clientView   = searchParams.get('view') === 'client';
  const projectQuery = clientView ? '?view=client' : '';
  const resolvedTab  = LEGACY_TABS[tabParam] ?? tabParam;
  const initialStep: WorkflowStep = VALID_STEPS.has(resolvedTab) ? (resolvedTab as WorkflowStep) : 'brief';

  const [project,     setProject]     = useState<Project | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [activeStep,  setActiveStep]  = useState<WorkflowStep>(initialStep);
  const [guideExpert, setGuideExpert] = useState<{ id: string; name: string } | null>(null);
  const [showDelete,  setShowDelete]  = useState(false);
  const [showShare,   setShowShare]   = useState(false);
  const [currentUserEmail, setCurrentUserEmail] = useState<string>('');
  const [currentUserRole,  setCurrentUserRole]  = useState<'admin' | 'user'>('user');
  // Source discovery pool — filters are per-visit, the sort choice is remembered.
  const [tierFilter,     setTierFilter]     = useState<SeniorityTier | 'all'>('all');
  const [categoryFilter, setCategoryFilter] = useState<ExpertCategory | 'all'>('all');
  const [statusFilter,   setStatusFilter]   = useState<SourceStatusFilter>('all');
  const [sortKey,        setSortKey]        = useState<ExpertSortKey>('seniority');
  // The thread to open when Conversations mounts — set by "Open" on a card so
  // the client lands on that expert instead of whoever is first in the list.
  const [selectedThread, setSelectedThread] = useState<string | undefined>(undefined);

  // Restore the remembered sort after mount — reading storage during render
  // would desync the server-rendered markup.
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(SOURCE_SORT_KEY);
      if (stored === 'seniority' || stored === 'score') setSortKey(stored);
    } catch {
      // Storage blocked (private mode, disabled cookies) — the default stands.
    }
  }, []);

  const handleSortChange = useCallback((key: ExpertSortKey) => {
    setSortKey(key);
    try {
      window.localStorage.setItem(SOURCE_SORT_KEY, key);
    } catch {
      // Storage blocked — the choice still applies for this visit.
    }
  }, []);

  const clearSourceFilters = useCallback(() => {
    setTierFilter('all');
    setCategoryFilter('all');
    setStatusFilter('all');
  }, []);

  // The brief as typed, kept here so switching tabs never loses it.
  const [briefDraft, setBriefDraft] = useState<BriefDraft | null>(null);

  useEffect(() => {
    // X-Em-Visit marks the page's first load as ONE visit for usage records;
    // the sourcing poll below never sends it.
    fetch(`/api/projects/${projectId}${projectQuery}`, { headers: { 'X-Em-Visit': '1' } })
      .then(r => r.json())
      .then((d: { project?: Project; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setProject(d.project ?? null);
        if (d.project) setBriefDraft(draftFromProject(d.project));
      })
      .catch(() => setError('Failed to load project.'))
      .finally(() => setLoading(false));

    fetch('/api/auth/me')
      .then(r => r.json())
      .then((d: { email?: string; role?: 'admin' | 'user' }) => {
        if (d.email) setCurrentUserEmail(d.email);
        if (d.role)  setCurrentUserRole(d.role);
      })
      .catch(() => {});
  }, [projectId, projectQuery]);

  // Sync active step to URL query param (shallow replace — no scroll)
  function navigateTo(step: WorkflowStep) {
    setActiveStep(step);
    // Leaving Conversations drops the requested thread, so opening the same
    // expert again from Matches is honoured rather than swallowed as "no change".
    if (step !== 'conversations') setSelectedThread(undefined);
    const url = new URL(window.location.href);
    url.searchParams.set('tab', step);
    router.replace(url.pathname + url.search, { scroll: false });
  }

  const handleExpertUpdate = useCallback((updated: ProjectExpert) => {
    setProject(prev => {
      if (!prev) return prev;
      return { ...prev, experts: prev.experts.map(pe => pe.expert.id === updated.expert.id ? updated : pe), updatedAt: Date.now() };
    });
  }, []);

  const handleBriefSave = useCallback((updated: Partial<Project>) => {
    setProject(prev => prev ? { ...prev, ...updated } : prev);
  }, []);

  // ── Server-side sourcing: start + poll ────────────────────────────────────
  // The run lives on the server, so the only client state is "what does the
  // project say right now". Re-fetching the whole project keeps experts,
  // status, and error in sync in one shot.
  const refreshProject = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectId}${projectQuery}`);
      const d   = await res.json() as { project?: Project };
      if (d.project) setProject(d.project);
    } catch {
      // Transient — the next poll retries.
    }
  }, [projectId, projectQuery]);

  // Mutation responses come back shaped for the REAL viewer (an admin sees
  // everything), so in client view they are replaced by a redacted re-read
  // rather than shown as-is.
  const applyProjectUpdate = useCallback((updated: Project) => {
    setProject(updated);
    if (clientView) void refreshProject();
  }, [clientView, refreshProject]);

  function toggleClientView() {
    const url = new URL(window.location.href);
    if (clientView) url.searchParams.delete('view');
    else url.searchParams.set('view', 'client');
    setLoading(true);
    router.replace(url.pathname + url.search, { scroll: false });
  }

  const startSourcing = useCallback(async (
    overrides: { businessProblem?: string; expertType?: string },
  ): Promise<string | null> => {
    try {
      const res = await fetch(`/api/projects/${projectId}/source-experts`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(overrides),
      });
      const d = await res.json() as { ok?: boolean; error?: string; message?: string };

      if (res.status === 409 || d.error === 'sourcing_already_running') {
        // Someone (or another tab) already started it — pick up the live run.
        await refreshProject();
        return null;
      }
      if (!res.ok || !d.ok) {
        return d.message ?? 'Could not start sourcing. Please try again.';
      }

      // Reflect 'running' immediately so the pill and polling start without
      // waiting for a round trip.
      setProject(prev => prev
        ? { ...prev, sourcingStatus: 'running', sourcingStartedAt: Date.now(), sourcingError: null }
        : prev);
      return null;
    } catch {
      return 'Could not start sourcing. Please try again.';
    }
  }, [projectId, refreshProject]);

  const view          = sourcingView(project);
  const isSourcing    = view === 'running';
  const sourcingStale = view === 'stale';

  useEffect(() => {
    if (!isSourcing) return;
    const interval = setInterval(() => { void refreshProject(); }, 5000);
    return () => clearInterval(interval);
  }, [isSourcing, refreshProject]);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F7F9FC' }}>
        <div className="flex items-center gap-2 text-sm text-muted">
          <span className="inline-block w-4 h-4 border border-navy border-t-transparent rounded-full animate-spin" />
          Loading project…
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4" style={{ background: '#F7F9FC' }}>
        <p className="text-sm text-red-600">{error || 'Project not found.'}</p>
        <Link href="/app" className="text-xs text-muted hover:text-navy underline">Back to Projects</Link>
      </div>
    );
  }

  const isStaff           = currentUserRole === 'admin';
  const isAdmin           = isStaff && !clientView;
  const isOwner           = project.ownerEmail === currentUserEmail;
  // Only the owner (or staff) may start outreach or write to an expert
  // (docs/MATCHY_SPEC.md, founder answer 5). Collaborators read.
  const canSend           = isAdmin || isOwner;
  const nextAction        = getNextAction(project);
  const viewStep: WorkflowStep = STEPS.some(x => x.id === activeStep) ? activeStep : 'brief';
  // Walkthrough is a property of the project, so the pill rides in the header
  // and is visible on every step — not just the one that owns the settings.
  const walkthrough       = isWalkthrough(project);
  const sourceExperts     = project.experts.filter(e => e.status !== 'rejected');
  // Passed experts live outside the default pool — the "Passed" chip is the one
  // way back to them, so it swaps the pool rather than filtering inside it.
  const sourcePool = statusFilter === 'passed'
    ? project.experts.filter(e => e.status === 'rejected')
    : sourceExperts;
  // Category + status narrow the pool first; tier counts are then computed over
  // what's left, so a chip's count always equals what clicking it would show.
  const sourceCohort = sourcePool.filter(pe =>
    (categoryFilter === 'all' || pe.expert.category === categoryFilter) &&
    matchesStatusFilter(pe.status, statusFilter)
  );
  const sourceTierCounts: Record<SeniorityTier | 'all', number> = {
    all: sourceCohort.length, executive: 0, senior: 0, mid: 0,
  };
  // Prefer the tier persisted at sourcing time — `title` is blanked for
  // anonymized experts, so classifying from it would bucket them all as Mid.
  for (const pe of sourceCohort) sourceTierCounts[tierOf(pe.expert)] += 1;
  const sourceComparator = expertComparator(sortKey);
  const visibleSourceExperts = sourceCohort
    .filter(pe => tierFilter === 'all' || tierOf(pe.expert) === tierFilter)
    .sort((a, b) => sourceComparator(a.expert, b.expert));
  const hasExpertsSourced = sourceExperts.length > 0;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      {/* ── Header ── */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        {/* flex-wrap: the walkthrough pill is a fourth item in this row and a
            375px screen has no room for it beside the rest. */}
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between gap-3 sm:gap-4 flex-wrap">
          <Link
            href="/app"
            className="text-[10px] uppercase tracking-widest text-gold/60 hover:text-gold transition-colors shrink-0"
            style={{ letterSpacing: '0.18em' }}
          >
            ← Projects
          </Link>
          <div className="flex-1 min-w-0">
            <p className="font-display text-cream font-semibold truncate" style={{ fontSize: '13px', letterSpacing: '0.05em' }}>
              {project.name}
            </p>
          </div>
          {/* The one thing a client must never be unsure about: whether this
              project can reach a real person. Clicking it goes to Conversations,
              where MatchySettingsStrip has the switch. */}
          {walkthrough && (
            <button
              type="button"
              onClick={() => navigateTo('conversations')}
              title="Nothing is sent in walkthrough mode"
              className="shrink-0 text-[10px] uppercase tracking-widest text-gold border border-gold px-2.5 py-1.5 hover:bg-gold/10 transition-colors"
              style={{ letterSpacing: '0.14em' }}
            >
              Walkthrough
            </button>
          )}
          {isStaff && (
            <button
              type="button"
              onClick={toggleClientView}
              title={clientView ? 'Showing this project as a client sees it' : 'Preview this project as a client sees it'}
              className={`shrink-0 text-[10px] uppercase tracking-widest border px-2.5 py-1.5 transition-colors ${
                clientView
                  ? 'text-navy bg-gold border-gold hover:bg-gold/90'
                  : 'text-gold/70 hover:text-gold border-gold/30 hover:border-gold'
              }`}
              style={{ letterSpacing: '0.14em' }}
            >
              {clientView ? 'Client view · on' : 'Client view'}
            </button>
          )}
          {(isAdmin || project.ownerEmail === currentUserEmail) && (
            <button
              onClick={() => setShowShare(true)}
              className="shrink-0 text-[10px] uppercase tracking-widest text-gold/70 hover:text-gold border border-gold/30 hover:border-gold px-3 py-1.5 transition-colors"
              style={{ letterSpacing: '0.12em' }}
            >
              Share
            </button>
          )}
          <button
            onClick={() => { downloadProjectBriefPdf(project); }}
            className="shrink-0 text-[10px] uppercase tracking-widest text-gold/70 hover:text-gold border border-gold/30 hover:border-gold px-3 py-1.5 transition-colors"
            style={{ letterSpacing: '0.12em' }}
          >
            Export Brief
          </button>
        </div>
      </header>

      {/* ── Horizontal stepper ── */}
      <div className="bg-surface border-b border-frame">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 flex items-center gap-4">
          {/* Sourcing indicator — sits outside the scrolling step row so it
              stays visible on every step, not just Brief. */}
          {(isSourcing || sourcingStale) && (
            <div className="order-2 shrink-0 ml-auto">
              {isSourcing ? (
                <span
                  className="flex items-center gap-2 border border-frame bg-cream px-3 py-1.5 text-[10px] uppercase tracking-widest text-navy font-medium"
                  style={{ letterSpacing: '0.14em' }}
                  title="Expert sourcing is running on our servers — it continues if you leave this page."
                >
                  <span className="inline-block w-3 h-3 border border-navy border-t-transparent rounded-full animate-spin shrink-0" />
                  Sourcing experts…
                </span>
              ) : (
                // A dead run used to render an inert badge with no way to act on
                // it. It is now the button that restarts the run.
                <button
                  type="button"
                  onClick={() => { void startSourcing({}); }}
                  className="flex items-center gap-2 border border-amber-300 bg-amber-50 px-3 py-1.5 text-[10px] uppercase tracking-widest text-amber-700 font-medium hover:bg-amber-100 hover:border-amber-500 transition-colors"
                  style={{ letterSpacing: '0.14em' }}
                  title="This run has been going for over 15 minutes — start it again."
                >
                  Sourcing timed out — try again
                </button>
              )}
            </div>
          )}
          <div className="order-1 flex overflow-x-auto min-w-0">
            {STEPS.map((step, idx) => {
              const summary  = stepSummary(project, step.id);
              const isActive = viewStep === step.id;
              return (
                <button
                  key={step.id}
                  onClick={() => navigateTo(step.id)}
                  className={`group flex flex-col items-start py-4 pr-8 shrink-0 border-b-2 transition-colors ${
                    isActive ? 'border-navy' : 'border-transparent hover:border-navy/30'
                  }`}
                >
                  <div className="flex items-center gap-2 mb-0.5">
                    <span
                      className={`text-[9px] font-medium rounded-full w-4 h-4 flex items-center justify-center shrink-0 transition-colors ${
                        summary.done ? 'bg-navy text-cream' : 'bg-frame text-muted'
                      }`}
                    >
                      {idx + 1}
                    </span>
                    <span
                      className={`text-[10px] uppercase tracking-widest font-medium whitespace-nowrap transition-colors ${
                        isActive ? 'text-navy' : 'text-muted group-hover:text-navy/70'
                      }`}
                      style={{ letterSpacing: '0.16em' }}
                    >
                      {step.label}
                    </span>
                  </div>
                  <p className={`text-[10px] pl-6 whitespace-nowrap transition-colors ${isActive ? 'text-navy/60' : 'text-muted/60'}`}>
                    {summary.text}
                  </p>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Brief-first banner (experts already sourced) ── */}
      {viewStep === 'brief' && hasExpertsSourced && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-6xl mx-auto px-6 sm:px-10 py-3 flex items-center justify-between gap-4">
            <p className="text-xs text-amber-800">
              We&apos;ve already found candidates for this brief. Review it, then head to Matches.
            </p>
            <button
              onClick={() => navigateTo('matches')}
              className="shrink-0 text-[10px] uppercase tracking-widest text-amber-700 border border-amber-300 hover:border-amber-500 px-3 py-1 transition-colors"
              style={{ letterSpacing: '0.12em' }}
            >
              Go to Matches
            </button>
          </div>
        </div>
      )}

      {/* ── Ambient next-best-action (navigation only — never starts sourcing) ── */}
      {viewStep !== 'brief' && nextAction && nextAction.step !== viewStep && (
        <div className="bg-navy/5 border-b border-navy/10">
          <div className="max-w-6xl mx-auto px-6 sm:px-10 py-3 flex items-center justify-between gap-4">
            <p className="text-xs text-navy/70">{nextAction.message}</p>
            <button
              onClick={() => navigateTo(nextAction.step)}
              className="shrink-0 text-[10px] uppercase tracking-widest text-navy border border-navy/30 hover:border-navy px-3 py-1 transition-colors"
              style={{ letterSpacing: '0.12em' }}
            >
              {nextAction.cta}
            </button>
          </div>
        </div>
      )}

      {/* ── Step content ── */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 sm:px-10 py-10">

        {/* 1 — Brief */}
        {viewStep === 'brief' && (
          <BriefSection
            project={project}
            draft={briefDraft ?? draftFromProject(project)}
            onDraftChange={setBriefDraft}
            readOnly={!canSend}
            onSave={handleBriefSave}
            onStepChange={navigateTo}
            onDeleteStart={() => setShowDelete(true)}
            onStartSourcing={startSourcing}
            sourcingActive={isSourcing}
            sourcingError={sourcingStale ? 'Sourcing timed out — try again.' : (project.sourcingError ?? null)}
          />
        )}

        {/* 2 — Matches */}
        {viewStep === 'matches' && (
          <div className="space-y-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="max-w-xl">
                <p className="text-sm text-muted leading-relaxed" style={{ fontWeight: 300 }}>
                  <strong className="font-medium text-navy">Who&apos;s actually done this?</strong>{' '}
                  Bookmark anyone worth a call — we&apos;ll take it from there.
                </p>
              </div>
            </div>

            {/* Inline sourcing panel */}
            <SourcePanel
              project={project}
              onStartSourcing={startSourcing}
              sourcingActive={isSourcing}
              sourcingStale={sourcingStale}
              sourcingError={project.sourcingError ?? null}
            />

            {/* Discovery pool */}
            {project.experts.length > 0 && (
              <>
                <div className="flex items-center gap-4 pt-2 flex-wrap">
                  <p className="text-[10px] uppercase tracking-widest text-muted font-medium shrink-0" style={{ letterSpacing: '0.16em' }}>
                    Candidates
                  </p>
                  <div className="flex-1 rule-divider" />
                </div>

                <SourceListControls
                  tierCounts={sourceTierCounts}
                  total={sourcePool.length}
                  visibleCount={visibleSourceExperts.length}
                  tierFilter={tierFilter}
                  categoryFilter={categoryFilter}
                  statusFilter={statusFilter}
                  sortKey={sortKey}
                  onTierChange={setTierFilter}
                  onCategoryChange={setCategoryFilter}
                  onStatusChange={setStatusFilter}
                  onSortChange={handleSortChange}
                  onClearFilters={clearSourceFilters}
                />

                {visibleSourceExperts.length === 0 ? (
                  <EmptyStep
                    message="No experts match these filters."
                    action={
                      <button onClick={clearSourceFilters} className="text-xs text-muted hover:text-navy underline">
                        Clear filters
                      </button>
                    }
                  />
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                    {visibleSourceExperts.map(pe => (
                      <ProjectExpertCard
                        key={pe.expert.id}
                        projectExpert={pe}
                        projectId={projectId}
                        query={project.researchQuestion}
                        onUpdate={handleExpertUpdate}
                        onInterviewGuide={id => setGuideExpert({ id, name: pe.expert.name })}
                        canBookmark={canSend}
                        isAdmin={isAdmin}
                        onOpenConversation={id => { setSelectedThread(id); navigateTo('conversations'); }}
                      />
                    ))}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {/* 3 — Conversations */}
        {viewStep === 'conversations' && (
          <div className="space-y-6">
            <p className="text-sm text-muted leading-relaxed max-w-xl" style={{ fontWeight: 300 }}>
              <strong className="font-medium text-navy">We&apos;ve reached out.</strong>{' '}
              Replies land here — we&apos;ll tell you when there&apos;s something to decide.
            </p>

            <ConversationsPanel
              projectId={projectId}
              project={project}
              canSend={canSend}
              isAdmin={isAdmin}
              selectedExpertId={selectedThread}
              onExpertUpdate={handleExpertUpdate}
              onProjectUpdate={applyProjectUpdate}
              onGoToMatches={() => navigateTo('matches')}
            />
          </div>
        )}


      </main>

      {/* ── Modals ── */}
      {guideExpert && (
        <InterviewGuideModal
          projectId={projectId}
          expertId={guideExpert.id}
          expertName={guideExpert.name}
          onClose={() => setGuideExpert(null)}
        />
      )}
      {showDelete && (
        <DeleteConfirmOverlay
          projectId={projectId}
          onCancel={() => setShowDelete(false)}
          onDeleted={() => router.push('/app')}
        />
      )}
      {showShare && project && (
        <ShareModal
          projectId={projectId}
          collaborators={project.collaborators ?? []}
          onUpdate={applyProjectUpdate}
          onClose={() => setShowShare(false)}
        />
      )}
    </div>
  );
}

// ─── Page export — wraps inner in Suspense for useSearchParams ────────────────

export default function ProjectPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen flex items-center justify-center" style={{ background: '#F7F9FC' }}>
          <div className="flex items-center gap-2 text-sm text-muted">
            <span className="inline-block w-4 h-4 border border-navy border-t-transparent rounded-full animate-spin" />
            Loading…
          </div>
        </div>
      }
    >
      <ProjectPageInner />
    </Suspense>
  );
}

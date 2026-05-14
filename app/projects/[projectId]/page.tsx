'use client';

import { useCallback, useEffect, useRef, useState, Suspense } from 'react';
import Link from 'next/link';
import { useParams, useRouter, useSearchParams } from 'next/navigation';
import type { Project, ProjectExpert, ExpertStatus, Expert, ExpertResponse } from '../../../types';
import ProjectExpertCard from '../../../components/ProjectExpertCard';
import { downloadProjectBriefPdf } from '../../../lib/exportBrief';
import ScreeningCard from '../../../components/ScreeningCard';
import OutreachCard from '../../../components/OutreachCard';
import ClientReadyCard from '../../../components/ClientReadyCard';
import ExpertCard from '../../../components/ExpertCard';
import ClientSchedulingSection from '../../../components/ClientSchedulingSection';
import { useFocusTrap } from '../../../lib/useFocusTrap';

// ─── Workflow step config ─────────────────────────────────────────────────────

type WorkflowStep = 'brief' | 'source' | 'outreach' | 'screen' | 'deliver';

const VALID_STEPS = new Set<string>(['brief', 'source', 'outreach', 'screen', 'deliver']);

const STEPS: Array<{ id: WorkflowStep; label: string }> = [
  { id: 'brief',    label: 'Brief'    },
  { id: 'source',   label: 'Source'   },
  { id: 'outreach', label: 'Outreach' },
  { id: 'screen',   label: 'Screen'   },
  { id: 'deliver',  label: 'Deliver'  },
];

const OUTREACH_STATUSES: ExpertStatus[] = [
  'contact_found', 'outreach_drafted', 'contacted', 'replied', 'scheduled', 'completed',
];

// ─── Step summary & next action ───────────────────────────────────────────────

interface StepSummary { text: string; done: boolean }

function stepSummary(project: Project, step: WorkflowStep): StepSummary {
  const experts = project.experts;
  switch (step) {
    case 'brief':
      return { text: 'Research question defined', done: true };
    case 'source': {
      const n = experts.filter(e => e.status !== 'rejected').length;
      return { text: `${n} discovered`, done: n > 0 };
    }
    case 'outreach': {
      const n = experts.filter(e => OUTREACH_STATUSES.includes(e.status)).length;
      return { text: `${n} in outreach`, done: n > 0 };
    }
    case 'screen': {
      // Post-call screening: experts who've had a vetting call recorded
      const n = experts.filter(
        e => e.status !== 'rejected' && (e.screeningStatus ?? 'not_screened') !== 'not_screened'
          && e.screeningStatus !== 'vetting_questions_ready',
      ).length;
      return { text: `${n} calls recorded`, done: n > 0 };
    }
    case 'deliver': {
      const n = experts.filter(e => e.screeningStatus === 'client_ready' || e.recommendToClient === true).length;
      return { text: `${n} client-ready`, done: n > 0 };
    }
  }
}

type NextActionId = 'complete_brief' | 'source_experts' | 'screen_experts' | 'start_outreach' | 'export_brief';
interface NextAction { id: NextActionId; step?: WorkflowStep; message: string; cta: string }

function getNextAction(project: Project): NextAction | null {
  const { researchQuestion, keyQuestions, experts } = project;
  const briefComplete = !!researchQuestion && (!!keyQuestions || experts.length > 0);
  if (!briefComplete) {
    return { id: 'complete_brief', step: 'brief', message: 'Add key questions and context to complete the brief.', cta: 'Complete brief' };
  }
  const active      = experts.filter(e => e.status !== 'rejected');
  if (active.length === 0) {
    return { id: 'source_experts', step: 'source', message: 'No experts discovered yet. Source candidates to fill the pipeline.', cta: 'Go to Source' };
  }
  const shortlisted = active.filter(e => e.status === 'shortlisted');
  const inOutreach  = active.filter(e => OUTREACH_STATUSES.includes(e.status));
  if (shortlisted.length === 0 && inOutreach.length === 0) {
    return { id: 'source_experts', step: 'source', message: 'Shortlist candidates from the discovery pool, then move to Outreach.', cta: 'Go to Source' };
  }
  if (shortlisted.length > 0 && inOutreach.length === 0) {
    return { id: 'start_outreach', step: 'outreach', message: `${shortlisted.length} shortlisted expert${shortlisted.length !== 1 ? 's' : ''} ready for outreach.`, cta: 'Start outreach' };
  }
  // Experts who've had their vetting call and need a screening outcome recorded
  const callDone   = active.filter(e => e.status === 'scheduled' || e.status === 'completed' || e.status === 'replied');
  const postScreen = active.filter(e =>
    e.screeningStatus && e.screeningStatus !== 'not_screened' && e.screeningStatus !== 'vetting_questions_ready',
  );
  if (callDone.length > 0 && postScreen.length === 0) {
    return {
      id: 'screen_experts', step: 'screen',
      message: `${callDone.length} expert${callDone.length !== 1 ? 's' : ''} ready for vetting call review.`,
      cta: 'Record outcomes',
    };
  }
  const clientReady = active.filter(e => e.screeningStatus === 'client_ready' || e.recommendToClient);
  if (clientReady.length > 0) {
    return {
      id: 'export_brief',
      message: `${clientReady.length} expert${clientReady.length !== 1 ? 's' : ''} are client-ready. Export the brief to deliver.`,
      cta: 'Export brief',
    };
  }
  return null;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Expert profile modal ─────────────────────────────────────────────────────

function ExpertProfileModal({ projectExpert, query, onClose }: {
  projectExpert: ProjectExpert;
  query: string;
  onClose: () => void;
}) {
  const modalRef = useRef<HTMLDivElement>(null);
  useFocusTrap(modalRef, onClose);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(11,31,59,0.55)', backdropFilter: 'blur(2px)' }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        ref={modalRef}
        className="w-full max-w-lg max-h-[90vh] overflow-y-auto flex flex-col shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-label={`Expert profile — ${projectExpert.expert.name}`}
      >
        <div className="sticky top-0 bg-cream border-b border-frame px-4 py-2.5 flex items-center justify-between shrink-0 z-10">
          <p className="text-[10px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.16em' }}>
            Expert Profile
          </p>
          <button onClick={onClose} className="text-muted hover:text-navy transition-colors p-1" aria-label="Close">
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <ExpertCard expert={projectExpert.expert} query={query} />
      </div>
    </div>
  );
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

const PERSPECTIVES = [
  { id: 'operator',            label: 'Operator' },
  { id: 'advisor_consultant',  label: 'Advisor / Consultant' },
  { id: 'regulator',           label: 'Regulator / Governing Body' },
  { id: 'customer_end_user',   label: 'Customer / End User' },
  { id: 'competitor',          label: 'Competitor' },
  { id: 'supplier_vendor',     label: 'Supplier / Vendor' },
  { id: 'investor_analyst',    label: 'Investor / Market Analyst' },
  { id: 'academic_researcher', label: 'Academic / Researcher' },
];

// ─── Brief section ────────────────────────────────────────────────────────────

function BriefSection({
  project,
  onSave,
  onStepChange,
  onExport,
  onDeleteStart,
}: {
  project: Project;
  onSave: (updates: Partial<Project>) => void;
  onStepChange: (step: WorkflowStep) => void;
  onExport: () => void;
  onDeleteStart: () => void;
}) {
  // Research context
  const [keyQuestions,       setKeyQuestions]       = useState(project.keyQuestions       ?? '');
  const [initialHypotheses,  setInitialHypotheses]  = useState(project.initialHypotheses  ?? '');
  const [additionalContext,  setAdditionalContext]  = useState(project.additionalContext   ?? '');
  // Expertise
  const [mustHaveExpertise,  setMustHaveExpertise]  = useState(project.mustHaveExpertise  ?? '');
  const [niceToHaveExpertise,setNiceToHaveExpertise]= useState(project.niceToHaveExpertise?? '');
  const [perspectivesNeeded, setPerspectivesNeeded] = useState<string[]>(project.perspectivesNeeded ?? []);
  // Targeting
  const [targetCompanies,    setTargetCompanies]    = useState(project.targetCompanies    ?? '');
  const [companiesToAvoid,   setCompaniesToAvoid]   = useState(project.companiesToAvoid   ?? '');
  const [peopleToAvoid,      setPeopleToAvoid]      = useState(project.peopleToAvoid      ?? '');
  const [conflictExclusions, setConflictExclusions] = useState(project.conflictExclusions ?? '');
  // Project config
  const [timeline,           setTimeline]           = useState(project.timeline           ?? '');
  const [targetExpertCount,  setTargetExpertCount]  = useState(String(project.targetExpertCount ?? ''));
  // Internal notes
  const [notes,              setNotes]              = useState(project.notes              ?? '');
  const [confNotes,          setConfNotes]          = useState(project.confidentialNotes  ?? '');
  const [saving, setSaving] = useState(false);
  const [saved,  setSaved]  = useState(false);

  function togglePerspective(id: string) {
    setPerspectivesNeeded(prev =>
      prev.includes(id) ? prev.filter(p => p !== id) : [...prev, id],
    );
  }

  async function handleSave() {
    setSaving(true);
    try {
      const parsed = parseInt(targetExpertCount, 10);
      const body: Record<string, unknown> = {
        notes,
        confidentialNotes:  confNotes,
        timeline:           timeline           || '',
        keyQuestions:       keyQuestions       || '',
        initialHypotheses:  initialHypotheses  || '',
        additionalContext:  additionalContext  || '',
        mustHaveExpertise:  mustHaveExpertise  || '',
        niceToHaveExpertise:niceToHaveExpertise|| '',
        targetCompanies:    targetCompanies    || '',
        companiesToAvoid:   companiesToAvoid   || '',
        peopleToAvoid:      peopleToAvoid      || '',
        conflictExclusions: conflictExclusions || '',
        perspectivesNeeded,
      };
      if (!isNaN(parsed) && parsed > 0) body.targetExpertCount = parsed;

      const res = await fetch(`/api/projects/${project.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (res.ok) {
        const d = await res.json() as { project?: Project };
        if (d.project) onSave(d.project);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      }
    } finally {
      setSaving(false);
    }
  }

  const fieldClass = 'w-full px-3 py-2.5 text-sm border border-frame bg-cream focus:outline-none focus:border-navy text-ink resize-y';
  const labelClass = 'block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5';
  const hintClass  = 'text-[10px] text-muted/60 mt-1 leading-relaxed';
  const nextAction = getNextAction(project);

  return (
    <div className="space-y-8 max-w-3xl">

      {/* ── Research question — prominent ── */}
      <div className="border-l-4 border-gold pl-5 space-y-3">
        <p className="text-[10px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.16em' }}>
          Research Question / Business Problem
        </p>
        <p className="font-display text-navy leading-snug" style={{ fontSize: 'clamp(1.1rem, 2.5vw, 1.4rem)', fontWeight: 500 }}>
          {project.researchQuestion}
        </p>
        <p className="text-[11px] text-muted/70 italic leading-relaxed">
          This brief guides sourcing, screening, outreach, and the client-ready deliverable.
        </p>
      </div>

      {/* ── Project metadata tags ── */}
      {(project.industry || project.function || project.geography || project.seniority) && (
        <div className="flex flex-wrap gap-2">
          {project.industry  && (
            <span className="text-[10px] uppercase tracking-widest text-navy/70 border border-navy/20 bg-navy/5 px-2.5 py-1" style={{ letterSpacing: '0.1em' }}>{project.industry}</span>
          )}
          {project.function  && (
            <span className="text-[10px] uppercase tracking-widest text-navy/70 border border-navy/20 bg-navy/5 px-2.5 py-1" style={{ letterSpacing: '0.1em' }}>{project.function}</span>
          )}
          {project.geography && project.geography !== 'any' && (
            <span className="text-[10px] uppercase tracking-widest text-navy/70 border border-navy/20 bg-navy/5 px-2.5 py-1" style={{ letterSpacing: '0.1em' }}>{project.geography}</span>
          )}
          {project.seniority && project.seniority !== 'any' && (
            <span className="text-[10px] uppercase tracking-widest text-navy/70 border border-navy/20 bg-navy/5 px-2.5 py-1" style={{ letterSpacing: '0.1em' }}>{project.seniority}</span>
          )}
          <span className="text-[10px] text-muted px-2.5 py-1">Created {formatDate(project.createdAt)}</span>
        </div>
      )}

      {/* ── Next-best-action card ── */}
      {nextAction && (
        <div className="bg-navy/5 border border-navy/15 p-4 flex items-center justify-between gap-4">
          <div>
            <p className="text-[9px] uppercase tracking-widest text-navy/50 font-medium mb-0.5" style={{ letterSpacing: '0.14em' }}>Suggested next step</p>
            <p className="text-sm text-navy leading-snug">{nextAction.message}</p>
          </div>
          {nextAction.id === 'export_brief' ? (
            <button onClick={onExport} className="shrink-0 text-[10px] uppercase tracking-widest bg-navy text-cream px-4 py-2 hover:bg-navy/90 transition-colors whitespace-nowrap" style={{ letterSpacing: '0.12em' }}>
              {nextAction.cta}
            </button>
          ) : nextAction.step ? (
            <button onClick={() => onStepChange(nextAction.step!)} className="shrink-0 text-[10px] uppercase tracking-widest bg-navy text-cream px-4 py-2 hover:bg-navy/90 transition-colors whitespace-nowrap" style={{ letterSpacing: '0.12em' }}>
              {nextAction.cta}
            </button>
          ) : null}
        </div>
      )}

      {/* ══════════════════════════════════════════════════════════
          SECTION 1 — Research Context
          ══════════════════════════════════════════════════════════ */}
      <div className="pt-2 border-t border-frame space-y-5">
        <p className="text-[10px] uppercase tracking-widest text-navy/50 font-semibold" style={{ letterSpacing: '0.18em' }}>
          Research Context
        </p>

        <div>
          <label className={labelClass}>Key Questions</label>
          <textarea
            value={keyQuestions}
            onChange={e => setKeyQuestions(e.target.value)}
            rows={4}
            placeholder="What are the 3–5 core questions this project needs to answer?&#10;&#10;Example: How many elite youth soccer players exist in Arkansas? Who are the main competitors? What substitutes compete for talent?"
            className={fieldClass}
          />
          <p className={hintClass}>Used to target expert discovery and generate vetting questions.</p>
        </div>

        <div>
          <label className={labelClass}>Initial Hypotheses</label>
          <textarea
            value={initialHypotheses}
            onChange={e => setInitialHypotheses(e.target.value)}
            rows={3}
            placeholder="What do we think is true? What are we trying to validate or challenge?&#10;&#10;Example: Northwest Arkansas may support an MLS NEXT club due to Hispanic population growth, Walton-family investments, and rising soccer participation."
            className={fieldClass}
          />
          <p className={hintClass}>Experts will be sourced who can confirm, refute, or nuance these views.</p>
        </div>

        <div>
          <label className={labelClass}>Additional Context</label>
          <textarea
            value={additionalContext}
            onChange={e => setAdditionalContext(e.target.value)}
            rows={4}
            placeholder="Local market details, relevant organizations, target segments, assumptions, acronyms, constraints, or anything that helps define the scope."
            className={fieldClass}
          />
          <p className={hintClass}>Sharpens search query generation and relevance scoring.</p>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════
          SECTION 2 — Expertise Requirements
          ══════════════════════════════════════════════════════════ */}
      <div className="border-t border-frame space-y-5 pt-5">
        <p className="text-[10px] uppercase tracking-widest text-navy/50 font-semibold" style={{ letterSpacing: '0.18em' }}>
          Expertise Requirements
        </p>

        <div>
          <label className={labelClass}>Must-Have Expertise</label>
          <textarea
            value={mustHaveExpertise}
            onChange={e => setMustHaveExpertise(e.target.value)}
            rows={3}
            placeholder="Hard requirements — candidates without this background will be excluded.&#10;&#10;Example: MLS NEXT operations, youth soccer club leadership, Arkansas soccer market, academy player development."
            className={fieldClass}
          />
          <p className={hintClass}>These become hard requirements in expert scoring.</p>
        </div>

        <div>
          <label className={labelClass}>Nice-to-Have Expertise</label>
          <textarea
            value={niceToHaveExpertise}
            onChange={e => setNiceToHaveExpertise(e.target.value)}
            rows={3}
            placeholder="Scoring boosts — not required, but preferred.&#10;&#10;Example: Youth sports economics, Hispanic soccer participation, Arkansas high school/club soccer, sports real estate."
            className={fieldClass}
          />
          <p className={hintClass}>Increases relevance score; does not disqualify candidates who lack it.</p>
        </div>

        <div>
          <label className={labelClass}>Perspectives Needed</label>
          <div className="flex flex-wrap gap-2 mt-1">
            {PERSPECTIVES.map(p => {
              const active = perspectivesNeeded.includes(p.id);
              return (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => togglePerspective(p.id)}
                  className={`text-[10px] uppercase tracking-widest px-3 py-1.5 border transition-colors ${
                    active
                      ? 'bg-navy text-cream border-navy'
                      : 'bg-cream text-muted border-frame hover:border-navy/40 hover:text-navy'
                  }`}
                  style={{ letterSpacing: '0.1em' }}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
          <p className={hintClass}>Selected perspectives guide expert pool balance. Leave empty to use all.</p>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════
          SECTION 3 — Targeting & Exclusions
          ══════════════════════════════════════════════════════════ */}
      <div className="border-t border-frame space-y-5 pt-5">
        <p className="text-[10px] uppercase tracking-widest text-navy/50 font-semibold" style={{ letterSpacing: '0.18em' }}>
          Targeting &amp; Exclusions
        </p>

        <div>
          <label className={labelClass}>Target Companies / Organizations</label>
          <textarea
            value={targetCompanies}
            onChange={e => setTargetCompanies(e.target.value)}
            rows={3}
            placeholder="Companies, clubs, associations, or organizations to search within.&#10;&#10;Example: MLS NEXT clubs, USL clubs, Arkansas youth soccer clubs, high school athletic associations, soccer facility operators."
            className={fieldClass}
          />
          <p className={hintClass}>Generates company-specific search queries for these organizations.</p>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label className={labelClass}>Companies / Organizations to Avoid</label>
            <textarea
              value={companiesToAvoid}
              onChange={e => setCompaniesToAvoid(e.target.value)}
              rows={3}
              placeholder="Companies the client is negotiating with, or where conflicts exist."
              className={fieldClass}
            />
          </div>
          <div>
            <label className={labelClass}>People to Avoid</label>
            <textarea
              value={peopleToAvoid}
              onChange={e => setPeopleToAvoid(e.target.value)}
              rows={3}
              placeholder="Specific individuals to exclude from the shortlist."
              className={fieldClass}
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>Conflict / Exclusion Notes</label>
          <textarea
            value={conflictExclusions}
            onChange={e => setConflictExclusions(e.target.value)}
            rows={3}
            placeholder="Avoid current employees at organizations the client is actively negotiating with. Avoid experts with direct conflicts or prior relationships that limit objectivity."
            className={fieldClass}
          />
          <p className={hintClass}>Not included in client-facing exports by default.</p>
        </div>
      </div>

      {/* ══════════════════════════════════════════════════════════
          SECTION 4 — Project Config
          ══════════════════════════════════════════════════════════ */}
      <div className="border-t border-frame space-y-5 pt-5">
        <p className="text-[10px] uppercase tracking-widest text-navy/50 font-semibold" style={{ letterSpacing: '0.18em' }}>
          Project Config
        </p>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
          <div>
            <label className={labelClass}>Timeline</label>
            <input
              type="text"
              value={timeline}
              onChange={e => setTimeline(e.target.value)}
              placeholder="e.g. 2 weeks, end of Q2…"
              className="w-full px-3 py-2.5 text-sm border border-frame bg-cream focus:outline-none focus:border-navy text-ink"
            />
          </div>
          <div>
            <label className={labelClass}>Target Expert Count</label>
            <input
              type="number"
              min={1}
              max={200}
              value={targetExpertCount}
              onChange={e => setTargetExpertCount(e.target.value)}
              placeholder="e.g. 8"
              className="w-full px-3 py-2.5 text-sm border border-frame bg-cream focus:outline-none focus:border-navy text-ink"
            />
          </div>
        </div>

        <div>
          <label className={labelClass}>
            Project Notes <span className="normal-case tracking-normal font-normal">(included in export)</span>
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={4}
            placeholder="Key findings, next steps, client context…"
            className={fieldClass}
          />
        </div>

        <div>
          <label className={labelClass}>
            Confidential Notes <span className="normal-case tracking-normal font-normal">(never exported)</span>
          </label>
          <textarea
            value={confNotes}
            onChange={e => setConfNotes(e.target.value)}
            rows={3}
            placeholder="Internal context, client sensitivities, conflict flags…"
            className={fieldClass}
          />
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button
            onClick={handleSave}
            disabled={saving}
            className="bg-navy text-cream text-[10px] uppercase tracking-widest px-5 py-2.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
            style={{ letterSpacing: '0.12em' }}
          >
            {saving ? 'Saving…' : 'Save Brief'}
          </button>
          {saved && <span className="text-[10px] text-green-700">Saved ✓</span>}
        </div>
      </div>

      {/* ── Danger zone ── */}
      <div className="pt-6 border-t border-frame">
        <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-3" style={{ letterSpacing: '0.14em' }}>
          Danger Zone
        </p>
        <button
          onClick={onDeleteStart}
          className="text-[10px] uppercase tracking-widest text-red-600 border border-red-200 hover:bg-red-50 px-4 py-2 transition-colors"
          style={{ letterSpacing: '0.1em' }}
        >
          Delete Project
        </button>
      </div>
    </div>
  );
}

// ─── Source panel ─────────────────────────────────────────────────────────────

function buildBriefContext(project: Project): Record<string, unknown> {
  const bc: Record<string, unknown> = {};
  if (project.industry?.trim())            bc.industry            = project.industry.trim();
  if (project.function?.trim())            bc.function            = project.function.trim();
  if (project.keyQuestions?.trim())        bc.keyQuestions        = project.keyQuestions.trim();
  if (project.initialHypotheses?.trim())   bc.initialHypotheses   = project.initialHypotheses.trim();
  if (project.additionalContext?.trim())   bc.additionalContext   = project.additionalContext.trim();
  if (project.mustHaveExpertise?.trim())   bc.mustHaveExpertise   = project.mustHaveExpertise.trim();
  if (project.niceToHaveExpertise?.trim()) bc.niceToHaveExpertise = project.niceToHaveExpertise.trim();
  if (project.targetCompanies?.trim())     bc.targetCompanies     = project.targetCompanies.trim();
  if (project.companiesToAvoid?.trim())    bc.companiesToAvoid    = project.companiesToAvoid.trim();
  if (project.peopleToAvoid?.trim())       bc.peopleToAvoid       = project.peopleToAvoid.trim();
  if (project.conflictExclusions?.trim())  bc.conflictExclusionNotes = project.conflictExclusions.trim();
  if (project.perspectivesNeeded?.length)  bc.perspectivesNeeded  = project.perspectivesNeeded;
  if (project.targetExpertCount)           bc.targetExpertCount   = project.targetExpertCount;
  return bc;
}

// Build anonymized rejection reason counts for the sourcing feedback loop.
// ONLY reason codes are counted — no expert names, notes, or any other PII.
// Returns undefined if there are no rejections (avoids polluting the payload).
function buildRejectionFeedback(project: Project): Record<string, number> | undefined {
  const rejected = project.experts.filter(pe => pe.status === 'rejected' && pe.rejectionReason);
  if (rejected.length === 0) return undefined;
  const counts: Record<string, number> = {};
  for (const pe of rejected) {
    if (pe.rejectionReason) counts[pe.rejectionReason] = (counts[pe.rejectionReason] ?? 0) + 1;
  }
  return counts;
}

// Count how many brief context fields have content
function briefContextDepth(project: Project): number {
  return [
    project.keyQuestions, project.initialHypotheses, project.additionalContext,
    project.mustHaveExpertise, project.targetCompanies,
  ].filter(v => v?.trim()).length + (project.perspectivesNeeded?.length ? 1 : 0);
}

function SourcePanel({
  project,
  existingExpertIds,
  onExpertsAdded,
}: {
  project: Project;
  existingExpertIds: Set<string>;
  onExpertsAdded: (experts: ProjectExpert[]) => void;
}) {
  const [stage,       setStage]       = useState<'idle' | 'loading' | 'results' | 'error'>('idle');
  const [results,     setResults]     = useState<Expert[]>([]);
  const [addedIds,    setAddedIds]    = useState<Set<string>>(new Set());
  const [addingId,    setAddingId]    = useState<string | null>(null);
  const [addingAll,   setAddingAll]   = useState(false);
  const [srcError,    setSrcError]    = useState('');
  const [adjacentResults, setAdjacentResults] = useState<Expert[]>([]);
  const [limitedPool,     setLimitedPool]     = useState(false);
  const depth = briefContextDepth(project);

  async function runSourcing() {
    setStage('loading');
    setSrcError('');
    setResults([]);
    setAdjacentResults([]);
    setLimitedPool(false);
    setAddedIds(new Set());
    try {
      const briefContext       = buildBriefContext(project);
      const rejectionFeedback  = buildRejectionFeedback(project);
      // Merge rejection feedback into briefContext if present.
      // Only reason-code counts are sent — no expert names or notes.
      if (rejectionFeedback) briefContext.rejectionFeedback = rejectionFeedback;
      const res = await fetch('/api/generate-experts', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          query:    project.researchQuestion,
          geography: project.geography || 'any',
          seniority: project.seniority || 'any',
          briefContext: Object.keys(briefContext).length > 0 ? briefContext : undefined,
        }),
      });
      const data = await res.json() as ExpertResponse & { error?: string; message?: string };
      if (data.error) {
        const friendly = data.error === 'expert_generation_parse_failed'
          ? 'Expert generation failed while formatting results. Please try again or simplify the brief.'
          : (data.message ?? data.error);
        throw new Error(friendly);
      }
      const experts: Expert[] = (data.experts ?? []).map((e: Expert, i: number) => ({
        ...e,
        id: e.id || `src-${i}`,
        source_links: e.source_links ?? [],
      }));
      const adjacent: Expert[] = (data.adjacent_experts ?? []).map((e: Expert) => ({
        ...e,
        // Preserve the API-assigned id; fall back to a name+company slug so the
        // "✓ Added" state (keyed on expert.id) survives within this session.
        id: e.id || `adj-${(e.name + e.company).toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40)}`,
        source_links: e.source_links ?? [],
      }));
      setResults(experts);
      setAdjacentResults(adjacent);
      setLimitedPool(data.limited_pool ?? false);
      setStage(experts.length > 0 || adjacent.length > 0 ? 'results' : 'error');
      if (experts.length === 0 && adjacent.length === 0) {
        setSrcError('No experts found. Try broadening the brief or adjusting the research question.');
      }
    } catch (err) {
      setSrcError(err instanceof Error ? err.message : 'Expert sourcing failed. Please try again.');
      setStage('error');
    }
  }

  async function addExpert(expert: Expert) {
    if (addingId || existingExpertIds.has(expert.id) || addedIds.has(expert.id)) return;
    setAddingId(expert.id);
    try {
      const res = await fetch(`/api/projects/${project.id}/experts`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ experts: [{ expert }] }),
      });
      const data = await res.json() as { project?: { experts: ProjectExpert[] } };
      if (res.ok && data.project) {
        const added = data.project.experts.filter(pe => pe.expert.id === expert.id);
        if (added.length > 0) {
          setAddedIds(prev => { const n = new Set(prev); n.add(expert.id); return n; });
          onExpertsAdded(added);
        }
      }
    } finally {
      setAddingId(null);
    }
  }

  async function addAll() {
    const toAdd = results.filter(e => !existingExpertIds.has(e.id) && !addedIds.has(e.id));
    if (toAdd.length === 0 || addingAll) return;
    setAddingAll(true);
    try {
      const res = await fetch(`/api/projects/${project.id}/experts`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ experts: toAdd.map(expert => ({ expert })) }),
      });
      const data = await res.json() as { project?: { experts: ProjectExpert[] } };
      if (res.ok && data.project) {
        const newIds = new Set(toAdd.map(e => e.id));
        setAddedIds(prev => { const n = new Set(prev); newIds.forEach(id => n.add(id)); return n; });
        const added = data.project.experts.filter(pe => newIds.has(pe.expert.id));
        if (added.length > 0) onExpertsAdded(added);
      }
    } finally {
      setAddingAll(false);
    }
  }

  const alreadyInProject = (id: string) => existingExpertIds.has(id) || addedIds.has(id);
  const pendingCount = results.filter(e => !alreadyInProject(e.id)).length;

  return (
    <div className="border border-frame bg-cream">
      {/* Header */}
      <div className="px-5 py-4 border-b border-frame flex items-start justify-between gap-4">
        <div>
          <p className="text-[10px] uppercase tracking-widest text-navy font-semibold" style={{ letterSpacing: '0.16em' }}>
            Source Experts for This Project
          </p>
          <p className="text-[11px] text-muted mt-1 leading-relaxed">
            Experts are sourced against the full brief — key questions, hypotheses, required expertise, and exclusions.
            {depth > 0 && (
              <span className="ml-1 text-navy/60">({depth} brief context field{depth !== 1 ? 's' : ''} active)</span>
            )}
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
            {stage === 'error' ? 'Retry' : 'Source Experts'}
          </button>
        ) : stage === 'results' ? (
          <button
            onClick={runSourcing}
            className="shrink-0 text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-4 py-2 transition-colors whitespace-nowrap"
            style={{ letterSpacing: '0.12em' }}
          >
            Re-source
          </button>
        ) : null}
      </div>

      {/* Brief context chips (idle only, shows what will be used) */}
      {stage === 'idle' && depth > 0 && (
        <div className="px-5 py-3 flex flex-wrap gap-1.5 border-b border-frame/60 bg-navy/2">
          {project.keyQuestions?.trim() && (
            <span className="text-[10px] border border-navy/15 bg-navy/5 text-navy/70 px-2 py-0.5">Key questions</span>
          )}
          {project.initialHypotheses?.trim() && (
            <span className="text-[10px] border border-navy/15 bg-navy/5 text-navy/70 px-2 py-0.5">Hypotheses</span>
          )}
          {project.additionalContext?.trim() && (
            <span className="text-[10px] border border-navy/15 bg-navy/5 text-navy/70 px-2 py-0.5">Context</span>
          )}
          {project.mustHaveExpertise?.trim() && (
            <span className="text-[10px] border border-gold/30 bg-gold/5 text-amber-700 px-2 py-0.5">Must-have expertise</span>
          )}
          {project.targetCompanies?.trim() && (
            <span className="text-[10px] border border-navy/15 bg-navy/5 text-navy/70 px-2 py-0.5">Target companies</span>
          )}
          {(project.companiesToAvoid?.trim() || project.peopleToAvoid?.trim() || project.conflictExclusions?.trim()) && (
            <span className="text-[10px] border border-red-200 bg-red-50/60 text-red-700 px-2 py-0.5">Exclusions active</span>
          )}
          {project.perspectivesNeeded?.length ? (
            <span className="text-[10px] border border-navy/15 bg-navy/5 text-navy/70 px-2 py-0.5">
              {project.perspectivesNeeded.length} perspective{project.perspectivesNeeded.length !== 1 ? 's' : ''}
            </span>
          ) : null}
        </div>
      )}

      {/* Loading */}
      {stage === 'loading' && (
        <div className="px-5 py-10 flex items-center gap-3 text-sm text-muted">
          <span className="inline-block w-4 h-4 border border-navy border-t-transparent rounded-full animate-spin shrink-0" />
          Sourcing experts against the full brief…
        </div>
      )}

      {/* Error */}
      {stage === 'error' && srcError && (
        <div className="px-5 py-4 text-sm text-red-600">{srcError}</div>
      )}

      {/* Results */}
      {stage === 'results' && (results.length > 0 || adjacentResults.length > 0) && (
        <div>
          {/* Limited pool notice */}
          {limitedPool && (
            <div className="px-5 py-2.5 bg-amber-50 border-b border-amber-100 flex items-start gap-2">
              <svg className="w-3.5 h-3.5 text-amber-600 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
              </svg>
              <p className="text-[11px] text-amber-700 leading-relaxed">
                Limited direct expert pool. Showing direct matches first — adjacent material and domain perspectives appear below.
              </p>
            </div>
          )}
          {/* Core expert count / Add All */}
          {results.length > 0 && (
            <div className="px-5 py-3 border-b border-frame/60 flex items-center justify-between gap-4">
              <p className="text-[10px] text-muted">
                {results.length} core expert{results.length !== 1 ? 's' : ''} sourced
                {pendingCount > 0 && ` · ${pendingCount} not yet added`}
              </p>
              {pendingCount > 0 && (
                <button
                  onClick={addAll}
                  disabled={addingAll}
                  className="text-[10px] uppercase tracking-widest text-navy border border-navy/30 hover:border-navy px-3 py-1 transition-colors disabled:opacity-40"
                  style={{ letterSpacing: '0.12em' }}
                >
                  {addingAll ? 'Adding…' : `Add All (${pendingCount})`}
                </button>
              )}
            </div>
          )}
          {/* Core experts list */}
          {results.length > 0 && (
            <div className="divide-y divide-frame/60">
              {results.map(expert => {
                const inProject = alreadyInProject(expert.id);
                const isAdding  = addingId === expert.id;
                const scoreColor = expert.relevance_score >= 80 ? 'text-green-700' : expert.relevance_score >= 60 ? 'text-amber-700' : 'text-muted';
                return (
                  <div key={expert.id} className="px-5 py-3.5 flex items-start gap-3">
                    <div className={`shrink-0 font-display text-base font-semibold w-8 text-right ${scoreColor}`}>
                      {expert.relevance_score > 0 ? expert.relevance_score : '—'}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <p className="text-sm font-semibold text-navy">{expert.name}</p>
                        <span className="text-[10px] text-muted border border-frame px-1.5 py-0.5">
                          {expert.valueChainLabel ?? expert.category}
                        </span>
                      </div>
                      <p className="text-xs text-muted mt-0.5">{expert.title} · {expert.company}</p>
                      {expert.justification && (
                        <p className="text-[11px] text-muted/80 mt-1 leading-relaxed line-clamp-2">{expert.justification}</p>
                      )}
                    </div>
                    <button
                      onClick={() => addExpert(expert)}
                      disabled={inProject || isAdding}
                      className={`shrink-0 text-[10px] uppercase tracking-widest px-3 py-1.5 border transition-colors whitespace-nowrap ${
                        inProject
                          ? 'border-green-200 bg-green-50 text-green-700 cursor-default'
                          : 'border-navy/30 text-navy hover:bg-navy hover:text-cream hover:border-navy disabled:opacity-40'
                      }`}
                      style={{ letterSpacing: '0.1em' }}
                    >
                      {isAdding ? '…' : inProject ? '✓ Added' : 'Add'}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
          {/* Adjacent Perspectives section */}
          {adjacentResults.length > 0 && (
            <div className={results.length > 0 ? 'border-t border-frame' : ''}>
              <div className="px-5 py-3 bg-amber-50/50 border-b border-amber-100/80">
                <p className="text-[10px] uppercase tracking-widest text-amber-700 font-semibold" style={{ letterSpacing: '0.14em' }}>
                  Adjacent Perspectives
                </p>
                <p className="text-[11px] text-amber-700/70 mt-0.5 leading-relaxed">
                  These candidates may not directly own the primary domain, but can help evaluate material, technical, or commercialization pathways.
                </p>
              </div>
              <div className="divide-y divide-frame/60">
                {adjacentResults.map(expert => {
                  const inProject = alreadyInProject(expert.id);
                  const isAdding  = addingId === expert.id;
                  return (
                    <div key={expert.id} className="px-5 py-3.5 flex items-start gap-3 bg-amber-50/20">
                      <div className="shrink-0 font-display text-base font-semibold w-8 text-right text-muted">
                        {expert.relevance_score > 0 ? expert.relevance_score : '—'}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-semibold text-navy/80">{expert.name}</p>
                          <span className="text-[10px] text-amber-700 border border-amber-200 bg-amber-50 px-1.5 py-0.5">
                            {expert.valueChainLabel ?? expert.category}
                          </span>
                        </div>
                        <p className="text-xs text-muted mt-0.5">{expert.title} · {expert.company}</p>
                        {expert.justification && (
                          <p className="text-[11px] text-muted/80 mt-1 leading-relaxed line-clamp-2">{expert.justification}</p>
                        )}
                      </div>
                      <button
                        onClick={() => addExpert(expert)}
                        disabled={inProject || isAdding}
                        className={`shrink-0 text-[10px] uppercase tracking-widest px-3 py-1.5 border transition-colors whitespace-nowrap ${
                          inProject
                            ? 'border-green-200 bg-green-50 text-green-700 cursor-default'
                            : 'border-amber-200 text-amber-700 hover:bg-amber-700 hover:text-cream hover:border-amber-700 disabled:opacity-40'
                        }`}
                        style={{ letterSpacing: '0.1em' }}
                      >
                        {isAdding ? '…' : inProject ? '✓ Added' : 'Add'}
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Tool link ────────────────────────────────────────────────────────────────

function ToolLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-gold/70 hover:text-gold border border-gold/30 hover:border-gold px-3 py-1.5 transition-colors"
      style={{ letterSpacing: '0.12em' }}
    >
      {children}
    </Link>
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

// ─── Inner page (uses useSearchParams) ───────────────────────────────────────

function ProjectPageInner() {
  const params    = useParams();
  const router    = useRouter();
  const searchParams = useSearchParams();
  const projectId = params.projectId as string;

  // Derive initial step from ?tab= param, default to 'brief'
  const tabParam = searchParams.get('tab') ?? '';
  const initialStep: WorkflowStep = VALID_STEPS.has(tabParam) ? (tabParam as WorkflowStep) : 'brief';

  const [project,     setProject]     = useState<Project | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState('');
  const [activeStep,  setActiveStep]  = useState<WorkflowStep>(initialStep);
  const [guideExpert, setGuideExpert] = useState<{ id: string; name: string } | null>(null);
  const [profilePE,   setProfilePE]   = useState<ProjectExpert | null>(null);
  const [showDelete,  setShowDelete]  = useState(false);

  useEffect(() => {
    fetch(`/api/projects/${projectId}`)
      .then(r => r.json())
      .then((d: { project?: Project; error?: string }) => {
        if (d.error) { setError(d.error); return; }
        setProject(d.project ?? null);
      })
      .catch(() => setError('Failed to load project.'))
      .finally(() => setLoading(false));
  }, [projectId]);

  // Sync active step to URL query param (shallow replace — no scroll)
  function navigateTo(step: WorkflowStep) {
    setActiveStep(step);
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

  const handleExpertRemove = useCallback((expertId: string) => {
    setProject(prev => {
      if (!prev) return prev;
      return { ...prev, experts: prev.experts.filter(pe => pe.expert.id !== expertId), updatedAt: Date.now() };
    });
  }, []);

  const handleBriefSave = useCallback((updated: Partial<Project>) => {
    setProject(prev => prev ? { ...prev, ...updated } : prev);
  }, []);

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
        <Link href="/projects" className="text-xs text-muted hover:text-navy underline">Back to Projects</Link>
      </div>
    );
  }

  const nextAction        = getNextAction(project);
  const sourceExperts     = project.experts.filter(e => e.status !== 'rejected');
  const outreachExperts   = project.experts.filter(e => OUTREACH_STATUSES.includes(e.status));
  // Screen shows experts who've had (or are about to have) their vetting call
  const screenExperts     = project.experts.filter(
    e => e.status === 'scheduled' || e.status === 'replied' || e.status === 'completed',
  );
  const deliverExperts    = project.experts.filter(e => e.screeningStatus === 'client_ready' || e.recommendToClient === true);
  const hasExpertsSourced = sourceExperts.length > 0;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      {/* ── Header ── */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between gap-4">
          <Link
            href="/projects"
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
          <Link
            href={`/projects/${project.id}/client-view`}
            target="_blank"
            rel="noopener"
            className="shrink-0 text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors hidden sm:block"
            style={{ letterSpacing: '0.12em' }}
            title="Open client-safe view (no internal notes)"
          >
            Client View ↗
          </Link>
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
        <div className="max-w-6xl mx-auto px-6 sm:px-10">
          <div className="flex overflow-x-auto">
            {STEPS.map((step, idx) => {
              const summary  = stepSummary(project, step.id);
              const isActive = activeStep === step.id;
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
      {activeStep === 'brief' && hasExpertsSourced && (
        <div className="bg-amber-50 border-b border-amber-200">
          <div className="max-w-6xl mx-auto px-6 sm:px-10 py-3 flex items-center justify-between gap-4">
            <p className="text-xs text-amber-800">
              Experts have already been sourced for this brief. Review the brief, then continue to Source.
            </p>
            <button
              onClick={() => navigateTo('source')}
              className="shrink-0 text-[10px] uppercase tracking-widest text-amber-700 border border-amber-300 hover:border-amber-500 px-3 py-1 transition-colors"
              style={{ letterSpacing: '0.12em' }}
            >
              Go to Source
            </button>
          </div>
        </div>
      )}

      {/* ── Ambient next-best-action (non-brief steps) ── */}
      {activeStep !== 'brief' && nextAction && nextAction.step && nextAction.step !== activeStep && (
        <div className="bg-navy/5 border-b border-navy/10">
          <div className="max-w-6xl mx-auto px-6 sm:px-10 py-3 flex items-center justify-between gap-4">
            <p className="text-xs text-navy/70">{nextAction.message}</p>
            <button
              onClick={() => navigateTo(nextAction.step!)}
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
        {activeStep === 'brief' && (
          <BriefSection
            project={project}
            onSave={handleBriefSave}
            onStepChange={navigateTo}
            onExport={() => { downloadProjectBriefPdf(project); }}
            onDeleteStart={() => setShowDelete(true)}
          />
        )}

        {/* 2 — Source */}
        {activeStep === 'source' && (
          <div className="space-y-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="max-w-xl">
                <p className="text-sm text-muted leading-relaxed" style={{ fontWeight: 300 }}>
                  <strong className="font-medium text-navy">Who might have the knowledge we need?</strong>{' '}
                  Run brief-informed sourcing to populate the discovery pool. Shortlist the strongest fits inline —
                  shortlisted experts move to Outreach.
                  Use <strong className="font-medium text-navy">Review Candidates</strong> to score and compare against the brief.
                </p>
              </div>
              <ToolLink href={`/rank-experts?projectId=${projectId}`}>Review Candidates ↗</ToolLink>
            </div>

            {/* Inline sourcing panel */}
            <SourcePanel
              project={project}
              existingExpertIds={new Set(project.experts.map(pe => pe.expert.id))}
              onExpertsAdded={newPEs => {
                setProject(prev => {
                  if (!prev) return prev;
                  const existingIds = new Set(prev.experts.map(pe => pe.expert.id));
                  const trulyNew = newPEs.filter(pe => !existingIds.has(pe.expert.id));
                  return trulyNew.length > 0
                    ? { ...prev, experts: [...prev.experts, ...trulyNew] }
                    : prev;
                });
              }}
            />

            {/* Discovery pool */}
            {sourceExperts.length > 0 && (
              <>
                <div className="flex items-center gap-4 pt-2">
                  <p className="text-[10px] uppercase tracking-widest text-muted font-medium shrink-0" style={{ letterSpacing: '0.16em' }}>
                    Discovery Pool
                  </p>
                  <div className="flex-1 rule-divider" />
                  <span className="text-[10px] text-muted shrink-0">{sourceExperts.length} expert{sourceExperts.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                  {sourceExperts.map(pe => (
                    <ProjectExpertCard
                      key={pe.expert.id}
                      projectExpert={pe}
                      projectId={projectId}
                      query={project.researchQuestion}
                      onUpdate={handleExpertUpdate}
                      onRemove={handleExpertRemove}
                      onInterviewGuide={id => setGuideExpert({ id, name: pe.expert.name })}
                    />
                  ))}
                </div>
              </>
            )}
          </div>
        )}

        {/* 3 — Outreach */}
        {activeStep === 'outreach' && (
          <div className="space-y-6">
            <p className="text-sm text-muted leading-relaxed max-w-xl" style={{ fontWeight: 300 }}>
              <strong className="font-medium text-navy">Find, contact, and schedule.</strong>{' '}
              Shortlisted experts enter here. Find their professional email, generate interview prep questions,
              draft and send outreach, track replies, send an availability request, and confirm the vetting call slot.
              Record call outcomes in Screen.
            </p>
            {outreachExperts.length === 0 ? (
              <EmptyStep
                message="No experts in outreach yet."
                action={
                  <button onClick={() => navigateTo('source')} className="text-xs text-muted hover:text-navy underline">
                    Shortlist candidates in Source first
                  </button>
                }
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                {outreachExperts.map(pe => (
                  <OutreachCard
                    key={pe.expert.id}
                    projectExpert={pe}
                    projectId={projectId}
                    query={project.researchQuestion}
                    onUpdate={handleExpertUpdate}
                    onContactUpdated={handleExpertUpdate}
                    onViewProfile={() => setProfilePE(pe)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* 4 — Screen */}
        {activeStep === 'screen' && (
          <div className="space-y-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <div className="max-w-xl">
                <p className="text-sm text-muted leading-relaxed" style={{ fontWeight: 300 }}>
                  <strong className="font-medium text-navy">Vetting call done — what did you learn?</strong>{' '}
                  Record pass / fail / no-show, capture key insights, and flag conflicts.
                  Passed experts move to Deliver for client call scheduling.
                  No-shows return to Outreach for follow-up.
                </p>
              </div>
            </div>

            {/* Brief context banner */}
            {(project.researchQuestion || project.keyQuestions) && (
              <div className="border border-navy/15 bg-navy/5 px-4 py-3 space-y-1.5">
                <p className="text-[9px] uppercase tracking-widest text-navy/50 font-medium" style={{ letterSpacing: '0.16em' }}>
                  Evaluating against
                </p>
                <p className="text-sm text-navy leading-snug font-medium">{project.researchQuestion}</p>
                {project.keyQuestions && (
                  <details className="group">
                    <summary className="text-[10px] uppercase tracking-widest text-muted hover:text-navy cursor-pointer select-none transition-colors list-none flex items-center gap-1 mt-1"
                      style={{ letterSpacing: '0.14em' }}>
                      <svg className="w-3 h-3 shrink-0 transition-transform group-open:rotate-90" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                      </svg>
                      Key questions
                    </summary>
                    <p className="text-[11px] text-muted leading-relaxed mt-1.5 whitespace-pre-line">{project.keyQuestions}</p>
                  </details>
                )}
              </div>
            )}

            {screenExperts.length === 0 ? (
              <EmptyStep
                message="No experts at the vetting call stage yet."
                action={
                  <button onClick={() => navigateTo('outreach')} className="text-xs text-muted hover:text-navy underline">
                    Move experts through Outreach first
                  </button>
                }
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                {screenExperts.map(pe => (
                  <ScreeningCard
                    key={pe.expert.id}
                    projectExpert={pe}
                    projectId={projectId}
                    onUpdate={handleExpertUpdate}
                    onViewProfile={() => setProfilePE(pe)}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* 5 — Deliver */}
        {activeStep === 'deliver' && (
          <div className="space-y-6">
            <div className="flex items-start justify-between gap-4 flex-wrap">
              <p className="text-sm text-muted leading-relaxed max-w-xl" style={{ fontWeight: 300 }}>
                <strong className="font-medium text-navy">What does the client receive?</strong>{' '}
                Experts cleared on knowledge fit, conflicts, communication quality, and availability — ready to deliver to the client.
              </p>
              {deliverExperts.length > 0 && (
                <button
                  onClick={() => { downloadProjectBriefPdf(project); }}
                  className="shrink-0 text-[10px] uppercase tracking-widest bg-navy text-cream px-4 py-2 hover:bg-navy/90 transition-colors"
                  style={{ letterSpacing: '0.12em' }}
                >
                  Export Brief
                </button>
              )}
            </div>

            {/* Client scheduling section — always shown in Deliver tab */}
            <ClientSchedulingSection
              projectId={projectId}
              project={project}
              onProjectUpdate={p => setProject(p)}
            />

            {deliverExperts.length === 0 ? (
              <EmptyStep
                message="No client-ready experts yet."
                action={<p className="text-xs text-muted">Record vetting call outcomes in the Screen step — passed experts appear here.</p>}
              />
            ) : (
              <div className="space-y-3">
                <p className="text-[10px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.16em' }}>
                  Client-Ready Experts
                </p>
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-5">
                  {deliverExperts.map(pe => (
                    <div key={pe.expert.id} className="space-y-1.5">
                      {/* Per-expert scheduling status badge */}
                      {pe.calendarEventId ? (
                        <div className="flex items-center gap-1.5 px-2 py-1 bg-green-50 border border-green-200 text-[10px] text-green-700 font-medium">
                          <span>&#x1F4C5;</span>
                          <span>Scheduled</span>
                        </div>
                      ) : pe.overlapResult ? (
                        <div className="flex items-center gap-1.5 px-2 py-1 bg-amber-50 border border-amber-200 text-[10px] text-amber-700 font-medium">
                          <span>&#x26A0;</span>
                          <span>Overlap found — invite pending</span>
                        </div>
                      ) : pe.availabilitySubmitted ? (
                        <div className="flex items-center gap-1.5 px-2 py-1 bg-gray-50 border border-gray-200 text-[10px] text-muted font-medium">
                          <span>&#x23F3;</span>
                          <span>Availability received</span>
                        </div>
                      ) : null}
                      <ClientReadyCard projectExpert={pe} />
                      {/* Zoom status section */}
                      {pe.zoomJoinUrl && (
                        <div className="px-2 py-1.5 bg-sky-50 border border-sky-200 space-y-0.5">
                          <span className="block text-[10px] uppercase tracking-widest text-sky-700 font-medium" style={{ letterSpacing: '0.12em' }}>
                            &#x1F4F9; Zoom Created
                          </span>
                          <a
                            href={pe.zoomJoinUrl}
                            target="_blank"
                            rel="noopener"
                            className="block text-[10px] text-sky-700 hover:underline underline-offset-2 break-all"
                            title="Join Zoom meeting"
                          >
                            {pe.zoomJoinUrl}
                          </a>
                        </div>
                      )}
                      {pe.zoomMeetingStarted && !pe.zoomMeetingEndedAt && (
                        <div className="px-2 py-1.5 bg-green-50 border border-green-200">
                          <span className="text-[10px] uppercase tracking-widest text-green-700 font-medium" style={{ letterSpacing: '0.12em' }}>
                            &#x1F7E2; Call in Progress
                          </span>
                        </div>
                      )}
                      {pe.zoomMeetingEndedAt && (
                        <div className="px-2 py-1.5 bg-gray-50 border border-gray-200">
                          <span className="text-[10px] text-muted">
                            &#x2713; Call completed{pe.actualDurationMin != null ? ` · ${pe.actualDurationMin} min` : ''}
                          </span>
                        </div>
                      )}
                      {pe.actualDurationMin != null && pe.invoiceAmount == null && (
                        <div className="px-2 py-1.5 bg-amber-50 border border-amber-200 space-y-0.5">
                          <span className="block text-[10px] uppercase tracking-widest text-amber-700 font-medium" style={{ letterSpacing: '0.12em' }}>
                            Rate Not Set
                          </span>
                          <p className="text-[10px] text-amber-600">
                            Set the expert rate to send the invoice automatically.
                          </p>
                        </div>
                      )}
                      {/* Payment status badge */}
                      {pe.paymentStatus === 'unpaid' && (
                        <div className="px-2 py-1.5 bg-amber-50 border border-amber-200 space-y-0.5">
                          <span className="text-[10px] uppercase tracking-widest text-amber-700 font-medium" style={{ letterSpacing: '0.12em' }}>
                            Invoice Pending
                          </span>
                        </div>
                      )}
                      {pe.paymentStatus === 'invoice_sent' && (
                        <div className="px-2 py-1.5 bg-amber-50 border border-amber-200 space-y-1">
                          <span className="block text-[10px] uppercase tracking-widest text-amber-700 font-medium" style={{ letterSpacing: '0.12em' }}>
                            Invoice Sent
                          </span>
                          {pe.stripePaymentLinkUrl && (
                            <a
                              href={pe.stripePaymentLinkUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="block text-[10px] text-sky-700 hover:underline underline-offset-2 break-all"
                              title="Copy or share this payment link"
                            >
                              {pe.stripePaymentLinkUrl}
                            </a>
                          )}
                        </div>
                      )}
                      {pe.paymentStatus === 'paid' && (
                        <div className="px-2 py-1.5 bg-green-50 border border-green-200 space-y-0.5">
                          <span className="text-[10px] uppercase tracking-widest text-green-700 font-medium" style={{ letterSpacing: '0.12em' }}>
                            Paid ✓
                          </span>
                          {pe.paidAt != null && (
                            <p className="text-[10px] text-green-600">
                              {new Date(pe.paidAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
                            </p>
                          )}
                        </div>
                      )}
                      {pe.paymentStatus === 'failed' && (
                        <div className="px-2 py-1.5 bg-red-50 border border-red-200 space-y-1.5">
                          <span className="block text-[10px] uppercase tracking-widest text-red-700 font-medium" style={{ letterSpacing: '0.12em' }}>
                            Payment Failed
                          </span>
                          {pe.invoiceAmount != null && pe.callDurationMin != null && (
                            <button
                              onClick={async () => {
                                try {
                                  const res = await fetch(`/api/projects/${projectId}/experts/${pe.expert.id}/complete`, {
                                    method:  'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body:    JSON.stringify({
                                      callDurationMin: pe.callDurationMin,
                                      invoiceAmount:   pe.invoiceAmount,
                                    }),
                                  });
                                  const data = await res.json() as { paymentLinkUrl?: string };
                                  if (res.ok) {
                                    handleExpertUpdate({
                                      ...pe,
                                      paymentStatus:       'invoice_sent',
                                      stripePaymentLinkUrl: data.paymentLinkUrl ?? pe.stripePaymentLinkUrl,
                                      updatedAt:           Date.now(),
                                    });
                                  }
                                } catch {
                                  // silent — user can retry
                                }
                              }}
                              className="text-[10px] uppercase tracking-widest text-red-700 border border-red-300 hover:bg-red-100 px-2 py-1 transition-colors"
                              style={{ letterSpacing: '0.1em' }}
                            >
                              Resend Invoice
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
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
      {profilePE && (
        <ExpertProfileModal
          projectExpert={profilePE}
          query={project.researchQuestion}
          onClose={() => setProfilePE(null)}
        />
      )}
      {showDelete && (
        <DeleteConfirmOverlay
          projectId={projectId}
          onCancel={() => setShowDelete(false)}
          onDeleted={() => router.push('/projects')}
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

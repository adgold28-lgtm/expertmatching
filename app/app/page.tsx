'use client';

import { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import ExpertCard from '../../components/ExpertCard';
import ProjectSaveModal from '../../components/ProjectSaveModal';
import { Expert, ExpertResponse, ExpertStatus, QueryAnalysis, ProjectSummary } from '../../types';

const GEOGRAPHIES = ['Any Geography', 'United States', 'Europe', 'Asia Pacific', 'Latin America', 'Middle East & Africa', 'Global'];
const SENIORITIES = ['Any Seniority', 'Mid-Level', 'Senior', 'Executive / C-Suite'];

function formatDate(ts: number) {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Skeleton ──────────────────────────────────────────────────────────────────

function SkeletonCard() {
  return (
    <div className="expert-card p-6 space-y-5">
      <div className="flex justify-between items-start">
        <div className="space-y-2 flex-1">
          <div className="skeleton h-5 w-2/3 rounded" />
          <div className="skeleton h-3.5 w-1/2 rounded" />
          <div className="skeleton h-3.5 w-2/5 rounded" />
        </div>
        <div className="skeleton h-7 w-8 rounded" />
      </div>
      <div className="skeleton h-px w-full" />
      <div className="space-y-2">
        <div className="skeleton h-3.5 w-full rounded" />
        <div className="skeleton h-3.5 w-5/6 rounded" />
        <div className="skeleton h-3.5 w-4/5 rounded" />
      </div>
      <div className="skeleton h-10 w-full rounded" />
    </div>
  );
}

function LoadingState() {
  return (
    <div className="space-y-12 animate-fade-in">
      {(['Operators', 'Advisors', 'Outsiders'] as const).map((label) => (
        <div key={label} className="space-y-5">
          <div className="flex items-center gap-4">
            <div className="skeleton h-3 w-24 rounded" />
            <div className="flex-1 rule-divider" />
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            <SkeletonCard />
            <SkeletonCard />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Query Analysis Bar ────────────────────────────────────────────────────────

const CONFIDENCE_CLASS = {
  High:   'bg-status-success',
  Medium: 'bg-status-warning',
  Low:    'bg-status-danger',
} as const;

function ConfidenceDot({ level }: { level: 'High' | 'Medium' | 'Low' }) {
  return (
    <span
      className={`inline-block w-1.5 h-1.5 rounded-full mr-1.5 ${CONFIDENCE_CLASS[level]}`}
      style={{ verticalAlign: 'middle' }}
    />
  );
}

function AnalysisBar({ analysis }: { analysis: QueryAnalysis }) {
  return (
    <div className="animate-fade-in border-b border-frame bg-surface">
      <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex flex-wrap items-center gap-x-8 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-muted font-medium">Industry</span>
          <span className="text-xs text-ink font-medium">{analysis.industry}</span>
        </div>
        <div className="w-px h-3 bg-frame hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-muted font-medium">Function</span>
          <span className="text-xs text-ink font-medium">{analysis.function}</span>
        </div>
        <div className="w-px h-3 bg-frame hidden sm:block" />
        <div className="flex flex-wrap gap-1.5">
          {analysis.key_topics.slice(0, 4).map((t) => (
            <span key={t} className="text-[10px] px-2 py-0.5 border border-frame text-muted" style={{ letterSpacing: '0.02em' }}>
              {t}
            </span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <ConfidenceDot level={analysis.confidence} />
          <span className="text-[10px] uppercase tracking-widest text-muted font-medium">{analysis.confidence} Confidence</span>
        </div>
      </div>
    </div>
  );
}

// ─── Category Section ──────────────────────────────────────────────────────────

const CATEGORY_META = {
  Operator: { label: 'Operators', description: 'Practitioners with direct field experience' },
  Advisor:  { label: 'Advisors',  description: 'Analysts, investors, and consultants who evaluate the space' },
  Outsider: { label: 'Outsiders', description: 'Regulatory, enterprise, and independent perspectives' },
};

function CategorySection({
  category, experts, query, shortlistedIds, rejectedIds, onShortlist, onReject,
}: {
  category: 'Operator' | 'Advisor' | 'Outsider';
  experts: Expert[];
  query: string;
  shortlistedIds: Set<string>;
  rejectedIds: Set<string>;
  onShortlist: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const meta = CATEGORY_META[category];
  return (
    <section className="space-y-5">
      <div className="flex items-center gap-5">
        <div className="shrink-0">
          <h2 className="text-[11px] font-semibold uppercase text-navy" style={{ letterSpacing: '0.18em' }}>{meta.label}</h2>
          <p className="text-[11px] text-muted mt-0.5">{meta.description}</p>
        </div>
        <div className="flex-1 rule-divider" />
        <span className="text-[11px] text-muted shrink-0">{experts.length > 0 ? `${experts.length} found` : '—'}</span>
      </div>
      {experts.length === 0 ? (
        <div className="py-8 text-center border border-dashed border-frame" style={{ background: 'rgba(247,249,252,0.6)' }}>
          <p className="text-sm text-muted">No high-confidence experts identified for this category.</p>
          <p className="text-xs text-muted mt-1 opacity-70">Try a more specific query or different geography.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {experts.map((expert, i) => (
            <ExpertCard
              key={expert.id}
              expert={expert}
              query={query}
              index={i}
              quickActions={{
                isShortlisted: shortlistedIds.has(expert.id),
                isRejected:    rejectedIds.has(expert.id),
                onShortlist:   () => onShortlist(expert.id),
                onReject:      () => onReject(expert.id),
              }}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function FieldLabel({ htmlFor, children }: { htmlFor?: string; children: React.ReactNode }) {
  return (
    <label
      htmlFor={htmlFor}
      className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5"
      style={{ letterSpacing: '0.18em' }}
    >
      {children}
    </label>
  );
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function AppPage() {
  // Projects
  const [projects,        setProjects]        = useState<ProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);

  // Brief fields
  const [query,              setQuery]              = useState('');
  const [industry,           setIndustry]           = useState('');
  const [functionField,      setFunctionField]      = useState('');
  const [geography,          setGeography]          = useState('any');
  const [seniority,          setSeniority]          = useState('any');
  const [timeline,           setTimeline]           = useState('');
  const [targetExpertCount,  setTargetExpertCount]  = useState('');
  const [keyQuestions,       setKeyQuestions]       = useState('');
  const [initialHypotheses,  setInitialHypotheses]  = useState('');
  const [conflictExclusions, setConflictExclusions] = useState('');
  const [showAdvanced,       setShowAdvanced]       = useState(false);

  // Search state
  const [loading,        setLoading]        = useState(false);
  const [result,         setResult]         = useState<ExpertResponse | null>(null);
  const [error,          setError]          = useState('');
  const [shortlistedIds, setShortlistedIds] = useState<Set<string>>(new Set());
  const [rejectedIds,    setRejectedIds]    = useState<Set<string>>(new Set());
  const [showSaveModal,  setShowSaveModal]  = useState(false);

  // Create brief state
  const [creatingBrief, setCreatingBrief] = useState(false);
  const [briefError,    setBriefError]    = useState('');

  const formRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then((d: { projects?: ProjectSummary[] }) => {
        setProjects(d.projects ?? []);
        setProjectsLoading(false);
      })
      .catch(() => setProjectsLoading(false));
  }, []);

  // ─── Handlers ───────────────────────────────────────────────────────────────

  async function handleSignOut() {
    await fetch('/api/auth/logout', { method: 'POST' });
    window.location.href = '/';
  }

  function scrollToForm() {
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setTimeout(() => {
      formRef.current?.querySelector('textarea')?.focus();
    }, 350);
  }

  function handleShortlist(id: string) {
    setShortlistedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); }
      else { next.add(id); setRejectedIds(r => { const n = new Set(r); n.delete(id); return n; }); }
      return next;
    });
  }

  function handleReject(id: string) {
    setRejectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) { next.delete(id); }
      else { next.add(id); setShortlistedIds(s => { const n = new Set(s); n.delete(id); return n; }); }
      return next;
    });
  }

  function expertsWithStatus(): Array<{ expert: Expert; status: ExpertStatus }> {
    return (result?.experts ?? []).map(e => ({
      expert: e,
      status: shortlistedIds.has(e.id) ? 'shortlisted' : rejectedIds.has(e.id) ? 'rejected' : 'discovered',
    }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;
    setLoading(true);
    setResult(null);
    setError('');
    setShortlistedIds(new Set());
    setRejectedIds(new Set());
    try {
      const briefContext: Record<string, unknown> = {};
      if (industry.trim())           briefContext.industry              = industry.trim();
      if (functionField.trim())      briefContext.function              = functionField.trim();
      if (keyQuestions.trim())       briefContext.keyQuestions          = keyQuestions.trim();
      if (initialHypotheses.trim())  briefContext.initialHypotheses     = initialHypotheses.trim();
      if (conflictExclusions.trim()) briefContext.conflictExclusionNotes = conflictExclusions.trim();

      const res = await fetch('/api/generate-experts', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          query: query.trim(),
          geography,
          seniority,
          briefContext: Object.keys(briefContext).length > 0 ? briefContext : undefined,
        }),
      });
      const data = await res.json();
      if (data.error) {
        const msg: string =
          data.error === 'expert_generation_parse_failed'
            ? 'Expert generation failed while formatting results. Please try again or simplify the brief.'
            : (typeof data.message === 'string' ? data.message : data.error);
        throw new Error(msg);
      }
      data.experts = data.experts.map((ex: Expert, i: number) => ({
        ...ex,
        id:           ex.id || `exp-${i}`,
        source_links: ex.source_links || [],
      }));
      if (!industry.trim()      && data.query_analysis?.industry) setIndustry(data.query_analysis.industry);
      if (!functionField.trim() && data.query_analysis?.function) setFunctionField(data.query_analysis.function);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  async function handleCreateProjectBrief() {
    if (!query.trim() || creatingBrief) return;
    setCreatingBrief(true);
    setBriefError('');
    try {
      const res = await fetch('/api/projects', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          name:             query.trim().slice(0, 80),
          researchQuestion: query.trim(),
          industry:         industry.trim(),
          function:         functionField.trim(),
          geography:        geography === 'any' ? '' : geography,
          seniority:        seniority === 'any' ? '' : seniority,
          experts:          [],
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      const projectId: string = data.project.id;

      const extras: Record<string, unknown> = {};
      if (timeline.trim())           extras.timeline           = timeline.trim();
      if (targetExpertCount.trim())  extras.targetExpertCount  = parseInt(targetExpertCount, 10);
      if (keyQuestions.trim())       extras.keyQuestions        = keyQuestions.trim();
      if (initialHypotheses.trim())  extras.initialHypotheses   = initialHypotheses.trim();
      if (conflictExclusions.trim()) extras.conflictExclusions  = conflictExclusions.trim();

      if (Object.keys(extras).length > 0) {
        await fetch(`/api/projects/${projectId}`, {
          method:  'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify(extras),
        });
      }

      window.location.href = `/projects/${projectId}?tab=brief`;
    } catch (err) {
      setBriefError(err instanceof Error ? err.message : 'Failed to create project. Please try again.');
      setCreatingBrief(false);
    }
  }

  const operators = result?.experts.filter(e => e.category === 'Operator') ?? [];
  const advisors  = result?.experts.filter(e => e.category === 'Advisor')  ?? [];
  const outsiders = result?.experts.filter(e => e.category === 'Outsider') ?? [];

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      {/* ── Header ── */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between">
          <Link
            href="/app"
            className="font-display text-cream font-semibold"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <div className="flex items-center gap-3">
            <button
              onClick={scrollToForm}
              className="text-[10px] uppercase font-medium px-4 py-2 transition-colors"
              style={{
                background: '#C6A75E',
                color:      '#0B1F3B',
                letterSpacing: '0.14em',
              }}
            >
              New Project
            </button>
            <button
              onClick={handleSignOut}
              className="text-[10px] uppercase font-medium px-4 py-2 transition-colors border"
              style={{
                color:       'rgba(198,167,94,0.6)',
                borderColor: 'rgba(198,167,94,0.25)',
                letterSpacing: '0.14em',
              }}
            >
              Sign Out
            </button>
          </div>
        </div>
      </header>

      {/* ── Projects ── */}
      <div className="border-b border-frame bg-surface">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-8">
          <div className="flex items-center justify-between mb-5">
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.2em' }}>
              Projects
            </p>
            <Link
              href="/projects"
              className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
              style={{ letterSpacing: '0.14em' }}
            >
              View all →
            </Link>
          </div>

          {projectsLoading ? (
            <div className="space-y-2">
              {[1, 2, 3].map(i => (
                <div key={i} className="flex items-center gap-4 px-4 py-3.5 bg-cream border border-frame">
                  <div className="skeleton h-3.5 w-48 rounded" />
                  <div className="skeleton h-3 w-72 rounded flex-1" />
                  <div className="skeleton h-3 w-20 rounded" />
                </div>
              ))}
            </div>
          ) : projects.length > 0 ? (
            <div className="space-y-2">
              {projects.slice(0, 8).map(p => (
                <Link
                  key={p.id}
                  href={`/projects/${p.id}`}
                  className="flex items-center gap-6 bg-cream border border-frame hover:border-navy/40 px-4 py-3.5 transition-colors group"
                >
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-navy group-hover:underline underline-offset-2 leading-snug truncate">
                      {p.name}
                    </p>
                    <p className="text-[11px] text-muted mt-0.5 truncate leading-relaxed" style={{ fontWeight: 300 }}>
                      {p.researchQuestion}
                    </p>
                  </div>
                  <div className="shrink-0 flex items-center gap-5">
                    <span className="text-[10px] text-muted hidden sm:block">
                      {p.expertCount} expert{p.expertCount !== 1 ? 's' : ''}
                    </span>
                    <span className="text-[10px] text-muted hidden md:block">
                      {formatDate(p.createdAt)}
                    </span>
                    <span
                      className="text-[10px] uppercase font-medium group-hover:text-navy transition-colors"
                      style={{ color: '#C6A75E', letterSpacing: '0.12em' }}
                    >
                      Open →
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <div className="py-10 text-center border border-dashed border-frame" style={{ background: 'rgba(247,249,252,0.6)' }}>
              <p className="text-sm text-muted">No projects yet.</p>
              <p className="text-xs text-muted mt-1 opacity-70">
                Start by sourcing experts for a research question below.
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Source Experts form ── */}
      <div ref={formRef} className="border-b border-frame bg-surface">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-10">
          <p
            className="text-[10px] uppercase tracking-widest text-muted font-medium mb-6"
            style={{ letterSpacing: '0.2em' }}
          >
            Source Experts
          </p>

          <form onSubmit={handleSubmit} className="space-y-5 max-w-2xl">

            {/* Research Question */}
            <div>
              <FieldLabel htmlFor="query">Research Question <span className="text-red-400 ml-0.5">*</span></FieldLabel>
              <textarea
                id="query"
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="e.g. How does solar interconnection work in ERCOT, and what are the main bottlenecks operators face?"
                rows={3}
                className="input-search w-full px-4 py-3.5 text-sm text-ink placeholder-[#9AABB8] border border-frame resize-none bg-cream transition-all"
                style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(e as unknown as React.FormEvent);
                }}
              />
            </div>

            {/* Industry + Function */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel htmlFor="industry">Industry</FieldLabel>
                <input
                  id="industry"
                  type="text"
                  value={industry}
                  onChange={e => setIndustry(e.target.value)}
                  placeholder="e.g. Energy & Utilities"
                  className="w-full px-3 py-2.5 text-xs text-ink border border-frame bg-cream focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]"
                  style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                />
              </div>
              <div>
                <FieldLabel htmlFor="functionField">Function</FieldLabel>
                <input
                  id="functionField"
                  type="text"
                  value={functionField}
                  onChange={e => setFunctionField(e.target.value)}
                  placeholder="e.g. Operations"
                  className="w-full px-3 py-2.5 text-xs text-ink border border-frame bg-cream focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]"
                  style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                />
              </div>
            </div>

            {/* Geography + Seniority */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel htmlFor="geography">Geography</FieldLabel>
                <select
                  id="geography"
                  value={geography}
                  onChange={e => setGeography(e.target.value)}
                  className="select-field w-full px-3 py-2.5 text-xs text-ink border border-frame bg-cream pr-8 focus:outline-none focus:border-navy transition-colors"
                  style={{ fontFamily: 'var(--font-libre-franklin)' }}
                >
                  {GEOGRAPHIES.map(g => (
                    <option key={g} value={g === 'Any Geography' ? 'any' : g}>{g}</option>
                  ))}
                </select>
              </div>
              <div>
                <FieldLabel htmlFor="seniority">Seniority</FieldLabel>
                <select
                  id="seniority"
                  value={seniority}
                  onChange={e => setSeniority(e.target.value)}
                  className="select-field w-full px-3 py-2.5 text-xs text-ink border border-frame bg-cream pr-8 focus:outline-none focus:border-navy transition-colors"
                  style={{ fontFamily: 'var(--font-libre-franklin)' }}
                >
                  {SENIORITIES.map(s => (
                    <option key={s} value={s === 'Any Seniority' ? 'any' : s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Advanced context */}
            <div>
              <button
                type="button"
                onClick={() => setShowAdvanced(v => !v)}
                className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
                style={{ letterSpacing: '0.16em' }}
              >
                <svg
                  className={`w-3 h-3 transition-transform ${showAdvanced ? 'rotate-90' : ''}`}
                  fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}
                >
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                </svg>
                {showAdvanced ? 'Hide' : 'Add'} brief context
              </button>

              {showAdvanced && (
                <div className="mt-4 space-y-4 border-l-2 border-frame pl-5">
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <FieldLabel htmlFor="timeline">Timeline</FieldLabel>
                      <input
                        id="timeline"
                        type="text"
                        value={timeline}
                        onChange={e => setTimeline(e.target.value)}
                        placeholder="e.g. 2 weeks"
                        maxLength={200}
                        className="w-full px-3 py-2.5 text-xs text-ink border border-frame bg-cream focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]"
                        style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                      />
                    </div>
                    <div>
                      <FieldLabel htmlFor="targetExpertCount">Target Expert Count</FieldLabel>
                      <input
                        id="targetExpertCount"
                        type="number"
                        value={targetExpertCount}
                        onChange={e => setTargetExpertCount(e.target.value)}
                        placeholder="e.g. 10"
                        min={1}
                        max={200}
                        className="w-full px-3 py-2.5 text-xs text-ink border border-frame bg-cream focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]"
                        style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                      />
                    </div>
                  </div>
                  <div>
                    <FieldLabel htmlFor="keyQuestions">Key Questions</FieldLabel>
                    <textarea
                      id="keyQuestions"
                      value={keyQuestions}
                      onChange={e => setKeyQuestions(e.target.value)}
                      placeholder="What do you most need to understand from these experts?"
                      rows={3}
                      className="w-full px-3 py-2.5 text-xs text-ink border border-frame bg-cream resize-none focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]"
                      style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                    />
                  </div>
                  <div>
                    <FieldLabel htmlFor="initialHypotheses">Initial Hypotheses</FieldLabel>
                    <textarea
                      id="initialHypotheses"
                      value={initialHypotheses}
                      onChange={e => setInitialHypotheses(e.target.value)}
                      placeholder="What do you currently believe to be true that expert calls should confirm or refute?"
                      rows={3}
                      className="w-full px-3 py-2.5 text-xs text-ink border border-frame bg-cream resize-none focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]"
                      style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                    />
                  </div>
                  <div>
                    <FieldLabel htmlFor="conflictExclusions">Exclusions &amp; Conflict Notes</FieldLabel>
                    <textarea
                      id="conflictExclusions"
                      value={conflictExclusions}
                      onChange={e => setConflictExclusions(e.target.value)}
                      placeholder="Competitors, prior relationships, or sectors to exclude from expert sourcing."
                      rows={2}
                      className="w-full px-3 py-2.5 text-xs text-ink border border-frame bg-cream resize-none focus:outline-none focus:border-navy transition-colors placeholder-[#9AABB8]"
                      style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                    />
                  </div>
                </div>
              )}
            </div>

            {briefError && (
              <p className="text-xs text-red-600 border border-red-200 bg-red-50 px-3 py-2">{briefError}</p>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-1">
              <button
                type="submit"
                disabled={!query.trim() || loading}
                className="flex items-center gap-2.5 px-7 py-3 text-xs font-medium uppercase transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  background:    loading ? '#5A6B7A' : '#0B1F3B',
                  color:         '#C6A75E',
                  letterSpacing: '0.14em',
                  minHeight:     '44px',
                }}
              >
                {loading ? (
                  <>
                    <svg className="w-3.5 h-3.5 animate-spin-slow" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Sourcing
                  </>
                ) : (
                  <>
                    Source Experts
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                  </>
                )}
              </button>

              <button
                type="button"
                onClick={handleCreateProjectBrief}
                disabled={!query.trim() || creatingBrief}
                className="flex items-center gap-2 text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-5 py-3 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                style={{ letterSpacing: '0.12em', minHeight: '44px' }}
              >
                {creatingBrief ? (
                  <>
                    <svg className="w-3 h-3 animate-spin-slow" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                      <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                    Creating…
                  </>
                ) : (
                  <>
                    <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                    </svg>
                    Create Project Brief
                  </>
                )}
              </button>

              {!loading && (
                <span className="text-[10px] text-muted/60 self-center" style={{ letterSpacing: '0.04em' }}>
                  ⌘ + Enter to source
                </span>
              )}
            </div>

          </form>
        </div>
      </div>

      {/* ── Analysis bar ── */}
      {result && !loading && <AnalysisBar analysis={result.query_analysis} />}

      {/* ── Results ── */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 sm:px-10 py-12">

        {error && (
          <div className="border border-red-200 bg-red-50 px-5 py-4 flex items-start gap-3 text-sm text-red-700 mb-8">
            <svg className="w-4 h-4 shrink-0 mt-0.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            {error}
          </div>
        )}

        {loading && <LoadingState />}

        {result && !loading && (
          <div className="space-y-14 animate-fade-in">
            <CategorySection
              category="Operator" experts={operators} query={query}
              shortlistedIds={shortlistedIds} rejectedIds={rejectedIds}
              onShortlist={handleShortlist} onReject={handleReject}
            />
            <CategorySection
              category="Advisor" experts={advisors} query={query}
              shortlistedIds={shortlistedIds} rejectedIds={rejectedIds}
              onShortlist={handleShortlist} onReject={handleReject}
            />
            <CategorySection
              category="Outsider" experts={outsiders} query={query}
              shortlistedIds={shortlistedIds} rejectedIds={rejectedIds}
              onShortlist={handleShortlist} onReject={handleReject}
            />

            <div className="rule-divider" />

            <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 pb-6">
              <p className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.18em' }}>
                {result.experts.length} sourced expert{result.experts.length !== 1 ? 's' : ''} · Sources drawn from public professional records
                {shortlistedIds.size > 0 && (
                  <span className="ml-3 text-amber-700">· {shortlistedIds.size} shortlisted</span>
                )}
              </p>
              <button
                onClick={() => setShowSaveModal(true)}
                className="shrink-0 bg-navy text-cream text-[10px] uppercase tracking-widest px-5 py-2.5 hover:bg-navy-light transition-colors flex items-center gap-2"
                style={{ letterSpacing: '0.12em', minHeight: '40px' }}
              >
                <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 19a2 2 0 01-2-2V7a2 2 0 012-2h4l2 2h4a2 2 0 012 2v1M5 19h14a2 2 0 002-2v-5a2 2 0 00-2-2H9a2 2 0 00-2 2v5a2 2 0 01-2 2z" />
                </svg>
                Save as Project
              </button>
            </div>
          </div>
        )}
      </main>

      {showSaveModal && result && (
        <ProjectSaveModal
          query={query}
          geography={geography}
          seniority={seniority}
          queryAnalysis={result.query_analysis}
          experts={expertsWithStatus()}
          onClose={() => setShowSaveModal(false)}
          briefFields={{
            industry:          industry,
            function:          functionField,
            timeline:          timeline,
            targetExpertCount: targetExpertCount,
            keyQuestions:      keyQuestions,
            initialHypotheses: initialHypotheses,
            conflictExclusions: conflictExclusions,
          }}
        />
      )}
    </div>
  );
}

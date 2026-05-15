'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import ExpertCard from '../../components/ExpertCard';
import ProjectSaveModal from '../../components/ProjectSaveModal';
import { Expert, ExpertResponse, ExpertStatus, QueryAnalysis, ProjectSummary } from '../../types';

const GEOGRAPHIES = ['Any Geography', 'United States', 'Europe', 'Asia Pacific', 'Latin America', 'Middle East & Africa', 'Global'];
const SENIORITIES = ['Any Seniority', 'Mid-Level', 'Senior', 'Executive / C-Suite'];

const WORKFLOW_STEPS = [
  { n: '01', label: 'Brief',    desc: 'Define the research question, scope, and key hypotheses.' },
  { n: '02', label: 'Source',   desc: 'AI surfaces evidence-backed candidates from public records.' },
  { n: '03', label: 'Review',   desc: 'Score, compare, and shortlist the strongest profiles.' },
  { n: '04', label: 'Screen',   desc: 'Vet candidates with custom questions and conflict checks.' },
  { n: '05', label: 'Outreach', desc: 'Draft and send personalised expert outreach.' },
  { n: '06', label: 'Deliver',  desc: 'Export a client-ready deliverable with sourcing evidence.' },
];

const WHAT_NEXT = [
  'Your research question is used to identify practitioners, advisors, and domain outsiders with direct, verifiable experience.',
  'Each candidate is matched with public evidence linking them to your specific topic, scored, and categorised.',
  'You shortlist, screen for conflicts, draft outreach, and track replies — all in one project workspace.',
  'When ready, export a client-ready brief with sourced evidence for every recommended expert.',
];

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

// ─── Shared label style ────────────────────────────────────────────────────────

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

export default function Home() {
  // Brief fields
  const [query,               setQuery]               = useState('');
  const [industry,            setIndustry]            = useState('');
  const [functionField,       setFunctionField]       = useState('');
  const [geography,           setGeography]           = useState('any');
  const [seniority,           setSeniority]           = useState('any');
  const [timeline,            setTimeline]            = useState('');
  const [targetExpertCount,   setTargetExpertCount]   = useState('');
  const [keyQuestions,        setKeyQuestions]        = useState('');
  const [initialHypotheses,   setInitialHypotheses]   = useState('');
  const [conflictExclusions,  setConflictExclusions]  = useState('');
  const [showAdvanced,        setShowAdvanced]        = useState(false);

  // Search state
  const [loading,         setLoading]         = useState(false);
  const [result,          setResult]          = useState<ExpertResponse | null>(null);
  const [error,           setError]           = useState('');
  const [shortlistedIds,  setShortlistedIds]  = useState<Set<string>>(new Set());
  const [rejectedIds,     setRejectedIds]     = useState<Set<string>>(new Set());
  const [showSaveModal,   setShowSaveModal]   = useState(false);

  // Create brief state
  const [creatingBrief, setCreatingBrief] = useState(false);
  const [briefError,    setBriefError]    = useState('');

  // Recent projects (non-critical — silently ignored on error)
  const [recentProjects, setRecentProjects] = useState<ProjectSummary[]>([]);

  useEffect(() => {
    fetch('/api/projects')
      .then(r => r.json())
      .then((d: { projects?: ProjectSummary[] }) => setRecentProjects((d.projects ?? []).slice(0, 3)))
      .catch(() => {});
  }, []);

  // ─── Handlers ───────────────────────────────────────────────────────────────

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
      if (industry.trim())      briefContext.industry  = industry.trim();
      if (functionField.trim()) briefContext.function  = functionField.trim();
      if (keyQuestions.trim())  briefContext.keyQuestions = keyQuestions.trim();
      if (initialHypotheses.trim()) briefContext.initialHypotheses = initialHypotheses.trim();
      if (conflictExclusions.trim()) briefContext.conflictExclusionNotes = conflictExclusions.trim();

      const res = await fetch('/api/generate-experts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
        id: ex.id || `exp-${i}`,
        source_links: ex.source_links || [],
      }));
      if (!industry.trim() && data.query_analysis?.industry) setIndustry(data.query_analysis.industry);
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
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
      if (timeline.trim())            extras.timeline            = timeline.trim();
      if (targetExpertCount.trim())   extras.targetExpertCount   = parseInt(targetExpertCount, 10);
      if (keyQuestions.trim())        extras.keyQuestions        = keyQuestions.trim();
      if (initialHypotheses.trim())   extras.initialHypotheses   = initialHypotheses.trim();
      if (conflictExclusions.trim())  extras.conflictExclusions  = conflictExclusions.trim();

      if (Object.keys(extras).length > 0) {
        await fetch(`/api/projects/${projectId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(extras),
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
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-gold shrink-0" fill="currentColor" viewBox="0 0 20 20">
              <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
            </svg>
            <span
              className="font-display text-cream font-semibold tracking-widest"
              style={{ letterSpacing: '0.15em', fontSize: '13px' }}
            >
              EXPERTMATCH
            </span>
          </div>
          <div className="flex items-center gap-5">
            <Link
              href="/projects"
              className="text-[10px] uppercase tracking-widest text-gold/60 hover:text-gold transition-colors hidden sm:block"
              style={{ letterSpacing: '0.18em' }}
            >
              Projects
            </Link>
          </div>
        </div>
      </header>

      {/* ── Brief / Search Hero ── */}
      <div className="border-b border-frame bg-surface">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-12 sm:py-16">

          {/* Two-column layout: form left, info panel right (hidden once results load) */}
          <div className={`grid gap-12 ${!result && !loading ? 'lg:grid-cols-[1fr_360px]' : 'grid-cols-1'}`}>

            {/* ── Left: Brief form ── */}
            <div>
              {/* Title */}
              <div className="mb-8">
                <h1
                  className="font-display text-navy leading-tight"
                  style={{ fontSize: 'clamp(2rem, 4.5vw, 3rem)', fontWeight: 500, letterSpacing: '-0.01em' }}
                >
                  Expert intelligence
                  <br />
                  <span style={{ fontStyle: 'italic', fontWeight: 300, color: '#5A6B7A' }}>for critical decisions.</span>
                </h1>
                <p className="mt-3 text-sm text-muted leading-relaxed max-w-xl" style={{ fontWeight: 300 }}>
                  Build a sourced expert brief, shortlist evidence-backed candidates, screen them, and export a client-ready deliverable.
                </p>
              </div>

              {/* Brief intake form */}
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

                {/* Additional context toggle */}
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

                      {/* Timeline + Target count */}
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

                      {/* Key questions */}
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

                      {/* Initial hypotheses */}
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

                      {/* Conflict exclusions */}
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

                {/* Brief error */}
                {briefError && (
                  <p className="text-xs text-red-600 border border-red-200 bg-red-50 px-3 py-2">{briefError}</p>
                )}

                {/* Actions */}
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  {/* Primary: Source Experts */}
                  <button
                    type="submit"
                    disabled={!query.trim() || loading}
                    className="flex items-center gap-2.5 px-7 py-3 text-xs font-medium uppercase transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-navy-light"
                    style={{
                      background: loading ? '#5A6B7A' : '#0B1F3B',
                      color: '#C6A75E',
                      letterSpacing: '0.14em',
                      minHeight: '44px',
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

                  {/* Secondary: Create Project Brief */}
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

            {/* ── Right: Workflow panel (only when no results) ── */}
            {!result && !loading && (
              <div className="hidden lg:block space-y-8 pt-1">

                {/* Workflow steps */}
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-4" style={{ letterSpacing: '0.2em' }}>
                    The Expert Sourcing Workflow
                  </p>
                  <div className="space-y-3">
                    {WORKFLOW_STEPS.map((step, i) => (
                      <div key={step.n} className="flex items-start gap-3.5">
                        <div className="shrink-0 flex flex-col items-center">
                          <div
                            className="w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-semibold"
                            style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.04em' }}
                          >
                            {step.n}
                          </div>
                          {i < WORKFLOW_STEPS.length - 1 && (
                            <div className="w-px flex-1 mt-1" style={{ background: '#DDE3EA', minHeight: '12px' }} />
                          )}
                        </div>
                        <div className="pb-2">
                          <p className="text-xs font-semibold text-navy" style={{ letterSpacing: '0.03em' }}>{step.label}</p>
                          <p className="text-[11px] text-muted mt-0.5 leading-relaxed">{step.desc}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* What happens next */}
                <div className="border-t border-frame pt-6">
                  <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-4" style={{ letterSpacing: '0.2em' }}>
                    What Happens Next
                  </p>
                  <ol className="space-y-3">
                    {WHAT_NEXT.map((text, i) => (
                      <li key={i} className="flex items-start gap-3">
                        <span
                          className="shrink-0 text-[10px] font-semibold mt-0.5"
                          style={{ color: '#C6A75E', letterSpacing: '0.04em', minWidth: '14px' }}
                        >
                          {i + 1}.
                        </span>
                        <p className="text-[11px] text-muted leading-relaxed">{text}</p>
                      </li>
                    ))}
                  </ol>
                </div>
              </div>
            )}
          </div>

          {/* ── Recent Projects (only when no results) ── */}
          {!result && !loading && recentProjects.length > 0 && (
            <div className="mt-10 pt-8 border-t border-frame max-w-2xl">
              <div className="flex items-center justify-between mb-4">
                <p className="text-[10px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.2em' }}>
                  Recent Projects
                </p>
                <Link
                  href="/projects"
                  className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
                  style={{ letterSpacing: '0.14em' }}
                >
                  All projects →
                </Link>
              </div>
              <div className="space-y-2">
                {recentProjects.map(p => (
                  <Link
                    key={p.id}
                    href={`/projects/${p.id}`}
                    className="flex items-start justify-between gap-6 bg-cream border border-frame hover:border-navy/40 px-4 py-3.5 transition-colors group"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-navy group-hover:underline underline-offset-2 leading-snug truncate">
                        {p.name}
                      </p>
                      <p className="text-[11px] text-muted mt-0.5 line-clamp-1 leading-relaxed" style={{ fontWeight: 300 }}>
                        {p.researchQuestion}
                      </p>
                    </div>
                    <div className="shrink-0 text-right space-y-0.5">
                      <p className="text-[10px] text-muted">{p.expertCount} expert{p.expertCount !== 1 ? 's' : ''}</p>
                      <p className="text-[10px] text-muted/60">{formatDate(p.updatedAt)}</p>
                    </div>
                  </Link>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* ── Analysis bar ── */}
      {result && !loading && <AnalysisBar analysis={result.query_analysis} />}

      {/* ── Results ── */}
      <main className="flex-1 max-w-6xl w-full mx-auto px-6 sm:px-10 py-12">

        {/* Error */}
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

            {/* Save as Project */}
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

        {/* Empty state — only shown when there are no results and form is blank */}
        {!loading && !result && !error && !query.trim() && (
          <div className="py-16 max-w-lg">
            <p className="font-display text-2xl text-navy font-light italic leading-snug">
              What do you need to understand?
            </p>
            <p className="mt-4 text-sm text-muted leading-relaxed" style={{ fontWeight: 300 }}>
              Describe your research question above. ExpertMatch identifies real practitioners,
              advisors, and domain outsiders — each with evidence-backed sourcing.
            </p>
            <div className="mt-6 rule-gold w-16" />
          </div>
        )}
      </main>

      {/* Save as Project modal */}
      {showSaveModal && result && (
        <ProjectSaveModal
          query={query}
          geography={geography}
          seniority={seniority}
          queryAnalysis={result.query_analysis}
          experts={expertsWithStatus()}
          onClose={() => setShowSaveModal(false)}
          briefFields={{
            industry:           industry,
            function:           functionField,
            timeline:           timeline,
            targetExpertCount:  targetExpertCount,
            keyQuestions:       keyQuestions,
            initialHypotheses:  initialHypotheses,
            conflictExclusions: conflictExclusions,
          }}
        />
      )}

    </div>
  );
}

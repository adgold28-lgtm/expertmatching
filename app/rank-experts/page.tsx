'use client';

import { useState, useId } from 'react';
import Link from 'next/link';
import {
  ProjectBrief,
  RankableExpert,
  RankedExpertResult,
  ScoringWeights,
  DEFAULT_WEIGHTS,
  WEIGHT_KEYS,
  WEIGHT_LABELS,
  ValueChainStage,
  SeniorityLevel,
  PerspectiveType,
} from '../../rankExpertsTypes';
import {
  VALUE_CHAIN_STAGES,
  SENIORITY_LEVELS,
  VALUE_CHAIN_PERSPECTIVE,
  SENIORITY_PERSPECTIVE,
  recomputeWithWeights,
} from '../../lib/rankExperts';

// ─── Seed data ────────────────────────────────────────────────────────────────

const SEED_EXPERTS: RankableExpert[] = [
  {
    id: 'seed-1',
    fullName: 'Maria Santos',
    currentTitle: 'VP of Supply Chain',
    currentCompany: 'Volta Battery Materials',
    previousTitle: 'Director of Procurement',
    previousCompany: 'BASF SE',
    geography: 'United States',
    linkedinOrSourceUrl: 'https://linkedin.com/in/maria-santos-supply-chain',
    sourceNotes: 'LinkedIn profile confirmed. Runs a team of 40 overseeing cathode precursor sourcing across North America and Korea.',
    yearsInIndustry: 14,
    yearsOutsideIndustry: 0,
    lastDirectIndustryRoleYear: null,
    valueChainStage: 'Raw Materials / Inputs',
    seniorityLevel: 'VP / GM / Head',
    perspectiveType: 'Operator',
    whyRelevant: 'Direct oversight of lithium and cathode active material sourcing. Led the company\'s shift from spot to long-term contracts in 2022. Deep knowledge of upstream supply constraints and contract structures.',
    conflictsOrConcerns: '',
    internalNotes: 'Referred by portfolio company CFO.',
  },
  {
    id: 'seed-2',
    fullName: 'James Whitfield',
    currentTitle: 'Senior Consultant',
    currentCompany: 'Whitfield Advisory LLC',
    previousTitle: 'Director of Inbound Logistics',
    previousCompany: 'General Motors',
    geography: 'United States',
    linkedinOrSourceUrl: 'https://linkedin.com/in/jwhitfield-logistics',
    sourceNotes: 'LinkedIn and personal website confirmed. Left GM in 2022 after 9 years. Now advises OEMs and tier-1 suppliers on supply chain transformation.',
    yearsInIndustry: 9,
    yearsOutsideIndustry: 3,
    lastDirectIndustryRoleYear: 2022,
    valueChainStage: 'Distribution / Logistics',
    seniorityLevel: 'Director',
    perspectiveType: 'Advisor',
    whyRelevant: 'Ran inbound logistics for GM\'s EV platforms. Led the battery module transport network redesign for Ultium. Now advising on logistics strategy for a battery-as-a-service startup.',
    conflictsOrConcerns: 'May have signed an NDA with GM. Verify scope before disclosing GM-specific questions.',
    internalNotes: '',
  },
  {
    id: 'seed-3',
    fullName: 'Dr. Priya Mehta',
    currentTitle: 'Senior Research Analyst, Energy Transition',
    currentCompany: 'Greenhill & Co.',
    previousTitle: 'Associate',
    previousCompany: 'Rocky Mountain Institute',
    geography: 'United States',
    linkedinOrSourceUrl: 'https://linkedin.com/in/drpriyamehta-energy',
    sourceNotes: 'LinkedIn confirmed. Published three reports on EV battery supply chain risk in 2023–2024. PhD in Materials Science from MIT.',
    yearsInIndustry: 7,
    yearsOutsideIndustry: 0,
    lastDirectIndustryRoleYear: null,
    valueChainStage: 'Investor / Advisor',
    seniorityLevel: 'Individual Contributor / Specialist',
    perspectiveType: 'Investor',
    whyRelevant: 'Covers battery supply chain for institutional investors. Deep technical background in cathode and anode materials. Broad view of market structure, investment flows, and supplier consolidation trends.',
    conflictsOrConcerns: '',
    internalNotes: 'Non-operational — useful for market structure and benchmarking, not for process-level questions.',
  },
];

const EMPTY_BRIEF: ProjectBrief = {
  researchQuestion: '',
  projectObjective: '',
  mustHaveKnowledge: '',
  preferredGeography: '',
  preferredSeniority: '',
  targetValueChainStages: [],
  additionalNotes: '',
};

const EMPTY_EXPERT = (): RankableExpert => ({
  id: `exp-${Date.now()}`,
  fullName: '',
  currentTitle: '',
  currentCompany: '',
  previousTitle: '',
  previousCompany: '',
  geography: '',
  linkedinOrSourceUrl: '',
  sourceNotes: '',
  yearsInIndustry: null,
  yearsOutsideIndustry: null,
  lastDirectIndustryRoleYear: null,
  valueChainStage: '',
  seniorityLevel: '',
  perspectiveType: '',
  whyRelevant: '',
  conflictsOrConcerns: '',
  internalNotes: '',
});

const PERSPECTIVE_TYPES: PerspectiveType[] = [
  'Operator', 'Advisor', 'Academic', 'Customer', 'Regulator', 'Investor',
];

const CONFIDENCE_COLORS = {
  High: 'text-status-success border-status-success',
  Medium: 'text-status-warning border-status-warning',
  Low: 'text-status-danger border-status-danger',
};

// ─── Score bar ────────────────────────────────────────────────────────────────

function ScoreBar({ score, max, label }: { score: number; max: number; label: string }) {
  const pct = Math.round((score / max) * 100);
  return (
    <div className="flex items-center gap-3">
      <span className="text-[10px] uppercase tracking-widest text-muted w-44 shrink-0">{label}</span>
      <div className="flex-1 h-1 bg-cream-dark">
        <div className="h-full bg-navy transition-all" style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-medium text-ink w-10 text-right shrink-0">
        {score}/{max}
      </span>
    </div>
  );
}

// ─── Expert Form (modal) ──────────────────────────────────────────────────────

function ExpertFormModal({
  initial,
  onSave,
  onCancel,
}: {
  initial: RankableExpert;
  onSave: (e: RankableExpert) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<RankableExpert>(initial);

  function set<K extends keyof RankableExpert>(key: K, val: RankableExpert[K]) {
    setForm((f) => ({ ...f, [key]: val }));
  }

  function setNum(key: 'yearsInIndustry' | 'yearsOutsideIndustry' | 'lastDirectIndustryRoleYear', raw: string) {
    const v = raw === '' ? null : parseInt(raw, 10);
    setForm((f) => ({ ...f, [key]: isNaN(v as number) ? null : v }));
  }

  const labelCls = 'block text-[10px] uppercase tracking-widest text-muted font-medium mb-1';
  const inputCls =
    'w-full px-3 py-2 text-sm text-ink border border-frame bg-cream focus:outline-none focus:border-navy focus:ring-1 focus:ring-gold/30 transition-colors';
  const selectCls = `select-field ${inputCls} pr-8`;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-navy/55 animate-fade-in"
      onClick={(e) => e.target === e.currentTarget && onCancel()}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="expert-form-title"
        className="bg-surface w-full max-w-2xl max-h-[90vh] flex flex-col focus:outline-none"
        style={{ border: '1px solid #DDE2E8', borderTop: '3px solid #C6A75E' }}
        tabIndex={-1}
      >
        <div className="flex items-center justify-between px-7 py-5 border-b border-frame">
          <h2 id="expert-form-title" className="font-display text-xl font-semibold text-navy">
            {initial.fullName ? 'Edit Expert' : 'Add Expert'}
          </h2>
          <button
            onClick={onCancel}
            aria-label="Close dialog"
            className="text-muted hover:text-navy transition-colors"
            style={{ minWidth: 44, minHeight: 44, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-7 py-6 space-y-6">
          {/* Identity */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Identity</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className={labelCls}>Full Name *</label>
                <input className={inputCls} value={form.fullName} onChange={(e) => set('fullName', e.target.value)} placeholder="Jane Smith" />
              </div>
              <div>
                <label className={labelCls}>Geography</label>
                <input className={inputCls} value={form.geography} onChange={(e) => set('geography', e.target.value)} placeholder="e.g. United States" />
              </div>
              <div>
                <label className={labelCls}>Current Title</label>
                <input className={inputCls} value={form.currentTitle} onChange={(e) => set('currentTitle', e.target.value)} placeholder="VP of Operations" />
              </div>
              <div>
                <label className={labelCls}>Current Company</label>
                <input className={inputCls} value={form.currentCompany} onChange={(e) => set('currentCompany', e.target.value)} placeholder="Acme Corp" />
              </div>
              <div>
                <label className={labelCls}>Previous Title</label>
                <input className={inputCls} value={form.previousTitle} onChange={(e) => set('previousTitle', e.target.value)} placeholder="Director of Supply Chain" />
              </div>
              <div>
                <label className={labelCls}>Previous Company</label>
                <input className={inputCls} value={form.previousCompany} onChange={(e) => set('previousCompany', e.target.value)} placeholder="Prev Corp" />
              </div>
            </div>
          </div>

          {/* Classification */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Classification</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className={labelCls}>Value Chain Stage</label>
                <select className={selectCls} value={form.valueChainStage} onChange={(e) => set('valueChainStage', e.target.value as ValueChainStage)}>
                  <option value="">— Select —</option>
                  {VALUE_CHAIN_STAGES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Seniority Level</label>
                <select className={selectCls} value={form.seniorityLevel} onChange={(e) => set('seniorityLevel', e.target.value as SeniorityLevel)}>
                  <option value="">— Select —</option>
                  {SENIORITY_LEVELS.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className={labelCls}>Perspective Type</label>
                <select className={selectCls} value={form.perspectiveType} onChange={(e) => set('perspectiveType', e.target.value as PerspectiveType)}>
                  <option value="">— Select —</option>
                  {PERSPECTIVE_TYPES.map((p) => <option key={p} value={p}>{p}</option>)}
                </select>
              </div>
            </div>
          </div>

          {/* Experience timing */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Experience & Recency</p>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className={labelCls}>Years in Industry</label>
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  value={form.yearsInIndustry ?? ''}
                  onChange={(e) => setNum('yearsInIndustry', e.target.value)}
                  placeholder="e.g. 12"
                />
              </div>
              <div>
                <label className={labelCls}>Years Outside Industry</label>
                <input
                  className={inputCls}
                  type="number"
                  min={0}
                  value={form.yearsOutsideIndustry ?? ''}
                  onChange={(e) => setNum('yearsOutsideIndustry', e.target.value)}
                  placeholder="0 if currently active"
                />
              </div>
              <div>
                <label className={labelCls}>Last Direct Role Year</label>
                <input
                  className={inputCls}
                  type="number"
                  min={2000}
                  max={new Date().getFullYear()}
                  value={form.lastDirectIndustryRoleYear ?? ''}
                  onChange={(e) => setNum('lastDirectIndustryRoleYear', e.target.value)}
                  placeholder="e.g. 2022"
                />
              </div>
            </div>
          </div>

          {/* Relevance & sources */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Relevance & Sources</p>
            <div className="space-y-4">
              <div>
                <label className={labelCls}>Why Relevant</label>
                <textarea
                  className={inputCls}
                  rows={3}
                  value={form.whyRelevant}
                  onChange={(e) => set('whyRelevant', e.target.value)}
                  placeholder="Describe exactly how this person's experience maps to the research question..."
                />
              </div>
              <div>
                <label className={labelCls}>LinkedIn / Source URL</label>
                <input className={inputCls} value={form.linkedinOrSourceUrl} onChange={(e) => set('linkedinOrSourceUrl', e.target.value)} placeholder="https://linkedin.com/in/..." />
              </div>
              <div>
                <label className={labelCls}>Source Notes</label>
                <textarea
                  className={inputCls}
                  rows={2}
                  value={form.sourceNotes}
                  onChange={(e) => set('sourceNotes', e.target.value)}
                  placeholder="What did you find? Where did you find it?"
                />
              </div>
              <div>
                <label className={labelCls}>Conflicts / Concerns</label>
                <input className={inputCls} value={form.conflictsOrConcerns} onChange={(e) => set('conflictsOrConcerns', e.target.value)} placeholder="NDAs, competitive employment, etc." />
              </div>
              <div>
                <label className={labelCls}>Internal Notes</label>
                <input className={inputCls} value={form.internalNotes} onChange={(e) => set('internalNotes', e.target.value)} placeholder="Private notes — not sent to AI" />
              </div>
            </div>
          </div>
        </div>

        <div className="px-7 py-5 border-t border-frame flex gap-3">
          <button
            onClick={() => {
              if (!form.fullName.trim()) return;
              onSave(form);
            }}
            disabled={!form.fullName.trim()}
            className="flex-1 bg-navy hover:bg-navy-light text-cream text-xs font-medium uppercase tracking-widest py-3 transition-colors disabled:opacity-40"
            style={{ letterSpacing: '0.12em', minHeight: 44 }}
          >
            Save Expert
          </button>
          <button
            onClick={onCancel}
            className="px-6 py-3 text-xs font-medium text-muted hover:text-navy uppercase tracking-widest border border-frame hover:border-navy transition-colors"
            style={{ letterSpacing: '0.12em', minHeight: 44 }}
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Ranked Result Card ───────────────────────────────────────────────────────

function RankedResultRow({
  result,
  rank,
  expanded,
  onToggle,
}: {
  result: RankedExpertResult;
  rank: number;
  expanded: boolean;
  onToggle: () => void;
}) {
  const score = result.finalScore;
  const scoreColor = score >= 75 ? 'text-status-success' : score >= 55 ? 'text-status-warning' : 'text-muted';
  const e = result.expert;

  const vcPerspective = e.valueChainStage
    ? VALUE_CHAIN_PERSPECTIVE[e.valueChainStage as ValueChainStage]
    : null;
  const senPerspective = e.seniorityLevel
    ? SENIORITY_PERSPECTIVE[e.seniorityLevel as SeniorityLevel]
    : null;

  return (
    <div className="border-b border-frame last:border-b-0">
      {/* Summary row */}
      <button
        onClick={onToggle}
        className="w-full text-left px-6 py-5 hover:bg-cream transition-colors flex items-start gap-5 group"
        aria-expanded={expanded}
      >
        {/* Rank */}
        <div className="shrink-0 w-8 text-right">
          <span className="font-display text-2xl font-light text-muted leading-none">{rank}</span>
        </div>

        {/* Identity */}
        <div className="flex-1 min-w-0">
          <div className="flex items-start gap-3 flex-wrap">
            <h3 className="font-display text-lg font-semibold text-navy leading-tight">{e.fullName}</h3>
            {e.valueChainStage && (
              <span className="text-[10px] uppercase tracking-widest border border-frame text-muted px-2 py-0.5 shrink-0 mt-0.5">
                {e.valueChainStage}
              </span>
            )}
            {e.seniorityLevel && (
              <span className="text-[10px] uppercase tracking-widest border border-frame text-muted px-2 py-0.5 shrink-0 mt-0.5">
                {e.seniorityLevel}
              </span>
            )}
          </div>
          <p className="text-sm text-muted mt-0.5 leading-snug">
            {e.currentTitle}{e.currentCompany ? ` · ${e.currentCompany}` : ''}
          </p>
          <p className="text-xs text-muted mt-2 leading-relaxed max-w-2xl opacity-80 line-clamp-2" style={{ fontWeight: 300 }}>
            {result.rationale}
          </p>
        </div>

        {/* Scores */}
        <div className="shrink-0 text-right">
          <div className={`font-display text-3xl font-semibold leading-none ${scoreColor}`}>{score}</div>
          <div className="text-[10px] text-muted mt-0.5">
            {result.rawScore} raw
            {result.industryDistanceAdjustment !== 0 && (
              <span className="text-status-danger"> {result.industryDistanceAdjustment}</span>
            )}
          </div>
          <div className={`text-[10px] uppercase tracking-widest border px-1.5 py-0.5 mt-1.5 inline-block ${CONFIDENCE_COLORS[result.confidence]}`}>
            {result.confidence}
          </div>
        </div>

        {/* Chevron */}
        <div className="shrink-0 mt-1">
          <svg
            className={`w-4 h-4 text-muted transition-transform duration-200 ${expanded ? 'rotate-180' : ''}`}
            fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </div>
      </button>

      {/* Expanded detail */}
      {expanded && (
        <div className="px-6 pb-8 pt-2 bg-cream animate-fade-in space-y-8">
          {/* Score breakdown */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-4" style={{ letterSpacing: '0.18em' }}>Score Breakdown</p>
            <div className="space-y-2.5 max-w-xl">
              <ScoreBar score={result.scoreBreakdown.topicRelevance.score} max={30} label="Topic Relevance" />
              <ScoreBar score={result.scoreBreakdown.operationalExposure.score} max={20} label="Operational Exposure" />
              <ScoreBar score={result.scoreBreakdown.valueChainFit.score} max={15} label="Value Chain Fit" />
              <ScoreBar score={result.scoreBreakdown.seniorityFit.score} max={10} label="Seniority Fit" />
              <ScoreBar score={result.scoreBreakdown.recencyOfExperience.score} max={10} label="Recency of Experience" />
              <ScoreBar score={result.scoreBreakdown.geographyFit.score} max={5} label="Geography Fit" />
              <ScoreBar score={result.scoreBreakdown.sourceVerifiability.score} max={5} label="Source Verifiability" />
              <ScoreBar score={result.scoreBreakdown.coverageOfKeyQuestions.score} max={5} label="Coverage of Key Qs" />
            </div>
            <div className="mt-4 flex items-center gap-6 text-xs text-muted">
              <span>Raw score: <strong className="text-ink">{result.rawScore}</strong></span>
              <span>
                Industry distance adj:{' '}
                <strong className={result.industryDistanceAdjustment < 0 ? 'text-status-danger' : 'text-ink'}>
                  {result.industryDistanceAdjustment}
                </strong>
              </span>
              <span>Final: <strong className="text-ink">{result.finalScore}</strong></span>
            </div>
            <p className="mt-1 text-xs text-muted italic" style={{ fontWeight: 300 }}>
              {result.industryDistanceReason}
            </p>
          </div>

          {/* Score reasons */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Score Rationale</p>
            <div className="space-y-1.5">
              {(
                [
                  ['Topic Relevance', result.scoreBreakdown.topicRelevance.reason],
                  ['Operational Exposure', result.scoreBreakdown.operationalExposure.reason],
                  ['Value Chain Fit', result.scoreBreakdown.valueChainFit.reason],
                  ['Seniority Fit', result.scoreBreakdown.seniorityFit.reason],
                  ['Recency', result.scoreBreakdown.recencyOfExperience.reason],
                  ['Geography', result.scoreBreakdown.geographyFit.reason],
                  ['Verifiability', result.scoreBreakdown.sourceVerifiability.reason],
                  ['Key Question Coverage', result.scoreBreakdown.coverageOfKeyQuestions.reason],
                ] as [string, string][]
              ).map(([label, reason]) => (
                <div key={label} className="flex gap-2 text-xs">
                  <span className="text-muted shrink-0 w-40">{label}:</span>
                  <span className="text-ink" style={{ fontWeight: 300 }}>{reason}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Perspective note */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Perspective Analysis</p>
            <div className="space-y-3">
              {vcPerspective && (
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted mb-1">Value Chain Position</p>
                  <p className="text-xs text-ink leading-relaxed" style={{ fontWeight: 300 }}>
                    {result.perspectiveNote.valueChainEffect || vcPerspective}
                  </p>
                </div>
              )}
              {senPerspective && (
                <div>
                  <p className="text-[10px] uppercase tracking-widest text-muted mb-1">Seniority Lens</p>
                  <p className="text-xs text-ink leading-relaxed" style={{ fontWeight: 300 }}>
                    {result.perspectiveNote.seniorityEffect || senPerspective}
                  </p>
                </div>
              )}
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted mb-1">Industry Distance</p>
                <p className="text-xs text-ink leading-relaxed" style={{ fontWeight: 300 }}>
                  {result.perspectiveNote.timeOutsideEffect}
                </p>
              </div>
            </div>
          </div>

          {/* Strengths / Gaps / Missing */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-2" style={{ letterSpacing: '0.18em' }}>Strengths</p>
              <ul className="space-y-1">
                {result.strengths.map((s, i) => (
                  <li key={i} className="text-xs text-ink flex gap-2 leading-snug" style={{ fontWeight: 300 }}>
                    <span className="text-status-success shrink-0 mt-0.5">+</span> {s}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-2" style={{ letterSpacing: '0.18em' }}>Gaps</p>
              <ul className="space-y-1">
                {result.gaps.map((g, i) => (
                  <li key={i} className="text-xs text-ink flex gap-2 leading-snug" style={{ fontWeight: 300 }}>
                    <span className="text-status-danger shrink-0 mt-0.5">−</span> {g}
                  </li>
                ))}
              </ul>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-2" style={{ letterSpacing: '0.18em' }}>Missing Data</p>
              <ul className="space-y-1">
                {result.missingData.map((m, i) => (
                  <li key={i} className="text-xs text-ink flex gap-2 leading-snug" style={{ fontWeight: 300 }}>
                    <span className="text-muted shrink-0 mt-0.5">?</span> {m}
                  </li>
                ))}
              </ul>
            </div>
          </div>

          {/* Vetting questions */}
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Vetting Questions</p>
            <ol className="space-y-2">
              {result.vettingQuestions.map((q, i) => (
                <li key={i} className="text-sm text-ink leading-relaxed flex gap-3" style={{ fontWeight: 300 }}>
                  <span className="font-display text-base text-muted shrink-0">{i + 1}.</span>
                  {q}
                </li>
              ))}
            </ol>
          </div>

          {/* Source */}
          {e.linkedinOrSourceUrl && (
            <div>
              <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-2" style={{ letterSpacing: '0.18em' }}>Source</p>
              <a
                href={e.linkedinOrSourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="source-link text-xs flex items-center gap-2"
              >
                <svg className="w-3 h-3 shrink-0" viewBox="0 0 12 12" fill="none">
                  <path d="M1 11L11 1M11 1H4M11 1V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                {e.linkedinOrSourceUrl}
              </a>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function RankExpertsPage() {
  const [brief, setBrief] = useState<ProjectBrief>({ ...EMPTY_BRIEF });
  const [experts, setExperts] = useState<RankableExpert[]>(SEED_EXPERTS);
  const [weights, setWeights] = useState<ScoringWeights>(DEFAULT_WEIGHTS);
  const [results, setResults] = useState<RankedExpertResult[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editingExpert, setEditingExpert] = useState<RankableExpert | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [briefOpen, setBriefOpen] = useState(true);
  const [weightsOpen, setWeightsOpen] = useState(false);

  function setBriefField<K extends keyof ProjectBrief>(key: K, val: ProjectBrief[K]) {
    setBrief((b) => ({ ...b, [key]: val }));
  }

  function toggleValueChainTarget(stage: ValueChainStage) {
    setBrief((b) => ({
      ...b,
      targetValueChainStages: b.targetValueChainStages.includes(stage)
        ? b.targetValueChainStages.filter((s) => s !== stage)
        : [...b.targetValueChainStages, stage],
    }));
  }

  function saveExpert(e: RankableExpert) {
    setExperts((prev) => {
      const idx = prev.findIndex((x) => x.id === e.id);
      return idx >= 0 ? prev.map((x) => (x.id === e.id ? e : x)) : [...prev, e];
    });
    setShowForm(false);
    setEditingExpert(null);
  }

  function removeExpert(id: string) {
    setExperts((prev) => prev.filter((e) => e.id !== id));
  }

  function updateWeight(key: keyof ScoringWeights, val: number) {
    const updated = { ...weights, [key]: val };
    setWeights(updated);
    // Re-rank existing results immediately with new weights
    if (results) setResults(recomputeWithWeights(results, updated));
  }

  async function handleRank() {
    if (!brief.researchQuestion.trim() || experts.length === 0 || loading) return;
    setLoading(true);
    setError('');
    setResults(null);
    setExpandedId(null);

    try {
      const res = await fetch('/api/rank-experts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ brief, experts, weights }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResults(data.results);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const canRank = brief.researchQuestion.trim().length > 0 && experts.length > 0 && !loading;

  const labelCls = 'block text-xs uppercase tracking-widest text-muted font-medium mb-1.5';
  const inputCls =
    'w-full px-3 py-2.5 text-sm text-ink border border-frame bg-cream focus:outline-none focus:border-navy focus:ring-1 focus:ring-gold/30 transition-colors';
  const selectCls = `select-field ${inputCls} pr-8`;

  return (
    <div className="min-h-screen flex flex-col bg-cream">

      {/* ── Header ── */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link
              href="/"
              className="flex items-center gap-2.5 text-cream hover:text-gold/80 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              <span className="font-display font-semibold" style={{ letterSpacing: '0.15em', fontSize: '13px' }}>
                EXPERTMATCH
              </span>
            </Link>
            <span className="w-px h-4 bg-navy-muted hidden sm:block" />
            <span className="text-[10px] uppercase tracking-widest text-gold/70 hidden sm:block" style={{ letterSpacing: '0.2em' }}>
              Expert Ranking
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link
              href="/"
              className="text-[10px] uppercase tracking-widest text-gold/60 hover:text-gold transition-colors hidden sm:block"
              style={{ letterSpacing: '0.16em' }}
            >
              ← Search Experts
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-6xl w-full mx-auto px-6 sm:px-10 py-10 space-y-10">

        {/* ── Page intro ── */}
        <div className="max-w-2xl">
          <h1 className="font-display text-navy leading-tight" style={{ fontSize: 'clamp(1.9rem, 4vw, 3rem)', fontWeight: 500 }}>
            Expert Ranking
          </h1>
          <p className="mt-3 text-sm text-muted leading-relaxed" style={{ fontWeight: 300 }}>
            Score and rank experts you have already identified. Enter your brief, add your expert roster, then run the ranking engine — deterministic scoring combined with AI-generated rationale and vetting questions.
          </p>
          <div className="mt-5 rule-gold w-16" />
        </div>

        {/* ── Section 1: Project Brief ── */}
        <section>
          <button
            onClick={() => setBriefOpen((o) => !o)}
            className="w-full flex items-center gap-4 text-left group"
          >
            <h2 className="text-[11px] font-semibold uppercase text-navy shrink-0" style={{ letterSpacing: '0.18em' }}>
              01 · Project Brief
            </h2>
            <div className="flex-1 rule-divider" />
            <svg
              className={`w-4 h-4 text-muted transition-transform duration-200 shrink-0 ${briefOpen ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {briefOpen && (
            <div className="mt-5 space-y-4 max-w-3xl animate-fade-in">
              <div>
                <label htmlFor="rq" className={labelCls}>Research Question *</label>
                <textarea
                  id="rq"
                  rows={3}
                  className={`input-search ${inputCls} resize-none`}
                  value={brief.researchQuestion}
                  onChange={(e) => setBriefField('researchQuestion', e.target.value)}
                  placeholder="What specific question are you trying to answer? e.g. What are the key bottlenecks in EV battery supply chain logistics today?"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="po" className={labelCls}>Project Objective</label>
                  <textarea
                    id="po"
                    rows={2}
                    className={inputCls}
                    value={brief.projectObjective}
                    onChange={(e) => setBriefField('projectObjective', e.target.value)}
                    placeholder="What decision or output is this research informing?"
                  />
                </div>
                <div>
                  <label htmlFor="mhk" className={labelCls}>Must-Have Knowledge</label>
                  <textarea
                    id="mhk"
                    rows={2}
                    className={inputCls}
                    value={brief.mustHaveKnowledge}
                    onChange={(e) => setBriefField('mustHaveKnowledge', e.target.value)}
                    placeholder="Specific technical or operational knowledge the expert must have"
                  />
                </div>
                <div>
                  <label htmlFor="pg" className={labelCls}>Preferred Geography</label>
                  <input
                    id="pg"
                    className={inputCls}
                    value={brief.preferredGeography}
                    onChange={(e) => setBriefField('preferredGeography', e.target.value)}
                    placeholder="e.g. United States, or Global"
                  />
                </div>
                <div>
                  <label htmlFor="ps" className={labelCls}>Preferred Seniority</label>
                  <select
                    id="ps"
                    className={selectCls}
                    value={brief.preferredSeniority}
                    onChange={(e) => setBriefField('preferredSeniority', e.target.value as SeniorityLevel | '')}
                  >
                    <option value="">Any Seniority</option>
                    {SENIORITY_LEVELS.map((s) => <option key={s} value={s}>{s}</option>)}
                  </select>
                </div>
              </div>

              {/* Value chain target */}
              <div>
                <p className={labelCls}>Target Value Chain Stages</p>
                <div className="flex flex-wrap gap-2 mt-1">
                  {VALUE_CHAIN_STAGES.map((stage) => {
                    const active = brief.targetValueChainStages.includes(stage);
                    return (
                      <button
                        key={stage}
                        type="button"
                        onClick={() => toggleValueChainTarget(stage)}
                        className={`text-[10px] uppercase tracking-widest px-3 py-2 border transition-colors ${
                          active
                            ? 'bg-navy text-cream border-navy'
                            : 'text-muted border-frame hover:border-navy hover:text-navy'
                        }`}
                        style={{ letterSpacing: '0.1em' }}
                      >
                        {stage}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label htmlFor="an" className={labelCls}>Additional Notes</label>
                <textarea
                  id="an"
                  rows={2}
                  className={inputCls}
                  value={brief.additionalNotes}
                  onChange={(e) => setBriefField('additionalNotes', e.target.value)}
                  placeholder="Any other context that should inform the ranking"
                />
              </div>
            </div>
          )}
        </section>

        {/* ── Section 2: Expert Roster ── */}
        <section>
          <div className="flex items-center gap-4">
            <h2 className="text-[11px] font-semibold uppercase text-navy shrink-0" style={{ letterSpacing: '0.18em' }}>
              02 · Expert Roster
            </h2>
            <div className="flex-1 rule-divider" />
            <span className="text-[11px] text-muted shrink-0">{experts.length} entered</span>
          </div>

          <div className="mt-5 space-y-2">
            {/* Expert list */}
            {experts.map((e) => (
              <div key={e.id} className="flex items-center gap-4 px-4 py-3 border border-frame bg-surface hover:bg-cream transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-3 flex-wrap">
                    <span className="text-sm font-medium text-ink">{e.fullName || '(unnamed)'}</span>
                    {e.valueChainStage && (
                      <span className="text-[10px] uppercase tracking-widest border border-frame text-muted px-1.5 py-0.5">
                        {e.valueChainStage}
                      </span>
                    )}
                    {e.seniorityLevel && (
                      <span className="text-[10px] uppercase tracking-widest border border-frame text-muted px-1.5 py-0.5">
                        {e.seniorityLevel}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted mt-0.5">
                    {[e.currentTitle, e.currentCompany].filter(Boolean).join(' · ')}
                  </p>
                </div>
                <div className="flex gap-2 shrink-0">
                  <button
                    onClick={() => { setEditingExpert(e); setShowForm(true); }}
                    className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-3 py-1.5 transition-colors"
                    style={{ minHeight: 36 }}
                  >
                    Edit
                  </button>
                  <button
                    onClick={() => removeExpert(e.id)}
                    className="text-[10px] uppercase tracking-widest text-muted hover:text-status-danger border border-frame hover:border-status-danger px-3 py-1.5 transition-colors"
                    style={{ minHeight: 36 }}
                  >
                    Remove
                  </button>
                </div>
              </div>
            ))}

            {/* Add button */}
            <button
              onClick={() => { setEditingExpert(EMPTY_EXPERT()); setShowForm(true); }}
              className="w-full py-3 border border-dashed border-frame text-muted hover:text-navy hover:border-navy text-xs uppercase tracking-widest transition-colors"
              style={{ letterSpacing: '0.14em', minHeight: 44 }}
            >
              + Add Expert
            </button>
          </div>
        </section>

        {/* ── Section 3: Weight Controls ── */}
        <section>
          <button
            onClick={() => setWeightsOpen((o) => !o)}
            className="w-full flex items-center gap-4 text-left"
          >
            <h2 className="text-[11px] font-semibold uppercase text-navy shrink-0" style={{ letterSpacing: '0.18em' }}>
              03 · Adjust Weights
            </h2>
            <div className="flex-1 rule-divider" />
            <span className="text-[10px] text-muted shrink-0 mr-2">
              {Object.values(weights).reduce((a, b) => a + b, 0)} pts total
            </span>
            <svg
              className={`w-4 h-4 text-muted transition-transform duration-200 shrink-0 ${weightsOpen ? 'rotate-180' : ''}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {weightsOpen && (
            <div className="mt-5 max-w-xl space-y-4 animate-fade-in">
              <p className="text-xs text-muted leading-relaxed" style={{ fontWeight: 300 }}>
                Adjust relative weights. The system normalizes these automatically — they don't need to sum to 100.
                If results are already loaded, they re-rank instantly.
              </p>
              {WEIGHT_KEYS.map((key) => (
                <div key={key} className="flex items-center gap-4">
                  <label className="text-[10px] uppercase tracking-widest text-muted w-44 shrink-0">
                    {WEIGHT_LABELS[key]}
                  </label>
                  <input
                    type="range"
                    min={0}
                    max={50}
                    value={weights[key]}
                    onChange={(e) => updateWeight(key, parseInt(e.target.value, 10))}
                    className="flex-1 accent-navy"
                  />
                  <span className="text-xs font-medium text-ink w-6 text-right shrink-0">{weights[key]}</span>
                </div>
              ))}
              <button
                onClick={() => {
                  setWeights(DEFAULT_WEIGHTS);
                  if (results) setResults(recomputeWithWeights(results, DEFAULT_WEIGHTS));
                }}
                className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-4 py-2 transition-colors"
                style={{ letterSpacing: '0.14em' }}
              >
                Reset to Defaults
              </button>
            </div>
          )}
        </section>

        {/* ── Rank Button ── */}
        <div>
          <button
            onClick={handleRank}
            disabled={!canRank}
            className="flex items-center gap-3 px-8 py-3.5 bg-navy hover:bg-navy-light text-cream text-xs font-medium uppercase transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ letterSpacing: '0.14em', minHeight: 48, color: '#C6A75E' }}
          >
            {loading ? (
              <>
                <svg className="w-4 h-4 animate-spin-slow" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Ranking — this may take 20–40 seconds
              </>
            ) : (
              <>
                Rank {experts.length} Expert{experts.length !== 1 ? 's' : ''}
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                </svg>
              </>
            )}
          </button>
          {!brief.researchQuestion.trim() && (
            <p className="mt-2 text-xs text-muted">Add a research question to the project brief to enable ranking.</p>
          )}
          {experts.length === 0 && (
            <p className="mt-2 text-xs text-muted">Add at least one expert to rank.</p>
          )}
        </div>

        {/* ── Error ── */}
        {error && (
          <div className="border border-red-200 bg-red-50 px-5 py-4 flex items-start gap-3 text-sm text-red-700 max-w-2xl">
            <svg className="w-4 h-4 shrink-0 mt-0.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
            </svg>
            {error}
          </div>
        )}

        {/* ── Results ── */}
        {results && (
          <section className="animate-fade-in">
            <div className="flex items-center gap-4 mb-6">
              <h2 className="text-[11px] font-semibold uppercase text-navy shrink-0" style={{ letterSpacing: '0.18em' }}>
                Ranked Results
              </h2>
              <div className="flex-1 rule-divider" />
              <span className="text-[11px] text-muted shrink-0">{results.length} experts scored</span>
            </div>

            {/* Results list — editorial ranked list, not card grid */}
            <div className="border border-frame bg-surface">
              {results.map((result, i) => (
                <RankedResultRow
                  key={result.expert.id}
                  result={result}
                  rank={i + 1}
                  expanded={expandedId === result.expert.id}
                  onToggle={() => setExpandedId((id) => (id === result.expert.id ? null : result.expert.id))}
                />
              ))}
            </div>

            <p className="mt-4 text-[10px] uppercase tracking-widest text-muted text-center" style={{ letterSpacing: '0.18em' }}>
              Deterministic scoring by category · AI rationale by Claude Opus · Click any row to expand
            </p>
          </section>
        )}

      </div>

      {/* ── Expert form modal ── */}
      {showForm && editingExpert && (
        <ExpertFormModal
          initial={editingExpert}
          onSave={saveExpert}
          onCancel={() => { setShowForm(false); setEditingExpert(null); }}
        />
      )}
    </div>
  );
}

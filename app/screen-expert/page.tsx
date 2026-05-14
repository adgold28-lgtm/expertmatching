'use client';

import { useState } from 'react';
import Link from 'next/link';

interface ScoreBreakdown {
  directRelevance: number;
  valueChainClarity: number;
  callUsefulness: number;
  recency: number;
  distinctiveness: number;
  complianceClean: number;
}

interface ScreeningResult {
  evaluation: {
    primaryFit: {
      valueChainPosition: string;
      archetype: string;
      scope: 'broad' | 'surgical';
      scopeExplanation: string;
    };
    viabilityScore: {
      score: number;
      recommendation: 'Strong yes' | 'Yes' | 'Backup only' | 'No';
      scoreBreakdown: ScoreBreakdown;
    };
    whyFits: string[];
    questionsCanAnswer: string[];
    risksLimitations: string[];
    bottomLine: string;
  };
  candidate: { name: string; role: string; company: string };
}

const RECOMMENDATION_STYLES = {
  'Strong yes': { badge: 'bg-status-success text-white', label: 'Strong yes' },
  'Yes':        { badge: 'bg-gold text-navy',            label: 'Yes' },
  'Backup only':{ badge: 'bg-status-warning text-white', label: 'Backup only' },
  'No':         { badge: 'bg-status-danger text-white',  label: 'No' },
} as const;

const SCORE_DIMENSIONS: { key: keyof ScoreBreakdown; label: string; max: number }[] = [
  { key: 'directRelevance',   label: 'Direct relevance to brief', max: 30 },
  { key: 'valueChainClarity', label: 'Value chain clarity',       max: 20 },
  { key: 'callUsefulness',    label: 'Usefulness on a call',      max: 20 },
  { key: 'recency',           label: 'Recency of experience',     max: 10 },
  { key: 'distinctiveness',   label: 'Distinctiveness',           max: 10 },
  { key: 'complianceClean',   label: 'Compliance / no conflicts', max: 10 },
];

function ScoreBar({ score, max }: { score: number; max: number }) {
  return (
    <div className="flex-1 h-1 bg-cream-dark relative overflow-hidden">
      <div
        className="absolute inset-0 bg-navy origin-left transition-transform duration-500"
        style={{ transform: `scaleX(${score / max})` }}
      />
    </div>
  );
}

function ScoreMeter({ score }: { score: number }) {
  const color =
    score >= 75 ? 'text-status-success' :
    score >= 55 ? 'text-status-warning' :
    'text-status-danger';
  const arc = Math.round((score / 100) * 180);

  return (
    <div className="flex flex-col items-center">
      <div className={`font-display text-5xl font-semibold leading-none ${color}`}>{score}</div>
      <div className="text-[10px] uppercase tracking-widest text-muted mt-1">out of 100</div>
      <div
        className="mt-1 h-1 w-20 origin-left transition-all duration-700"
        style={{ background: `linear-gradient(to right, var(--navy) ${arc}%, var(--border) ${arc}%)` }}
      />
    </div>
  );
}

export default function ScreenExpertPage() {
  const [brief, setBrief] = useState('');
  const [industry, setIndustry] = useState('');
  const [targetTypes, setTargetTypes] = useState('');
  const [keyTopics, setKeyTopics] = useState('');
  const [candidateName, setCandidateName] = useState('');
  const [candidateRole, setCandidateRole] = useState('');
  const [candidateCompany, setCandidateCompany] = useState('');
  const [candidateProfile, setCandidateProfile] = useState('');
  const [geography, setGeography] = useState('');
  const [knownConflicts, setKnownConflicts] = useState('');
  const [teamCoverage, setTeamCoverage] = useState('');
  const [showOptional, setShowOptional] = useState(false);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<ScreeningResult | null>(null);

  const canRun = brief.trim() && candidateName.trim() && candidateProfile.trim() && !loading;

  async function handleScreen() {
    if (!canRun) return;
    setLoading(true);
    setError('');
    setResult(null);
    try {
      const res = await fetch('/api/screen-expert', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          project_brief: brief.trim(),
          industry: industry.trim(),
          target_expert_types: targetTypes.trim(),
          key_topics: keyTopics.trim(),
          candidate_name: candidateName.trim(),
          candidate_role: candidateRole.trim(),
          candidate_company: candidateCompany.trim(),
          candidate_profile: candidateProfile.trim(),
          geography: geography.trim(),
          known_conflicts: knownConflicts.trim(),
          team_coverage: teamCoverage.trim(),
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Screening failed. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const labelCls = 'block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5';
  const inputCls =
    'w-full px-3 py-2.5 text-sm text-ink border border-frame bg-cream focus:outline-none focus:border-navy focus:ring-1 focus:ring-gold/30 transition-colors';

  const rec = result?.evaluation.viabilityScore.recommendation;
  const recStyle = rec ? RECOMMENDATION_STYLES[rec] : null;

  return (
    <div className="min-h-screen flex flex-col bg-cream">

      {/* ── Header ── */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between">
          <div className="flex items-center gap-6">
            <Link href="/" className="flex items-center gap-2.5 text-cream hover:text-gold/80 transition-colors">
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 19l-7-7m0 0l7-7m-7 7h18" />
              </svg>
              <span className="font-display font-semibold" style={{ letterSpacing: '0.15em', fontSize: '13px' }}>
                EXPERTMATCH
              </span>
            </Link>
            <span className="w-px h-4 bg-navy-muted hidden sm:block" />
            <span className="text-[10px] uppercase tracking-widest text-gold/70 hidden sm:block" style={{ letterSpacing: '0.2em' }}>
              Expert Vetting
            </span>
          </div>
          <div className="flex items-center gap-4 text-[10px] uppercase tracking-widest">
            <Link href="/rank-experts" className="text-gold/60 hover:text-gold transition-colors hidden sm:block" style={{ letterSpacing: '0.16em' }}>
              Shortlist Builder
            </Link>
            <Link href="/projects" className="text-gold/60 hover:text-gold transition-colors hidden sm:block" style={{ letterSpacing: '0.16em' }}>
              ← Projects
            </Link>
          </div>
        </div>
      </header>

      <div className="max-w-6xl w-full mx-auto px-6 sm:px-10 py-10 space-y-10">

        {/* ── Page intro ── */}
        <div className="max-w-2xl">
          <h1 className="font-display text-navy leading-tight" style={{ fontSize: 'clamp(1.9rem, 4vw, 3rem)', fontWeight: 500 }}>
            Expert Vetting
          </h1>
          <p className="mt-3 text-sm text-muted leading-relaxed" style={{ fontWeight: 300 }}>
            Vet an individual expert for direct knowledge, conflicts, communication quality, and client readiness. Scores fit across six dimensions and recommends prioritize, backup, or reject.
          </p>
          <div className="mt-5 rule-gold w-16" />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">

          {/* ── Left: Inputs ── */}
          <div className="space-y-8">

            {/* Project Brief */}
            <section>
              <div className="flex items-center gap-4 mb-5">
                <h2 className="text-[11px] font-semibold uppercase text-navy shrink-0" style={{ letterSpacing: '0.18em' }}>
                  01 · Project Brief
                </h2>
                <div className="flex-1 rule-divider" />
              </div>
              <div className="space-y-4">
                <div>
                  <label htmlFor="brief" className={labelCls}>Client brief *</label>
                  <textarea
                    id="brief"
                    rows={4}
                    className={`input-search ${inputCls} resize-none`}
                    value={brief}
                    onChange={(e) => setBrief(e.target.value)}
                    placeholder="What is the client trying to learn? What decision is this research informing? Be specific about the questions they want answered."
                  />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label htmlFor="industry" className={labelCls}>Industry</label>
                    <input
                      id="industry"
                      className={inputCls}
                      value={industry}
                      onChange={(e) => setIndustry(e.target.value)}
                      placeholder="e.g. Dairy / Food & Bev"
                    />
                  </div>
                  <div>
                    <label htmlFor="targetTypes" className={labelCls}>Target expert types</label>
                    <input
                      id="targetTypes"
                      className={inputCls}
                      value={targetTypes}
                      onChange={(e) => setTargetTypes(e.target.value)}
                      placeholder="e.g. Operators, distributors"
                    />
                  </div>
                </div>
                <div>
                  <label htmlFor="keyTopics" className={labelCls}>Key topics</label>
                  <input
                    id="keyTopics"
                    className={inputCls}
                    value={keyTopics}
                    onChange={(e) => setKeyTopics(e.target.value)}
                    placeholder="e.g. raw milk pricing, retail shelf placement, private label dynamics"
                  />
                </div>

                {/* Optional fields */}
                <button
                  type="button"
                  onClick={() => setShowOptional((o) => !o)}
                  className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors flex items-center gap-2"
                  style={{ letterSpacing: '0.16em' }}
                >
                  <svg
                    className={`w-3 h-3 transition-transform duration-200 ${showOptional ? 'rotate-180' : ''}`}
                    fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                  </svg>
                  {showOptional ? 'Hide' : 'Add'} optional context
                </button>

                {showOptional && (
                  <div className="space-y-3 animate-fade-in">
                    <div>
                      <label htmlFor="geography" className={labelCls}>Geography preference</label>
                      <input id="geography" className={inputCls} value={geography} onChange={(e) => setGeography(e.target.value)} placeholder="e.g. United States" />
                    </div>
                    <div>
                      <label htmlFor="conflicts" className={labelCls}>Known conflicts / compliance concerns</label>
                      <input id="conflicts" className={inputCls} value={knownConflicts} onChange={(e) => setKnownConflicts(e.target.value)} placeholder="e.g. Do not contact current employees of Target Corp" />
                    </div>
                    <div>
                      <label htmlFor="coverage" className={labelCls}>Experts already selected (coverage context)</label>
                      <textarea
                        id="coverage"
                        rows={2}
                        className={`${inputCls} resize-none`}
                        value={teamCoverage}
                        onChange={(e) => setTeamCoverage(e.target.value)}
                        placeholder="List other experts already chosen so the screener can flag overlap"
                      />
                    </div>
                  </div>
                )}
              </div>
            </section>

            {/* Candidate */}
            <section>
              <div className="flex items-center gap-4 mb-5">
                <h2 className="text-[11px] font-semibold uppercase text-navy shrink-0" style={{ letterSpacing: '0.18em' }}>
                  02 · Candidate Profile
                </h2>
                <div className="flex-1 rule-divider" />
              </div>
              <div className="space-y-4">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div>
                    <label htmlFor="candName" className={labelCls}>Name *</label>
                    <input id="candName" className={inputCls} value={candidateName} onChange={(e) => setCandidateName(e.target.value)} placeholder="Jane Smith" />
                  </div>
                  <div>
                    <label htmlFor="candRole" className={labelCls}>Current role</label>
                    <input id="candRole" className={inputCls} value={candidateRole} onChange={(e) => setCandidateRole(e.target.value)} placeholder="VP of Operations" />
                  </div>
                  <div>
                    <label htmlFor="candCompany" className={labelCls}>Company</label>
                    <input id="candCompany" className={inputCls} value={candidateCompany} onChange={(e) => setCandidateCompany(e.target.value)} placeholder="Acme Corp" />
                  </div>
                </div>
                <div>
                  <label htmlFor="candProfile" className={labelCls}>LinkedIn / bio / background text *</label>
                  <textarea
                    id="candProfile"
                    rows={7}
                    className={`${inputCls} resize-none`}
                    value={candidateProfile}
                    onChange={(e) => setCandidateProfile(e.target.value)}
                    placeholder="Paste the candidate's LinkedIn About section, career history, bio, or any background text. The more context, the more accurate the screening."
                  />
                </div>
              </div>
            </section>

            {/* Submit */}
            <button
              onClick={handleScreen}
              disabled={!canRun}
              className="w-full flex items-center justify-center gap-2.5 py-3.5 text-xs font-medium uppercase transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed hover:bg-navy-light"
              style={{
                background: loading ? '#5A6B7A' : '#0B1F3B',
                color: '#C6A75E',
                letterSpacing: '0.14em',
                minHeight: '48px',
              }}
            >
              {loading ? (
                <>
                  <svg className="w-3.5 h-3.5 animate-spin-slow" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-20" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                    <path className="opacity-80" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Screening candidate...
                </>
              ) : (
                <>
                  Screen Candidate
                  <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </>
              )}
            </button>

            {error && (
              <div className="border border-red-200 bg-red-50 px-5 py-4 flex items-start gap-3 text-sm text-red-700">
                <svg className="w-4 h-4 shrink-0 mt-0.5 text-red-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z" />
                </svg>
                {error}
              </div>
            )}
          </div>

          {/* ── Right: Results ── */}
          <div className="lg:sticky lg:top-24">
            {!result && !loading && (
              <div className="border border-dashed border-frame py-20 flex flex-col items-center justify-center text-center" style={{ background: 'rgba(247,249,252,0.5)' }}>
                <svg className="w-8 h-8 text-frame mb-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                </svg>
                <p className="font-display text-lg text-navy font-light italic">Evaluation will appear here.</p>
                <p className="text-xs text-muted mt-2" style={{ fontWeight: 300 }}>Fill in the brief and candidate profile, then run the screener.</p>
              </div>
            )}

            {loading && (
              <div className="border border-frame bg-surface py-20 flex flex-col items-center justify-center gap-5 animate-fade-in">
                <div className="relative w-10 h-10">
                  <div className="absolute inset-0 rounded-full border-2 border-frame" />
                  <div className="absolute inset-0 rounded-full border-2 border-navy border-t-transparent animate-spin-slow" />
                </div>
                <div className="text-center">
                  <p className="text-sm text-ink font-medium">Screening candidate...</p>
                  <p className="text-xs text-muted mt-1" style={{ fontWeight: 300 }}>Evaluating fit across six dimensions</p>
                </div>
              </div>
            )}

            {result && (
              <div className="border border-frame bg-surface animate-fade-in" style={{ borderTop: '3px solid var(--gold)' }}>

                {/* Candidate header */}
                <div className="px-7 py-5 border-b border-frame">
                  <p className="text-[10px] uppercase tracking-widest text-muted mb-1" style={{ letterSpacing: '0.18em' }}>Candidate</p>
                  <h2 className="font-display text-xl font-semibold text-navy">{result.candidate.name}</h2>
                  {(result.candidate.role || result.candidate.company) && (
                    <p className="text-sm text-muted mt-0.5">
                      {result.candidate.role}{result.candidate.company ? ` · ${result.candidate.company}` : ''}
                    </p>
                  )}
                </div>

                {/* Score + recommendation */}
                <div className="px-7 py-6 border-b border-frame flex items-center justify-between gap-6">
                  <ScoreMeter score={result.evaluation.viabilityScore.score} />
                  <div className="text-right">
                    {recStyle && (
                      <span className={`inline-block text-[10px] uppercase tracking-widest font-semibold px-3 py-1.5 ${recStyle.badge}`} style={{ letterSpacing: '0.14em' }}>
                        {recStyle.label}
                      </span>
                    )}
                    <div className="mt-3 space-y-1.5">
                      {SCORE_DIMENSIONS.map(({ key, label, max }) => (
                        <div key={key} className="flex items-center gap-2">
                          <span className="text-[9px] uppercase tracking-widest text-muted w-28 text-right shrink-0">{label}</span>
                          <ScoreBar score={result.evaluation.viabilityScore.scoreBreakdown[key]} max={max} />
                          <span className="text-[10px] text-ink w-8 text-right shrink-0">
                            {result.evaluation.viabilityScore.scoreBreakdown[key]}/{max}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Primary fit */}
                <div className="px-7 py-5 border-b border-frame">
                  <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Primary Fit</p>
                  <div className="flex flex-wrap gap-2 mb-3">
                    <span className="text-[10px] uppercase tracking-widest border border-frame text-muted px-2.5 py-1">
                      {result.evaluation.primaryFit.valueChainPosition}
                    </span>
                    <span className="text-[10px] uppercase tracking-widest border border-navy text-navy px-2.5 py-1">
                      {result.evaluation.primaryFit.archetype}
                    </span>
                    <span className={`text-[10px] uppercase tracking-widest px-2.5 py-1 ${
                      result.evaluation.primaryFit.scope === 'surgical'
                        ? 'bg-gold/10 text-gold-dark border border-gold/30'
                        : 'border border-frame text-muted'
                    }`}>
                      {result.evaluation.primaryFit.scope}
                    </span>
                  </div>
                  <p className="text-xs text-muted italic" style={{ fontWeight: 300 }}>
                    {result.evaluation.primaryFit.scopeExplanation}
                  </p>
                </div>

                {/* Why fits */}
                <div className="px-7 py-5 border-b border-frame">
                  <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Why This Candidate Fits</p>
                  <ul className="space-y-2">
                    {result.evaluation.whyFits.map((point, i) => (
                      <li key={i} className="flex gap-2.5 text-sm text-ink leading-snug" style={{ fontWeight: 300 }}>
                        <span className="text-status-success shrink-0 mt-0.5 font-medium">+</span>
                        {point}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Questions */}
                <div className="px-7 py-5 border-b border-frame">
                  <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Questions They Can Answer</p>
                  <ul className="space-y-2">
                    {result.evaluation.questionsCanAnswer.map((q, i) => (
                      <li key={i} className="flex gap-2.5 text-sm text-ink leading-snug" style={{ fontWeight: 300 }}>
                        <span className="font-display text-base text-gold shrink-0 leading-tight">{i + 1}.</span>
                        {q}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Risks */}
                <div className="px-7 py-5 border-b border-frame">
                  <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Risks / Limitations</p>
                  <ul className="space-y-2">
                    {result.evaluation.risksLimitations.map((r, i) => (
                      <li key={i} className="flex gap-2.5 text-sm text-ink leading-snug" style={{ fontWeight: 300 }}>
                        <span className="text-status-danger shrink-0 mt-0.5 font-medium">−</span>
                        {r}
                      </li>
                    ))}
                  </ul>
                </div>

                {/* Bottom line */}
                <div className="px-7 py-5">
                  <p className="text-[10px] uppercase tracking-widest text-muted font-semibold mb-3" style={{ letterSpacing: '0.18em' }}>Bottom Line</p>
                  <p className="text-sm text-ink leading-relaxed" style={{ fontWeight: 300 }}>
                    {result.evaluation.bottomLine}
                  </p>
                </div>

              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  );
}

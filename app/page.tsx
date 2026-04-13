'use client';

import { useState } from 'react';
import ExpertCard from '../components/ExpertCard';
import { Expert, ExpertResponse, QueryAnalysis } from '../types';

const GEOGRAPHIES = ['Any Geography', 'United States', 'Europe', 'Asia Pacific', 'Latin America', 'Middle East & Africa', 'Global'];
const SENIORITIES = ['Any Seniority', 'Mid-Level', 'Senior', 'Executive / C-Suite'];

const EXAMPLE_QUERIES = [
  'How does grid interconnection work for utility-scale solar in ERCOT?',
  'What are the key bottlenecks in EV battery supply chain logistics?',
  'How are large food manufacturers approaching AI in production?',
];

const CATEGORY_META = {
  Operator: {
    label: 'Operators',
    description: 'Practitioners with direct field experience',
  },
  Advisor: {
    label: 'Advisors',
    description: 'Analysts, investors, and consultants who evaluate the space',
  },
  Outsider: {
    label: 'Outsiders',
    description: 'Regulatory, enterprise, and independent perspectives',
  },
};

// ─── Skeleton ──────────────────────────────────────────────────────────────

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

// ─── Query Analysis Bar ─────────────────────────────────────────────────────

function ConfidenceDot({ level }: { level: 'High' | 'Medium' | 'Low' }) {
  const colors = { High: '#2E7D52', Medium: '#B45309', Low: '#C0392B' };
  return (
    <span
      className="inline-block w-1.5 h-1.5 rounded-full mr-1.5"
      style={{ background: colors[level], verticalAlign: 'middle' }}
    />
  );
}

function AnalysisBar({ analysis }: { analysis: QueryAnalysis }) {
  return (
    <div className="animate-fade-in border-b border-[#DDE2E8] bg-white">
      <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex flex-wrap items-center gap-x-8 gap-y-2">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-muted font-medium">Industry</span>
          <span className="text-xs text-ink font-medium">{analysis.industry}</span>
        </div>
        <div className="w-px h-3 bg-[#DDE2E8] hidden sm:block" />
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-widest text-muted font-medium">Function</span>
          <span className="text-xs text-ink font-medium">{analysis.function}</span>
        </div>
        <div className="w-px h-3 bg-[#DDE2E8] hidden sm:block" />
        <div className="flex flex-wrap gap-1.5">
          {analysis.key_topics.slice(0, 4).map((t) => (
            <span
              key={t}
              className="text-[10px] px-2 py-0.5 border border-[#DDE2E8] text-muted"
              style={{ letterSpacing: '0.02em' }}
            >
              {t}
            </span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <ConfidenceDot level={analysis.confidence} />
          <span className="text-[10px] uppercase tracking-widest text-muted font-medium">
            {analysis.confidence} Confidence
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── Category Section ───────────────────────────────────────────────────────

function CategorySection({
  category,
  experts,
  query,
}: {
  category: 'Operator' | 'Advisor' | 'Outsider';
  experts: Expert[];
  query: string;
}) {
  const meta = CATEGORY_META[category];

  return (
    <section className="space-y-5">
      <div className="flex items-center gap-5">
        <div className="shrink-0">
          <h2
            className="text-[11px] font-semibold uppercase text-navy"
            style={{ letterSpacing: '0.18em' }}
          >
            {meta.label}
          </h2>
          <p className="text-[11px] text-muted mt-0.5">{meta.description}</p>
        </div>
        <div className="flex-1 rule-divider" />
        <span className="text-[11px] text-muted shrink-0">
          {experts.length > 0 ? `${experts.length} found` : '—'}
        </span>
      </div>

      {experts.length === 0 ? (
        <div
          className="py-8 text-center border border-dashed border-[#DDE2E8]"
          style={{ background: 'rgba(247,249,252,0.6)' }}
        >
          <p className="text-sm text-muted">No high-confidence experts identified for this category.</p>
          <p className="text-xs text-muted mt-1 opacity-70">Try a more specific query or different geography.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {experts.map((expert, i) => (
            <ExpertCard key={expert.id} expert={expert} query={query} index={i} />
          ))}
        </div>
      )}
    </section>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function Home() {
  const [query, setQuery] = useState('');
  const [geography, setGeography] = useState('any');
  const [seniority, setSeniority] = useState('any');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExpertResponse | null>(null);
  const [error, setError] = useState('');
  const [inputFocused, setInputFocused] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;
    setLoading(true);
    setResult(null);
    setError('');
    try {
      const res = await fetch('/api/generate-experts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: query.trim(), geography, seniority }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      data.experts = data.experts.map((ex: Expert, i: number) => ({
        ...ex,
        id: ex.id || `exp-${i}`,
        source_links: ex.source_links || [],
      }));
      setResult(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  const operators = result?.experts.filter((e) => e.category === 'Operator') ?? [];
  const advisors = result?.experts.filter((e) => e.category === 'Advisor') ?? [];
  const outsiders = result?.experts.filter((e) => e.category === 'Outsider') ?? [];

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
          <span
            className="text-[10px] uppercase tracking-widest hidden sm:block"
            style={{ color: 'rgba(198,167,94,0.7)', letterSpacing: '0.2em' }}
          >
            Intelligence Platform
          </span>
        </div>
      </header>

      {/* ── Hero / Search ── */}
      <div className="border-b border-[#DDE2E8] bg-white">
        <div className="max-w-6xl mx-auto px-6 sm:px-10 py-14 sm:py-20">

          {/* Headline */}
          <div className="max-w-2xl mb-10">
            <h1 className="font-display text-navy leading-tight" style={{ fontSize: 'clamp(2.2rem, 5vw, 3.5rem)', fontWeight: 500, letterSpacing: '-0.01em' }}>
              Expert intelligence
              <br />
              <span style={{ fontStyle: 'italic', fontWeight: 300, color: '#5A6B7A' }}>for critical decisions.</span>
            </h1>
            <p className="mt-4 text-sm text-muted leading-relaxed max-w-lg" style={{ fontWeight: 300 }}>
              Surface the practitioners, advisors, and outliers who have navigated your exact question — with verified sources.
            </p>
          </div>

          {/* Search form */}
          <form onSubmit={handleSubmit} className="space-y-4 max-w-3xl">
            <div>
              <label className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-2" style={{ letterSpacing: '0.18em' }}>
                Research Question
              </label>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onFocus={() => setInputFocused(true)}
                onBlur={() => setInputFocused(false)}
                placeholder="e.g. How does solar interconnection work in Texas, and what are the main bottlenecks operators face?"
                rows={3}
                className="input-search w-full px-4 py-3.5 text-sm text-ink placeholder-[#9AABB8] border border-[#DDE2E8] resize-none bg-cream transition-all"
                style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(e as unknown as React.FormEvent);
                }}
              />
              <p className="text-[10px] text-muted mt-1.5" style={{ letterSpacing: '0.05em' }}>
                ⌘ + Enter to search
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 items-start sm:items-end">
              <div className="flex gap-3 flex-1">
                {/* Geography */}
                <div className="flex-1">
                  <label className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5" style={{ letterSpacing: '0.18em' }}>
                    Geography
                  </label>
                  <select
                    value={geography}
                    onChange={(e) => setGeography(e.target.value)}
                    className="select-field w-full px-3 py-2.5 text-xs text-ink border border-[#DDE2E8] bg-cream pr-8 focus:outline-none focus:border-navy transition-colors"
                    style={{ fontFamily: 'var(--font-libre-franklin)' }}
                  >
                    {GEOGRAPHIES.map((g) => (
                      <option key={g} value={g === 'Any Geography' ? 'any' : g}>{g}</option>
                    ))}
                  </select>
                </div>

                {/* Seniority */}
                <div className="flex-1">
                  <label className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5" style={{ letterSpacing: '0.18em' }}>
                    Seniority
                  </label>
                  <select
                    value={seniority}
                    onChange={(e) => setSeniority(e.target.value)}
                    className="select-field w-full px-3 py-2.5 text-xs text-ink border border-[#DDE2E8] bg-cream pr-8 focus:outline-none focus:border-navy transition-colors"
                    style={{ fontFamily: 'var(--font-libre-franklin)' }}
                  >
                    {SENIORITIES.map((s) => (
                      <option key={s} value={s === 'Any Seniority' ? 'any' : s}>{s}</option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Submit */}
              <button
                type="submit"
                disabled={!query.trim() || loading}
                className="shrink-0 flex items-center gap-2.5 px-7 py-2.5 text-xs font-medium uppercase transition-all duration-200 disabled:opacity-40 disabled:cursor-not-allowed"
                style={{
                  background: loading ? '#5A6B7A' : '#0B1F3B',
                  color: '#C6A75E',
                  letterSpacing: '0.14em',
                  border: '1px solid transparent',
                }}
                onMouseEnter={(e) => { if (!loading && query.trim()) (e.currentTarget as HTMLElement).style.background = '#142d52'; }}
                onMouseLeave={(e) => { if (!loading && query.trim()) (e.currentTarget as HTMLElement).style.background = '#0B1F3B'; }}
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
                    Find Experts
                    <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M17 8l4 4m0 0l-4 4m4-4H3" />
                    </svg>
                  </>
                )}
              </button>
            </div>
          </form>

          {/* Example queries */}
          {!result && !loading && !error && (
            <div className="mt-8 flex flex-wrap gap-2">
              <span className="text-[10px] uppercase tracking-widest text-muted self-center mr-1" style={{ letterSpacing: '0.18em' }}>
                Try:
              </span>
              {EXAMPLE_QUERIES.map((q) => (
                <button
                  key={q}
                  onClick={() => setQuery(q)}
                  className="text-xs text-muted hover:text-navy border border-[#DDE2E8] hover:border-navy px-3 py-1.5 transition-colors text-left"
                  style={{ fontWeight: 300 }}
                >
                  {q}
                </button>
              ))}
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
          <div className="border-l-4 border-red-500 bg-white px-5 py-4 text-sm text-red-700 mb-8" style={{ borderTop: '1px solid #DDE2E8', borderRight: '1px solid #DDE2E8', borderBottom: '1px solid #DDE2E8' }}>
            {error}
          </div>
        )}

        {/* Loading */}
        {loading && <LoadingState />}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-14 animate-fade-in">
            <CategorySection category="Operator" experts={operators} query={query} />
            <CategorySection category="Advisor" experts={advisors} query={query} />
            <CategorySection category="Outsider" experts={outsiders} query={query} />

            <div className="rule-divider" />
            <p className="text-[10px] uppercase tracking-widest text-muted text-center pb-4" style={{ letterSpacing: '0.18em' }}>
              {result.experts.length} verified expert{result.experts.length !== 1 ? 's' : ''} · Sources drawn from public professional records
            </p>
          </div>
        )}

        {/* Empty state */}
        {!loading && !result && !error && (
          <div className="flex flex-col items-center justify-center py-24 gap-6 text-center">
            <div
              className="w-14 h-14 flex items-center justify-center border border-[#DDE2E8]"
              style={{ background: 'white' }}
            >
              <svg className="w-6 h-6 text-gold" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
              </svg>
            </div>
            <div>
              <p className="font-display text-xl text-navy font-medium tracking-wide">Ready when you are.</p>
              <p className="text-sm text-muted mt-2 max-w-xs leading-relaxed" style={{ fontWeight: 300 }}>
                Enter any business question above. We identify real experts — with sources.
              </p>
            </div>
          </div>
        )}
      </main>

    </div>
  );
}

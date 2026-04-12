'use client';

import { useState } from 'react';
import ExpertCard from '../components/ExpertCard';
import { Expert, ExpertResponse, QueryAnalysis } from '../types';

const GEOGRAPHIES = ['Any Geography', 'United States', 'Europe', 'Asia Pacific', 'Latin America', 'Middle East & Africa', 'Global'];
const SENIORITIES = ['Any Seniority', 'Mid-Level', 'Senior', 'Executive / C-Suite'];

const confidenceConfig = {
  High: { color: 'bg-green-100 text-green-700 border-green-200', dot: 'bg-green-500', label: 'High Confidence' },
  Medium: { color: 'bg-yellow-100 text-yellow-700 border-yellow-200', dot: 'bg-yellow-500', label: 'Medium Confidence' },
  Low: { color: 'bg-orange-100 text-orange-700 border-orange-200', dot: 'bg-orange-500', label: 'Low Confidence' },
};

const categoryConfig = {
  Operator: {
    title: 'Operators',
    subtitle: 'Practitioners directly working in the field',
    icon: '⚙️',
    accent: 'border-indigo-200 bg-indigo-50/50',
    titleColor: 'text-indigo-800',
    subtitleColor: 'text-indigo-500',
    countBadge: 'bg-indigo-100 text-indigo-700',
  },
  Advisor: {
    title: 'Advisors',
    subtitle: 'Consultants, investors, and analysts who evaluate the space',
    icon: '💡',
    accent: 'border-emerald-200 bg-emerald-50/50',
    titleColor: 'text-emerald-800',
    subtitleColor: 'text-emerald-500',
    countBadge: 'bg-emerald-100 text-emerald-700',
  },
  Outsider: {
    title: 'Outsiders',
    subtitle: 'Regulatory, enterprise, and independent perspectives',
    icon: '🔭',
    accent: 'border-amber-200 bg-amber-50/50',
    titleColor: 'text-amber-800',
    subtitleColor: 'text-amber-500',
    countBadge: 'bg-amber-100 text-amber-700',
  },
};

function SkeletonCard() {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 p-5 space-y-4">
      <div className="flex items-start gap-3">
        <div className="w-14 h-14 rounded-full shimmer shrink-0" />
        <div className="flex-1 space-y-2">
          <div className="h-4 shimmer rounded-lg w-3/4" />
          <div className="h-3 shimmer rounded-lg w-1/2" />
          <div className="h-3 shimmer rounded-lg w-2/5" />
        </div>
      </div>
      <div className="h-3 shimmer rounded-lg w-1/3" />
      <div className="space-y-2">
        <div className="h-3 shimmer rounded-lg w-full" />
        <div className="h-3 shimmer rounded-lg w-5/6" />
        <div className="h-3 shimmer rounded-lg w-4/5" />
      </div>
      <div className="h-10 shimmer rounded-xl" />
    </div>
  );
}

function SkeletonSection({ title, icon }: { title: string; icon: string }) {
  return (
    <section className="space-y-4">
      <div className="flex items-center gap-3">
        <span className="text-2xl">{icon}</span>
        <div className="space-y-1">
          <div className="h-5 shimmer rounded-lg w-28" />
          <div className="h-3 shimmer rounded-lg w-48" />
        </div>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {[1, 2].map((i) => <SkeletonCard key={i} />)}
      </div>
    </section>
  );
}

function QueryBadge({ analysis }: { analysis: QueryAnalysis }) {
  const conf = confidenceConfig[analysis.confidence];

  return (
    <div className="bg-white rounded-2xl border border-violet-100 shadow-sm p-5 animate-slide-up">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-3 flex-1">
          <div className="flex flex-wrap gap-2">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide self-center mr-1">Industry:</span>
            <span className="bg-violet-100 text-violet-700 text-xs font-medium px-2.5 py-1 rounded-full">{analysis.industry}</span>
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wide self-center ml-2 mr-1">Function:</span>
            <span className="bg-violet-100 text-violet-700 text-xs font-medium px-2.5 py-1 rounded-full">{analysis.function}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            <span className="text-xs text-gray-400 self-center mr-1">Topics:</span>
            {analysis.key_topics.map((t) => (
              <span key={t} className="bg-gray-100 text-gray-600 text-xs px-2 py-0.5 rounded-full">{t}</span>
            ))}
          </div>
        </div>
        <div className={`flex items-center gap-2 px-3 py-2 rounded-full border text-xs font-medium ${conf.color} shrink-0`}>
          <div className={`w-2 h-2 rounded-full ${conf.dot}`} />
          {conf.label}
        </div>
      </div>
      {analysis.confidence_reason && (
        <p className="text-xs text-gray-500 mt-3 italic">{analysis.confidence_reason}</p>
      )}
    </div>
  );
}

function CategorySection({
  category,
  experts,
  query,
}: {
  category: 'Operator' | 'Advisor' | 'Outsider';
  experts: Expert[];
  query: string;
}) {
  const cfg = categoryConfig[category];

  if (experts.length === 0) {
    return (
      <section className={`rounded-2xl border ${cfg.accent} p-5 space-y-4`}>
        <div className="flex items-center gap-2.5">
          <span className="text-2xl">{cfg.icon}</span>
          <div>
            <h2 className={`font-bold text-lg ${cfg.titleColor}`}>{cfg.title}</h2>
            <p className={`text-xs ${cfg.subtitleColor}`}>{cfg.subtitle}</p>
          </div>
        </div>
        <div className="bg-white/60 border border-dashed border-gray-300 rounded-2xl p-6 text-center">
          <p className="text-sm text-gray-500 font-medium">Not enough high-confidence experts found for this category.</p>
          <p className="text-xs text-gray-400 mt-1">Try refining your query with more specific terms or a different geography.</p>
        </div>
      </section>
    );
  }

  return (
    <section className={`rounded-2xl border ${cfg.accent} p-5 space-y-4`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <span className="text-2xl">{cfg.icon}</span>
          <div>
            <h2 className={`font-bold text-lg ${cfg.titleColor}`}>{cfg.title}</h2>
            <p className={`text-xs ${cfg.subtitleColor}`}>{cfg.subtitle}</p>
          </div>
        </div>
        <span className={`text-xs font-bold px-2.5 py-1 rounded-full ${cfg.countBadge}`}>
          {experts.length} expert{experts.length !== 1 ? 's' : ''}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {experts.map((expert) => (
          <ExpertCard key={expert.id} expert={expert} query={query} />
        ))}
      </div>
    </section>
  );
}

export default function Home() {
  const [query, setQuery] = useState('');
  const [geography, setGeography] = useState('any');
  const [seniority, setSeniority] = useState('any');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<ExpertResponse | null>(null);
  const [error, setError] = useState('');

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

      // Assign IDs if missing
      data.experts = data.experts.map((e: Expert, i: number) => ({
        ...e,
        id: e.id || `exp-${i}`,
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
    <div className="min-h-screen">
      {/* Header */}
      <header className="sticky top-0 z-40 backdrop-blur-md bg-violet-50/80 border-b border-violet-100">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 bg-violet-600 rounded-lg flex items-center justify-center shadow-sm">
              <svg className="w-4.5 h-4.5 text-white" fill="currentColor" viewBox="0 0 20 20">
                <path d="M9 6a3 3 0 11-6 0 3 3 0 016 0zM17 6a3 3 0 11-6 0 3 3 0 016 0zM12.93 17c.046-.327.07-.66.07-1a6.97 6.97 0 00-1.5-4.33A5 5 0 0119 16v1h-6.07zM6 11a5 5 0 015 5v1H1v-1a5 5 0 015-5z" />
              </svg>
            </div>
            <span className="font-bold text-violet-900 text-lg tracking-tight">ExpertMatch</span>
          </div>
          <p className="text-xs text-violet-500 hidden sm:block font-medium">AI-Powered Expert Sourcing</p>
        </div>
      </header>

      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-10 space-y-10">
        {/* Hero */}
        <div className="text-center space-y-3 pt-4">
          <h1 className="text-4xl sm:text-5xl font-extrabold text-violet-950 tracking-tight leading-tight">
            Find the right expert
            <br />
            <span className="text-violet-600">for any question.</span>
          </h1>
          <p className="text-gray-500 text-lg max-w-xl mx-auto leading-relaxed">
            Describe your research question. Get a curated, consultant-quality list of experts to interview — instantly.
          </p>
        </div>

        {/* Search Form */}
        <div className="bg-white rounded-2xl shadow-md border border-violet-100 p-6 space-y-5">
          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-sm font-semibold text-gray-700 mb-2">
                Your Research Question
              </label>
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="e.g. How does solar interconnection work in Texas? What are the key bottlenecks operators face?"
                rows={3}
                className="w-full px-4 py-3 rounded-xl border border-gray-200 focus:border-violet-400 focus:ring-2 focus:ring-violet-100 outline-none resize-none text-gray-800 placeholder-gray-400 text-sm transition-colors"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) handleSubmit(e as unknown as React.FormEvent);
                }}
              />
              <p className="text-xs text-gray-400 mt-1.5">Press ⌘+Enter to search</p>
            </div>

            <div className="flex flex-col sm:flex-row gap-3">
              <div className="flex-1">
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Geography</label>
                <select
                  value={geography}
                  onChange={(e) => setGeography(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 focus:border-violet-400 focus:ring-2 focus:ring-violet-100 outline-none text-sm text-gray-700 bg-white transition-colors"
                >
                  {GEOGRAPHIES.map((g) => (
                    <option key={g} value={g === 'Any Geography' ? 'any' : g}>{g}</option>
                  ))}
                </select>
              </div>

              <div className="flex-1">
                <label className="block text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">Seniority</label>
                <select
                  value={seniority}
                  onChange={(e) => setSeniority(e.target.value)}
                  className="w-full px-3 py-2.5 rounded-xl border border-gray-200 focus:border-violet-400 focus:ring-2 focus:ring-violet-100 outline-none text-sm text-gray-700 bg-white transition-colors"
                >
                  {SENIORITIES.map((s) => (
                    <option key={s} value={s === 'Any Seniority' ? 'any' : s}>{s}</option>
                  ))}
                </select>
              </div>

              <div className="flex items-end">
                <button
                  type="submit"
                  disabled={!query.trim() || loading}
                  className="w-full sm:w-auto px-8 py-2.5 bg-violet-600 hover:bg-violet-700 disabled:bg-violet-300 disabled:cursor-not-allowed text-white font-semibold rounded-xl transition-colors text-sm flex items-center justify-center gap-2 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2"
                >
                  {loading ? (
                    <>
                      <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                      </svg>
                      Sourcing...
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                      </svg>
                      Find Experts
                    </>
                  )}
                </button>
              </div>
            </div>
          </form>
        </div>

        {/* Error */}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded-2xl p-4 flex items-start gap-3">
            <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="space-y-8 animate-fade-in">
            <div className="bg-white rounded-2xl border border-violet-100 p-5">
              <div className="flex gap-6">
                <div className="space-y-2 flex-1">
                  <div className="h-3.5 shimmer rounded-lg w-1/3" />
                  <div className="h-3 shimmer rounded-lg w-1/2" />
                </div>
                <div className="h-8 shimmer rounded-full w-32" />
              </div>
            </div>
            <SkeletonSection title="Operators" icon="⚙️" />
            <SkeletonSection title="Advisors" icon="💡" />
            <SkeletonSection title="Outsiders" icon="🔭" />
          </div>
        )}

        {/* Results */}
        {result && !loading && (
          <div className="space-y-6 animate-fade-in">
            {/* Query analysis */}
            <QueryBadge analysis={result.query_analysis} />

            {/* Expert sections */}
            <CategorySection category="Operator" experts={operators} query={query} />
            <CategorySection category="Advisor" experts={advisors} query={query} />
            <CategorySection category="Outsider" experts={outsiders} query={query} />

            {/* Footer note */}
            <p className="text-center text-xs text-gray-400 pb-4">
              {result.experts.length} verified expert{result.experts.length !== 1 ? 's' : ''} sourced from LinkedIn and professional directories
            </p>
          </div>
        )}

        {/* Empty state */}
        {!loading && !result && !error && (
          <div className="text-center py-16 space-y-4">
            <div className="w-20 h-20 bg-violet-100 rounded-full flex items-center justify-center mx-auto">
              <svg className="w-10 h-10 text-violet-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
              </svg>
            </div>
            <div>
              <p className="font-semibold text-gray-700 text-lg">Ask any business question</p>
              <p className="text-gray-400 text-sm mt-1 max-w-xs mx-auto">
                ExpertMatch will identify the most relevant operators, advisors, and outsiders for your research.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center pt-2">
              {[
                'How does grid interconnection work for solar in ERCOT?',
                'What are the key dynamics in US industrial real estate?',
                'How are large food manufacturers approaching sustainability?',
              ].map((ex) => (
                <button
                  key={ex}
                  onClick={() => setQuery(ex)}
                  className="text-xs bg-white border border-violet-200 text-violet-700 hover:bg-violet-50 px-3 py-1.5 rounded-full transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

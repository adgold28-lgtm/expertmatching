'use client';

import { useState } from 'react';
import { Expert, SourceLink } from '../types';
import OutreachModal from './OutreachModal';

interface Props {
  expert: Expert;
  query: string;
}

const categoryColors = {
  Operator: {
    badge: 'bg-indigo-100 text-indigo-700 border-indigo-200',
    score: 'text-indigo-600',
    scoreBg: 'bg-indigo-50',
    border: 'border-indigo-100',
    button: 'bg-indigo-600 hover:bg-indigo-700 focus:ring-indigo-500',
  },
  Advisor: {
    badge: 'bg-emerald-100 text-emerald-700 border-emerald-200',
    score: 'text-emerald-600',
    scoreBg: 'bg-emerald-50',
    border: 'border-emerald-100',
    button: 'bg-emerald-600 hover:bg-emerald-700 focus:ring-emerald-500',
  },
  Outsider: {
    badge: 'bg-amber-100 text-amber-700 border-amber-200',
    score: 'text-amber-600',
    scoreBg: 'bg-amber-50',
    border: 'border-amber-100',
    button: 'bg-amber-600 hover:bg-amber-700 focus:ring-amber-500',
  },
};

const subcategoryIcons: Record<string, string> = {
  Government: '🏛️',
  'Large Enterprise': '🏢',
  'Small Business': '🏪',
};

function ScoreRing({ score, category }: { score: number; category: Expert['category'] }) {
  const colors = categoryColors[category];
  const color =
    score >= 80
      ? 'stroke-green-500'
      : score >= 65
      ? 'stroke-yellow-500'
      : 'stroke-orange-400';

  const radius = 20;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference - (score / 100) * circumference;

  return (
    <div className={`relative flex items-center justify-center w-14 h-14 rounded-full ${colors.scoreBg} shrink-0`}>
      <svg className="absolute inset-0 w-14 h-14 -rotate-90" viewBox="0 0 56 56">
        <circle cx="28" cy="28" r={radius} strokeWidth="3" fill="none" className="stroke-gray-200" />
        <circle
          cx="28"
          cy="28"
          r={radius}
          strokeWidth="3"
          fill="none"
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          className={`${color} transition-all duration-700`}
        />
      </svg>
      <span className={`relative text-xs font-bold ${colors.score}`}>{score}</span>
    </div>
  );
}

export default function ExpertCard({ expert, query }: Props) {
  const [showOutreach, setShowOutreach] = useState(false);
  const colors = categoryColors[expert.category];

  return (
    <>
      <div
        className={`bg-white rounded-2xl shadow-sm border ${colors.border} p-5 flex flex-col gap-4 hover:shadow-md transition-all duration-200 animate-slide-up`}
      >
        {/* Header */}
        <div className="flex items-start gap-3">
          <ScoreRing score={expert.relevance_score} category={expert.category} />
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="font-semibold text-gray-900 text-base leading-tight">{expert.name}</h3>
              {expert.outsider_subcategory && (
                <span className="text-xs text-gray-500">
                  {subcategoryIcons[expert.outsider_subcategory]} {expert.outsider_subcategory}
                </span>
              )}
            </div>
            <p className="text-sm text-gray-600 mt-0.5 leading-snug">{expert.title}</p>
            <p className="text-sm font-medium text-violet-700 mt-0.5">{expert.company}</p>
          </div>
        </div>

        {/* Location */}
        <div className="flex items-center gap-1.5 text-xs text-gray-500">
          <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
          </svg>
          {expert.location}
        </div>

        {/* Justification */}
        <div className="bg-gray-50 rounded-xl p-3 border border-gray-100">
          <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1">Why relevant</p>
          <p className="text-sm text-gray-700 leading-relaxed">{expert.justification}</p>
        </div>

        {/* Source Links */}
        {expert.source_links && expert.source_links.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Sources</p>
            <div className="flex flex-col gap-1.5">
              {expert.source_links.map((link: SourceLink, i: number) => (
                <a
                  key={i}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-2 group"
                >
                  <span className="mt-0.5 shrink-0">
                    {link.type === 'LinkedIn' && (
                      <span className="inline-flex items-center justify-center w-4 h-4 rounded bg-[#0077b5] text-white text-[8px] font-bold">in</span>
                    )}
                    {link.type === 'Article' && (
                      <svg className="w-4 h-4 text-gray-400 group-hover:text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M19 20H5a2 2 0 01-2-2V6a2 2 0 012-2h10a2 2 0 012 2v1m2 13a2 2 0 01-2-2V7m2 13a2 2 0 002-2V9a2 2 0 00-2-2h-2m-4-3H9M7 16h6M7 12h6m-6-4h6" />
                      </svg>
                    )}
                    {(link.type === 'Company Website' || link.type === 'Professional Directory' || link.type === 'Government Website' || link.type === 'Other') && (
                      <svg className="w-4 h-4 text-gray-400 group-hover:text-violet-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                        <path strokeLinecap="round" strokeLinejoin="round" d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                      </svg>
                    )}
                  </span>
                  <span className="text-xs text-violet-600 group-hover:text-violet-800 group-hover:underline underline-offset-2 leading-tight line-clamp-2">
                    {link.label}
                  </span>
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Outreach button */}
        <button
          onClick={() => setShowOutreach(true)}
          className={`w-full ${colors.button} text-white text-sm font-medium py-2.5 px-4 rounded-xl transition-colors duration-150 focus:outline-none focus:ring-2 focus:ring-offset-2 flex items-center justify-center gap-2`}
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
          </svg>
          Generate Outreach
        </button>
      </div>

      {showOutreach && (
        <OutreachModal
          expert={expert}
          query={query}
          onClose={() => setShowOutreach(false)}
        />
      )}
    </>
  );
}

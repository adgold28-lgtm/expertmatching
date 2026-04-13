'use client';

import { useState } from 'react';
import { Expert, SourceLink } from '../types';
import OutreachModal from './OutreachModal';

interface Props {
  expert: Expert;
  query: string;
  index?: number;
}

function ArrowIcon() {
  return (
    <svg className="w-3 h-3 shrink-0 mt-0.5" viewBox="0 0 12 12" fill="none">
      <path d="M1 11L11 1M11 1H4M11 1V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function LinkTypeIcon({ type }: { type: SourceLink['type'] }) {
  if (type === 'LinkedIn') {
    return (
      <span className="inline-flex items-center justify-center w-3.5 h-3.5 rounded-sm bg-[#0077b5] text-white shrink-0 mt-0.5" style={{ fontSize: '7px', fontWeight: 700, letterSpacing: 0 }}>
        in
      </span>
    );
  }
  return <ArrowIcon />;
}

export default function ExpertCard({ expert, query, index = 0 }: Props) {
  const [showOutreach, setShowOutreach] = useState(false);

  const scoreColor =
    expert.relevance_score >= 80
      ? '#2E7D52'
      : expert.relevance_score >= 65
      ? '#B45309'
      : '#5A6B7A';

  return (
    <>
      <article
        className="expert-card animate-slide-up"
        style={{ animationDelay: `${index * 60}ms`, animationFillMode: 'both', opacity: 0 }}
      >
        <div className="p-6 flex flex-col gap-5 h-full">

          {/* Top row: score + name */}
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h3 className="font-display text-xl font-semibold text-navy leading-tight tracking-wide">
                {expert.name}
              </h3>
              <p className="text-sm text-muted mt-1 leading-snug">{expert.title}</p>
              <p className="text-sm font-medium text-ink mt-0.5">{expert.company}</p>
            </div>
            <div className="text-right shrink-0">
              <div
                className="font-display text-2xl font-semibold leading-none"
                style={{ color: scoreColor }}
              >
                {expert.relevance_score}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-muted mt-1">Score</div>
            </div>
          </div>

          {/* Location */}
          <div className="flex items-center gap-1.5 text-xs text-muted -mt-2">
            <svg className="w-3 h-3 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M17.657 16.657L13.414 20.9a2 2 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
            {expert.location}
          </div>

          {/* Divider */}
          <div className="rule-divider" />

          {/* Justification */}
          <p className="text-sm text-ink leading-relaxed" style={{ fontWeight: 300 }}>
            {expert.justification}
          </p>

          {/* Source links */}
          {expert.source_links && expert.source_links.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-muted font-medium">Sources</p>
              <div className="flex flex-col gap-1.5">
                {expert.source_links.map((link: SourceLink, i: number) => (
                  <a
                    key={i}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="source-link flex items-start gap-2 text-xs leading-snug"
                  >
                    <LinkTypeIcon type={link.type} />
                    <span className="hover:underline underline-offset-2 line-clamp-1">{link.label}</span>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* CTA */}
          <div className="mt-auto pt-1">
            <button
              onClick={() => setShowOutreach(true)}
              className="w-full bg-navy text-cream text-xs font-medium uppercase tracking-widest py-3 px-4 transition-all duration-200 hover:bg-navy-light flex items-center justify-center gap-2 group"
              style={{ letterSpacing: '0.12em' }}
            >
              <svg className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Draft Outreach
            </button>
          </div>

        </div>
      </article>

      {showOutreach && (
        <OutreachModal expert={expert} query={query} onClose={() => setShowOutreach(false)} />
      )}
    </>
  );
}

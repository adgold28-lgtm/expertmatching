'use client';

import { useState } from 'react';
import { Expert, SourceLink, EvidenceItem } from '../types';
import { isLinkedInProfileUrl } from '../lib/domainSuggestions';
import { classifySeniority, TIER_PRICING } from '../lib/seniorityClassifier';
import OutreachModal from './OutreachModal';
import ContactSection from './ContactSection';

interface QuickActions {
  isShortlisted: boolean;
  isRejected: boolean;
  onShortlist: () => void;
  onReject: () => void;
}

interface Props {
  expert: Expert;
  query: string;
  index?: number;
  quickActions?: QuickActions;
  hideContact?: boolean;
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

// Score color via status design tokens
function scoreClass(score: number): string {
  if (score >= 80) return 'text-status-success';
  if (score >= 65) return 'text-status-warning';
  return 'text-muted';
}

export default function ExpertCard({ expert, query, index = 0, quickActions, hideContact = false }: Props) {
  const [showOutreach, setShowOutreach] = useState(false);
  const tier    = classifySeniority(expert.title ?? '');
  const pricing = TIER_PRICING[tier];

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
              <div className={`font-display text-2xl font-semibold leading-none ${expert.relevance_score > 0 ? scoreClass(expert.relevance_score) : 'text-muted/40'}`}>
                {expert.relevance_score > 0 ? expert.relevance_score : '—'}
              </div>
              <div className="text-[10px] uppercase tracking-widest text-muted mt-1">Score</div>
              <div className={`mt-1.5 text-[9px] uppercase tracking-widest font-semibold px-1.5 py-0.5 ${
                tier === 'executive' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
                tier === 'senior'    ? 'bg-teal-50 text-teal-700 border border-teal-200' :
                                       'bg-slate-50 text-slate-500 border border-slate-200'
              }`} style={{ letterSpacing: '0.1em' }}>
                {tier === 'executive' ? 'Executive' : tier === 'senior' ? 'Senior' : 'Mid-Level'}
              </div>
              <div className="text-[9px] text-muted mt-0.5">${pricing.callRate}/call</div>
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

          {/* Evidence items — structured backing evidence; absent on legacy experts */}
          {expert.evidenceItems && expert.evidenceItems.length > 0 && (
            <div className="space-y-2">
              <p className="text-[10px] uppercase tracking-widest text-muted font-medium">Evidence</p>
              <div className="flex flex-col gap-2">
                {expert.evidenceItems.map((ev: EvidenceItem) => (
                  <div key={ev.id} className="border border-frame bg-surface px-3 py-2.5 space-y-1">
                    <div className="flex items-start justify-between gap-2">
                      <p className="text-[11px] font-medium text-ink leading-snug">{ev.claim}</p>
                      {ev.confidence && (
                        <span className={`shrink-0 text-[9px] uppercase tracking-wider px-1.5 py-0.5 font-medium ${
                          ev.confidence === 'high'   ? 'text-status-success bg-status-success/10' :
                          ev.confidence === 'medium' ? 'text-amber-700 bg-amber-50' :
                                                       'text-muted bg-frame'
                        }`}>
                          {ev.confidence}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-muted leading-snug">{ev.relevance}</p>
                    {ev.sourceUrl ? (
                      <a
                        href={ev.sourceUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1 text-[10px] text-muted hover:text-navy transition-colors leading-none underline underline-offset-2"
                      >
                        {ev.sourceLabel}
                        <svg className="w-2.5 h-2.5 shrink-0" viewBox="0 0 12 12" fill="none">
                          <path d="M1 11L11 1M11 1H4M11 1V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                      </a>
                    ) : (
                      <span className="text-[10px] text-muted/70">{ev.sourceLabel}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Source links — LinkedIn entries are only shown when the URL is a real profile */}
          {expert.source_links && expert.source_links.length > 0 && (() => {
            const visibleLinks = expert.source_links.filter((link: SourceLink) =>
              link.type !== 'LinkedIn' || isLinkedInProfileUrl(link.url)
            );
            if (visibleLinks.length === 0) return null;
            return (
              <div className="space-y-2">
                <p className="text-[10px] uppercase tracking-widest text-muted font-medium">Sources</p>
                <div className="flex flex-col gap-1.5">
                  {visibleLinks.map((link: SourceLink, i: number) => (
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
            );
          })()}

          {/* CTA */}
          <div className="mt-auto pt-1">
            <button
              onClick={() => setShowOutreach(true)}
              className="w-full bg-navy text-cream text-xs font-medium uppercase tracking-widest py-3 px-4 transition-all duration-200 hover:bg-navy-light flex items-center justify-center gap-2 group"
              style={{ letterSpacing: '0.12em', minHeight: '44px' }}
            >
              <svg className="w-3.5 h-3.5 transition-transform duration-200 group-hover:translate-x-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
              Draft Outreach
            </button>
          </div>

          {/* Contact enrichment — only runs on explicit user action; suppressed in project context */}
          {!hideContact && <ContactSection expert={expert} query={query} />}

          {/* Quick actions — shown when browsing search results before saving to a project */}
          {quickActions && (
            <div className="pt-3 border-t border-frame mt-1 flex gap-2">
              <button
                onClick={quickActions.onShortlist}
                className={`flex-1 text-[10px] uppercase tracking-widest py-2 border transition-colors ${
                  quickActions.isShortlisted
                    ? 'bg-amber-50 text-amber-700 border-amber-300'
                    : 'text-muted hover:text-amber-700 border-frame hover:border-amber-300'
                }`}
              >
                ★ {quickActions.isShortlisted ? 'Shortlisted' : 'Shortlist'}
              </button>
              <button
                onClick={quickActions.onReject}
                className={`flex-1 text-[10px] uppercase tracking-widest py-2 border transition-colors ${
                  quickActions.isRejected
                    ? 'bg-red-50 text-red-600 border-red-200'
                    : 'text-muted hover:text-red-500 border-frame hover:border-red-200'
                }`}
              >
                ✗ {quickActions.isRejected ? 'Rejected' : 'Reject'}
              </button>
            </div>
          )}

        </div>
      </article>

      {showOutreach && (
        <OutreachModal expert={expert} query={query} onClose={() => setShowOutreach(false)} />
      )}
    </>
  );
}

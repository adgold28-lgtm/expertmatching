'use client';

// Client-facing view of an expert shortlist.
//
// Security model:
// - Shows only shortlisted / client_ready experts.
// - Strips: confidentialNotes, rejectionNotes, userNotes (internal), screeningNotes,
//   rejectionReason, rejectedAt, contactEmail, outreachDraft, outreachSubject.
// - Project IDs are 24-char hex (96-bit entropy); URL is unguessable.
// - TODO: Replace with session/JWT auth before public launch.

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import type { Project, ProjectExpert, SourceLink, EvidenceItem } from '../../../../types';
import { isLinkedInProfileUrl } from '../../../../lib/domainSuggestions';

// ─── Client-safe data shapes ──────────────────────────────────────────────────

interface ClientExpert {
  id: string;
  name: string;
  title: string;
  company: string;
  location: string;
  category: string;
  justification: string;
  relevance_score: number;
  source_links: SourceLink[];
  evidenceItems?: EvidenceItem[];
  // Screening-derived fields — safe to share
  valueChainPosition?: string;
  knowledgeFit?: number;
  communicationQuality?: number;
  availability?: string;
  recommendToClient?: boolean;
  screeningStatus?: string;
}

interface ClientView {
  projectName: string;
  researchQuestion: string;
  industry: string;
  function: string;
  geography: string;
  seniority: string;
  keyQuestions?: string;
  experts: ClientExpert[];
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const VALUE_CHAIN_LABEL: Record<string, string> = {
  supplier:               'Supplier / Input Provider',
  equipment_vendor:       'Equipment Vendor',
  producer_operator:      'Producer / Operator',
  processor_manufacturer: 'Processor / Manufacturer',
  distributor:            'Distributor / Logistics',
  retail_customer:        'Retail / End Customer',
  regulator_academic:     'Regulator / Academic',
  investor_advisor:       'Investor / Advisor',
  other:                  'Other',
};

function sanitizeForClient(project: Project): ClientView {
  // Only include experts the team has marked as shortlisted or client_ready.
  const clientStatuses = new Set(['shortlisted', 'contacted', 'replied', 'scheduled', 'completed']);
  const clientReadyScreen = new Set(['client_ready', 'screened']);

  const experts: ClientExpert[] = project.experts
    .filter(pe => {
      if (!clientStatuses.has(pe.status)) return false;
      // If screening data exists, only show experts who passed screening
      // (i.e., not rejected_after_screen, not vetting_questions_ready only)
      if (pe.screeningStatus === 'rejected_after_screen') return false;
      return true;
    })
    .map(pe => ({
      id:             pe.expert.id,
      name:           pe.expert.name,
      title:          pe.expert.title,
      company:        pe.expert.company,
      location:       pe.expert.location,
      category:       pe.expert.category,
      justification:  pe.expert.justification,
      relevance_score: pe.expert.relevance_score,
      source_links:   pe.expert.source_links ?? [],
      evidenceItems:  pe.expert.evidenceItems,
      // Screening fields safe for clients
      ...(pe.valueChainPosition && { valueChainPosition: pe.valueChainPosition }),
      ...(pe.knowledgeFit       && { knowledgeFit:       pe.knowledgeFit       }),
      ...(pe.communicationQuality && { communicationQuality: pe.communicationQuality }),
      ...(pe.availability       && { availability:       pe.availability       }),
      ...(pe.recommendToClient !== undefined && { recommendToClient: pe.recommendToClient }),
      ...(pe.screeningStatus && clientReadyScreen.has(pe.screeningStatus) && {
        screeningStatus: pe.screeningStatus,
      }),
    }));

  return {
    projectName:      project.name,
    researchQuestion: project.researchQuestion,
    industry:         project.industry,
    function:         project.function,
    geography:        project.geography,
    seniority:        project.seniority,
    // keyQuestions is safe to share with the client
    ...(project.keyQuestions?.trim() && { keyQuestions: project.keyQuestions.trim() }),
    experts,
  };
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function ScoreDot({ score }: { score: number }) {
  const color = score >= 80 ? '#166534' : score >= 65 ? '#92400e' : '#6b7280';
  return (
    <div
      className="flex items-center gap-1.5 shrink-0"
      title={`Relevance score: ${score}/100`}
    >
      <span className="text-xl font-semibold font-display leading-none" style={{ color }}>
        {score > 0 ? score : '—'}
      </span>
      <span className="text-[9px] uppercase tracking-widest text-muted">Score</span>
    </div>
  );
}

function RatingBar({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-[10px] text-muted w-28 shrink-0">{label}</span>
      <div className="flex gap-0.5">
        {[1, 2, 3, 4, 5].map(i => (
          <div
            key={i}
            className={`w-3 h-3 rounded-sm ${i <= value ? 'bg-navy' : 'bg-frame'}`}
          />
        ))}
      </div>
      <span className="text-[10px] text-muted">{value}/5</span>
    </div>
  );
}

function ExpertBlock({ expert }: { expert: ClientExpert }) {
  const visibleLinks = (expert.source_links ?? []).filter((link: SourceLink) =>
    link.type !== 'LinkedIn' || isLinkedInProfileUrl(link.url)
  );

  return (
    <div className="border border-frame bg-white">
      {/* Header */}
      <div className="px-6 py-5 border-b border-frame flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0">
          <h3 className="font-display text-lg font-semibold text-navy leading-tight">{expert.name}</h3>
          <p className="text-sm text-muted mt-0.5">{expert.title}</p>
          <p className="text-sm font-medium text-ink mt-0.5">{expert.company}</p>
          {expert.location && (
            <p className="text-xs text-muted/70 mt-1">{expert.location}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-2 shrink-0">
          <ScoreDot score={expert.relevance_score} />
          {expert.recommendToClient && (
            <span className="text-[9px] uppercase tracking-widest text-green-700 bg-green-50 border border-green-200 px-2 py-0.5">
              ✓ Recommended
            </span>
          )}
          {expert.valueChainPosition && (
            <span className="text-[9px] text-muted/70 text-right max-w-32 leading-tight">
              {VALUE_CHAIN_LABEL[expert.valueChainPosition] ?? expert.valueChainPosition}
            </span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="px-6 py-5 space-y-5">

        {/* Justification */}
        <p className="text-sm text-ink leading-relaxed" style={{ fontWeight: 300 }}>
          {expert.justification}
        </p>

        {/* Evidence items */}
        {expert.evidenceItems && expert.evidenceItems.length > 0 && (
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium">Evidence</p>
            <div className="space-y-2">
              {expert.evidenceItems.map((ev: EvidenceItem) => (
                <div key={ev.id} className="border border-frame bg-surface px-3 py-2.5 space-y-1">
                  <p className="text-[11px] font-medium text-ink leading-snug">{ev.claim}</p>
                  <p className="text-[10px] text-muted leading-snug">{ev.relevance}</p>
                  {ev.sourceUrl ? (
                    <a
                      href={ev.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-[10px] text-muted hover:text-navy transition-colors underline underline-offset-2"
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

        {/* Screening ratings */}
        {(expert.knowledgeFit || expert.communicationQuality) && (
          <div className="space-y-2">
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium">Screening Ratings</p>
            {expert.knowledgeFit       && <RatingBar label="Knowledge Fit"       value={expert.knowledgeFit} />}
            {expert.communicationQuality && <RatingBar label="Communication"     value={expert.communicationQuality} />}
          </div>
        )}

        {/* Availability */}
        {expert.availability && (
          <div>
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-1">Availability</p>
            <p className="text-xs text-ink">{expert.availability}</p>
          </div>
        )}

        {/* Sources */}
        {visibleLinks.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium">Sources</p>
            {visibleLinks.map((link: SourceLink, i: number) => (
              <a
                key={i}
                href={link.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-start gap-2 text-xs text-muted hover:text-navy transition-colors leading-snug"
              >
                <svg className="w-3 h-3 shrink-0 mt-0.5" viewBox="0 0 12 12" fill="none">
                  <path d="M1 11L11 1M11 1H4M11 1V8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
                <span className="hover:underline underline-offset-2 line-clamp-1">{link.label}</span>
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function ClientViewPage() {
  const params    = useParams();
  const projectId = Array.isArray(params.projectId) ? params.projectId[0] : params.projectId;

  const [view,    setView]    = useState<ClientView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState('');

  useEffect(() => {
    if (!projectId) return;
    (async () => {
      try {
        const res  = await fetch(`/api/projects/${projectId}`);
        const data = await res.json() as { project?: Project; error?: string };
        if (!res.ok || !data.project) {
          setError(data.error === 'not_found' ? 'Project not found.' : 'Failed to load project.');
          return;
        }
        setView(sanitizeForClient(data.project));
      } catch {
        setError('Failed to load project.');
      } finally {
        setLoading(false);
      }
    })();
  }, [projectId]);

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F7F9FC' }}>
        <p className="text-xs uppercase tracking-widest text-muted animate-pulse">Loading…</p>
      </div>
    );
  }

  if (error || !view) {
    return (
      <div className="min-h-screen flex items-center justify-center" style={{ background: '#F7F9FC' }}>
        <p className="text-sm text-muted">{error || 'Project not found.'}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen" style={{ background: '#F7F9FC' }}>

      {/* Header */}
      <header className="bg-navy border-b-2 border-gold">
        <div className="max-w-3xl mx-auto px-6 sm:px-10 py-5">
          <p className="text-[10px] uppercase tracking-widest text-gold/60 mb-1" style={{ letterSpacing: '0.18em' }}>
            ExpertMatch · Expert Brief
          </p>
          <h1 className="font-display text-cream font-semibold text-xl leading-tight">{view.projectName}</h1>
          <p className="text-[11px] text-gold/50 mt-1">{today}</p>
        </div>
      </header>

      <main className="max-w-3xl mx-auto px-6 sm:px-10 py-10 space-y-10">

        {/* Research question */}
        <section className="space-y-2">
          <p className="text-[10px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
            Research Question
          </p>
          <p className="text-base text-navy leading-relaxed font-display font-medium">
            {view.researchQuestion}
          </p>
        </section>

        {/* Search parameters */}
        {(view.industry || view.function || (view.geography && view.geography !== 'any') || (view.seniority && view.seniority !== 'any')) && (
          <section className="space-y-2">
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
              Scope
            </p>
            <div className="flex flex-wrap gap-2">
              {view.industry  && <span className="text-[11px] border border-frame px-2.5 py-1 text-muted">{view.industry}</span>}
              {view.function  && <span className="text-[11px] border border-frame px-2.5 py-1 text-muted">{view.function}</span>}
              {view.geography && view.geography !== 'any' && <span className="text-[11px] border border-frame px-2.5 py-1 text-muted">{view.geography}</span>}
              {view.seniority && view.seniority !== 'any' && <span className="text-[11px] border border-frame px-2.5 py-1 text-muted">{view.seniority}</span>}
            </div>
          </section>
        )}

        {/* Key questions (safe to share) */}
        {view.keyQuestions && (
          <section className="space-y-2">
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
              Key Questions
            </p>
            <p className="text-sm text-ink leading-relaxed whitespace-pre-wrap">{view.keyQuestions}</p>
          </section>
        )}

        {/* Executive summary */}
        <section>
          <div className="bg-navy/5 border border-navy/10 px-5 py-4 flex items-center gap-6">
            <div className="text-center">
              <p className="font-display text-2xl font-semibold text-navy leading-none">{view.experts.length}</p>
              <p className="text-[9px] uppercase tracking-widest text-muted mt-0.5">Expert{view.experts.length !== 1 ? 's' : ''}</p>
            </div>
            <div className="h-8 w-px bg-frame" />
            <p className="text-xs text-navy/70 leading-relaxed">
              {view.experts.length === 0
                ? 'No shortlisted experts yet — check back soon.'
                : `${view.experts.length} expert${view.experts.length !== 1 ? 's' : ''} selected for your review, each with direct domain relevance to your research question.`
              }
            </p>
          </div>
        </section>

        {/* Experts */}
        {view.experts.length > 0 && (
          <section className="space-y-6">
            <p className="text-[10px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
              Recommended Experts
            </p>
            {view.experts.map(expert => (
              <ExpertBlock key={expert.id} expert={expert} />
            ))}
          </section>
        )}

        {/* Footer */}
        <footer className="border-t border-frame pt-6">
          <p className="text-[10px] text-muted/60 text-center">
            Prepared by ExpertMatch · {today} · Confidential
          </p>
        </footer>

      </main>
    </div>
  );
}

'use client';

import type { ProjectExpert, ValueChainPosition } from '../types';

// ─── Display metadata ─────────────────────────────────────────────────────────

const VALUE_CHAIN_LABEL: Record<ValueChainPosition, string> = {
  supplier:               'Supplier / Input',
  equipment_vendor:       'Equipment Vendor',
  producer_operator:      'Producer / Operator',
  processor_manufacturer: 'Processor / Manufacturer',
  distributor:            'Distributor',
  retail_customer:        'Retail / Customer',
  regulator_academic:     'Regulator / Academic',
  investor_advisor:       'Investor / Advisor',
  other:                  'Other',
};

const CONFLICT_CLASS: Record<string, string> = {
  low:     'text-green-700 border-green-200 bg-green-50',
  medium:  'text-amber-700 border-amber-300 bg-amber-50',
  high:    'text-red-600 border-red-200 bg-red-50',
  unknown: 'text-muted border-frame',
};

const CATEGORY_CLASS: Record<string, string> = {
  Operator: 'text-sky-700 border-sky-200 bg-sky-50',
  Advisor:  'text-amber-700 border-amber-200 bg-amber-50',
  Outsider: 'text-green-700 border-green-200 bg-green-50',
};

function RatingDots({ value }: { value: number | undefined }) {
  if (!value) return <span className="text-[10px] text-muted">—</span>;
  return (
    <div className="flex gap-0.5">
      {([1, 2, 3, 4, 5] as const).map(n => (
        <span
          key={n}
          className={`inline-block w-2.5 h-2.5 rounded-full border ${
            n <= value ? 'bg-navy border-navy' : 'bg-transparent border-frame'
          }`}
        />
      ))}
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  projectExpert: ProjectExpert;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ClientReadyCard({ projectExpert }: Props) {
  const { expert } = projectExpert;

  return (
    <div className="border border-frame bg-cream flex flex-col">
      {/* Header */}
      <div className="px-4 py-3 border-b border-frame bg-surface">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">{expert.name}</p>
            <p className="text-[11px] text-muted truncate">{expert.title}</p>
            <p className="text-[11px] text-muted truncate">{expert.company}</p>
          </div>
          <div className="flex flex-col items-end gap-1 shrink-0">
            <span className="text-[9px] uppercase tracking-widest text-navy border border-navy/20 bg-navy/5 px-1.5 py-0.5 font-medium">
              Client Ready
            </span>
            {expert.category && (
              <span className={`text-[9px] uppercase tracking-widest border px-1.5 py-0.5 ${CATEGORY_CLASS[expert.category] ?? 'text-muted border-frame'}`}>
                {expert.category}
              </span>
            )}
          </div>
        </div>
      </div>

      <div className="px-4 py-3 space-y-2.5">

        {/* Value chain */}
        {projectExpert.valueChainPosition && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-muted w-24 shrink-0">Value chain:</span>
            <span className="text-[11px] text-ink">{VALUE_CHAIN_LABEL[projectExpert.valueChainPosition]}</span>
          </div>
        )}

        {/* Ratings row */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-muted shrink-0">Knowledge:</span>
            <RatingDots value={projectExpert.knowledgeFit} />
          </div>
          {projectExpert.communicationQuality !== undefined && (
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-muted shrink-0">Comm.:</span>
              <RatingDots value={projectExpert.communicationQuality} />
            </div>
          )}
        </div>

        {/* Conflict risk */}
        {projectExpert.conflictRisk && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-muted w-24 shrink-0">Conflict risk:</span>
            <span className={`text-[10px] px-2 py-0.5 border uppercase tracking-wider ${CONFLICT_CLASS[projectExpert.conflictRisk]}`}>
              {projectExpert.conflictRisk}
            </span>
          </div>
        )}

        {/* Availability */}
        {projectExpert.availability && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-muted w-24 shrink-0">Availability:</span>
            <span className="text-[11px] text-ink">{projectExpert.availability}</span>
          </div>
        )}

        {/* Rate expectation */}
        {projectExpert.rateExpectation && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-widest text-muted w-24 shrink-0">Rate:</span>
            <span className="text-[11px] text-ink">{projectExpert.rateExpectation}</span>
          </div>
        )}

        {/* Justification */}
        <div className="pt-1 border-t border-frame">
          <p className="text-[11px] text-ink leading-relaxed line-clamp-3">{expert.justification}</p>
        </div>

        {/* Source links — public evidence only */}
        {expert.source_links && expert.source_links.length > 0 && (
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {expert.source_links.map((l, i) => (
              <a
                key={i}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[10px] text-muted hover:text-navy underline transition-colors"
              >
                {l.label}
              </a>
            ))}
          </div>
        )}

      </div>
    </div>
  );
}

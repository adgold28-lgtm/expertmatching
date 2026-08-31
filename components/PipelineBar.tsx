'use client';

import type { ProjectExpert } from '../types';
import {
  PIPELINE_STAGES,
  STAGE_META,
  pipelineStage,
  type PipelineStage,
} from '../lib/expertPipeline';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  /** The full outreach cohort — counts and the total both derive from this. */
  experts:       ProjectExpert[];
  activeStage:   PipelineStage | null;
  onStageChange: (stage: PipelineStage | null) => void;
}

// ─── Segment ──────────────────────────────────────────────────────────────────

function Segment({
  label,
  count,
  accentClasses,
  selected,
  dimmed,
  onClick,
}: {
  label:         string;
  count:         number;
  accentClasses: string;
  selected:      boolean;
  dimmed:        boolean;
  onClick:       () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={`relative flex-1 min-w-[112px] text-left px-3 pt-2 pb-2.5 border-r border-frame last:border-r-0 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-gold ${
        selected ? 'bg-cream' : 'bg-surface hover:bg-cream'
      } ${dimmed && !selected ? 'opacity-45' : ''}`}
    >
      {/* Stage accent rule */}
      <span aria-hidden className={`block h-0 border-t-2 mb-1.5 ${accentClasses}`} />

      <span
        className="block text-[9px] uppercase tracking-widest font-medium text-muted leading-tight"
        style={{ letterSpacing: '0.12em' }}
      >
        {label}
      </span>

      <span
        className={`block font-display text-lg font-semibold leading-none mt-1 ${
          count === 0 ? 'text-muted' : 'text-navy'
        }`}
      >
        {count}
      </span>

      {/* Selected indicator — absolute so selection never shifts layout */}
      {selected && <span aria-hidden className="absolute inset-x-0 bottom-0 h-[2px] bg-navy" />}
    </button>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Pipeline summary + filter strip shown above the Outreach grid.
 *
 * One segment per PIPELINE_STAGES entry — always all seven, zero-count segments
 * dimmed rather than hidden, so the funnel shape stays readable. Clicking a
 * segment filters the grid; clicking the active segment (or "All") clears it.
 *
 * Counts are recomputed from `experts` on every render, so a card's optimistic
 * update flowing through the page's onUpdate callback moves the numbers
 * immediately. Purely presentational — no fetching, no local copy of state.
 */
export default function PipelineBar({ experts, activeStage, onStageChange }: Props) {
  const counts = new Map<PipelineStage, number>(PIPELINE_STAGES.map(s => [s, 0]));
  for (const pe of experts) {
    const stage   = pipelineStage(pe);
    const current = counts.get(stage);
    // pre_outreach is intentionally absent from PIPELINE_STAGES — skip it.
    if (current !== undefined) counts.set(stage, current + 1);
  }

  const activeLabel = activeStage ? STAGE_META[activeStage].label : '';

  return (
    <div className="space-y-2">
      <div
        role="group"
        aria-label="Filter outreach by pipeline stage"
        className="border border-frame bg-surface overflow-x-auto"
      >
        <div className="flex min-w-max lg:min-w-0">
          <Segment
            label="All"
            count={experts.length}
            accentClasses="border-navy/25"
            selected={activeStage === null}
            dimmed={false}
            onClick={() => onStageChange(null)}
          />
          {PIPELINE_STAGES.map(stage => {
            const count = counts.get(stage) ?? 0;
            return (
              <Segment
                key={stage}
                label={STAGE_META[stage].label}
                count={count}
                accentClasses={STAGE_META[stage].classes}
                selected={activeStage === stage}
                dimmed={count === 0}
                onClick={() => onStageChange(activeStage === stage ? null : stage)}
              />
            );
          })}
        </div>
      </div>

      {activeStage && (
        <div className="flex items-center gap-2 flex-wrap">
          <p
            className="text-[10px] uppercase tracking-widest text-muted font-medium"
            style={{ letterSpacing: '0.12em' }}
          >
            Filtered — {activeLabel}
          </p>
          <button
            type="button"
            onClick={() => onStageChange(null)}
            className="text-[10px] uppercase tracking-widest text-muted border border-frame hover:border-navy hover:text-navy px-2 py-0.5 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-gold"
            style={{ letterSpacing: '0.12em' }}
          >
            Clear filter ✕
          </button>
        </div>
      )}
    </div>
  );
}

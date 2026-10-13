// How much of the client's set one expert said they can speak to, as a pill
// (docs/SCREENING_FLOW_PLAN.md, build step 5).
//
// IT SAYS A RATIO AND NOTHING ELSE. "4 of 6" and "67%", in one of three tints.
// No adjective, no "strong match", no stars, no rank — the product's claim is
// that the client reads the expert's own answers and decides, and a badge that
// editorialised would be the platform deciding for them. The tint is a reading
// aid on a number that is already there, which is why the number is never
// hidden behind it.
//
// The band thresholds live in lib/screeningCoverage (green ≥ 0.66, amber ≥
// 0.34) so the table, this badge and the tests cannot disagree about where the
// lines are.
//
// NULL IS NOT ZERO. A respondent who has not answered has no coverage, and
// drawing them as 0 of 0 in red would state something false about a person who
// has said nothing. They get a neutral dash with "Not yet answered" behind it
// for anyone reading with a screen reader.
//
// Presentational: no state, no fetch, no effects.

import { coverageBand } from '../../lib/screeningCoverage';
import type { Coverage } from '../../types';

type Tint = { bg: string; text: string; border: string };

// Hex rather than Tailwind classes because three of the four are one-offs that
// exist only here; status.success / .warning / .danger in tailwind.config.js are
// the same three foreground values.
const TINTS: Record<'green' | 'amber' | 'red' | 'none', Tint> = {
  green: { bg: '#EDFAF3', text: '#2E7D52', border: 'rgba(46,125,82,0.30)' },
  amber: { bg: '#FFF7ED', text: '#B45309', border: 'rgba(180,83,9,0.30)' },
  red:   { bg: '#FDF2F0', text: '#BE3A2B', border: 'rgba(190,58,43,0.30)' },
  none:  { bg: '#F0F2F5', text: '#5A6B7A', border: '#DDE2E8' },
};

/**
 * The same fact as a sentence, for the mobile card and for `aria-label` — a
 * screen reader reading "4 of 6 67%" is reading a layout, not a number.
 */
export function coverageSentence(coverage: Coverage | null): string {
  if (coverage === null) return 'Not yet answered';
  return `${coverage.yes} of ${coverage.total} objective${coverage.total === 1 ? '' : 's'}`;
}

interface CoverageBadgeProps {
  coverage: Coverage | null;
  size?:    'sm' | 'md';
}

export default function CoverageBadge({ coverage, size = 'md' }: CoverageBadgeProps) {
  const pad   = size === 'sm' ? 'px-2 py-1 gap-1.5' : 'px-2.5 py-1.5 gap-2';
  const main  = size === 'sm' ? 'text-[11px]' : 'text-xs';
  const small = size === 'sm' ? 'text-[9px]'  : 'text-[10px]';

  if (coverage === null) {
    const tint = TINTS.none;
    return (
      <span
        className={`inline-flex items-baseline border ${pad} ${main} tabular-nums`}
        style={{ background: tint.bg, color: tint.text, borderColor: tint.border }}
        aria-label="Not yet answered"
      >
        <span aria-hidden="true">—</span>
      </span>
    );
  }

  const tint = TINTS[coverageBand(coverage.ratio)];

  return (
    <span
      className={`inline-flex items-baseline border ${pad} ${main} tabular-nums`}
      style={{ background: tint.bg, color: tint.text, borderColor: tint.border }}
      aria-label={coverageSentence(coverage)}
    >
      <span aria-hidden="true" className="font-medium whitespace-nowrap">
        {coverage.yes} of {coverage.total}
      </span>
      <span aria-hidden="true" className={`${small} opacity-80`}>
        {Math.round(coverage.ratio * 100)}%
      </span>
    </span>
  );
}

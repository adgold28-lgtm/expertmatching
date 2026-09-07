// Canonical expert pipeline model.
//
// Single source of truth for:
//   1. the full set of valid ExpertStatus values (API allowlists derive from it)
//   2. the coarse project-card stage (summaryStage) derived from status counts
//   3. per-status display metadata (label + pill classes)
//
// The per-expert pipeline-stage model (PipelineBar) was retired with the
// three-tab workspace; nothing is persisted here and there is no new status.
//
// Colour language:
//   sky   — contact found / draft ready
//   amber — in-flight, waiting, negotiating
//   teal  — scheduling link sent
//   green — replied interested / scheduled / billed (shade deepens along the funnel)
//   navy  — completed
//   red   — conflict
//   slate — declined

import type { ProjectExpert, ExpertStatus } from '../types';

// ─── Status universe ──────────────────────────────────────────────────────────

/**
 * Every valid ExpertStatus — all 16 members of the union, in pipeline order so
 * consumers can render them directly. API allowlists and UI selectors build
 * from this rather than repeating the literals.
 *
 * ORDER IS LOAD-BEARING: lib/redactExpert.ts reveals an expert's identity at
 * and after the index of 'scheduled', so a new status must be inserted at the
 * point in the funnel where it actually sits. 'bookmarked' goes before
 * 'contact_found' — the client has saved the expert, Matchy has not yet found
 * an address, and nothing about the identity is revealed.
 */
export const EXPERT_STATUSES: readonly ExpertStatus[] = [
  'discovered',
  'shortlisted',
  'bookmarked',
  'contact_found',
  'outreach_drafted',
  'contacted',
  'email2_sent',
  'scheduling_sent',
  'replied',
  'followup_sent',
  'rate_negotiation',
  'conflict_flagged',
  'scheduled',
  'completed',
  'rejected',
  'rejected_after_outreach',
] as const;

// ─── Project-list stage ───────────────────────────────────────────────────────

/**
 * The stage shown on a project card in the home list. Deliberately coarse:
 * a client's workflow is Brief → Matches → Conversations
 * (docs/MATCHY_SPEC.md), and the two outcomes worth calling out are a booked
 * call and a finished one.
 */
export type SummaryStage = 'Brief' | 'Matches' | 'In conversation' | 'Scheduled' | 'Completed';

/**
 * Statuses that mean Matchy owns the relationship: the client bookmarked the
 * expert and something is in flight. 'scheduled' and 'completed' are their own
 * stages and are deliberately absent.
 */
const IN_CONVERSATION_STATUSES: readonly ExpertStatus[] = [
  'bookmarked',
  'contact_found',
  'outreach_drafted',
  'contacted',
  'email2_sent',
  'followup_sent',
  'scheduling_sent',
  'replied',
  'rate_negotiation',
  'conflict_flagged',
] as const;

/**
 * Derive a project card's stage from its expert counts. Pure — no store, no
 * fetch, no dates.
 *
 * `stageCounts` is optional because ProjectSummary does not carry per-status
 * counts yet (see the report note): with it absent, a project with experts
 * reads as "Matches", which is the honest floor.
 */
export function summaryStage(counts: {
  expertCount: number;
  stageCounts?: Partial<Record<ExpertStatus, number>>;
}): SummaryStage {
  if (counts.expertCount <= 0) return 'Brief';

  const at = (status: ExpertStatus): number => counts.stageCounts?.[status] ?? 0;

  if (at('completed') > 0) return 'Completed';
  if (at('scheduled') > 0) return 'Scheduled';
  if (IN_CONVERSATION_STATUSES.some(s => at(s) > 0)) return 'In conversation';
  return 'Matches';
}

// ─── Display metadata ─────────────────────────────────────────────────────────

export const STATUS_META: Record<ExpertStatus, { label: string; classes: string }> = {
  discovered:              { label: 'Discovered',       classes: 'text-muted border-frame'                     },
  shortlisted:             { label: 'Shortlisted',      classes: 'text-amber-700 border-amber-300 bg-amber-50' },
  bookmarked:              { label: 'Bookmarked',       classes: 'text-sky-700 border-sky-300 bg-sky-50'       },
  rejected:                { label: 'Rejected',         classes: 'text-slate-500 border-slate-200 bg-slate-50' },
  contact_found:           { label: 'Contact Found',    classes: 'text-sky-600 border-sky-200 bg-sky-50'       },
  outreach_drafted:        { label: 'Draft Ready',      classes: 'text-sky-700 border-sky-300 bg-sky-50'       },
  contacted:               { label: 'Email 1 Sent',     classes: 'text-amber-700 border-amber-300 bg-amber-50' },
  email2_sent:             { label: 'Email 2 Sent',     classes: 'text-amber-700 border-amber-300 bg-amber-50' },
  followup_sent:           { label: 'Follow-up Sent',   classes: 'text-amber-700 border-amber-300 bg-amber-50' },
  scheduling_sent:         { label: 'Scheduling Sent',  classes: 'text-teal-700 border-teal-300 bg-teal-50'    },
  replied:                 { label: 'Replied',          classes: 'text-green-700 border-green-200 bg-green-50' },
  rate_negotiation:        { label: 'Rate Negotiation', classes: 'text-amber-700 border-amber-400 bg-amber-50' },
  conflict_flagged:        { label: 'Conflict Flagged', classes: 'text-red-700 border-red-300 bg-red-50'       },
  scheduled:               { label: 'Scheduled',        classes: 'text-green-700 border-green-300 bg-green-50' },
  completed:               { label: 'Completed',        classes: 'text-navy border-navy/20 bg-navy/5'          },
  rejected_after_outreach: { label: 'Declined',         classes: 'text-slate-500 border-slate-200 bg-slate-50' },
};

// Client-facing status vocabulary for the Matchy workspace.
//
// lib/expertPipeline.STATUS_META is the shared map and still carries the staff
// wording ("Email 1 Sent", "Contact Found", "Draft Ready") that the admin
// Outreach card renders. Clients get the plain stages below instead — no email
// numbering, no machinery, no verdicts on a person (docs/COPY_AUDIT.md 7.45 →
// 7.47, Top-10 item 6). Import CLIENT_STATUS_META anywhere a client can see a
// pill; leave STATUS_META to the admin surfaces.

import type { ExpertStatus } from '../types';

export interface StatusPill {
  label:   string;
  classes: string;
}

export const CLIENT_STATUS_META: Record<ExpertStatus, StatusPill> = {
  discovered:              { label: 'New',                 classes: 'text-muted border-frame'                     },
  shortlisted:             { label: 'Saved',               classes: 'text-muted border-frame'                     },
  bookmarked:              { label: 'Bookmarked',          classes: 'text-sky-700 border-sky-300 bg-sky-50'       },
  contact_found:           { label: 'Bookmarked',          classes: 'text-sky-700 border-sky-300 bg-sky-50'       },
  outreach_drafted:        { label: 'Intro ready',         classes: 'text-sky-700 border-sky-300 bg-sky-50'       },
  contacted:               { label: 'Intro sent',          classes: 'text-amber-700 border-amber-300 bg-amber-50' },
  email2_sent:             { label: 'Intro sent',          classes: 'text-amber-700 border-amber-300 bg-amber-50' },
  followup_sent:           { label: 'Discussing terms',    classes: 'text-amber-700 border-amber-300 bg-amber-50' },
  scheduling_sent:         { label: 'Scheduling',          classes: 'text-teal-700 border-teal-300 bg-teal-50'    },
  replied:                 { label: 'Replied',             classes: 'text-green-700 border-green-200 bg-green-50' },
  rate_negotiation:        { label: 'Discussing terms',    classes: 'text-amber-700 border-amber-400 bg-amber-50' },
  conflict_flagged:        { label: 'Checking a conflict', classes: 'text-red-700 border-red-300 bg-red-50'       },
  scheduled:               { label: 'Call booked',         classes: 'text-green-700 border-green-300 bg-green-50' },
  completed:               { label: 'Call done',           classes: 'text-navy border-navy/20 bg-navy/5'          },
  rejected:                { label: 'Passed',              classes: 'text-slate-500 border-slate-200 bg-slate-50' },
  rejected_after_outreach: { label: 'Passed',              classes: 'text-slate-500 border-slate-200 bg-slate-50' },
};

/**
 * Every status that belongs in Conversations: bookmarked and everything after
 * it, including the two ways an engagement ends. `discovered` / `shortlisted`
 * live in Matches; `rejected` (passed before any contact) never had a thread.
 */
export const CONVERSATION_STATUSES: ReadonlySet<ExpertStatus> = new Set<ExpertStatus>([
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
  'scheduled',
  'completed',
  'rejected_after_outreach',
]);

/** True once the client has bookmarked this expert — a thread exists. */
export function hasConversation(status: ExpertStatus): boolean {
  return CONVERSATION_STATUSES.has(status);
}

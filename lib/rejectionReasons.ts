// lib/rejectionReasons.ts — the one list of reasons a client passes on an
// expert, with the labels the UI shows. Shared by the Matches card
// (components/ProjectExpertCard.tsx) and the thread's pass card
// (components/MatchyAskCard.tsx) so the two never drift.

import type { RejectionReason } from '../types';

export const REJECTION_REASONS: ReadonlyArray<{ value: RejectionReason; label: string }> = [
  { value: 'too_generic',             label: 'Too Generic'              },
  { value: 'wrong_industry',          label: 'Wrong Industry'           },
  { value: 'wrong_geography',         label: 'Wrong Geography'          },
  { value: 'weak_evidence',           label: 'Weak Evidence'            },
  { value: 'no_contact_path',         label: "Couldn't reach them"      },
  { value: 'conflict_risk',           label: 'Conflict Risk'            },
  { value: 'not_senior_enough',       label: 'Not Senior Enough'        },
  { value: 'too_academic',            label: 'Too Academic'             },
  { value: 'vendor_biased',           label: 'Vendor Biased'            },
  { value: 'better_option_available', label: 'Better Option Available'  },
  { value: 'other',                   label: 'Other'                    },
];

/** Reasons that warrant a follow-up notes field. */
export const REASONS_WITH_NOTES: ReadonlySet<RejectionReason> = new Set<RejectionReason>([
  'other', 'better_option_available', 'conflict_risk',
]);

/** The label for a reason, for Matchy's one line ("Passed: not senior enough."). */
export function rejectionLabel(reason: RejectionReason): string {
  return REJECTION_REASONS.find(r => r.value === reason)?.label ?? 'Other';
}

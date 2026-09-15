'use client';

// The respondents panel on an approved request: who has a screening link, and
// how much of the client's set each of them can speak to.
//
// DELIBERATELY SMALL. Step 5 of docs/SCREENING_FLOW_PLAN.md replaces this with
// the full table (coverage badges, background lines, rate, availability,
// expand-row breakdown in the expert's own words, "Request call"). Keeping it
// in its own component means that swap is one line in app/requests/[id]/page.tsx
// rather than surgery on the page.
//
// It shows what is true today and nothing more: an approved request with no
// links yet says so plainly, and a respondent who has not replied reads "not
// yet answered" rather than a coverage of zero, which would be a different and
// false statement.
//
// The client never sees a name or an address here — lib/screeningView drops
// both for a non-admin viewer, and `name` is rendered only when it is present.
//
// Mobile-first: one stacked row per respondent, no table.

import type { RespondentView } from '../../lib/screeningView';

function formatDate(iso: string | null): string {
  if (!iso) return '';
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function coverageLabel(respondent: RespondentView): string {
  if (respondent.coverage === null) return 'Not yet answered';
  return `${respondent.coverage.yes} of ${respondent.coverage.total} objectives`;
}

export default function RespondentsSummary({ respondents }: { respondents: RespondentView[] }) {
  if (respondents.length === 0) {
    return (
      <p className="text-xs leading-relaxed text-muted">
        No screening links have been sent yet.
      </p>
    );
  }

  return (
    <ul className="divide-y divide-frame">
      {respondents.map(respondent => {
        const submitted = formatDate(respondent.submittedAt);
        return (
          <li key={respondent.id} className="py-3 first:pt-0 last:pb-0">
            <div className="flex items-baseline justify-between gap-3 flex-wrap">
              <span className="text-[11px] uppercase text-navy" style={{ letterSpacing: '0.14em' }}>
                {respondent.label}
                {respondent.name && (
                  <span className="ml-2 normal-case tracking-normal text-muted">{respondent.name}</span>
                )}
              </span>
              <span className="text-xs text-muted">{coverageLabel(respondent)}</span>
            </div>
            {respondent.headline && (
              <p className="mt-1 text-xs leading-relaxed text-ink-light">{respondent.headline}</p>
            )}
            <p className="mt-1 text-[11px] text-muted">
              {respondent.revokedAt
                ? 'Link revoked.'
                : submitted
                  ? `Answered ${submitted}.`
                  : 'Waiting on a reply.'}
            </p>
          </li>
        );
      })}
    </ul>
  );
}

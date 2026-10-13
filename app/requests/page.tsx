'use client';

// /requests — every structured request this account can see, newest first
// (docs/SCREENING_FLOW_PLAN.md, step 2 of the build order).
//
// A REQUEST IS NOT A PROJECT. It is a topic plus three to six learning
// objectives, and the row exists to answer one question at a glance: has anyone
// been screened against those objectives yet. Hence the counts — objectives,
// and "N of M responded" once links have gone out — rather than a stage bar.
//
// Access scoping is the API's job (lib/requestStore.listRequestsForUser is
// owner-or-platform-admin), so this page renders whatever it is given and never
// filters by role itself — the same contract /app has with /api/projects.
//
// FOUR STATES, ALL REAL: loading, a failed list, an empty account, and rows. A
// failed fetch is an ERROR and never the empty state — "No requests yet" on a
// 500 would tell someone their work is gone when it is still there.
//
// Mobile-first: one column, each row stacks with the status pill above the
// topic; the whole row is the tap target.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RequestsShell, { ShellSkeleton, ShellError } from '../../components/requests/RequestsShell';
import type { ScreeningRequestStatus, ScreeningRequestSummary } from '../../types';

// Draft is muted grey, approved a green tint and closed a navy tint — the same
// three families as STAGE_COLORS in app/app/page.tsx so a pill means the same
// thing on both surfaces.
const STATUS_PILL: Record<ScreeningRequestStatus, { label: string; bg: string; text: string }> = {
  draft:    { label: 'Draft',    bg: '#F0F2F5', text: '#6B7C8D' },
  approved: { label: 'Approved', bg: '#EDFAF3', text: '#1A7A4A' },
  closed:   { label: 'Closed',   bg: '#EBF0F7', text: '#0B1F3B' },
};

// The deadline is an END-OF-DAY UTC instant (lib/screeningValidation stamps a
// 'YYYY-MM-DD' as 23:59:59.999Z), so it is shown in UTC. Rendering it in the
// reader's zone would move the date for anyone east of London and make the list
// disagree with the date they typed. `createdAt` is a real instant and is shown
// in the reader's own zone.
const DEADLINE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const CREATED_FMT  = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

function formatDate(iso: string, fmt: Intl.DateTimeFormat): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  return fmt.format(new Date(ms));
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}

/** The gold call to action, shared by the title row and the empty state. */
function NewRequestButton({ size = 'sm' }: { size?: 'sm' | 'lg' }) {
  return (
    <Link
      href="/requests/new"
      className={`inline-flex items-center justify-center text-[10px] uppercase font-medium transition-colors hover:opacity-90 min-h-[44px] ${
        size === 'lg' ? 'px-6 py-3' : 'px-4 py-2'
      }`}
      style={{ background: '#C6A75E', color: '#0B1F3B', letterSpacing: '0.14em' }}
    >
      New request
    </Link>
  );
}

export default function RequestsPage() {
  const [requests, setRequests] = useState<ScreeningRequestSummary[]>([]);
  const [loading,  setLoading]  = useState(true);
  const [error,    setError]    = useState('');
  const [attempt,  setAttempt]  = useState(0);

  const retry = useCallback(() => setAttempt(n => n + 1), []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');

    fetch('/api/requests')
      .then(async res => {
        const data = await res.json().catch(() => ({})) as {
          requests?: ScreeningRequestSummary[];
          error?:    string;
        };
        if (!res.ok) throw new Error(data.error ?? `http_${res.status}`);
        if (!active) return;
        setRequests(data.requests ?? []);
      })
      // Never the raw code: the person reads a sentence and gets a retry.
      .catch(() => { if (active) setError("We couldn't load your requests. They are still there — try again."); })
      .finally(() => { if (active) setLoading(false); });

    return () => { active = false; };
  }, [attempt]);

  return (
    <RequestsShell
      title="Requests"
      description="A topic and the questions you need answered. Experts tell you which ones they can speak to before you book."
      aside={<NewRequestButton />}
    >
      {loading ? (
        <ShellSkeleton rows={4} />
      ) : error ? (
        <ShellError message={error} onRetry={retry} />
      ) : requests.length === 0 ? (
        <div className="border border-frame bg-white px-6 py-14 text-center">
          <p className="text-sm font-medium text-navy">No requests yet.</p>
          <p className="mx-auto mt-2 max-w-sm text-xs leading-relaxed text-muted" style={{ fontWeight: 300 }}>
            A request is a one-line topic plus the three to six things you need to learn — we ask every
            candidate which of them they can speak to, and you see the answers before you book a call.
          </p>
          <div className="mt-7 flex justify-center">
            <NewRequestButton size="lg" />
          </div>
        </div>
      ) : (
        <ul className="space-y-3">
          {requests.map(request => {
            const pill     = STATUS_PILL[request.status];
            const expires  = formatDate(request.deadline,  DEADLINE_FMT);
            const created  = formatDate(request.createdAt, CREATED_FMT);

            return (
              <li key={request.id}>
                <Link
                  href={`/requests/${request.id}`}
                  className="block border border-frame bg-white px-5 py-4 transition-colors hover:border-navy/40"
                >
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
                    <div className="order-2 min-w-0 sm:order-1">
                      {/* Truncated in CSS, not in the data — the full line is the title attribute. */}
                      <p className="truncate text-sm text-ink" title={request.topicStatement}>
                        {request.topicStatement}
                      </p>
                      <div
                        className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted"
                        style={{ fontWeight: 300 }}
                      >
                        <span>{plural(request.objectiveCount, 'objective')}</span>
                        {request.respondentCount > 0 && (
                          <span>{request.submittedCount} of {request.respondentCount} responded</span>
                        )}
                        {expires && <span>Links expire {expires}</span>}
                        {created && <span>Created {created}</span>}
                      </div>
                    </div>
                    <span
                      className="order-1 shrink-0 self-start px-2 py-0.5 text-[9px] font-semibold uppercase tracking-widest sm:order-2"
                      style={{ background: pill.bg, color: pill.text, letterSpacing: '0.12em' }}
                    >
                      {pill.label}
                    </span>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </RequestsShell>
  );
}

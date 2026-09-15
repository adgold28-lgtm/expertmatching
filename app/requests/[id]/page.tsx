'use client';

// /requests/[id] — one structured request, in one of two states
// (docs/SCREENING_FLOW_PLAN.md, build step 3).
//
//   draft     → components/requests/ScreeningSetEditor: the client reads the
//               questions an expert will be asked, edits any of them inline and
//               approves the set. Nothing is sent until they do.
//   otherwise → the approved view: the frozen screening set, collapsed because
//               it is settled and the client is here for the replies, and the
//               respondents panel.
//
// The respondents panel is deliberately thin. Step 5 replaces
// components/requests/RespondentsSummary with the full table — coverage badges,
// background lines, rate, availability, expand-row breakdown, "Request call" —
// and that swap is this one import.
//
// A client component because everything on it is a fetch, an edit or a press.
// The route it reads is the only opinion on who may see this request: an
// inaccessible one answers 404, never 403, so a stranger never learns that a
// request id exists. This page says the same thing back in a sentence.
//
// Every state is drawn: loading, missing, failed-with-retry, draft, approved.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import RequestsShell, { ShellSkeleton, ShellError } from '../../../components/requests/RequestsShell';
import ScreeningSetEditor from '../../../components/requests/ScreeningSetEditor';
import RespondentsSummary from '../../../components/requests/RespondentsSummary';
import type { ScreeningRequestView } from '../../../lib/screeningView';

type LoadState = 'loading' | 'ready' | 'missing' | 'error';

const STATUS_LABEL: Record<ScreeningRequestView['status'], string> = {
  draft:    'Draft',
  approved: 'Approved',
  closed:   'Closed',
};

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

/** "4 objectives · links expire Sep 28, 2026 · $1,300/hr · 60 min" */
function describe(request: ScreeningRequestView): string {
  const parts = [
    `${request.objectives.length} objective${request.objectives.length === 1 ? '' : 's'}`,
    `links expire ${formatDate(request.deadline)}`,
    `$${request.clientRate.toLocaleString('en-US')}/hr`,
    `${request.callLengthMin} min`,
  ];
  return parts.filter(Boolean).join(' · ');
}

function StatusPill({ status }: { status: ScreeningRequestView['status'] }) {
  const tone = status === 'approved'
    ? 'border-gold text-navy bg-gold/10'
    : status === 'closed'
      ? 'border-frame text-muted bg-cream-dark'
      : 'border-frame text-muted bg-white';

  return (
    <span
      className={`inline-block text-[10px] uppercase border px-2.5 py-1 ${tone}`}
      style={{ letterSpacing: '0.16em' }}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}

// ─── The approved, read-only screening set ────────────────────────────────────

function ApprovedScreeningSet({ request }: { request: ScreeningRequestView }) {
  const [shown, setShown] = useState(false);

  return (
    <section className="border border-frame bg-white">
      <header className="px-5 sm:px-6 py-4 border-b border-frame flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[11px] uppercase font-medium text-navy" style={{ letterSpacing: '0.16em' }}>
            Screening set
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-muted">
            What every expert on this request is asked. Settled at approval.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setShown(v => !v)}
          aria-expanded={shown}
          className="shrink-0 text-[10px] uppercase text-navy underline underline-offset-2 hover:opacity-70 transition-opacity"
          style={{ letterSpacing: '0.14em' }}
        >
          {shown ? 'Hide' : 'Show'}
        </button>
      </header>

      {shown && (
        <ol className="px-5 sm:px-6 py-5 space-y-5">
          {request.objectives.map((objective, index) => (
            <li key={objective.id}>
              <p className="text-[10px] uppercase text-muted" style={{ letterSpacing: '0.16em' }}>
                Objective {index + 1}
              </p>
              <p className="mt-1.5 text-sm leading-relaxed text-ink">{objective.objectiveText}</p>
              <p className="mt-2.5 text-sm leading-relaxed text-navy">{objective.stem}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">{objective.proofPrompt}</p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

// ─── The page ─────────────────────────────────────────────────────────────────

export default function RequestDetailPage({ params }: { params: { id: string } }) {
  const [state,   setState]   = useState<LoadState>('loading');
  const [request, setRequest] = useState<ScreeningRequestView | null>(null);

  const load = useCallback(async () => {
    setState('loading');
    try {
      const res = await fetch(`/api/requests/${params.id}`);
      if (res.status === 404) { setState('missing'); return; }
      if (!res.ok)            { setState('error');   return; }

      const data: { request?: ScreeningRequestView } | null = await res.json().catch(() => null);
      if (!data?.request) { setState('error'); return; }

      setRequest(data.request);
      setState('ready');
    } catch {
      setState('error');
    }
  }, [params.id]);

  useEffect(() => { void load(); }, [load]);

  // ── Loading ──────────────────────────────────────────────────────────────
  if (state === 'loading') {
    return (
      <RequestsShell>
        <div className="mb-8 space-y-2" aria-hidden="true">
          <div className="skeleton h-6 w-2/3" />
          <div className="skeleton h-3 w-1/2" />
        </div>
        <ShellSkeleton rows={3} />
      </RequestsShell>
    );
  }

  // ── Not there, or not yours ──────────────────────────────────────────────
  if (state === 'missing') {
    return (
      <RequestsShell title="Request">
        <div className="border border-frame bg-white px-5 sm:px-6 py-6">
          <p className="text-sm leading-relaxed text-ink">We couldn&apos;t find that request.</p>
          <Link
            href="/requests"
            className="mt-3 inline-block text-[10px] uppercase text-navy underline underline-offset-2 hover:opacity-70 transition-opacity"
            style={{ letterSpacing: '0.14em' }}
          >
            Back to requests
          </Link>
        </div>
      </RequestsShell>
    );
  }

  // ── Failed ───────────────────────────────────────────────────────────────
  if (state === 'error' || !request) {
    return (
      <RequestsShell title="Request">
        <ShellError message="We could not load that request." onRetry={() => void load()} />
      </RequestsShell>
    );
  }

  // ── Ready ────────────────────────────────────────────────────────────────
  return (
    <RequestsShell
      title={request.topicStatement}
      description={describe(request)}
      aside={<StatusPill status={request.status} />}
    >
      {request.status === 'draft' ? (
        <ScreeningSetEditor request={request} onChange={setRequest} />
      ) : (
        <div className="space-y-5">
          <ApprovedScreeningSet request={request} />

          <section className="border border-frame bg-white">
            <header className="px-5 sm:px-6 py-4 border-b border-frame">
              <h2 className="text-[11px] uppercase font-medium text-navy" style={{ letterSpacing: '0.16em' }}>
                Respondents
              </h2>
              <p className="mt-1.5 text-xs leading-relaxed text-muted">
                Each expert&apos;s own answers, in their own words.
              </p>
            </header>
            <div className="px-5 sm:px-6 py-5">
              <RespondentsSummary respondents={request.respondents} />
            </div>
          </section>
        </div>
      )}
    </RequestsShell>
  );
}

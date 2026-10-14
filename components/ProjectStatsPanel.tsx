'use client';

// Live project stats, at the top of Conversations: intros sent, replies (and
// the rate), calls booked, and how long the first call took to book after the
// first intro. The offer promises these "on your project page as it happens".
//
// Reads GET /api/projects/:id/stats, whose payload is five aggregate numbers
// (lib/outreachStats.toClientProjectStats): no expert, no arm, no money.
//
// HIDDEN until an intro has really reached someone. A walkthrough project
// sends nothing, so it shows nothing: no row, no zeros. While the first read is
// in flight, a skeleton shows only when the project's statuses say outreach has
// started; otherwise the panel stays out of the way until it has a number.
//
// Refreshes when the project changes on this page and once a minute while the
// tab is visible, so a reply that lands while the client is reading shows up.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExpertStatus, Project } from '../types';
import type { ClientProjectStats } from '../lib/outreachStats';

interface Props {
  projectId: string;
  project:   Project;
}

const REFRESH_MS = 60_000;
/** The page's own project refresh can run every 5 s while sourcing; read at most this often on it. */
const MIN_GAP_MS = 10_000;
const DAY_MS     = 24 * 60 * 60 * 1000;

/** Statuses that only exist once Matchy has tried to send an intro. */
const OUTREACH_STARTED: ReadonlySet<ExpertStatus> = new Set<ExpertStatus>([
  'contacted', 'replied', 'followup_sent', 'rate_negotiation', 'conflict_flagged',
  'scheduling_sent', 'scheduled', 'completed', 'rejected_after_outreach', 'email2_sent',
]);

function formatRate(rate: number | null): string | null {
  if (rate === null) return null;
  return `${Math.round(rate * 100)}% of intros`;
}

/** "Within a day" / "1 day" / "3 days", or null before a call is booked. */
function formatLead(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < DAY_MS) return 'Within a day';
  const days = Math.max(1, Math.round(ms / DAY_MS));
  return `${days} ${days === 1 ? 'day' : 'days'}`;
}

function Stat({ label, value, detail }: { label: string; value: string; detail?: string | null }) {
  return (
    <div className="bg-surface px-4 py-3 min-w-0">
      <dt className="text-[10px] uppercase tracking-widest text-muted leading-snug" style={{ letterSpacing: '0.14em' }}>
        {label}
      </dt>
      <dd className="mt-1 flex items-baseline gap-2 flex-wrap min-w-0">
        <span className="text-lg text-navy font-medium tabular-nums leading-none">{value}</span>
        {detail && <span className="text-[11px] text-muted leading-snug">{detail}</span>}
      </dd>
    </div>
  );
}

export default function ProjectStatsPanel({ projectId, project }: Props) {
  const [stats,   setStats]   = useState<ClientProjectStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed,  setFailed]  = useState(false);
  const inFlight   = useRef<AbortController | null>(null);
  const lastLoadAt = useRef(0);
  const queued     = useRef<ReturnType<typeof setTimeout> | null>(null);

  const outreachStarted = project.experts.some(pe => OUTREACH_STARTED.has(pe.status));

  const load = useCallback(async () => {
    inFlight.current?.abort();
    const controller = new AbortController();
    inFlight.current = controller;
    lastLoadAt.current = Date.now();
    try {
      const res = await fetch(`/api/projects/${projectId}/stats`, { signal: controller.signal, cache: 'no-store' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      const data = await res.json() as { stats?: ClientProjectStats };
      if (controller.signal.aborted) return;
      setStats(data.stats ?? null);
      setFailed(false);
    } catch {
      if (controller.signal.aborted) return;
      // Keep the last good numbers on a failed refresh; only an empty panel shows the error.
      setFailed(true);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [projectId]);

  // First read, and again whenever the project changes on this page, at most
  // once per MIN_GAP_MS (a change inside the gap is read when the gap ends).
  useEffect(() => {
    const wait = lastLoadAt.current + MIN_GAP_MS - Date.now();
    if (wait <= 0) { void load(); return; }
    if (queued.current) return;
    queued.current = setTimeout(() => { queued.current = null; void load(); }, wait);
  }, [load, project.updatedAt]);

  // A reply can land at any moment: refresh while the tab is in view.
  useEffect(() => {
    const tick = () => { if (document.visibilityState === 'visible') void load(); };
    const interval = setInterval(tick, REFRESH_MS);
    document.addEventListener('visibilitychange', tick);
    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', tick);
      if (queued.current) { clearTimeout(queued.current); queued.current = null; }
      // An aborted read never landed, so the next mount may read straight away.
      inFlight.current?.abort();
      lastLoadAt.current = 0;
    };
  }, [load]);

  // ── Loading ──
  if (loading && !stats) {
    if (!outreachStarted) return null;
    return (
      <div aria-busy="true" aria-label="Loading project stats" className="border border-frame grid grid-cols-2 sm:grid-cols-4 gap-px bg-frame">
        {[0, 1, 2, 3].map(i => (
          <div key={i} className="bg-surface px-4 py-3 space-y-2">
            <div className="h-2.5 w-2/3 bg-frame animate-pulse" />
            <div className="h-4 w-1/3 bg-frame animate-pulse" />
          </div>
        ))}
      </div>
    );
  }

  // ── Error (nothing to show yet) ──
  if (failed && !stats) {
    if (!outreachStarted) return null;
    return (
      <div className="border border-frame bg-surface px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
        <p className="text-[11px] text-muted">Project stats did not load.</p>
        <button
          type="button"
          onClick={() => { setLoading(true); void load(); }}
          className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2.5 py-1 transition-colors"
          style={{ letterSpacing: '0.12em' }}
        >
          Try again
        </button>
      </div>
    );
  }

  // ── Empty: nothing has reached an expert yet ──
  if (!stats || stats.introsSent === 0) return null;

  const lead = formatLead(stats.firstCallAfterMs);

  return (
    <section aria-label="Project stats">
      <dl className="border border-frame grid grid-cols-2 sm:grid-cols-4 gap-px bg-frame">
        <Stat label="Intros sent"  value={String(stats.introsSent)} />
        <Stat label="Replies"      value={String(stats.replies)} detail={formatRate(stats.replyRate)} />
        <Stat label="Calls booked" value={String(stats.callsBooked)} />
        <Stat
          label="First call booked"
          value={lead ?? 'Not yet'}
          detail={lead ? 'after the first intro' : null}
        />
      </dl>
    </section>
  );
}

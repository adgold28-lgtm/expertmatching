'use client';

// /admin/outreach — the Test A scoreboard (founder/launch.md): did 100
// anonymized intros earn at least 15 replies inside five business days, and at
// least 5 experts agreeing to a call at the offered rate? Plus everything the
// read-out records: time to first reply, decline reasons in the experts' words
// (Matchy's summary of each "no"), bounces and complaints, by intro arm.
//
// Staff only: middleware.ts 404s /admin/* for everyone else, and the API runs
// adminGuard. Every number comes from GET /api/admin/outreach-stats, computed
// by lib/outreachStats.ts (which documents its source). The CSV carries the
// aggregate table only: no expert, no project name, no wording.

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  CLIENT_PASS_REASON_LABEL,
  REPLY_WINDOW_BUSINESS_DAYS,
  TEST_A_AGREED_LINE,
  TEST_A_REPLY_LINE_PCT,
  type OutreachStatsResponse,
  type OutreachTotals,
  type Ratio,
  type TestAMark,
} from '../../../lib/outreachStats';

// ─── Formatting ───────────────────────────────────────────────────────────────

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS  = 24 * HOUR_MS;

function pct(rate: number | null): string {
  if (rate === null) return 'Not enough data';
  return `${(rate * 100).toFixed(rate === 0 || rate === 1 ? 0 : 1)}%`;
}

function ratioText(r: Ratio): string {
  if (r.rate === null) return 'Not enough data';
  return `${pct(r.rate)} (${r.numerator} of ${r.denominator})`;
}

function durationText(ms: number | null): string {
  if (ms === null) return 'Not enough data';
  if (ms < HOUR_MS) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (ms < 2 * DAY_MS) return `${(ms / HOUR_MS).toFixed(1)} hours`;
  return `${(ms / DAY_MS).toFixed(1)} days`;
}

function dateText(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function dateTimeText(ms: number): string {
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** 'YYYY-MM-DD' → 'Oct 14, 2026' without a time zone shift. */
function isoDayText(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function reasonLabel(key: string): string {
  return (CLIENT_PASS_REASON_LABEL as Record<string, string>)[key] ?? key.replace(/_/g, ' ');
}

async function readError(res: Response): Promise<string> {
  try {
    const data = await res.json() as { message?: string; error?: string };
    return data.message ?? data.error ?? 'Something went wrong.';
  } catch {
    return 'Something went wrong.';
  }
}

// ─── The table, defined once for the screen and the CSV ──────────────────────

interface Row {
  group:   string;
  label:   string;
  display: (t: OutreachTotals) => string;
  csv:     (t: OutreachTotals) => string;
}

const n = (pick: (t: OutreachTotals) => number) => ({
  display: (t: OutreachTotals) => String(pick(t)),
  csv:     (t: OutreachTotals) => String(pick(t)),
});
const r = (pick: (t: OutreachTotals) => Ratio) => ({
  display: (t: OutreachTotals) => ratioText(pick(t)),
  csv:     (t: OutreachTotals) => {
    const rate = pick(t).rate;
    return rate === null ? 'not enough data' : `${(rate * 100).toFixed(1)}%`;
  },
});

function tableRows(reasonKeys: string[]): Row[] {
  return [
    { group: 'Sending', label: 'Intros sent',  ...n(t => t.introsSent) },
    { group: 'Sending', label: 'Delivered',    ...n(t => t.delivered) },
    { group: 'Sending', label: 'Bounces',      ...n(t => t.bounces) },
    { group: 'Sending', label: 'Complaints (marked as spam)', ...n(t => t.complaints) },

    { group: 'Replies', label: 'Replies',        ...n(t => t.replies) },
    { group: 'Replies', label: 'Reply rate',     ...r(t => t.replyRate) },
    { group: 'Replies', label: `Replied within ${REPLY_WINDOW_BUSINESS_DAYS} business days`, ...n(t => t.repliesInWindow) },
    { group: 'Replies', label: `Rate within ${REPLY_WINDOW_BUSINESS_DAYS} business days (closed windows)`, ...r(t => t.inWindowRate) },
    { group: 'Replies', label: 'Still inside their window, no reply yet', ...n(t => t.stillInWindow) },
    { group: 'Replies', label: 'Automatic replies left out (out of office, blocked notices)', ...n(t => t.automaticReplies) },
    {
      group: 'Replies', label: 'Median time to first reply',
      display: t => durationText(t.medianTimeToFirstReplyMs),
      csv:     t => (t.medianTimeToFirstReplyMs === null ? 'not enough data' : `${(t.medianTimeToFirstReplyMs / HOUR_MS).toFixed(1)} hours`),
    },

    { group: 'Outcomes', label: 'Positive replies (said yes)',        ...n(t => t.positiveReplies) },
    { group: 'Outcomes', label: 'Countered on rate',                  ...n(t => t.counteredOnRate) },
    { group: 'Outcomes', label: 'Raised a conflict',                  ...n(t => t.conflictsRaised) },
    { group: 'Outcomes', label: 'Agreed to a call (any rate)',        ...n(t => t.agreedToCall) },
    { group: 'Outcomes', label: 'Agreed to a call at the offered rate', ...n(t => t.agreedAtOfferedRate) },
    { group: 'Outcomes', label: 'Calls booked',                       ...n(t => t.callsBooked) },
    { group: 'Outcomes', label: 'Completed calls',                    ...n(t => t.completedCalls) },
    { group: 'Outcomes', label: 'Mismatch guarantee claims',          ...n(t => t.mismatchClaims) },

    { group: 'Declines', label: 'Expert said no',                ...n(t => t.declines.expertSaidNo) },
    { group: 'Declines', label: 'Client passed after the intro', ...n(t => t.declines.clientPassed) },
    ...reasonKeys.map(key => ({
      group: 'Declines',
      label: `Client passed: ${reasonLabel(key)}`,
      ...n(t => t.declines.clientPassReasons[key] ?? 0),
    })),
  ];
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function buildCsv(data: OutreachStatsResponse, rows: Row[]): string {
  const lines: string[][] = [
    ['Outreach scoreboard'],
    ['Intros sent from', data.range.from, 'to', data.range.to, `(${data.range.zone})`],
    ['Projects', data.projectIds.length === 0 ? 'all' : data.projectIds.join(' ')],
    ['Generated', new Date(data.generatedAt).toISOString()],
    [],
    ['Section', 'Metric', 'Arm 1', 'Arm 2', 'All'],
    ...rows.map(row => [row.group, row.label, row.csv(data.byArm.arm1), row.csv(data.byArm.arm2), row.csv(data.byArm.all)]),
    [],
    ['Intros with no recorded arm (in All only)', String(data.byArm.unassigned)],
    ['Test A: reply rate within 5 business days >= 15%', data.testA.replyLine],
    ['Test A: agreed to a call at the offered rate >= 5', data.testA.agreedLine],
  ];
  return lines.map(cells => cells.map(csvCell).join(',')).join('\n') + '\n';
}

function downloadCsv(data: OutreachStatsResponse, rows: Row[]): void {
  const blob = new Blob([buildCsv(data, rows)], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `outreach-scoreboard-${data.range.from}_${data.range.to}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ─── Small pieces ─────────────────────────────────────────────────────────────

const LABEL_CLASS = 'block text-[10px] uppercase tracking-widest text-muted mb-1.5';
const INPUT_CLASS = 'w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors';
const ACTION_CLASS =
  'text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-3 py-2 transition-colors disabled:opacity-40';
const PRIMARY_CLASS =
  'text-[10px] uppercase tracking-widest border border-navy bg-navy text-gold px-4 py-2 transition-colors hover:bg-navy/90 disabled:opacity-40';

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-4 mb-5">
      <p className="text-[10px] uppercase tracking-widest text-muted font-medium shrink-0" style={{ letterSpacing: '0.2em' }}>
        {title}
      </p>
      <div className="flex-1 h-px bg-frame" />
    </div>
  );
}

const MARK_META: Record<TestAMark, { label: string; classes: string }> = {
  pass:    { label: 'Pass',        classes: 'border-status-success text-status-success bg-white' },
  fail:    { label: 'Fail',        classes: 'border-status-danger text-status-danger bg-white' },
  pending: { label: 'Not settled', classes: 'border-status-warning text-status-warning bg-white' },
  no_data: { label: 'No data',     classes: 'border-frame text-muted bg-white' },
};

function Mark({ mark }: { mark: TestAMark }) {
  const meta = MARK_META[mark];
  return (
    <span
      className={`inline-block text-[10px] uppercase tracking-widest border px-2.5 py-1 shrink-0 ${meta.classes}`}
      style={{ letterSpacing: '0.12em' }}
    >
      {meta.label}
    </span>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2" aria-busy="true" aria-label="Loading the scoreboard">
      {[0, 1, 2].map(i => (
        <div key={i} className="border border-frame bg-white px-4 py-4">
          <div className="h-3 w-1/2 bg-frame animate-pulse mb-2" />
          <div className="h-2.5 w-1/3 bg-frame animate-pulse" />
        </div>
      ))}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function OutreachScoreboardPage() {
  const [data,     setData]     = useState<OutreachStatsResponse | null>(null);
  const [loading,  setLoading]  = useState(true);
  const [errMsg,   setErrMsg]   = useState('');
  // The filter as typed, applied only on "Show".
  const [from,     setFrom]     = useState('');
  const [to,       setTo]       = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  const load = useCallback((query: { from?: string; to?: string; projects?: string[] }) => {
    setLoading(true);
    setErrMsg('');
    const params = new URLSearchParams();
    if (query.from) params.set('from', query.from);
    if (query.to)   params.set('to', query.to);
    if (query.projects && query.projects.length > 0) params.set('projects', query.projects.join(','));
    const qs = params.toString();
    fetch(`/api/admin/outreach-stats${qs ? `?${qs}` : ''}`, { cache: 'no-store' })
      .then(async res => {
        if (!res.ok) throw new Error(await readError(res));
        return res.json() as Promise<OutreachStatsResponse>;
      })
      .then(d => {
        setData(d);
        setFrom(d.range.from);
        setTo(d.range.to);
        setSelected(d.projectIds);
      })
      .catch((e: unknown) => setErrMsg(e instanceof Error ? e.message : 'Could not load the scoreboard.'))
      .finally(() => setLoading(false));
  }, []);

  // First load: the server's default range (the last 30 days).
  useEffect(() => { load({}); }, [load]);

  const apply  = () => load({ from, to, projects: selected });
  const reset  = () => load({});
  const toggle = (id: string) =>
    setSelected(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));

  const reasonKeys = useMemo(() => {
    if (!data) return [];
    return Object.keys(data.byArm.all.declines.clientPassReasons).sort();
  }, [data]);
  const rows = useMemo(() => tableRows(reasonKeys), [reasonKeys]);

  const all = data?.byArm.all ?? null;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-5xl mx-auto px-4 sm:px-10 py-4 flex items-center justify-between gap-4">
          <Link href="/app" className="font-display text-cream font-semibold shrink-0" style={{ letterSpacing: '0.15em', fontSize: '13px' }}>
            EXPERTMATCH
          </Link>
          <nav className="flex items-center gap-5 min-w-0">
            <Link
              href="/admin/requests"
              className="text-[10px] uppercase tracking-widest text-cream/70 hover:text-cream transition-colors truncate"
              style={{ letterSpacing: '0.18em' }}
            >
              Admin console
            </Link>
            <span className="text-[10px] uppercase tracking-widest text-gold/80 shrink-0" style={{ letterSpacing: '0.18em' }}>
              Outreach
            </span>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-10 py-10 space-y-12">

        <div className="space-y-2">
          <h1 className="font-display text-2xl text-navy">Outreach scoreboard</h1>
          <p className="text-xs text-muted leading-relaxed max-w-2xl" style={{ fontWeight: 300 }}>
            Test A: two real briefs, 100 anonymized intros. It passes when at least {TEST_A_REPLY_LINE_PCT}% of
            intros get a reply within {REPLY_WINDOW_BUSINESS_DAYS} business days and at least {TEST_A_AGREED_LINE} experts
            agree to a call at the offered rate.
          </p>
        </div>

        {/* ── Filters ── */}
        <section>
          <SectionHeader title="Filter" />
          <div className="border border-frame bg-white px-4 py-4 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label htmlFor="from" className={LABEL_CLASS} style={{ letterSpacing: '0.12em' }}>Intro sent from</label>
                <input id="from" type="date" value={from} onChange={e => setFrom(e.target.value)} className={INPUT_CLASS} />
              </div>
              <div>
                <label htmlFor="to" className={LABEL_CLASS} style={{ letterSpacing: '0.12em' }}>Intro sent to</label>
                <input id="to" type="date" value={to} onChange={e => setTo(e.target.value)} className={INPUT_CLASS} />
              </div>
            </div>

            <details className="border border-frame bg-cream">
              <summary className="cursor-pointer px-3 py-2.5 text-xs text-ink select-none">
                {selected.length === 0
                  ? 'All projects'
                  : `${selected.length} ${selected.length === 1 ? 'project' : 'projects'} selected`}
              </summary>
              <div className="border-t border-frame bg-white max-h-64 overflow-y-auto divide-y divide-frame">
                {(data?.projectOptions ?? []).length === 0 ? (
                  <p className="px-3 py-3 text-[11px] text-muted">No project has sent an intro yet.</p>
                ) : (
                  (data?.projectOptions ?? []).map(p => (
                    <label key={p.id} className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-cream">
                      <input
                        type="checkbox"
                        checked={selected.includes(p.id)}
                        onChange={() => toggle(p.id)}
                        className="accent-navy shrink-0"
                      />
                      <span className="text-xs text-ink truncate flex-1 min-w-0">{p.name}</span>
                      <span className="text-[10px] text-muted shrink-0">{p.introsSent} sent</span>
                    </label>
                  ))
                )}
              </div>
              {selected.length > 0 && (
                <div className="border-t border-frame px-3 py-2 bg-white">
                  <button type="button" onClick={() => setSelected([])} className="text-[10px] uppercase tracking-widest text-muted hover:text-navy" style={{ letterSpacing: '0.12em' }}>
                    Clear selection
                  </button>
                </div>
              )}
            </details>

            <div className="flex items-center gap-2 flex-wrap">
              <button type="button" onClick={apply} disabled={loading} className={PRIMARY_CLASS} style={{ letterSpacing: '0.12em' }}>
                {loading ? 'Loading…' : 'Show'}
              </button>
              <button type="button" onClick={reset} disabled={loading} className={ACTION_CLASS} style={{ letterSpacing: '0.12em' }}>
                Last 30 days, all projects
              </button>
              <button
                type="button"
                onClick={() => { if (data) downloadCsv(data, rows); }}
                disabled={loading || !data || data.byArm.all.introsSent === 0}
                className={`${ACTION_CLASS} sm:ml-auto`}
                style={{ letterSpacing: '0.12em' }}
              >
                Download CSV
              </button>
            </div>
          </div>
        </section>

        {/* ── Results ── */}
        {loading && !data ? (
          <Skeleton />
        ) : errMsg ? (
          <div className="border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-xs text-red-600">{errMsg}</p>
            <button
              type="button"
              onClick={apply}
              className="mt-2 text-[10px] uppercase tracking-widest text-red-500 hover:text-red-700 transition-colors"
              style={{ letterSpacing: '0.12em' }}
            >
              Try again
            </button>
          </div>
        ) : !data || !all ? null : all.introsSent === 0 ? (
          <p className="text-sm text-muted py-6">
            No intros went out between {isoDayText(data.range.from)} and {isoDayText(data.range.to)}
            {data.projectIds.length > 0 ? ' for the selected projects' : ''}. Walkthrough drafts never count.
          </p>
        ) : (
          <div className={`space-y-12 ${loading ? 'opacity-60 transition-opacity' : ''}`}>

            <p className="text-[11px] text-muted">
              Intros sent {isoDayText(data.range.from)} to {isoDayText(data.range.to)} (US Eastern)
              {data.projectIds.length > 0 ? `, ${data.projectIds.length} selected ${data.projectIds.length === 1 ? 'project' : 'projects'}` : ', all projects'}.
              {' '}As of {dateTimeText(data.generatedAt)}.
            </p>

            {data.incomplete && (
              <p className="border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-700">
                Some records could not be read, so these numbers may be low. Reload to try again.
              </p>
            )}

            {/* ── Test A ── */}
            <section>
              <SectionHeader title="Test A" />
              <div className="border border-frame bg-white divide-y divide-frame">
                <div className="px-4 py-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="text-xs text-navy font-medium">
                      Reply rate within {REPLY_WINDOW_BUSINESS_DAYS} business days ≥ {TEST_A_REPLY_LINE_PCT}%
                    </p>
                    <p className="text-[11px] text-muted leading-relaxed">
                      {all.repliesInWindow} of {all.introsSent} intros got a reply in time
                      ({pct(all.introsSent > 0 ? all.repliesInWindow / all.introsSent : null)}).
                      {all.stillInWindow > 0 && ` ${all.stillInWindow} more ${all.stillInWindow === 1 ? 'is' : 'are'} still inside the window.`}
                    </p>
                    <p className="text-[11px] text-muted leading-relaxed">
                      Out-of-office notes and blocked notices are not replies and are left out
                      {all.automaticReplies > 0 ? ` (${all.automaticReplies} so far)` : ''}.
                    </p>
                  </div>
                  <Mark mark={data.testA.replyLine} />
                </div>
                <div className="px-4 py-4 flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
                  <div className="min-w-0 space-y-1">
                    <p className="text-xs text-navy font-medium">
                      Agreed to a call at the offered rate ≥ {TEST_A_AGREED_LINE}
                    </p>
                    <p className="text-[11px] text-muted leading-relaxed">
                      {all.agreedAtOfferedRate} {all.agreedAtOfferedRate === 1 ? 'expert' : 'experts'} agreed without countering.
                      {all.agreedToCall > all.agreedAtOfferedRate
                        && ` ${all.agreedToCall - all.agreedAtOfferedRate} more agreed after a counter.`}
                    </p>
                  </div>
                  <Mark mark={data.testA.agreedLine} />
                </div>
              </div>
            </section>

            {/* ── The table ── */}
            <section>
              <SectionHeader title="By intro arm" />
              <div className="border border-frame bg-white overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-frame text-left">
                      <th scope="col" className="px-3 sm:px-4 py-2.5 text-[10px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.12em' }}>Metric</th>
                      <th scope="col" className="px-3 py-2.5 text-[10px] uppercase tracking-widest text-muted font-medium text-right whitespace-nowrap" style={{ letterSpacing: '0.12em' }}>Arm 1</th>
                      <th scope="col" className="px-3 py-2.5 text-[10px] uppercase tracking-widest text-muted font-medium text-right whitespace-nowrap" style={{ letterSpacing: '0.12em' }}>Arm 2</th>
                      <th scope="col" className="px-3 sm:px-4 py-2.5 text-[10px] uppercase tracking-widest text-navy font-semibold text-right whitespace-nowrap" style={{ letterSpacing: '0.12em' }}>All</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row, i) => {
                      const groupStart = i === 0 || rows[i - 1].group !== row.group;
                      return (
                        <tr key={`${row.group}:${row.label}`} className={groupStart ? 'border-t border-frame' : ''}>
                          <th scope="row" className="px-3 sm:px-4 py-2 text-left font-normal text-ink align-top">
                            {groupStart && (
                              <span className="block text-[9px] uppercase tracking-widest text-muted mb-1" style={{ letterSpacing: '0.14em' }}>{row.group}</span>
                            )}
                            {row.label}
                          </th>
                          <td className="px-3 py-2 text-right tabular-nums text-ink align-bottom">{row.display(data.byArm.arm1)}</td>
                          <td className="px-3 py-2 text-right tabular-nums text-ink align-bottom">{row.display(data.byArm.arm2)}</td>
                          <td className="px-3 sm:px-4 py-2 text-right tabular-nums text-navy font-medium align-bottom">{row.display(data.byArm.all)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <div className="mt-3 space-y-1 text-[11px] text-muted leading-relaxed">
                <p>
                  Mismatch guarantee: {all.mismatchClaims} {all.mismatchClaims === 1 ? 'claim' : 'claims'} on {all.completedCalls} completed {all.completedCalls === 1 ? 'call' : 'calls'}.
                </p>
                {data.byArm.unassigned > 0 && (
                  <p>{data.byArm.unassigned} {data.byArm.unassigned === 1 ? 'intro has' : 'intros have'} no recorded arm: counted in All, in neither arm.</p>
                )}
              </div>
            </section>

            {/* ── Decline wording ── */}
            <section>
              <SectionHeader title="Why experts said no" />
              {data.declineWords.length === 0 ? (
                <p className="text-sm text-muted py-2">
                  {all.declines.expertSaidNo === 0
                    ? 'No expert has said no in this range.'
                    : 'Experts said no, but Matchy stored no summary for those replies.'}
                </p>
              ) : (
                <div className="space-y-2">
                  <p className="text-[11px] text-muted">Matchy&apos;s one-line summary of each reply read as a no, newest first. Staff only; not in the CSV.</p>
                  {data.declineWords.map(w => (
                    <div key={`${w.projectId}:${w.expertId}:${w.at}`} className="border border-frame bg-white px-4 py-3">
                      <p className="text-xs text-ink leading-relaxed break-words">{w.summary}</p>
                      <p className="mt-1.5 text-[10px] text-muted break-words">
                        {w.expertName} · {w.projectName}{w.arm ? ` · Arm ${w.arm}` : ''} · {dateText(w.at)}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* ── By project ── */}
            <section>
              <SectionHeader title="By project" />
              <div className="border border-frame bg-white overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-frame text-left">
                      {['Project', 'Sent', 'Delivered', 'Replies', 'Calls', 'First call'].map((h, i) => (
                        <th
                          key={h}
                          scope="col"
                          className={`px-3 py-2.5 text-[10px] uppercase tracking-widest text-muted font-medium whitespace-nowrap ${i === 0 ? '' : 'text-right'}`}
                          style={{ letterSpacing: '0.12em' }}
                        >
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-frame">
                    {data.projects.map(p => (
                      <tr key={p.projectId}>
                        <th scope="row" className="px-3 py-2 text-left font-normal text-ink max-w-[220px]">
                          <Link href={`/projects/${p.projectId}`} className="hover:text-navy underline-offset-2 hover:underline break-words">
                            {p.name}
                          </Link>
                        </th>
                        <td className="px-3 py-2 text-right tabular-nums">{p.introsSent}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{p.delivered}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{p.replies}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{p.callsBooked}</td>
                        <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                          {p.firstCallAfterMs === null ? 'Not yet' : durationText(p.firstCallAfterMs)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-[11px] text-muted">First call: from the project&apos;s first intro in this range to its first booked call.</p>
            </section>

            {/* ── Definitions ── */}
            <section>
              <SectionHeader title="How these are counted" />
              <ul className="space-y-1.5 text-[11px] text-muted leading-relaxed list-disc pl-4">
                <li>Intro sent: Matchy&apos;s intro email actually went out. Walkthrough drafts and held sends never count.</li>
                <li>Delivered: sent, minus hard bounces that were never followed by a reply.</li>
                <li>
                  {REPLY_WINDOW_BUSINESS_DAYS} business days: Monday to Friday on the US Eastern calendar, counted from the day after
                  the intro. A reply on the intro&apos;s own day or over a weekend is inside. Holidays are not skipped.
                </li>
                <li>
                  The table&apos;s rate within {REPLY_WINDOW_BUSINESS_DAYS} business days only counts intros whose window is over. The
                  Test A line counts every intro sent (bounces included) and stays &quot;Not settled&quot; while open windows could still change it.
                </li>
                <li>Unclear-only replies: Matchy could not read them as a yes, a no, a counter or a conflict. Out-of-office notes land here.</li>
                <li>Agreed at the offered rate: agreed to a call (rate accepted, scheduling, booked or done) without ever countering.</li>
              </ul>
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

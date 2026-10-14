'use client';

// /admin/held-intros — intros Matchy is holding until staff write the "why
// them" line (docs/OUTREACH_EMAIL_RUBRIC.md, "Personalization").
//
// An intro is held when none of Matchy's three attempts produced a line it
// trusts (lib/introPersonalization: evidence, one model call, the sourced
// title and company). The client sees "Matchy is finishing the intro" and
// nothing has gone to the expert. Each card here shows the expert as staff see
// them (real name, title, company, evidence), takes one sentence, and sends it
// through the EXISTING approve route, which screens the line, lints it against
// the rubric, appends the closing clause and sends the intro. Its validation
// message is shown inline; nothing is patched here.
//
// Platform admins only: middleware 404s /admin/* for everyone else, and the
// list comes from GET /api/admin/held-intros behind adminGuard.

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import type { HeldIntro } from '../../../lib/heldIntros';

/** Mirrors MAX_WHY_THEM_CHARS in app/api/projects/[projectId]/experts/[expertId]/outreach/approve/route.ts. */
const MAX_LINE_CHARS = 200;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatTimestamp(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms) || ms <= 0) return '';
  return new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** Codes the approve route can answer with no message of its own, in plain words. */
const APPROVE_ERROR_LINES: Record<string, string> = {
  invalid_why_them:          'Write the line first, under 200 characters.',
  walkthrough_mode:          'This project is in walkthrough mode. It has to go live before anything is sent.',
  not_awaiting_approval:     'This intro is no longer waiting. Refresh the list.',
  no_contact_email:          'There is no address for this expert yet.',
  contact_suppressed:        'This expert has opted out of outreach.',
  contact_check_unavailable: 'The opt-out list could not be checked, so nothing was sent. Try again in a minute.',
  step_failed:               "The intro didn't send. Try again.",
  approve_failed:            "The intro didn't send. Try again.",
  project_not_found:         'This project no longer exists.',
  expert_not_found:          'This expert is no longer on the project.',
  forbidden:                 'Only staff can do this.',
  staff_only:                'Only staff can write the personal line.',
};

/** whyThemRejection reasons the route passes back on a 422 why_them_rubric. */
const RUBRIC_REASON_LINES: Record<string, string> = {
  too_long: 'It is too long. Keep it to one short sentence.',
  url:      'Take out the link.',
  money:    'Take out the dollar amount. The offer sentence carries the rate.',
  rubric:   'Take out the em dash or the banned phrase.',
  empty:    'Write the line first.',
};

interface ApproveFailure {
  error?:    string;
  message?:  string;
  reason?:   string;
  findings?: Array<{ kind?: string; hint?: string }>;
}

type CardResult =
  | { kind: 'sent' }
  | { kind: 'saved' };

// ─── One held intro ───────────────────────────────────────────────────────────

function HeldIntroCard({ item, onSettled }: { item: HeldIntro; onSettled: () => void }) {
  const [line,     setLine]     = useState('');
  const [busy,     setBusy]     = useState(false);
  const [errMsg,   setErrMsg]   = useState('');
  const [hints,    setHints]    = useState<string[]>([]);
  const [result,   setResult]   = useState<CardResult | null>(null);

  const trimmed  = line.trim();
  const tooLong  = trimmed.length > MAX_LINE_CHARS;
  const fieldId  = `why-them-${item.projectId}-${item.expertId}`;
  const helpId   = `${fieldId}-help`;
  const errorId  = `${fieldId}-error`;

  async function send() {
    if (!trimmed || tooLong || busy) return;
    setBusy(true);
    setErrMsg('');
    setHints([]);
    try {
      const res = await fetch(
        `/api/projects/${encodeURIComponent(item.projectId)}/experts/${encodeURIComponent(item.expertId)}/outreach/approve`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ whyThem: trimmed }),
        },
      );
      const data = await res.json().catch(() => ({})) as ApproveFailure & { outcome?: string };
      if (!res.ok) {
        const code = data.error ?? '';
        const reasonLine = data.reason ? RUBRIC_REASON_LINES[data.reason] : undefined;
        setErrMsg(reasonLine
          ? `${data.message ?? 'The line breaks the outreach rubric.'} ${reasonLine}`
          : data.message ?? APPROVE_ERROR_LINES[code] ?? "That didn't go through. Try again.");
        setHints((data.findings ?? []).map(f => f.hint ?? '').filter(Boolean));
        return;
      }
      setResult(data.outcome === 'intro_sent' ? { kind: 'sent' } : { kind: 'saved' });
      onSettled();
    } catch {
      setErrMsg("Couldn't reach ExpertMatch. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  const heldAt = formatTimestamp(item.heldAt);

  return (
    <article className="border border-frame bg-white px-4 sm:px-5 py-4 space-y-3">
      {/* Where it is held */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-1.5">
        <Link
          href={`/projects/${item.projectId}?tab=conversations`}
          className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors min-w-0 truncate"
          style={{ letterSpacing: '0.12em' }}
        >
          {item.projectName || 'Untitled project'} →
        </Link>
        {heldAt && <span className="text-[10px] text-muted shrink-0">Held {heldAt}</span>}
      </div>

      {/* Who */}
      <div className="min-w-0">
        <p className="text-sm text-navy font-medium">{item.name || 'Unnamed expert'}</p>
        <p className="text-xs text-ink leading-relaxed">
          {[item.title, item.company].filter(Boolean).join(' · ') || 'No title or company on file'}
          {item.location ? <span className="text-muted">{` · ${item.location}`}</span> : null}
        </p>
        {item.sourceUrl && (
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block mt-1 text-[11px] text-muted hover:text-navy underline underline-offset-2 break-all"
          >
            {item.sourceLabel || 'Source'}
          </a>
        )}
      </div>

      {/* What we know */}
      {item.evidence.length > 0 ? (
        <ul className="space-y-1.5 border-l-2 border-frame pl-3">
          {item.evidence.map((ev, i) => (
            <li key={i} className="text-xs text-ink leading-relaxed">
              {ev.claim}
              {(ev.sourceLabel || ev.sourceUrl) && (
                <>
                  {' '}
                  {ev.sourceUrl ? (
                    <a
                      href={ev.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-[11px] text-muted hover:text-navy underline underline-offset-2"
                    >
                      {ev.sourceLabel || 'source'}
                    </a>
                  ) : (
                    <span className="text-[11px] text-muted">{ev.sourceLabel}</span>
                  )}
                </>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted">No evidence on file. Use the source above.</p>
      )}

      {item.introDomain && (
        <p className="text-[11px] text-muted">
          Subject will read: <span className="text-ink">Expert in {item.introDomain}</span>
        </p>
      )}

      {item.walkthrough && (
        <p className="text-[11px] text-amber-700 border border-amber-200 bg-amber-50 px-3 py-2">
          This project is in walkthrough mode. Nothing sends until the client switches it to live.
        </p>
      )}

      {/* The line */}
      {result ? (
        <p className="text-xs text-green-700 border border-green-200 bg-green-50 px-3 py-2" role="status">
          {result.kind === 'sent'
            ? `Sent. ${item.name ? item.name.split(/\s+/)[0] : 'The expert'} has the intro.`
            : 'Line saved, but the intro did not send. It waits as a draft on the project.'}
        </p>
      ) : (
        <div className="space-y-2">
          <label
            htmlFor={fieldId}
            className="block text-[10px] uppercase tracking-widest text-muted"
            style={{ letterSpacing: '0.14em' }}
          >
            Why them
          </label>
          <textarea
            id={fieldId}
            value={line}
            onChange={e => { setLine(e.target.value); setErrMsg(''); setHints([]); }}
            placeholder="You ran distribution in the Southeast for Sysco for six years"
            rows={2}
            disabled={busy}
            aria-describedby={errMsg ? `${helpId} ${errorId}` : helpId}
            aria-invalid={errMsg ? true : undefined}
            className={`w-full border bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50 resize-none disabled:opacity-60 ${
              errMsg || tooLong ? 'border-red-300' : 'border-frame'
            }`}
          />
          <div className="flex items-start justify-between gap-3">
            <p id={helpId} className="text-[10px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>
              One fact from their background. &ldquo;So I think you&apos;d be a great fit for my client&rdquo; is added for you.
            </p>
            <span className={`text-[10px] shrink-0 ${tooLong ? 'text-red-600' : 'text-muted'}`}>
              {trimmed.length}/{MAX_LINE_CHARS}
            </span>
          </div>

          {errMsg && (
            <div id={errorId} className="border border-red-200 bg-red-50 px-3 py-2" role="alert">
              <p className="text-xs text-red-600">{errMsg}</p>
              {hints.length > 0 && (
                <ul className="mt-1 list-disc pl-4 space-y-0.5">
                  {hints.map((hint, i) => <li key={i} className="text-[11px] text-red-600">{hint}</li>)}
                </ul>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => { void send(); }}
            disabled={!trimmed || tooLong || busy}
            className="w-full sm:w-auto text-[10px] uppercase tracking-widest px-4 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            style={{ background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.14em' }}
          >
            {busy ? 'Sending…' : 'Add the line and send'}
          </button>
        </div>
      )}
    </article>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function HeldIntrosPage() {
  const [items,   setItems]   = useState<HeldIntro[]>([]);
  const [loading, setLoading] = useState(true);
  const [errMsg,  setErrMsg]  = useState('');
  const [settled, setSettled] = useState(0);

  const load = useCallback(() => {
    setLoading(true);
    setErrMsg('');
    setSettled(0);
    fetch('/api/admin/held-intros')
      .then(async r => {
        const data = await r.json().catch(() => ({})) as { items?: HeldIntro[]; message?: string; error?: string };
        if (!r.ok) throw new Error(data.message ?? 'Could not load the held intros.');
        return data.items ?? [];
      })
      .then(setItems)
      .catch((e: unknown) => setErrMsg(e instanceof Error ? e.message : 'Could not load the held intros.'))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  const waiting = items.length - settled;

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between gap-4">
          <Link
            href="/app"
            className="font-display text-cream font-semibold shrink-0"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <nav className="flex items-center gap-5">
            <Link
              href="/admin/requests"
              className="text-[10px] uppercase tracking-widest text-gold/60 hover:text-gold transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              Admin console
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 sm:px-10 py-10 space-y-6">
        <div className="flex items-center gap-4">
          <p
            className="text-[10px] uppercase tracking-widest text-muted font-medium shrink-0"
            style={{ letterSpacing: '0.2em' }}
          >
            Intros Waiting For A Line{!loading && !errMsg && waiting > 0 ? ` (${waiting})` : ''}
          </p>
          <div className="flex-1 h-px bg-frame" />
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2.5 py-1 transition-colors disabled:opacity-40 shrink-0"
            style={{ letterSpacing: '0.12em' }}
          >
            Refresh
          </button>
        </div>

        <p className="text-[11px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>
          Matchy could not write the personal first line for these intros, so nothing has gone to the
          expert. Write one fact from their background and send. The line is screened and checked
          against the outreach rubric first.
        </p>

        {loading ? (
          <div className="space-y-3" aria-busy="true">
            {[1, 2].map(i => (
              <div key={i} className="border border-frame bg-white px-5 py-4 space-y-2">
                <div className="h-3 w-1/3 bg-frame rounded animate-pulse" />
                <div className="h-4 w-1/2 bg-frame rounded animate-pulse" />
                <div className="h-12 w-full bg-frame rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : errMsg ? (
          <div className="border border-red-200 bg-red-50 px-4 py-3" role="alert">
            <p className="text-xs text-red-600">{errMsg}</p>
            <button
              onClick={load}
              className="mt-2 text-[10px] uppercase tracking-widest text-red-500 hover:text-red-700 transition-colors"
              style={{ letterSpacing: '0.12em' }}
            >
              Try again
            </button>
          </div>
        ) : items.length === 0 ? (
          <p className="text-sm text-muted py-6">Nothing is waiting for a line.</p>
        ) : (
          <div className="space-y-3">
            {items.map(item => (
              <HeldIntroCard
                key={`${item.projectId}:${item.expertId}`}
                item={item}
                onSettled={() => setSettled(n => n + 1)}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

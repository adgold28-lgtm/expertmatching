'use client';

// Adding one expert to an approved request, and killing a link that should not
// have gone out (docs/SCREENING_FLOW_PLAN.md, build step 5).
//
// PLATFORM STAFF ONLY, and the reason is the anonymity boundary rather than a
// permission table: minting a link needs the expert's name and address, and a
// client is never allowed to hold either. So a client cannot "copy a link" for
// an expert by construction — staff add the candidate and either email the link
// or hand it over out of band. /requests/[id] renders this panel only when
// `request.isAdmin`, and POST /api/requests/[id]/tokens runs adminGuard again
// on its own, because a component that decides who may call a route is a
// component one stale bundle away from being wrong.
//
// THE LINK IS SHOWN ONCE. It is a signed single-use token; the platform stores
// only its sha256, so there is no screen anywhere that can show it again. The
// result block says so, and revoking and re-inviting is the honest recovery.
//
// SENDING CAN BE HELD, AND A HELD SEND IS NOT A FAILURE TO HIDE. Emails off in
// this environment, an address on the do-not-contact list, a suppression list
// that could not be reached, a send that bounced at the provider — each gets
// its own sentence saying what happened and what to do, because "Sent." over a
// suppressed address is how a platform mails someone who asked it not to.
//
// Never renders the expert's address back to anyone but the staff member who
// typed it, and never logs anything.

import { useCallback, useRef, useState } from 'react';
import type { RespondentView, ScreeningRequestView } from '../../lib/screeningView';

// ─── Wire shapes ──────────────────────────────────────────────────────────────

type Held = 'disabled' | 'suppressed' | 'suppression_unavailable' | 'send_failed';

interface MintEnvelope {
  respondent?: RespondentView;
  link?:       string;
  sent?:       boolean;
  held?:       Held;
  error?:      string;
  message?:    string;
  field?:      string;
  errors?:     Array<{ field?: string; error?: string; message?: string }>;
}

interface Result {
  link:  string;
  sent:  boolean;
  held?: Held;
  /** What staff typed, echoed back in "Sent to …" — never read from the wire. */
  email: string | null;
}

interface BackgroundLine {
  company: string;
  role:    string;
  dates:   string;
}

// ─── Copy ─────────────────────────────────────────────────────────────────────

const NETWORK_MESSAGE = 'We could not reach the server. Check your connection and try again.';

const MAX_LINES = 8;

const LABEL_STYLE = { letterSpacing: '0.16em' } as const;
const LABEL_CLASS = 'block text-[10px] uppercase text-muted';
const INPUT_CLASS = 'input-search w-full bg-white px-3 py-2 text-sm text-ink border disabled:bg-cream-dark disabled:text-muted';

/** One sentence per reason a send did not happen. Never "Sent." for any of them. */
const HELD_SENTENCE: Record<Held, string> = {
  disabled:                'Email is switched off in this environment; copy the link instead.',
  suppressed:              'This address has opted out. Do not email it; the link was not sent.',
  suppression_unavailable: 'Couldn’t check the do-not-contact list, so nothing was sent. Copy the link or try again.',
  send_failed:             'The email did not go out. Copy the link and send it yourself.',
};

const EMPTY_LINE: BackgroundLine = { company: '', role: '', dates: '' };

function formatDate(iso: string): string {
  const parsed = new Date(iso);
  if (Number.isNaN(parsed.getTime())) return '';
  return parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function FieldError({ id, message }: { id: string; message: string | undefined }) {
  if (!message) return null;
  return (
    <p id={id} role="alert" className="mt-1.5 text-[11px] leading-relaxed text-red-600">{message}</p>
  );
}

// ─── The panel ────────────────────────────────────────────────────────────────

interface InvitePanelProps {
  request:  ScreeningRequestView;
  onChange: (next: ScreeningRequestView) => void;
}

export default function InvitePanel({ request, onChange }: InvitePanelProps) {
  const [name,     setName]     = useState('');
  const [headline, setHeadline] = useState('');
  const [email,    setEmail]    = useState('');
  const [send,     setSend]     = useState(false);
  const [lines,    setLines]    = useState<BackgroundLine[]>([{ ...EMPTY_LINE }]);

  const [busy,      setBusy]      = useState<'create' | 'revoke' | null>(null);
  const [revoking,  setRevoking]  = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [notice,    setNotice]    = useState<string | null>(null);
  const [issues,    setIssues]    = useState<Record<string, string>>({});
  const [result,    setResult]    = useState<Result | null>(null);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'select'>('idle');

  const linkRef = useRef<HTMLInputElement | null>(null);

  const setLine = useCallback((index: number, field: keyof BackgroundLine, value: string) => {
    setLines(current => current.map((line, i) => (i === index ? { ...line, [field]: value } : line)));
    setIssues(current => {
      const key = `background[${index}].${field}`;
      if (!current[key]) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);

  const addLine = useCallback(() => {
    setLines(current => (current.length >= MAX_LINES ? current : [...current, { ...EMPTY_LINE }]));
  }, []);

  // Genuinely 0 to 8: a candidate with no recorded background is a real case,
  // and a row that cannot be removed would be a row staff have to blank instead.
  const removeLine = useCallback((index: number) => {
    setLines(current => current.filter((_, i) => i !== index));
    setIssues({});
  }, []);

  const resetForm = useCallback(() => {
    setName('');
    setHeadline('');
    setEmail('');
    setSend(false);
    setLines([{ ...EMPTY_LINE }]);
    setIssues({});
  }, []);

  // ── Create ───────────────────────────────────────────────────────────────
  const create = useCallback(async () => {
    setBusy('create');
    setNotice(null);
    setIssues({});
    setResult(null);
    setCopyState('idle');

    // A row the staff member added and left blank is not a background line.
    // The indices of what is SENT are what a 400 points at, so the mapping back
    // to the row on screen is kept rather than recomputed.
    const kept = lines
      .map((line, index) => ({ line, index }))
      .filter(entry => entry.line.company.trim() !== ''
        || entry.line.role.trim() !== ''
        || entry.line.dates.trim() !== '');

    const typedEmail = email.trim();

    try {
      const res = await fetch(`/api/requests/${request.id}/tokens`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name:       name.trim(),
          headline:   headline.trim(),
          background: kept.map(entry => ({
            company: entry.line.company.trim(),
            role:    entry.line.role.trim(),
            dates:   entry.line.dates.trim(),
          })),
          email: typedEmail === '' ? undefined : typedEmail,
          send:  send && typedEmail !== '',
        }),
      });
      const data: MintEnvelope | null = await res.json().catch(() => null);

      if (res.status === 403) {
        setNotice('Only platform staff can invite experts.');
        return;
      }

      if (res.status === 400) {
        const mapped: Record<string, string> = {};
        let unplaced = false;
        for (const issue of data?.errors ?? []) {
          const field = issue.field ?? '';
          const message = issue.message ?? '';
          if (!message) { unplaced = true; continue; }

          const line = /^background\[(\d+)\]\.(company|role|dates)$/.exec(field);
          if (line) {
            const row = kept[parseInt(line[1], 10)];
            if (row) mapped[`background[${row.index}].${line[2]}`] = message;
            else unplaced = true;
            continue;
          }
          if (field === 'name' || field === 'headline' || field === 'email') {
            mapped[field] = message;
            continue;
          }
          unplaced = true;
        }
        setIssues(mapped);
        if (unplaced || Object.keys(mapped).length === 0) {
          setNotice(data?.message ?? 'Some of those details could not be used. Check the fields below.');
        }
        return;
      }

      if (!res.ok || !data?.respondent || !data.link) {
        setNotice(data?.message ?? 'We could not create that screening link. Try again.');
        return;
      }

      setResult({
        link:  data.link,
        sent:  data.sent === true,
        held:  data.held,
        email: typedEmail === '' ? null : typedEmail,
      });
      // Appended, not re-sorted: an unanswered link belongs at the end of the
      // server's order until the next load puts it where it belongs.
      onChange({ ...request, respondents: [...request.respondents, data.respondent] });
      resetForm();
    } catch {
      setNotice(NETWORK_MESSAGE);
    } finally {
      setBusy(null);
    }
  }, [request, name, headline, email, send, lines, onChange, resetForm]);

  // ── Copy ─────────────────────────────────────────────────────────────────
  const copy = useCallback(async () => {
    const link = result?.link;
    if (!link) return;
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(link);
        setCopyState('copied');
        return;
      }
    } catch {
      // Permission refused or no secure context — the select fallback below.
    }
    const field = linkRef.current;
    if (field) {
      field.focus();
      field.select();
    }
    setCopyState('select');
  }, [result]);

  // ── Revoke ───────────────────────────────────────────────────────────────
  const revoke = useCallback(async (respondent: RespondentView) => {
    setBusy('revoke');
    setRevoking(respondent.id);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/requests/${request.id}/tokens/${respondent.id}/revoke`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      const data: MintEnvelope | null = await res.json().catch(() => null);

      if (res.status === 403) {
        setNotice('Only platform staff can invite experts.');
        return;
      }
      if (!res.ok || !data?.respondent) {
        setNotice(data?.message ?? 'We could not revoke that link. Try again.');
        return;
      }
      const next = data.respondent;
      onChange({
        ...request,
        respondents: request.respondents.map(r => (r.id === next.id ? next : r)),
      });
      setConfirming(null);
    } catch {
      setNotice(NETWORK_MESSAGE);
    } finally {
      setBusy(null);
      setRevoking(null);
    }
  }, [request, onChange]);

  const working  = busy !== null;
  const openLinks = request.respondents.filter(r => r.submittedAt === null && r.revokedAt === null);
  const canSend  = email.trim() !== '';

  return (
    <section className="border border-frame bg-white">
      <header className="px-5 sm:px-6 py-4 border-b border-frame">
        <h2 className="text-[11px] uppercase font-medium text-navy" style={LABEL_STYLE}>
          Invite an expert
        </h2>
        <p className="mt-1.5 text-xs leading-relaxed text-muted">
          The expert never sees the client&apos;s name or firm; the client never sees the
          expert&apos;s name or address.
        </p>
      </header>

      <div className="px-5 sm:px-6 py-5 space-y-6">

        {/* ── The link, shown once ── */}
        {result && (
          <div className="border border-gold/40 bg-gold/5 px-4 py-4">
            <p className="text-[10px] uppercase text-navy" style={LABEL_STYLE}>Screening link</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              This is the only time we can show it — we store a hash, not the link.
            </p>
            <div className="mt-3 flex flex-col sm:flex-row gap-2">
              <input
                ref={linkRef}
                type="text"
                readOnly
                value={result.link}
                aria-label="Screening link"
                onFocus={e => e.currentTarget.select()}
                className={`${INPUT_CLASS} border-frame font-mono text-[11px]`}
              />
              <button
                type="button"
                onClick={() => void copy()}
                className="shrink-0 text-[10px] uppercase tracking-widest text-navy border border-frame bg-white px-3 py-2 hover:bg-cream transition-colors"
                style={LABEL_STYLE}
              >
                Copy
              </button>
            </div>
            {copyState === 'copied' && (
              <p role="status" className="mt-2 text-[11px] leading-relaxed text-muted">Copied.</p>
            )}
            {copyState === 'select' && (
              <p role="status" className="mt-2 text-[11px] leading-relaxed text-muted">
                We selected the link — copy it with Ctrl-C (Cmd-C on a Mac).
              </p>
            )}

            <p className="mt-3 text-[11px] leading-relaxed text-ink-light">
              {result.sent && result.email
                ? `Sent to ${result.email}.`
                : result.held
                  ? HELD_SENTENCE[result.held]
                  : 'Nothing was emailed. Send the link yourself.'}
            </p>

            <button
              type="button"
              onClick={() => { setResult(null); setCopyState('idle'); }}
              className="mt-3 text-[10px] uppercase text-navy underline underline-offset-2 hover:opacity-70 transition-opacity"
              style={{ letterSpacing: '0.14em' }}
            >
              Done
            </button>
          </div>
        )}

        {/* ── Panel-level problem ── */}
        {notice && (
          <div role="alert" className="border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-xs leading-relaxed text-red-700">{notice}</p>
          </div>
        )}

        {/* ── The form ── */}
        <form
          onSubmit={e => { e.preventDefault(); void create(); }}
          className="space-y-5"
        >
          <div>
            <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor="invite-name">Name</label>
            <input
              id="invite-name"
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              disabled={working}
              required
              autoComplete="off"
              aria-invalid={issues.name ? true : undefined}
              aria-describedby={issues.name ? 'invite-name-error' : undefined}
              className={`mt-1.5 ${INPUT_CLASS} ${issues.name ? 'border-red-300' : 'border-frame'}`}
            />
            <FieldError id="invite-name-error" message={issues.name} />
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              Staff-only. The client sees &ldquo;Candidate N&rdquo; and the lines below.
            </p>
          </div>

          <div>
            <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor="invite-headline">
              Headline <span className="normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="invite-headline"
              type="text"
              value={headline}
              onChange={e => setHeadline(e.target.value)}
              disabled={working}
              autoComplete="off"
              placeholder="VP Supply Chain, mid-market distributor"
              aria-invalid={issues.headline ? true : undefined}
              aria-describedby={issues.headline ? 'invite-headline-error' : undefined}
              className={`mt-1.5 ${INPUT_CLASS} ${issues.headline ? 'border-red-300' : 'border-frame'}`}
            />
            <FieldError id="invite-headline-error" message={issues.headline} />
          </div>

          <div>
            <p className={LABEL_CLASS} style={LABEL_STYLE}>Background</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-muted">
              Up to {MAX_LINES} lines. The company is what the client reads; a line with no
              company is dropped.
            </p>
            {lines.length === 0 && (
              <p className="mt-2.5 text-xs leading-relaxed text-muted">
                No background lines. The client will read &ldquo;No background recorded&rdquo;.
              </p>
            )}
            <ul className="mt-2.5 space-y-2.5">
              {lines.map((line, index) => {
                const companyError = issues[`background[${index}].company`];
                const roleError    = issues[`background[${index}].role`];
                const datesError   = issues[`background[${index}].dates`];
                return (
                  <li key={index} className="border border-frame bg-cream/40 px-3 py-3">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                      <div>
                        <label className="sr-only" htmlFor={`invite-company-${index}`}>
                          Company, line {index + 1}
                        </label>
                        <input
                          id={`invite-company-${index}`}
                          type="text"
                          value={line.company}
                          onChange={e => setLine(index, 'company', e.target.value)}
                          disabled={working}
                          autoComplete="off"
                          placeholder="Company"
                          aria-invalid={companyError ? true : undefined}
                          className={`${INPUT_CLASS} ${companyError ? 'border-red-300' : 'border-frame'}`}
                        />
                      </div>
                      <div>
                        <label className="sr-only" htmlFor={`invite-role-${index}`}>
                          Role, line {index + 1}
                        </label>
                        <input
                          id={`invite-role-${index}`}
                          type="text"
                          value={line.role}
                          onChange={e => setLine(index, 'role', e.target.value)}
                          disabled={working}
                          autoComplete="off"
                          placeholder="Role"
                          aria-invalid={roleError ? true : undefined}
                          className={`${INPUT_CLASS} ${roleError ? 'border-red-300' : 'border-frame'}`}
                        />
                      </div>
                      <div>
                        <label className="sr-only" htmlFor={`invite-dates-${index}`}>
                          Dates, line {index + 1}
                        </label>
                        <input
                          id={`invite-dates-${index}`}
                          type="text"
                          value={line.dates}
                          onChange={e => setLine(index, 'dates', e.target.value)}
                          disabled={working}
                          autoComplete="off"
                          placeholder="2019–2023"
                          aria-invalid={datesError ? true : undefined}
                          className={`${INPUT_CLASS} ${datesError ? 'border-red-300' : 'border-frame'}`}
                        />
                      </div>
                    </div>
                    {[companyError, roleError, datesError].filter(Boolean).map((message, i) => (
                      <p key={i} role="alert" className="mt-1.5 text-[11px] leading-relaxed text-red-600">
                        {message}
                      </p>
                    ))}
                    <div className="mt-2 text-right">
                      <button
                        type="button"
                        onClick={() => removeLine(index)}
                        disabled={working}
                        className="text-[10px] uppercase text-navy underline underline-offset-2 hover:opacity-70 disabled:opacity-40 transition-opacity"
                        style={{ letterSpacing: '0.14em' }}
                      >
                        Remove line
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
            {lines.length < MAX_LINES && (
              <button
                type="button"
                onClick={addLine}
                disabled={working}
                className="mt-2.5 text-[10px] uppercase tracking-widest text-navy border border-frame px-3 py-2 hover:bg-cream disabled:opacity-40 transition-colors"
                style={LABEL_STYLE}
              >
                Add a line
              </button>
            )}
          </div>

          <div>
            <label className={LABEL_CLASS} style={LABEL_STYLE} htmlFor="invite-email">
              Email <span className="normal-case tracking-normal">(optional)</span>
            </label>
            <input
              id="invite-email"
              type="email"
              value={email}
              onChange={e => {
                setEmail(e.target.value);
                if (e.target.value.trim() === '') setSend(false);
              }}
              disabled={working}
              autoComplete="off"
              aria-invalid={issues.email ? true : undefined}
              aria-describedby={issues.email ? 'invite-email-error' : undefined}
              className={`mt-1.5 ${INPUT_CLASS} ${issues.email ? 'border-red-300' : 'border-frame'}`}
            />
            <FieldError id="invite-email-error" message={issues.email} />

            <label className="mt-2.5 flex items-start gap-2 text-xs leading-relaxed text-ink">
              <input
                type="checkbox"
                checked={send && canSend}
                onChange={e => setSend(e.target.checked)}
                disabled={working || !canSend}
                className="mt-0.5"
              />
              <span className={canSend ? '' : 'text-muted'}>
                Email the link
                {!canSend && ' — add an address first'}
              </span>
            </label>
          </div>

          <div>
            <button
              type="submit"
              disabled={working || name.trim() === ''}
              className="w-full sm:w-auto text-[10px] uppercase tracking-widest text-navy bg-gold border border-gold px-4 py-2.5 hover:bg-gold/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              style={LABEL_STYLE}
            >
              {busy === 'create' ? 'Creating…' : 'Create screening link'}
            </button>
          </div>
        </form>

        {/* ── Open links ── */}
        <div className="border-t border-frame pt-5">
          <h3 className={LABEL_CLASS} style={LABEL_STYLE}>Open links</h3>
          {openLinks.length === 0 ? (
            <p className="mt-1.5 text-xs leading-relaxed text-muted">
              No screening link is waiting on a reply.
            </p>
          ) : (
            <ul className="mt-2.5 divide-y divide-frame">
              {openLinks.map(respondent => (
                <li key={respondent.id} className="py-3 first:pt-0 last:pb-0">
                  <div className="flex items-start justify-between gap-3 flex-wrap">
                    <div className="min-w-0">
                      <p className="flex items-baseline gap-2 flex-wrap">
                        <span className="text-[10px] uppercase text-navy" style={LABEL_STYLE}>
                          {respondent.label}
                        </span>
                        {respondent.name && (
                          <span className="text-xs text-ink">{respondent.name}</span>
                        )}
                      </p>
                      <p className="mt-1 text-[11px] leading-relaxed text-muted">
                        Expires {formatDate(respondent.expiresAt)}
                      </p>
                    </div>

                    {confirming === respondent.id ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <span className="text-[11px] text-ink">Revoke this link?</span>
                        <button
                          type="button"
                          onClick={() => void revoke(respondent)}
                          disabled={working}
                          className="text-[10px] uppercase tracking-widest text-cream bg-navy px-2.5 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                          style={LABEL_STYLE}
                        >
                          {revoking === respondent.id ? 'Revoking…' : 'Yes'}
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirming(null)}
                          disabled={working}
                          className="text-[10px] uppercase tracking-widest text-navy border border-frame px-2.5 py-1.5 hover:bg-cream disabled:opacity-40 transition-colors"
                          style={LABEL_STYLE}
                        >
                          Keep
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirming(respondent.id)}
                        disabled={working}
                        className="shrink-0 text-[10px] uppercase tracking-widest text-navy border border-frame px-2.5 py-1.5 hover:bg-cream disabled:opacity-40 transition-colors"
                        style={LABEL_STYLE}
                      >
                        Revoke
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  );
}

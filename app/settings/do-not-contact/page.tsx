'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  DNC_COPY,
  DO_NOT_CONTACT_KINDS,
  DO_NOT_CONTACT_LIMIT,
  KIND_LABELS,
  UPLOAD_MAX_BYTES,
  countByKind,
  detectKind,
  normalizeEntry,
  type DoNotContactKind,
  type RejectedLine,
} from '../../../lib/doNotContact';

// -----------------------------------------------------------------------------
// /settings/do-not-contact: the firm's own do-not-contact list. Companies,
// people, single addresses and whole domains Matchy must never write to. The
// rules (what matches what) are lib/doNotContact.ts; every read and write goes
// through /api/org/do-not-contact (GET, POST) and /api/org/do-not-contact/[id]
// (DELETE).
//
// The champion (org_admin) and platform staff see the whole list and change
// it. Everyone else sees the count and that the champion manages it: the GET
// answers `canManage: false` with no entries, so this page has no
// authorization of its own and only reacts to what the server sends.
//
// Until the launch-pack migration is applied the GET answers 503
// `not_available`, and the page says the list will be available shortly.
//
// Mobile-first: forms and rows stack on a phone and go side by side from sm.
// -----------------------------------------------------------------------------

// ─── Types (mirror /api/org/do-not-contact) ───────────────────────────────────

interface Entry {
  id:        string;
  kind:      DoNotContactKind;
  value:     string;
  createdAt: string;
}

interface ListResponse {
  organization: { id: string; name: string };
  canManage:    boolean;
  limit:        number;
  counts:       { total: number };
  entries?:     Entry[];
  message?:     string;
}

interface WriteResponse {
  ok?:            boolean;
  added?:         number;
  alreadyListed?: number;
  rejected?:      RejectedLine[];
  rejectedCount?: number;
  overLimit?:     number;
  error?:         string;
  message?:       string;
}

interface UploadSummary {
  added:         number;
  alreadyListed: number;
  rejected:      RejectedLine[];
  rejectedCount: number;
  overLimit:     number;
}

// ─── Copy ─────────────────────────────────────────────────────────────────────

const PLURAL: Record<DoNotContactKind, string> = {
  company: 'Companies',
  person:  'People',
  email:   'Emails',
  domain:  'Domains',
};

const PLACEHOLDER: Record<DoNotContactKind, string> = {
  company: 'Acme Corp',
  person:  'Jane Okafor',
  email:   'jane@acme.com',
  domain:  'acme.com',
};

const HINT: Record<DoNotContactKind, string> = {
  company: 'Matches the company an expert works at, and any company whose name starts with it (Meta also covers Meta Platforms). Inc, LLC and the like are ignored.',
  person:  'Matches first and last name. Middle names and initials are ignored.',
  email:   'Matches this one address.',
  domain:  'Matches every address at this domain, and its subdomains.',
};

const SHOWN_ROWS = 200;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return await res.json() as T;
  } catch {
    return null;
  }
}

// ─── Shared UI ────────────────────────────────────────────────────────────────

function SectionHeader({ title }: { title: string }) {
  return (
    <div className="flex items-center gap-4 mb-5">
      <p
        className="text-[10px] uppercase tracking-widest text-muted font-medium shrink-0"
        style={{ letterSpacing: '0.2em' }}
      >
        {title}
      </p>
      <div className="flex-1 h-px bg-frame" />
    </div>
  );
}

function KindBadge({ kind }: { kind: DoNotContactKind }) {
  return (
    <span
      className="text-[10px] px-2 py-0.5 uppercase tracking-widest font-medium border border-frame text-muted shrink-0"
      style={{ letterSpacing: '0.1em' }}
    >
      {KIND_LABELS[kind]}
    </span>
  );
}

const inputClass =
  'w-full border border-frame bg-cream px-3 py-2.5 text-xs text-ink focus:outline-none focus:border-navy transition-colors placeholder-muted/50 disabled:opacity-60';
const labelClass = 'block text-[10px] uppercase tracking-widest text-muted mb-1.5';
const primaryButtonClass =
  'text-[10px] uppercase tracking-widest px-5 py-2.5 transition-colors disabled:opacity-40 disabled:cursor-not-allowed shrink-0';
const primaryButtonStyle = { background: '#0B1F3B', color: '#C6A75E', letterSpacing: '0.14em' };

// ─── Add one ──────────────────────────────────────────────────────────────────

function AddOne({ onAdded }: { onAdded: () => void }) {
  const [kind,        setKind]        = useState<DoNotContactKind>('company');
  const [kindTouched, setKindTouched] = useState(false);
  const [value,       setValue]       = useState('');
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState('');
  const [note,        setNote]        = useState('');

  function onValueChange(next: string) {
    setValue(next);
    setError('');
    setNote('');
    // An email or a domain is recognised on sight; anything else keeps the
    // last company/person choice. Once the user picks a kind, it stays picked.
    if (!kindTouched) {
      const seen = detectKind(next);
      setKind(seen ?? (kind === 'person' ? 'person' : 'company'));
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    const checked = normalizeEntry(kind, value);
    if (!checked.ok) { setError(checked.reason); return; }

    setBusy(true);
    setError('');
    setNote('');
    try {
      const res  = await fetch('/api/org/do-not-contact', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ kind, value: checked.value }),
      });
      const data = await readJson<WriteResponse>(res);
      if (!res.ok) {
        setError(data?.message ?? 'Something went wrong. Try again.');
        return;
      }
      setNote(data?.added ? `Added ${checked.value}.` : `${checked.value} is already on the list.`);
      setValue('');
      setKindTouched(false);
      onAdded();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3" noValidate>
      <div className="grid grid-cols-1 sm:grid-cols-[150px_1fr_auto] gap-3 sm:items-end">
        <div>
          <label htmlFor="dnc-kind" className={labelClass} style={{ letterSpacing: '0.14em' }}>
            Kind
          </label>
          <select
            id="dnc-kind"
            value={kind}
            onChange={e => {
              setKind(e.target.value as DoNotContactKind);
              setKindTouched(true);
              setError('');
            }}
            disabled={busy}
            className={inputClass}
          >
            {DO_NOT_CONTACT_KINDS.map(k => (
              <option key={k} value={k}>{KIND_LABELS[k]}</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="dnc-value" className={labelClass} style={{ letterSpacing: '0.14em' }}>
            {KIND_LABELS[kind]}
          </label>
          <input
            id="dnc-value"
            type="text"
            value={value}
            onChange={e => onValueChange(e.target.value)}
            placeholder={PLACEHOLDER[kind]}
            maxLength={200}
            disabled={busy}
            autoComplete="off"
            className={inputClass}
          />
        </div>
        <button
          type="submit"
          disabled={busy || !value.trim()}
          className={primaryButtonClass}
          style={primaryButtonStyle}
        >
          {busy ? 'Adding…' : 'Add'}
        </button>
      </div>
      <p className="text-[11px] text-muted" style={{ fontWeight: 300 }}>{HINT[kind]}</p>
      <div aria-live="polite">
        {error && <p className="text-[11px] text-red-600">{error}</p>}
        {note  && <p className="text-[11px] text-green-700">{note}</p>}
      </div>
    </form>
  );
}

// ─── Add many ─────────────────────────────────────────────────────────────────

function AddMany({ onAdded }: { onAdded: () => void }) {
  const [text,        setText]        = useState('');
  const [fileName,    setFileName]    = useState('');
  const [defaultKind, setDefaultKind] = useState<'company' | 'person'>('company');
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState('');
  const [summary,     setSummary]     = useState<UploadSummary | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const lineCount = useMemo(
    () => (text ? text.split(/\r\n|\r|\n/).filter(l => l.trim() !== '').length : 0),
    [text],
  );

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError('');
    setSummary(null);
    if (!/\.(csv|txt)$/i.test(file.name)) {
      setError('Choose a .csv or .txt file.');
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      setError('That file is too large. Keep it under 1 MB.');
      return;
    }
    try {
      setText(await file.text());
      setFileName(file.name);
    } catch {
      setError("Couldn't read that file. Try again, or paste the list instead.");
    }
  }

  async function submit() {
    if (busy || !text.trim()) return;
    if (new Blob([text]).size > UPLOAD_MAX_BYTES) {
      setError('That list is too large. Keep it under 1 MB.');
      return;
    }
    setBusy(true);
    setError('');
    setSummary(null);
    try {
      const res  = await fetch('/api/org/do-not-contact', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ upload: text, defaultKind }),
      });
      const data = await readJson<WriteResponse>(res);
      if (!res.ok) {
        setError(data?.message ?? 'Something went wrong. Try again.');
        // A 400 still says which lines could not be used.
        if (data?.rejected?.length) {
          setSummary({
            added:         0,
            alreadyListed: 0,
            rejected:      data.rejected,
            rejectedCount: data.rejectedCount ?? data.rejected.length,
            overLimit:     data.overLimit ?? 0,
          });
        }
        return;
      }
      setSummary({
        added:         data?.added ?? 0,
        alreadyListed: data?.alreadyListed ?? 0,
        rejected:      data?.rejected ?? [],
        rejectedCount: data?.rejectedCount ?? 0,
        overLimit:     data?.overLimit ?? 0,
      });
      setText('');
      setFileName('');
      onAdded();
    } catch {
      setError("Couldn't reach the server. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <div>
        <label htmlFor="dnc-upload" className={labelClass} style={{ letterSpacing: '0.14em' }}>
          Paste a list
        </label>
        <textarea
          id="dnc-upload"
          value={text}
          onChange={e => { setText(e.target.value); setFileName(''); setError(''); setSummary(null); }}
          rows={6}
          disabled={busy}
          spellCheck={false}
          placeholder={'One per line, or kind,value on each line. For example:\nAcme Corp\njane@acme.com\nperson,Jane Okafor'}
          className={`${inputClass} font-mono leading-relaxed resize-y`}
        />
      </div>

      <div className="flex flex-col sm:flex-row sm:items-end gap-3">
        <div className="flex-1 min-w-0">
          <label htmlFor="dnc-default" className={labelClass} style={{ letterSpacing: '0.14em' }}>
            Other lines are
          </label>
          <select
            id="dnc-default"
            value={defaultKind}
            onChange={e => setDefaultKind(e.target.value === 'person' ? 'person' : 'company')}
            disabled={busy}
            className={inputClass}
          >
            <option value="company">Companies</option>
            <option value="person">People</option>
          </select>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.txt,text/csv,text/plain"
            onChange={onFile}
            className="hidden"
            aria-hidden
            tabIndex={-1}
          />
          <button
            type="button"
            onClick={() => fileRef.current?.click()}
            disabled={busy}
            className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-4 py-2.5 transition-colors disabled:opacity-40 shrink-0"
            style={{ letterSpacing: '0.12em' }}
          >
            Upload .csv or .txt
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={busy || !text.trim()}
            className={primaryButtonClass}
            style={primaryButtonStyle}
          >
            {busy ? 'Adding…' : 'Add list'}
          </button>
        </div>
      </div>

      <p className="text-[11px] text-muted" style={{ fontWeight: 300 }}>
        {fileName ? `${fileName} · ` : ''}
        {lineCount > 0 ? `${plural(lineCount, 'line', 'lines')} · ` : ''}
        Emails and domains are recognised on their own. Up to 5,000 entries.
      </p>

      <div aria-live="polite" className="space-y-2">
        {error && <p className="text-[11px] text-red-600">{error}</p>}
        {summary && (
          <div className="border border-frame bg-white px-4 py-3 space-y-2">
            <p className="text-xs text-navy">
              Added {summary.added.toLocaleString('en-US')}.
              {summary.alreadyListed > 0 && ` ${plural(summary.alreadyListed, 'was', 'were')} already on the list.`}
              {summary.rejectedCount > 0 && ` ${plural(summary.rejectedCount, 'line', 'lines')} skipped.`}
              {summary.overLimit > 0 && ` ${plural(summary.overLimit, 'more was', 'more were')} past the 5,000 limit.`}
            </p>
            {summary.rejected.length > 0 && (
              <ul className="space-y-1">
                {summary.rejected.map(r => (
                  <li key={`${r.line}-${r.value}`} className="text-[11px] text-muted break-words">
                    <span className="text-ink">Line {r.line}</span>
                    {r.value ? <>: {r.value}</> : null}
                    <span className="text-red-600"> {r.reason}</span>
                  </li>
                ))}
                {summary.rejectedCount > summary.rejected.length && (
                  <li className="text-[11px] text-muted">
                    And {plural(summary.rejectedCount - summary.rejected.length, 'more line', 'more lines')}.
                  </li>
                )}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── One row ──────────────────────────────────────────────────────────────────

function EntryRow({ entry, onRemoved }: { entry: Entry; onRemoved: (id: string) => void }) {
  const [busy,  setBusy]  = useState(false);
  const [error, setError] = useState('');

  async function remove() {
    if (!confirm(`Remove ${entry.value} from the list? Matchy will be able to contact them again.`)) return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/org/do-not-contact/${encodeURIComponent(entry.id)}`, { method: 'DELETE' });
      if (res.ok || res.status === 404) {
        onRemoved(entry.id);
        return;
      }
      const data = await readJson<WriteResponse>(res);
      setError(data?.message ?? 'Something went wrong. Try again.');
      setBusy(false);
    } catch {
      setError("Couldn't reach the server. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="border border-frame bg-cream px-4 py-3">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-xs text-navy font-medium break-words">{entry.value}</p>
          {formatDate(entry.createdAt) && (
            <p className="text-[10px] text-muted">Added {formatDate(entry.createdAt)}</p>
          )}
        </div>
        <div className="flex items-center gap-3">
          <KindBadge kind={entry.kind} />
          <button
            type="button"
            onClick={remove}
            disabled={busy}
            className="text-[10px] uppercase tracking-widest text-muted hover:text-red-600 border border-frame hover:border-red-300 px-2.5 py-1 transition-colors disabled:opacity-40 shrink-0"
            style={{ letterSpacing: '0.1em' }}
          >
            {busy ? '…' : 'Remove'}
          </button>
        </div>
      </div>
      {error && <p className="text-[10px] text-red-600 mt-2">{error}</p>}
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DoNotContactPage() {
  const [data,         setData]         = useState<ListResponse | null>(null);
  const [entries,      setEntries]      = useState<Entry[]>([]);
  const [loading,      setLoading]      = useState(true);
  const [loadErr,      setLoadErr]      = useState('');
  const [notAvailable, setNotAvailable] = useState(false);
  const [search,       setSearch]       = useState('');
  const [kindFilter,   setKindFilter]   = useState<DoNotContactKind | null>(null);

  const load = useCallback((initial: boolean) => {
    if (initial) setLoading(true);
    setLoadErr('');
    fetch('/api/org/do-not-contact', { cache: 'no-store' })
      .then(async (res) => {
        const body = await readJson<ListResponse & { error?: string; message?: string }>(res);
        if (res.status === 503 && body?.error === 'not_available') {
          setNotAvailable(true);
          return;
        }
        if (!res.ok || !body) {
          throw new Error(body?.message ?? "Couldn't load the list. Try again.");
        }
        setNotAvailable(false);
        setData(body);
        setEntries(body.entries ?? []);
      })
      .catch((e: unknown) => setLoadErr(e instanceof Error ? e.message : "Couldn't load the list. Try again."))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(true); }, [load]);

  const counts = useMemo(() => countByKind(entries), [entries]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter(e =>
      (!kindFilter || e.kind === kindFilter) && (!q || e.value.toLowerCase().includes(q)));
  }, [entries, search, kindFilter]);

  const orgName = data?.organization.name || 'your firm';

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      {/* ── Header ── */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between gap-4">
          <Link
            href="/app"
            className="font-display text-cream font-semibold shrink-0"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <nav className="flex items-center gap-4 sm:gap-5 flex-wrap justify-end">
            <span
              className="text-[10px] uppercase tracking-widest text-gold/80"
              style={{ letterSpacing: '0.18em' }}
            >
              Do not contact
            </span>
            <Link
              href="/settings"
              className="text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              ← Settings
            </Link>
            <Link
              href="/app"
              className="text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              ← Projects
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 sm:px-10 py-8 sm:py-10 space-y-12">
        <div>
          <h1
            className="font-display text-navy"
            style={{ fontSize: '1.5rem', fontWeight: 500, letterSpacing: '0.01em' }}
          >
            Do-not-contact list
          </h1>
          <p className="mt-1.5 text-xs leading-relaxed text-muted" style={{ fontWeight: 300 }}>
            {DNC_COPY.explainer}
          </p>
        </div>

        {loading ? (
          <div className="space-y-2" aria-busy="true">
            {[1, 2, 3].map(i => (
              <div key={i} className="border border-frame bg-cream px-4 py-3">
                <div className="h-3 w-1/3 bg-frame rounded animate-pulse mb-1.5" />
                <div className="h-2.5 w-1/4 bg-frame rounded animate-pulse" />
              </div>
            ))}
          </div>
        ) : notAvailable ? (
          <div className="border border-frame bg-white px-6 py-10 text-center">
            <p className="text-sm font-semibold text-navy">{DNC_COPY.notAvailable}</p>
          </div>
        ) : loadErr ? (
          <div className="border border-red-200 bg-red-50 px-4 py-3">
            <p className="text-xs text-red-600">{loadErr}</p>
            <button
              onClick={() => load(true)}
              className="mt-2 text-[10px] uppercase tracking-widest text-red-500 hover:text-red-700 transition-colors"
              style={{ letterSpacing: '0.12em' }}
            >
              Retry
            </button>
          </div>
        ) : data && !data.canManage ? (
          <div className="border border-frame bg-white px-6 py-10 text-center">
            <p
              className="text-[28px] font-semibold leading-none"
              style={{ color: '#0B1F3B', fontFamily: 'var(--font-display)' }}
            >
              {data.counts.total.toLocaleString('en-US')}
            </p>
            <p className="text-xs text-muted mt-2">
              {data.counts.total === 1 ? 'entry' : 'entries'} on {orgName}&rsquo;s list.
            </p>
            <p className="text-xs text-muted leading-relaxed max-w-sm mx-auto mt-4" style={{ fontWeight: 300 }}>
              {data.message ?? DNC_COPY.championNote}
            </p>
          </div>
        ) : data ? (
          <>
            {/* ── Add one ── */}
            <section>
              <SectionHeader title="Add one" />
              <AddOne onAdded={() => load(false)} />
            </section>

            {/* ── Add many ── */}
            <section>
              <SectionHeader title="Add many" />
              <AddMany onAdded={() => load(false)} />
            </section>

            {/* ── The list ── */}
            <section>
              <SectionHeader title={`On the list (${counts.total.toLocaleString('en-US')} of ${DO_NOT_CONTACT_LIMIT.toLocaleString('en-US')})`} />

              <div className="border border-frame bg-white mb-4">
                <div className="grid grid-cols-2 sm:grid-cols-4 divide-x divide-frame">
                  {DO_NOT_CONTACT_KINDS.map((k, i) => {
                    const active = kindFilter === k;
                    return (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setKindFilter(active ? null : k)}
                        aria-pressed={active}
                        className={`text-left px-5 py-4 transition-colors ${active ? 'bg-navy/5' : 'hover:bg-cream'} ${i < 2 ? 'border-b sm:border-b-0 border-frame' : ''}`}
                      >
                        <p
                          className="text-[20px] font-semibold leading-none"
                          style={{ color: '#0B1F3B', fontFamily: 'var(--font-display)' }}
                        >
                          {counts[k].toLocaleString('en-US')}
                        </p>
                        <p
                          className={`text-[10px] uppercase tracking-widest mt-1.5 ${active ? 'text-navy' : 'text-muted'}`}
                          style={{ letterSpacing: '0.14em' }}
                        >
                          {PLURAL[k]}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </div>

              {entries.length > 0 && (
                <div className="mb-4">
                  <label htmlFor="dnc-search" className="sr-only">Search the list</label>
                  <input
                    id="dnc-search"
                    type="search"
                    value={search}
                    onChange={e => setSearch(e.target.value)}
                    placeholder="Search the list"
                    className={inputClass}
                  />
                </div>
              )}

              {entries.length === 0 ? (
                <p className="text-sm text-muted py-2">
                  Nothing on the list yet. Add a company, person, email or domain above.
                </p>
              ) : filtered.length === 0 ? (
                <p className="text-sm text-muted py-2">
                  Nothing matches{search.trim() ? ` "${search.trim()}"` : ''}
                  {kindFilter ? ` in ${PLURAL[kindFilter].toLowerCase()}` : ''}.
                </p>
              ) : (
                <div className="space-y-2">
                  {filtered.slice(0, SHOWN_ROWS).map(entry => (
                    <EntryRow
                      key={entry.id}
                      entry={entry}
                      onRemoved={id => setEntries(prev => prev.filter(e => e.id !== id))}
                    />
                  ))}
                  {filtered.length > SHOWN_ROWS && (
                    <p className="text-[11px] text-muted pt-2">
                      Showing {SHOWN_ROWS} of {filtered.length.toLocaleString('en-US')}. Search to narrow it down.
                    </p>
                  )}
                </div>
              )}
            </section>
          </>
        ) : null}
      </main>
    </div>
  );
}

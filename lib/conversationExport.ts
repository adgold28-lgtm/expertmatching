// The conversation log export: "an exportable log of every message" for a
// client's compliance officer.
//
//   GET /api/projects/:id/experts/:expertId/messages/export?format=csv|txt
//   GET /api/projects/:id/conversations/export?format=csv|txt
//
// THE RULE: the file holds EXACTLY what this viewer can read in the thread,
// and nothing else. Every row goes through lib/conversations
// .redactMessageForViewer, the same wall the thread's GET uses:
//   • a client gets Matchy's masked summary for every expert message and never
//     the body (Matchy 2.0), Matchy's own copy with the dollar amounts (and,
//     before the reveal, the expert's surname and employer) masked, and their
//     own messages as written;
//   • staff get the clean bodies, as the Staff panel shows them;
//   • body_raw never leaves the server, for anyone.
// The expert is named as the thread names them: the anonymized label
// ("Scott S.") until the call is booked, the first name after.
//
// THE FILE IS A SPREADSHEET SOMEONE WILL OPEN. Every CSV cell is quoted, quotes
// are doubled, and a cell that a spreadsheet would read as a formula (one that
// starts with = + - @, a tab or a carriage return) is prefixed with an
// apostrophe (OWASP, "CSV Injection"). The filename names neither the client's
// firm nor the expert: a short project id, a short one-way hash of the expert
// id for a single thread, and the date.
//
// Pure apart from `listThreads`, which reads through lib/conversations (the one
// sanctioned way into conversation_messages) and is injectable for tests.
// Unit-checked by scripts/test-conversation-export.ts.
//
// Never logs: message text, summaries, expert names, addresses.

import { createHash, createHmac } from 'crypto';
import type { ProjectExpert } from '../types';
import type { ConversationMessageRow } from './supabase/database.types';
import { listThread, redactMessageForViewer, type ViewerMessage } from './conversations';
import { isIdentityRevealed } from './redactExpert';
import { toInitialForm } from './nameValidation';
import { heldLabel } from './walkthrough';
import type { RateLimiterStore } from './rateLimiter';

// ─── Shapes ───────────────────────────────────────────────────────────────────

export type ExportFormat = 'csv' | 'txt';
export type ExportScope  = 'thread' | 'project';
export type ExportRole   = 'admin' | 'user';

export interface ExportRow {
  /** ISO 8601, UTC. */
  timestamp: string;
  /** The expert as the thread names them for this viewer. */
  expert:    string;
  author:    'Client' | 'Matchy' | 'Expert';
  direction: 'From expert' | 'To expert';
  /** Received / Sent / Awaiting approval / the held tag the thread shows. */
  state:     string;
  text:      string;
}

export const EXPORT_COLUMNS = ['Timestamp (UTC)', 'Expert', 'Author', 'Direction', 'State', 'Text'] as const;

/** What a client reads in place of an expert's email (the thread's Matchy line). */
export const SUMMARY_PREFIX = "Matchy's summary: ";

// ─── Request parsing ──────────────────────────────────────────────────────────

/** `?format=` → a format, defaulting to CSV. Anything else is null (400). */
export function parseExportFormat(value: string | null | undefined): ExportFormat | null {
  const v = (value ?? '').trim().toLowerCase();
  if (v === '' || v === 'csv') return 'csv';
  if (v === 'txt') return 'txt';
  return null;
}

// ─── The expert's label ───────────────────────────────────────────────────────

/**
 * "Scott S." before the reveal, "Scott" after it: the thread's own names for
 * the expert. Never the surname before the booking, for any viewer, so a staff
 * export forwarded to a client cannot break the wall either.
 */
export function expertLabel(pe: Pick<ProjectExpert, 'expert' | 'status' | 'booking' | 'zoomMeetingId'>): string {
  const name = (pe.expert?.name ?? '').trim();
  if (isIdentityRevealed(pe)) {
    const first = name.split(/\s+/)[0] ?? '';
    return first || 'Expert';
  }
  return toInitialForm(name) || 'Expert';
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

/** Control characters other than tab and newline never belong in a log. */
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

function clean(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(CONTROL_RE, '').trim();
}

function isoUtc(value: string): string {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

function stateOf(m: ViewerMessage, fromExpert: boolean): string {
  if (fromExpert)        return 'Received';
  if (m.held)            return heldLabel(m.held);
  if (m.pendingApproval) return 'Awaiting approval';
  return 'Sent';
}

/**
 * The text column. It is the redacted message, so the viewer decides what is
 * in it before this runs: for a client an expert message has no body, and the
 * row carries Matchy's summary instead, exactly as the thread does.
 */
function textOf(m: ViewerMessage, fromExpert: boolean): string {
  const body    = clean(m.body ?? '');
  const summary = clean(m.summary ?? '');
  if (fromExpert) {
    if (!body) return summary ? `${SUMMARY_PREFIX}${summary}` : 'Reply received.';
    return summary ? `${body}\n\n${SUMMARY_PREFIX}${summary}` : body;
  }
  return body || summary;
}

export function toExportRow(m: ViewerMessage, label: string): ExportRow {
  const fromExpert = m.direction === 'inbound' || m.author === 'expert';
  return {
    timestamp: isoUtc(m.createdAt),
    expert:    label,
    author:    m.author === 'client' ? 'Client' : m.author === 'matchy' ? 'Matchy' : 'Expert',
    direction: fromExpert ? 'From expert' : 'To expert',
    state:     stateOf(m, fromExpert),
    text:      textOf(m, fromExpert),
  };
}

/**
 * One thread's rows, oldest first, as this viewer reads them. The viewer is
 * built exactly as GET …/messages builds it.
 */
export function threadRows(
  pe: ProjectExpert,
  rows: readonly ConversationMessageRow[],
  role: ExportRole,
  label: string = expertLabel(pe),
): ExportRow[] {
  const viewer = {
    role,
    revealed:       isIdentityRevealed(pe),
    expertFullName: pe.expert.name,
    expertCompany:  pe.expert.company,
  };
  return rows.map(row => toExportRow(redactMessageForViewer(row, viewer), label));
}

export interface ThreadInput {
  pe:   ProjectExpert;
  rows: readonly ConversationMessageRow[];
}

/**
 * Every thread in a project, merged into one chronological log. Two experts
 * who share a label ("Scott S." twice) are told apart with a plain suffix, in
 * the order their threads were given.
 */
export function projectRows(threads: readonly ThreadInput[], role: ExportRole): ExportRow[] {
  const seen = new Map<string, number>();
  const out: ExportRow[] = [];
  for (const { pe, rows } of threads) {
    if (rows.length === 0) continue;
    const base  = expertLabel(pe);
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    const label = count === 1 ? base : `${base} (${count})`;
    out.push(...threadRows(pe, rows, role, label));
  }
  // Stable: rows with the same instant keep their thread order.
  return out
    .map((row, index) => ({ row, index }))
    .sort((a, b) => a.row.timestamp.localeCompare(b.row.timestamp) || a.index - b.index)
    .map(entry => entry.row);
}

// ─── CSV ──────────────────────────────────────────────────────────────────────

/**
 * One CSV cell: quoted, inner quotes doubled, and a would-be formula defused
 * with a leading apostrophe. A cell that opens with whitespace before the
 * trigger character is defused too: some spreadsheets trim before they parse.
 */
export function csvCell(value: string): string {
  const raw = value ?? '';
  const formula = /^[=+\-@\t\r]/.test(raw) || /^\s*[=+\-@]/.test(raw);
  const text = (formula ? `'${raw}` : raw).replace(/\r\n?/g, '\n').replace(CONTROL_RE, '');
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * The CSV file: a UTF-8 byte-order mark (so a spreadsheet reads accents and
 * the middle dot correctly), the header, one line per message, CRLF endings.
 */
export function toCsv(rows: readonly ExportRow[]): string {
  const lines = [
    EXPORT_COLUMNS.map(csvCell).join(','),
    ...rows.map(r => [r.timestamp, r.expert, r.author, r.direction, r.state, r.text].map(csvCell).join(',')),
  ];
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

// ─── Plain text ───────────────────────────────────────────────────────────────

export interface TxtMeta {
  scope:      ExportScope;
  projectId:  string;
  exportedAt: number;
}

/** The same rows, one block per message, for someone who will just read it. */
export function toTxt(rows: readonly ExportRow[], meta: TxtMeta): string {
  const header = [
    meta.scope === 'project' ? 'Conversation log: every thread in the project' : 'Conversation log',
    `Project reference: ${shortProjectId(meta.projectId)}`,
    `Exported: ${new Date(meta.exportedAt).toISOString()}. All times are UTC.`,
    `Messages: ${rows.length}`,
  ];
  const blocks = rows.map(r => [
    [r.timestamp, r.expert, r.author, r.direction, r.state].join(' | '),
    r.text || '(no text)',
  ].join('\n'));
  return `${[header.join('\n'), ...blocks].join('\n\n')}\n`;
}

// ─── Filename and headers ─────────────────────────────────────────────────────

export function shortProjectId(projectId: string): string {
  return projectId.replace(/[^a-z0-9]/gi, '').slice(0, 8).toLowerCase();
}

/** Six hex characters of a one-way hash: tells two threads apart, names nobody. */
function shortThreadRef(expertId: string): string {
  return createHash('sha256').update(expertId).digest('hex').slice(0, 6);
}

/**
 * `conversations-<project>-<yyyy-mm-dd>.csv`, or
 * `conversation-<project>-<thread>-<yyyy-mm-dd>.txt` for one thread. No firm
 * name, no expert name, nothing a filename sync could leak.
 */
export function exportFilename(
  scope: ExportScope,
  projectId: string,
  format: ExportFormat,
  now: number,
  expertId?: string,
): string {
  const day = new Date(now).toISOString().slice(0, 10);
  const project = shortProjectId(projectId);
  return scope === 'thread' && expertId
    ? `conversation-${project}-${shortThreadRef(expertId)}-${day}.${format}`
    : `conversations-${project}-${day}.${format}`;
}

export function exportHeaders(format: ExportFormat, filename: string): Record<string, string> {
  return {
    'Content-Type':           format === 'csv' ? 'text/csv; charset=utf-8' : 'text/plain; charset=utf-8',
    'Content-Disposition':    `attachment; filename="${filename}"`,
    'Cache-Control':          'no-store',
    'X-Content-Type-Options': 'nosniff',
  };
}

// ─── Which experts have a thread ──────────────────────────────────────────────

const BEFORE_ANY_THREAD = new Set<ProjectExpert['status']>(['discovered', 'shortlisted', 'rejected']);

/**
 * True when this engagement may have messages: bookmarked or later, or passed
 * after Matchy had already written to them. A candidate who was only ever in
 * Matches costs no read.
 */
export function mayHaveThread(pe: ProjectExpert): boolean {
  if (!BEFORE_ANY_THREAD.has(pe.status)) return true;
  return Boolean(pe.contactedAt || pe.outreachToken || pe.email1SentAt || pe.followupSentAt);
}

/** How many thread reads run at once for a project export. */
const THREAD_READ_CONCURRENCY = 4;

export type ListThreadFn = (projectId: string, expertId: string) => Promise<ConversationMessageRow[]>;

/** Every thread in the project, read a few at a time. Order follows `experts`. */
export async function listThreads(
  projectId: string,
  experts: readonly ProjectExpert[],
  list: ListThreadFn = listThread,
): Promise<ThreadInput[]> {
  const candidates = experts.filter(mayHaveThread);
  const out: ThreadInput[] = new Array(candidates.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    for (;;) {
      const index = cursor++;
      if (index >= candidates.length) return;
      const pe = candidates[index];
      out[index] = { pe, rows: await list(projectId, pe.expert.id) };
    }
  }

  await Promise.all(Array.from(
    { length: Math.min(THREAD_READ_CONCURRENCY, candidates.length) },
    () => worker(),
  ));
  return out;
}

// ─── Rate limit ───────────────────────────────────────────────────────────────
// A modest ceiling: an honest compliance pull is a handful of files, a script
// looping on the route is not. Per user, keyed by an HMAC of the email so no
// address sits in Redis. The routes FAIL OPEN on a store outage, like the
// draft limiter: a missing limiter must not stop a client getting their log.

export const EXPORT_LIMIT_PER_USER_HOUR = 30;
const ONE_HOUR_MS = 60 * 60 * 1000;

function limitKey(userEmail: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  const digest = createHmac('sha256', secret).update(userEmail.trim().toLowerCase()).digest('hex').slice(0, 16);
  return `rl:export:user:1h:${digest}`;
}

export async function checkExportLimit(
  store: RateLimiterStore,
  userEmail: string,
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const { count, ttlMs } = await store.increment(limitKey(userEmail), ONE_HOUR_MS);
  if (count > EXPORT_LIMIT_PER_USER_HOUR) return { allowed: false, retryAfterMs: ttlMs };
  return { allowed: true };
}

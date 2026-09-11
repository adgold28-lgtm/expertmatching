// Pure decision helpers for app/api/inbound-email/route.ts.
//
// They live beside the route rather than inside it because a Next 14 route
// module may export nothing but its HTTP handlers (the build rejects any other
// export), and both of these have to be unit-testable:
// scripts/test-inbound-claim.ts drives them directly.
//
// No I/O, no env vars, no logging. The route does the Redis calls and decides
// what status code to answer; everything here is a pure function of its input.

// ─── Two-phase delivery claim ────────────────────────────────────────────────

/** The value written while handleReply is running (short TTL, see the route). */
export const CLAIM_IN_PROGRESS = 'processing';

/** The value written once the reply has been fully handled (7-day TTL). */
export const CLAIM_DONE = 'done';

/**
 * What to do about a delivery whose `inbound-seen:{id}` key already existed.
 *
 *   process      no one holds the key — handle the reply
 *   duplicate    already handled to completion — acknowledge 200 and stop
 *   in_progress  another delivery of the same id is mid-flight — answer 409 so
 *                Resend redelivers after that attempt has finished or expired
 */
export type ClaimDecision = 'process' | 'duplicate' | 'in_progress';

/**
 * Reads the existing claim value.
 *
 * `null` means the key vanished between the failed SET NX and the GET (its TTL
 * ran out), so the delivery is unclaimed again and we process it: losing a
 * reply is worse than duplicating one, which is the same fail-open rule the
 * route applies when Redis is unreachable.
 *
 * ANY OTHER VALUE IS A COMPLETED DELIVERY. The previous single-phase claim
 * wrote `'1'` and meant "handled", so keys written before this deploy must
 * still read as duplicates for the rest of their 7 days.
 */
export function decideClaim(existingValue: string | null | undefined): ClaimDecision {
  if (existingValue == null || existingValue === '') return 'process';
  if (existingValue === CLAIM_IN_PROGRESS) return 'in_progress';
  return 'duplicate';
}

// ─── Sender authentication (SPF / DKIM / DMARC) ──────────────────────────────

/** The three mechanisms we look for. Only DKIM and DMARC can refuse a reply. */
export type AuthMechanism = 'spf' | 'dkim' | 'dmarc';

export interface SenderAuthVerdict {
  /** True when the payload carried a result for at least one mechanism. */
  present: boolean;
  /** False ONLY on a hard DKIM or DMARC fail. Absent results allow. */
  allow:   boolean;
  /** Which mechanisms hard-failed, for count-only logging. */
  failed:  AuthMechanism[];
  /** The normalised (lower-cased) result per mechanism, or null when absent. */
  results: Record<AuthMechanism, string | null>;
}

const MECHANISMS: AuthMechanism[] = ['spf', 'dkim', 'dmarc'];

/**
 * A hard fail is the literal `fail` verdict. `none`, `neutral`, `softfail`,
 * `temperror`, `permerror` and anything unrecognised are NOT hard fails: they
 * mean the receiving side could not decide, and refusing on them would drop
 * genuine replies from experts whose employer publishes no DMARC record.
 */
function isHardFail(result: string | null): boolean {
  return result === 'fail';
}

/** `{ status: 'PASS' }`, `{ result: 'pass' }`, `'pass'`, `'dkim=pass'`. */
function readResultValue(raw: unknown): string | null {
  let text: string | null = null;
  if (typeof raw === 'string') {
    text = raw;
  } else if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    for (const key of ['status', 'result', 'verdict', 'value']) {
      if (typeof obj[key] === 'string') { text = obj[key] as string; break; }
    }
  }
  if (text == null) return null;

  const trimmed = text.trim().toLowerCase();
  if (!trimmed) return null;
  // "dkim=pass header.d=acme.com" and "pass (mailfrom)" both reduce to "pass".
  const tagged = trimmed.match(/^(?:spf|dkim|dmarc)\s*=\s*([a-z]+)/);
  if (tagged) return tagged[1];
  const word = trimmed.match(/^([a-z]+)/);
  return word ? word[1] : null;
}

/** Pulls `dkim=pass ...; spf=fail ...` out of an Authentication-Results header. */
function parseAuthenticationResults(header: string): Partial<Record<AuthMechanism, string>> {
  const out: Partial<Record<AuthMechanism, string>> = {};
  const re = /\b(spf|dkim|dmarc)\s*=\s*([a-z]+)/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(header)) !== null) {
    const mechanism = match[1].toLowerCase() as AuthMechanism;
    // First occurrence wins: a multi-signature header lists the strongest first.
    if (!out[mechanism]) out[mechanism] = match[2].toLowerCase();
  }
  return out;
}

/** Headers arrive either as `[{ name, value }]` or as a plain object. */
function findHeader(container: Record<string, unknown>, wanted: string): string | null {
  const headers = container.headers;
  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!entry || typeof entry !== 'object') continue;
      const row = entry as Record<string, unknown>;
      if (typeof row.name === 'string' && row.name.toLowerCase() === wanted
          && typeof row.value === 'string') {
        return row.value;
      }
    }
    return null;
  }
  if (headers && typeof headers === 'object') {
    for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
      if (name.toLowerCase() === wanted && typeof value === 'string') return value;
    }
  }
  return null;
}

/**
 * Reads whatever authentication results the inbound payload carries.
 *
 * WHAT RESEND ACTUALLY SENDS, as of the 2026-09 docs: the `email.received`
 * webhook carries metadata only (from, to, subject, message_id, attachments) —
 * no headers and no SPF/DKIM/DMARC verdicts, and the received-email API returns
 * only from / return-path / mime-version. So on today's payloads this returns
 * `present: false` and the route keeps the address-match behaviour it has,
 * while raising ONE system failure a day so the founder notices that the check
 * is inert. It reads three shapes so it starts working the moment a verdict
 * does appear, wherever Resend puts it:
 *
 *   1. `spf` / `dkim` / `dmarc` at the top level or under `data`, as a string
 *      or as `{ status }` / `{ result }` / `{ verdict }`
 *   2. `authentication_results` / `authenticationResults` as a raw string
 *   3. an `Authentication-Results` header in a `headers` array or object
 *
 * Never throws: a malformed payload reads as "no results".
 */
export function senderAuthAllows(payload: unknown): SenderAuthVerdict {
  const results: Record<AuthMechanism, string | null> = { spf: null, dkim: null, dmarc: null };

  const root = (payload && typeof payload === 'object')
    ? payload as Record<string, unknown>
    : {};
  const data = (root.data && typeof root.data === 'object')
    ? root.data as Record<string, unknown>
    : {};
  const containers = [root, data];

  // 1. Discrete per-mechanism fields.
  for (const container of containers) {
    for (const mechanism of MECHANISMS) {
      if (results[mechanism]) continue;
      results[mechanism] = readResultValue(container[mechanism]);
    }
  }

  // 2 and 3. A combined Authentication-Results string, wherever it lives.
  for (const container of containers) {
    const raw =
      (typeof container.authentication_results === 'string' ? container.authentication_results : null)
      ?? (typeof container.authenticationResults === 'string' ? container.authenticationResults : null)
      ?? findHeader(container, 'authentication-results');
    if (!raw) continue;
    const parsed = parseAuthenticationResults(raw);
    for (const mechanism of MECHANISMS) {
      if (!results[mechanism] && parsed[mechanism]) results[mechanism] = parsed[mechanism]!;
    }
  }

  const present = MECHANISMS.some(m => results[m] !== null);
  // SPF is recorded but never refuses on its own: a forwarded reply legitimately
  // breaks SPF while DKIM survives, and DMARC is the verdict that combines them.
  const failed  = (['dkim', 'dmarc'] as AuthMechanism[]).filter(m => isHardFail(results[m]));

  return { present, allow: failed.length === 0, failed, results };
}

// ─── Inbound message id ──────────────────────────────────────────────────────

/**
 * The sender's own Message-ID, stored on the conversation row
 * (`resend_message_id`) as a second line of defence behind the Redis claim:
 * with it on the row a duplicate delivery is visible in the data even when
 * Redis was unreachable and the claim failed open.
 *
 * Returns null when the payload carries nothing usable; the column is nullable.
 */
export function extractResendMessageId(payload: unknown): string | null {
  const root = (payload && typeof payload === 'object')
    ? payload as Record<string, unknown>
    : {};
  const data = (root.data && typeof root.data === 'object')
    ? root.data as Record<string, unknown>
    : {};

  for (const candidate of [
    root.message_id, root.messageId, data.message_id, data.messageId,
    data.email_id, root.email_id, root.id, data.id,
  ]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, 500);
  }
  return null;
}

// ─── Resend `email.received` envelope ────────────────────────────────────────
// Resend's inbound webhook (verified in production 2026-09-10) is
//   { type: 'email.received', created_at, data: { email_id, from, to[], subject,
//     message_id, attachments[] } }
// and carries NO body: the text/html must be fetched afterwards from
// GET /emails/receiving/{email_id}. The older flat shape ({ to, from, text })
// is still accepted so replayed fixtures and any legacy relay keep working.

export interface InboundEnvelope {
  toAddress: string;
  fromField: unknown;
  /** Body when the payload carried one inline; null means fetch it by emailId. */
  text: string | null;
  emailId: string | null;
}

export function normalizeInboundEnvelope(payload: Record<string, unknown>): InboundEnvelope {
  const data = payload.type === 'email.received' && payload.data && typeof payload.data === 'object'
    ? payload.data as Record<string, unknown>
    : null;
  const toField = data ? data.to : payload.to;
  let toAddress = '';
  if (Array.isArray(toField) && toField.length > 0) {
    const first = toField[0] as unknown;
    if (typeof first === 'string') toAddress = first;
    else if (first && typeof first === 'object' && typeof (first as Record<string, unknown>).email === 'string') {
      toAddress = (first as Record<string, unknown>).email as string;
    }
  } else if (typeof toField === 'string') {
    toAddress = toField;
  }
  const emailId = data && typeof data.email_id === 'string' ? data.email_id : null;
  const text = typeof payload.text === 'string' ? payload.text : null;
  return { toAddress, fromField: data ? data.from : payload.from, text, emailId };
}

/** Very small HTML-to-text for the fallback when a reply has no text part. */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/tr>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Fetch a received email's body from Resend. Returns '' when the message has
 * neither text nor html, or when the API call fails (the caller treats an
 * empty body as "nothing to act on" and closes the claim). Never throws.
 */
export async function fetchReceivedEmailBody(
  emailId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const res = await fetchImpl(`https://api.resend.com/emails/receiving/${encodeURIComponent(emailId)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      console.warn('[inbound-email] received-email fetch failed', { status: res.status });
      return '';
    }
    const body = await res.json() as { text?: unknown; html?: unknown };
    if (typeof body.text === 'string' && body.text.trim()) return body.text;
    if (typeof body.html === 'string' && body.html.trim()) return htmlToPlainText(body.html);
    return '';
  } catch {
    console.warn('[inbound-email] received-email fetch threw');
    return '';
  }
}

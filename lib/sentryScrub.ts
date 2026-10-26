// lib/sentryScrub.ts — what leaves for Sentry, and what never does.
//
// Sentry gets a stack trace, a route, a message and counts. It never gets a
// brief, a question, an expert's name or address, a session cookie, a signed
// link or a request body (D12, 2026-10-18: scrub every event, do not rely on
// the SDK's defaults alone). This module is the beforeSend hook that every
// runtime's Sentry.init installs (lib/sentry.ts). It is pure — no Sentry
// import, no I/O — so scripts/test-sentry-scrub.ts can prove each rule.
//
// The rules, applied to every event:
//   1. `user` is dropped whole. Vercel's logs know who; Sentry does not need to.
//   2. `request` keeps the method and a URL with its query string removed and
//      every opaque path segment (a token, an id) replaced by [redacted]; the
//      headers, cookies, body, query and env are dropped.
//   3. Console breadcrumbs are dropped (they repeat our own log lines, which
//      lib/log.ts already keeps free of personal data by contract); every
//      other breadcrumb loses its request and response bodies and gets the
//      same URL and text treatment.
//   4. In `extra`, `contexts` and `tags`, a key whose name suggests a person
//      or a secret (brief, question, email, token, cookie …) is removed
//      wherever it sits, to a bounded depth.
//   5. Every free-text field — exception values, the message, breadcrumb
//      messages, the transaction name — has email addresses and long opaque
//      strings redacted and is cut at MAX_TEXT characters.
//   6. Stack frames lose their local variables, if any were captured.
//
// If anything in here throws, the event is DROPPED, never sent unscrubbed.

const MAX_TEXT  = 500;
const MAX_DEPTH = 6;
const MAX_KEYS  = 100;
const MAX_ITEMS = 50;

/** Keys that are removed wherever they appear in extra, contexts, tags and breadcrumb data. */
const SENSITIVE_KEY = /brief|question|objective|notes?$|\bbody|e-?mail|phone|address|token|secret|password|authorization|cookie|session|card|payload|transcript|first_?name|last_?name|full_?name|display_?name|user_?name|headers|query/i;

/** Breadcrumb data keys that carry a request or response body under one name or another. */
const BODY_KEY = /body|input|response|request|payload|arguments/i;

const EMAIL_RE  = /[\w.+%-]+@[\w-]+(?:\.[\w-]+)+/g;
/** A run of 24+ URL-safe characters: a signed token, an API key, a session id. */
const OPAQUE_RE = /[A-Za-z0-9_-]{24,}/g;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Free text with addresses and opaque strings redacted, cut at MAX_TEXT. */
export function scrubText(text: string): string {
  const cleaned = text.replace(EMAIL_RE, '[email]').replace(OPAQUE_RE, '[redacted]');
  return cleaned.length > MAX_TEXT ? `${cleaned.slice(0, MAX_TEXT)}…` : cleaned;
}

/**
 * A URL with its query string and fragment removed and any opaque path segment
 * replaced. A segment is opaque when it is 16+ characters and not a plain
 * lowercase word (so `/expert-onboarding/` survives and `/schedule/<token>/`
 * does not). A relative URL stays relative; an unparseable one is replaced.
 */
export function scrubUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw, 'https://placeholder.invalid'); } catch { return '[redacted]'; }

  const path = url.pathname
    .split('/')
    .map(segment => (segment.length >= 16 && !/^[a-z-]+$/.test(segment) ? '[redacted]' : segment))
    .join('/');

  return url.origin === 'https://placeholder.invalid' ? path : `${url.origin}${path}`;
}

/** A copy of `value` with sensitive keys removed and text scrubbed, to a bounded depth and size. */
export function stripSensitive(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[depth]';
  if (typeof value === 'string') return scrubText(value);
  if (Array.isArray(value)) return value.slice(0, MAX_ITEMS).map(item => stripSensitive(item, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value).slice(0, MAX_KEYS)) {
      if (SENSITIVE_KEY.test(key)) continue;
      out[key] = stripSensitive(inner, depth + 1);
    }
    return out;
  }
  return value;
}

function scrubBreadcrumb(crumb: Record<string, unknown>): Record<string, unknown> {
  if (typeof crumb.message === 'string') crumb.message = scrubText(crumb.message);
  if (isRecord(crumb.data)) {
    const data = crumb.data;
    for (const key of Object.keys(data)) {
      if (BODY_KEY.test(key) || SENSITIVE_KEY.test(key)) delete data[key];
    }
    if (typeof data.url === 'string') data.url = scrubUrl(data.url);
    crumb.data = stripSensitive(data);
  }
  return crumb;
}

function scrubRecord(event: Record<string, unknown>): void {
  // 1. Nobody.
  delete event.user;

  // 2. The request: method and a redacted URL, nothing else.
  if (isRecord(event.request)) {
    const request = event.request;
    const url     = typeof request.url    === 'string' ? scrubUrl(request.url) : undefined;
    const method  = typeof request.method === 'string' ? request.method        : undefined;
    for (const key of Object.keys(request)) delete request[key];
    if (url)    request.url    = url;
    if (method) request.method = method;
  }

  // 3. Breadcrumbs.
  if (Array.isArray(event.breadcrumbs)) {
    event.breadcrumbs = event.breadcrumbs
      .filter(isRecord)
      .filter(crumb => crumb.category !== 'console')
      .slice(-MAX_ITEMS)
      .map(scrubBreadcrumb);
  }

  // 4. Attached data.
  for (const field of ['extra', 'contexts', 'tags'] as const) {
    if (isRecord(event[field])) event[field] = stripSensitive(event[field]);
  }

  // 5. Free text.
  if (typeof event.message     === 'string') event.message     = scrubText(event.message);
  if (typeof event.transaction === 'string') event.transaction = scrubText(event.transaction);
  if (isRecord(event.logentry) && typeof event.logentry.message === 'string') {
    event.logentry.message = scrubText(event.logentry.message);
  }
  if (isRecord(event.exception) && Array.isArray(event.exception.values)) {
    for (const item of event.exception.values) {
      if (!isRecord(item)) continue;
      if (typeof item.value === 'string') item.value = scrubText(item.value);
      // 6. Local variables, when a runtime captured them.
      if (isRecord(item.stacktrace) && Array.isArray(item.stacktrace.frames)) {
        for (const frame of item.stacktrace.frames) {
          if (isRecord(frame)) delete frame.vars;
        }
      }
    }
  }
}

/** The shape beforeSend hands over; Sentry's ErrorEvent satisfies it. */
export interface ScrubbableEvent {
  user?:        unknown;
  request?:     { url?: string; method?: string };
  breadcrumbs?: Array<{ category?: string; message?: string; data?: Record<string, unknown> }>;
  extra?:       Record<string, unknown>;
  contexts?:    Record<string, unknown>;
  tags?:        Record<string, unknown>;
  exception?:   { values?: Array<{ value?: string }> };
  message?:     string;
  logentry?:    { message?: string };
  transaction?: string;
}

/**
 * The beforeSend hook: the same event, scrubbed in place, or null when the
 * scrub itself failed — an event that could not be cleaned is not sent.
 */
export function scrubSentryEvent<T extends ScrubbableEvent>(event: T): T | null {
  try {
    scrubRecord(event as unknown as Record<string, unknown>);
    return event;
  } catch {
    return null;
  }
}

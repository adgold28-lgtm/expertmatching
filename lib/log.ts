// lib/log.ts — the one structured logger for app code.
//
// One line per call, `<scope> <message> <fields as JSON>`:
//
//   log.info('[hunter]', 'result-counts', { returned: 3, verified: 1 });
//   → [hunter] result-counts {"returned":3,"verified":1}
//
// The scope is the same bracketed tag the console calls always carried, so a
// Vercel log search for "[hunter]" keeps working, and the fields are JSON so a
// log drain can parse them instead of guessing at prose. Isomorphic on
// purpose: no Node-only imports, so a client component may import it; it
// writes through whatever console the runtime offers (info, warn and error map
// one to one, and Node prints info to stdout exactly as it prints plain log).
//
// The logger does NOT redact. Each module's "NEVER LOG" note still governs
// what goes in `fields`: counts, outcomes, ids and durations, never an email,
// a name or a message body. Pass a caught error through errorMessage() rather
// than reading err.message yourself, so a third party's error page cannot put
// an unbounded payload in the log.

type LogFields = Record<string, unknown>;
type LogLevel  = 'info' | 'warn' | 'error';

/** Where every log.error line is also delivered once monitoring is up. */
export type ErrorSink = (scope: string, message: string, fields: LogFields | undefined) => void;

let errorSink: ErrorSink | null = null;

/**
 * Install (or, with null, remove) the error sink. lib/sentry.ts installs one
 * that forwards each log.error line to Sentry as a message event, so a failure
 * a route caught and logged reaches the monitor as surely as one it did not.
 * The logger stays free of any Sentry import: the sink is the only coupling,
 * and a sink that throws never reaches the caller.
 */
export function setErrorSink(sink: ErrorSink | null): void {
  errorSink = sink;
}

/**
 * A safe, one-line, bounded string from anything a catch block can receive.
 *
 * An Error gives its message; a string gives itself; an object with a string
 * `message` (Supabase and Resend errors are plain objects) gives that; anything
 * else is JSON-encoded. Control characters and line breaks collapse to single
 * spaces and the result is cut at `max` characters, so a provider's HTML error
 * body cannot flood a log line. Never throws; an empty result reads 'unknown'.
 */
export function errorMessage(err: unknown, max = 200): string {
  let text = '';
  try {
    if (err instanceof Error) {
      text = err.message;
    } else if (typeof err === 'string') {
      text = err;
    } else if (err !== null && err !== undefined) {
      const message = (err as { message?: unknown }).message;
      text = typeof message === 'string'
        ? message
        : (JSON.stringify(err) ?? Object.prototype.toString.call(err));
    }
  } catch {
    text = '';
  }
  const flat = text.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (flat.length === 0) return 'unknown';
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/** JSON.stringify cannot see into an Error and refuses a bigint; both get a string. */
function fieldReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) return errorMessage(value);
  if (typeof value === 'bigint') return value.toString();
  return value;
}

function encodeFields(fields: LogFields | undefined): string {
  if (fields === undefined) return '';
  try {
    const json = JSON.stringify(fields, fieldReplacer);
    return json === undefined ? '' : ` ${json}`;
  } catch {
    // A circular structure or a throwing getter: say so rather than lose the line.
    return ' {"fields":"unserializable"}';
  }
}

function emit(level: LogLevel, scope: string, message: string, fields?: LogFields): void {
  const line = `${scope} ${message}${encodeFields(fields)}`;
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.info(line);

  if (level === 'error' && errorSink) {
    try { errorSink(scope, message, fields); } catch { /* monitoring must never break the app */ }
  }
}

export const log = {
  /** Routine events worth a line in production: a job finished, a charge went through. */
  info:  (scope: string, message: string, fields?: LogFields): void => emit('info', scope, message, fields),
  /** Something degraded but handled: a fallback taken, a retry scheduled. */
  warn:  (scope: string, message: string, fields?: LogFields): void => emit('warn', scope, message, fields),
  /** A failure somebody should look at. */
  error: (scope: string, message: string, fields?: LogFields): void => emit('error', scope, message, fields),
};

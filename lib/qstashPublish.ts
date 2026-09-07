// lib/qstashPublish.ts — publish one delayed job to QStash.
//
// lib/sourcingJob.publishSourcingJob already does this for the one job that
// runs immediately and throws on failure. The nudge planner needs the other
// shape: a DELAY of up to a day, NO RETRIES, and a result rather than an
// exception, because it queues many jobs in one pass and a single failure must
// cost exactly one engagement.
//
// THE HOST IS REGION-PINNED. QStash accounts live in a region and the global
// host answers 404 "user not found in this region" for this account's token,
// so QSTASH_URL wins and the fallback is the region this account is in. Same
// rule as lib/sourcingJob.ts — if that one moves, this one moves with it.
//
// THE DESTINATION URL GOES IN THE PATH VERBATIM. QStash rejects a
// percent-encoded destination with "endpoint has invalid scheme".
//
// RETRIES ARE OFF BY DEFAULT (`Upstash-Retries: 0`). A redelivered nudge is a
// second email to the same person on the same day, which is worse than a nudge
// that never went. The planner runs again tomorrow.
//
// LOCAL DEV NEVER SENDS. Without QSTASH_TOKEN this returns
// { ok: false, error: 'qstash_not_configured' } and runs NOTHING in process —
// unlike sourcing, which is safe to run locally. A nudge is a real email to a
// real expert and must never originate from a developer's machine.
//
// Never throws. Never logs: the job body, addresses, names, or the token.

/** Only the two headers this module sets are bounded; the rest is QStash's. */
const MAX_DELAY_SECONDS = 7 * 24 * 60 * 60;   // a week, far beyond any nudge

export interface PublishOptions {
  /** Seconds from now. Clamped to [0, one week]; 0 publishes immediately. */
  delaySeconds?: number;
  /** QStash redelivery attempts. Defaults to 0 — see the header. */
  retries?: number;
}

export type PublishResult =
  | { ok: true;  messageId: string | null }
  | { ok: false; error: string };

/** The account's own QStash endpoint. QSTASH_URL wins; the fallback is ours. */
function qstashHost(): string {
  return (process.env.QSTASH_URL ?? 'https://qstash-us-east-1.upstash.io').replace(/\/+$/, '');
}

/** Where QStash calls back into this app. */
function baseUrl(): string {
  return (
    process.env.NEXT_PUBLIC_BASE_URL
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? 'https://expertmatch.fit'
  ).replace(/\/+$/, '');
}

/**
 * Publish `body` to `path` on this app, delivered once, after `delaySeconds`.
 *
 * `path` is an absolute path on this app ('/api/jobs/send-nudge'), not a full
 * URL — the destination is built here so a caller cannot aim a QStash job at
 * another host.
 */
export async function publishQstashJob(
  path: string,
  body: unknown,
  opts: PublishOptions = {},
): Promise<PublishResult> {
  const token = process.env.QSTASH_TOKEN;
  if (!token) return { ok: false, error: 'qstash_not_configured' };

  if (!path.startsWith('/')) return { ok: false, error: 'invalid_path' };

  const delay = Math.min(
    Math.max(Math.trunc(opts.delaySeconds ?? 0) || 0, 0),
    MAX_DELAY_SECONDS,
  );
  const retries = Math.min(Math.max(Math.trunc(opts.retries ?? 0) || 0, 0), 3);

  const destination = `${baseUrl()}${path}`;

  try {
    const res = await fetch(`${qstashHost()}/v2/publish/${destination}`, {
      method: 'POST',
      headers: {
        'Authorization':   `Bearer ${token}`,
        'Content-Type':    'application/json',
        'Upstash-Delay':   `${delay}s`,
        'Upstash-Retries': String(retries),
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      // The status is the useful part; the response text can echo the
      // destination but never the body, so it is bounded and kept.
      const text = await res.text().catch(() => '');
      return { ok: false, error: `publish_failed_${res.status}${text ? `: ${text.slice(0, 120)}` : ''}` };
    }

    // QStash answers { messageId }. A shape we do not recognise is still a
    // successful publish, so the id is optional rather than fatal.
    const parsed: unknown = await res.json().catch(() => null);
    const messageId =
      parsed && typeof parsed === 'object' && typeof (parsed as { messageId?: unknown }).messageId === 'string'
        ? (parsed as { messageId: string }).messageId
        : null;

    return { ok: true, messageId };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message.slice(0, 120) : 'publish_threw',
    };
  }
}

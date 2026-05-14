// Snov.io provider — emails-by-domain-by-name v2 (start/poll pattern).
// All Snov-specific API logic lives here; the route sees only ContactProvider.

import type { ContactProvider, ContactLookupInput, ProviderEmailResult } from './types';
import { WEBMAIL_DOMAINS } from './types';

// ─── Snov-internal types ──────────────────────────────────────────────────────

type SnovSmtpStatus = 'valid' | 'unknown' | 'not_valid';

interface RawSnovEmail {
  email: string;
  smtp_status: SnovSmtpStatus;
  is_valid_format: boolean;
  is_disposable: boolean;
  is_webmail: boolean;
  is_gibberish: boolean;
  unknown_status_reason: string | null;
}

// ─── Token cache — server-side only, NEVER sent to client ─────────────────────

let cachedToken: string | null = null;
let tokenExpiresAt = 0;

async function getAccessToken(): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiresAt - 60_000) return cachedToken;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);

  try {
    const res = await fetch('https://api.snov.io/v1/oauth/access_token', {
      method: 'POST',
      // Credentials in body as required by Snov OAuth — NOT in URL
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id:     process.env.SNOV_CLIENT_ID,
        client_secret: process.env.SNOV_CLIENT_SECRET,
      }),
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`Snov auth HTTP ${res.status}`);

    const data = await res.json() as Record<string, unknown>;
    if (typeof data.access_token !== 'string') throw new Error('Missing access_token in Snov auth response');

    cachedToken = data.access_token;
    tokenExpiresAt = Date.now() + 55 * 60 * 1000; // cache 55 min (token valid 1 h)
    return cachedToken;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Lookup start ─────────────────────────────────────────────────────────────

async function startLookup(
  token: string,
  firstName: string,
  lastName: string,
  domain: string,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);

  try {
    const res = await fetch('https://api.snov.io/v2/emails-by-domain-by-name/start', {
      method: 'POST',
      // Authorization: Bearer header — access token is NEVER put in body or URL
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
      },
      body: JSON.stringify({
        rows: [{ first_name: firstName, last_name: lastName, domain }],
      }),
      signal: controller.signal,
    });

    if (res.status === 429) {
      throw Object.assign(new Error('Snov upstream rate limit'), { code: 'provider_rate_limited' });
    }

    if (!res.ok) {
      const body = await res.json().catch(() => ({})) as Record<string, unknown>;
      if (body.message === 'not_enough_credits' || body.error === 'not_enough_credits') {
        throw Object.assign(new Error('Insufficient Snov credits'), { code: 'not_enough_credits' });
      }
      throw new Error(`Snov start HTTP ${res.status}`);
    }

    const data = await res.json() as Record<string, unknown>;

    if (data.message === 'not_enough_credits' || data.error === 'not_enough_credits') {
      throw Object.assign(new Error('Insufficient Snov credits'), { code: 'not_enough_credits' });
    }

    // Snov may return { task_hash } or { data: { task_hash } }
    const inner = (data.data as Record<string, unknown> | undefined) ?? data;
    const taskHash = inner.task_hash;
    if (typeof taskHash !== 'string' || !taskHash) {
      throw new Error(`No task_hash in Snov response: ${JSON.stringify(Object.keys(data))}`);
    }

    return taskHash;
  } finally {
    clearTimeout(timer);
  }
}

// ─── Result polling ───────────────────────────────────────────────────────────

async function pollResult(token: string, taskHash: string): Promise<RawSnovEmail[]> {
  const maxAttempts = 8;
  const intervalMs  = 800;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, intervalMs));

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);

    try {
      // Bearer token in header — access token is NEVER in the URL
      const url = `https://api.snov.io/v2/emails-by-domain-by-name/result?task_hash=${encodeURIComponent(taskHash)}`;
      const res = await fetch(url, {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: controller.signal,
      });

      if (!res.ok) throw new Error(`Snov poll HTTP ${res.status}`);

      const raw = await res.json();

      // Response may be an array or { status, data/rows/results }
      let rows: unknown[];
      if (Array.isArray(raw)) {
        rows = raw;
      } else {
        const wrapped = raw as Record<string, unknown>;
        if (wrapped.status === 'in_progress') continue;
        rows = (
          (Array.isArray(wrapped.data)    ? wrapped.data    : null) ??
          (Array.isArray(wrapped.rows)    ? wrapped.rows    : null) ??
          (Array.isArray(wrapped.results) ? wrapped.results : null) ??
          []
        );
      }

      const emails: RawSnovEmail[] = [];
      let rowsStillPending = false;

      for (const row of rows) {
        if (typeof row !== 'object' || row === null) continue;
        const r = row as Record<string, unknown>;

        if (r.status === 'in_progress') { rowsStillPending = true; break; }

        // Emails may be in result[], emails[], or found_emails[]
        const found = (
          (Array.isArray(r.result)       ? r.result       : null) ??
          (Array.isArray(r.emails)       ? r.emails       : null) ??
          (Array.isArray(r.found_emails) ? r.found_emails : null) ??
          []
        ) as unknown[];

        for (const e of found) {
          if (typeof e !== 'object' || e === null) continue;
          const em = e as Record<string, unknown>;
          if (typeof em.email !== 'string' || !em.email) continue;

          emails.push({
            email:                  em.email,
            smtp_status:            (em.smtp_status as SnovSmtpStatus) ?? 'unknown',
            is_valid_format:        Boolean(em.is_valid_format   ?? true),
            is_disposable:          Boolean(em.is_disposable     ?? false),
            is_webmail:             Boolean(em.is_webmail        ?? false),
            is_gibberish:           Boolean(em.is_gibberish      ?? false),
            unknown_status_reason:  typeof em.unknown_status_reason === 'string'
                                      ? em.unknown_status_reason : null,
          });
        }
      }

      // A row signalled in_progress — Snov is still processing; keep polling
      if (rowsStillPending) continue;

      return emails;
    } finally {
      clearTimeout(timer);
    }
  }

  return []; // polling exhausted — treated as not_found by the route
}

// ─── Status normalization ─────────────────────────────────────────────────────

function normalizeStatus(raw: RawSnovEmail): ProviderEmailResult['normalizedStatus'] {
  if (raw.is_disposable) return 'invalid';
  if (raw.smtp_status === 'not_valid' || raw.is_gibberish || !raw.is_valid_format) return 'invalid';
  if (raw.smtp_status === 'valid') return 'verified';
  if (raw.smtp_status === 'unknown' && raw.unknown_status_reason === 'catchall') return 'catchall';
  if (raw.smtp_status === 'unknown') return 'risky';
  return 'invalid';
}

// ─── Provider implementation ──────────────────────────────────────────────────

export const snovProvider: ContactProvider = {
  name: 'snov',

  isConfigured(): boolean {
    return Boolean(process.env.SNOV_CLIENT_ID && process.env.SNOV_CLIENT_SECRET);
  },

  async findProfessionalEmail({ firstName, lastName, domain }: ContactLookupInput): Promise<ProviderEmailResult[]> {
    // THIS IS WHERE A SNOV CREDIT MAY BE SPENT
    const token = await getAccessToken();
    const taskHash = await startLookup(token, firstName, lastName, domain);
    const rawEmails = await pollResult(token, taskHash);

    // Debug audit: counts only — no emails, names, domains, tokens, or raw response logged.
    // Helps distinguish "Snov returned nothing" from "our filter excluded everything".
    {
      const domainOf = (e: RawSnovEmail) => e.email.split('@')[1]?.toLowerCase() ?? '';
      const statuses = rawEmails.map(normalizeStatus);
      console.log('[snov] result-counts', JSON.stringify({
        totalReturned:    rawEmails.length,
        webmailCount:     rawEmails.filter(e => e.is_webmail || WEBMAIL_DOMAINS.has(domainOf(e))).length,
        disposableCount:  rawEmails.filter(e => e.is_disposable).length,
        verifiedCount:    statuses.filter(s => s === 'verified').length,
        catchallCount:    statuses.filter(s => s === 'catchall').length,
        riskyCount:       statuses.filter(s => s === 'risky').length,
        invalidCount:     statuses.filter(s => s === 'invalid').length,
        displayableCount: rawEmails.filter((e, i) =>
          !e.is_webmail && !WEBMAIL_DOMAINS.has(domainOf(e)) &&
          !e.is_disposable && !e.is_gibberish && e.is_valid_format &&
          (statuses[i] === 'verified' || statuses[i] === 'catchall')
        ).length,
      }));
    }

    // Filter webmail / personal addresses — security invariant enforced at provider level.
    // Callers never see webmail results regardless of their own filtering.
    return rawEmails
      .filter(e => !e.is_webmail && !WEBMAIL_DOMAINS.has(e.email.split('@')[1]?.toLowerCase() ?? ''))
      .map(raw => ({
        email:            raw.email,
        provider:         'snov' as const,
        providerStatus:   raw.smtp_status,
        normalizedStatus: normalizeStatus(raw),
        isWebmail:        raw.is_webmail,
        isDisposable:     raw.is_disposable,
        isValidFormat:    raw.is_valid_format,
        isGibberish:      raw.is_gibberish,
        reason:           raw.unknown_status_reason,
      }));
  },

  estimateCreditsPerLookup(_input: ContactLookupInput): number {
    return 1;
  },
};

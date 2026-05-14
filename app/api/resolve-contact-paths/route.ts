// POST /api/resolve-contact-paths
//
// Resolves official domains and public contact emails for an expert.
// Uses the configured search provider (Tavily / ScrapingBee) to supplement
// local heuristics. Does NOT call Snov or Hunter — no email credits spent.
//
// Security:
// - Same-origin check (NEXT_PUBLIC_APP_URL / APP_URL)
// - Session auth if isAuthEnabled(); else CONTACT_ENRICHMENT_ADMIN_TOKEN fallback for dev/staging
// - Content-Type: application/json required
// - Body ≤ 32 KB
//
// NEVER logged: expert names, company names, raw emails, provider keys.

import { timingSafeEqual } from 'crypto';
import { NextRequest }     from 'next/server';
import { isAuthEnabled }   from '../../../lib/auth';
import { resolveContactPaths } from '../../../lib/contactPathResolver';
import { getSearchProvider }   from '../../../lib/searchProviders';
import { createRateLimiterStore } from '../../../lib/rateLimiter';
import { createHmac }      from 'crypto';
import type { Expert }     from '../../../types';

const MAX_BODY_BYTES = 32 * 1024;
const TEN_MIN_MS     = 10 * 60 * 1000;
const TWENTY_FOUR_H  = 24 * 60 * 60 * 1000;

// ─── Auth / origin guard ──────────────────────────────────────────────────────

function checkOrigin(request: NextRequest): Response | null {
  const origin = request.headers.get('origin');
  if (!origin) return null; // same-origin or server-to-server

  const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? process.env.APP_URL;
  if (!appUrl) return null;
  try {
    const allowed = new URL(appUrl).origin;
    if (origin !== allowed) return Response.json({ error: 'forbidden' }, { status: 403 });
  } catch { /* bad APP_URL — skip */ }
  return null;
}

function checkAuth(request: NextRequest): Response | null {
  // In production with session auth, middleware verified the session cookie already.
  if (isAuthEnabled()) return null;

  // Dev / staging without global auth: check admin token if configured.
  const adminToken = process.env.CONTACT_ENRICHMENT_ADMIN_TOKEN;
  if (!adminToken) return null; // dev convenience: no token required

  const provided = request.headers.get('x-enrichment-token') ?? '';
  const tokenBuf = Buffer.from(adminToken, 'utf8');
  const inputBuf = Buffer.from(provided,   'utf8');
  // Always run timingSafeEqual regardless of length to avoid leaking the expected
  // token length via early-return timing. Use adminBuf twice on length mismatch.
  const lengthMatch = tokenBuf.length === inputBuf.length;
  const safeRef = Buffer.alloc(Math.max(tokenBuf.length, inputBuf.length));
  const safeCmp = Buffer.alloc(Math.max(tokenBuf.length, inputBuf.length));
  tokenBuf.copy(safeRef);
  (lengthMatch ? inputBuf : tokenBuf).copy(safeCmp);
  const valueMatch = timingSafeEqual(safeRef, safeCmp);
  if (!lengthMatch || !valueMatch) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }
  return null;
}

// ─── Rate limiter helpers ─────────────────────────────────────────────────────

function rlHash(prefix: string, value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  return `${prefix}:${createHmac('sha256', secret).update(value).digest('hex').slice(0, 16)}`;
}

// ─── Input validation ─────────────────────────────────────────────────────────

function sanitize(v: unknown, max: number): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // 1. Origin check
  const originErr = checkOrigin(request);
  if (originErr) return originErr;

  // 2. Auth check
  const authErr = checkAuth(request);
  if (authErr) return authErr;

  // 3. Content-type
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.startsWith('application/json')) {
    return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
  }

  // 4. Body size + parse
  const clHeader = request.headers.get('content-length');
  if (clHeader !== null && parseInt(clHeader, 10) > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload_too_large' }, { status: 413 });
  }
  let text: string;
  try { text = await request.text(); } catch {
    return Response.json({ error: 'failed_to_read_body' }, { status: 400 });
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload_too_large' }, { status: 413 });
  }
  let body: Record<string, unknown>;
  try { body = JSON.parse(text) as Record<string, unknown>; } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  // 5. Search provider check (fail-closed if not configured)
  try {
    getSearchProvider(); // throws if not configured
  } catch {
    return Response.json({
      error: 'service_unavailable',
      reason: 'search_provider_not_configured',
    }, { status: 503 });
  }

  // 6. Input validation
  const expertName   = sanitize(body.expertName,  200);
  const title        = sanitize(body.title,        300);
  const company      = sanitize(body.company,      300);
  const forceRefresh = body.forceRefresh === true;

  if (!expertName) return Response.json({ error: 'expertName required', field: 'expertName' }, { status: 400 });
  if (!company)    return Response.json({ error: 'company required',    field: 'company'    }, { status: 400 });

  // Reconstruct a minimal Expert shape for the resolver
  // (resolver only uses name, company, title, source_links — safe to omit the rest)
  const rawSourceLinks = Array.isArray(body.sourceLinks) ? body.sourceLinks : [];
  const sourceLinks = rawSourceLinks
    .filter((l): l is Record<string, unknown> => !!l && typeof l === 'object')
    .map(l => ({
      url:   typeof l.url   === 'string' ? l.url.slice(0, 500)   : '',
      label: typeof l.label === 'string' ? l.label.slice(0, 200) : 'Source',
      type:  typeof l.type  === 'string' ? l.type                : 'Other',
    }))
    .filter(l => l.url.startsWith('http'));

  const expert: Expert = {
    id:              'resolver-input',
    name:            expertName,
    title,
    company,
    location:        '',
    category:        'Operator',
    justification:   '',
    relevance_score: 0,
    source_url:      '',
    source_label:    '',
    // Only Company Website links are used for domain suggestions
    source_links:    sourceLinks as Expert['source_links'],
  };

  // 7. Rate limit — per IP: 20 / 10 min, 100 / 24 h
  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  try {
    const rl = createRateLimiterStore();
    const { count: c1, ttlMs: t1 } = await rl.increment(rlHash('rl:cpath:10m', ip), TEN_MIN_MS);
    if (c1 > 20) {
      return Response.json({ error: 'rate_limited', retryAfterMs: t1 }, { status: 429 });
    }
    const { count: c2, ttlMs: t2 } = await rl.increment(rlHash('rl:cpath:24h', ip), TWENTY_FOUR_H);
    if (c2 > 100) {
      return Response.json({ error: 'rate_limited', retryAfterMs: t2 }, { status: 429 });
    }
  } catch {
    // Rate limiter failure is non-fatal in dev; log in prod
    if (process.env.NODE_ENV === 'production') {
      console.error('[resolve-contact-paths] rate limiter failed');
    }
  }

  // 8. Resolve
  try {
    const paths = await resolveContactPaths({ expert, forceRefresh });
    return Response.json({ paths });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[resolve-contact-paths] resolver error:', msg);
    return Response.json({ error: 'resolver_failed' }, { status: 500 });
  }
}

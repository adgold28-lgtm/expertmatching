import { NextRequest } from 'next/server';
import { Resend } from 'resend';
import { createHmac } from 'crypto';
import { getServiceRoleClient } from '../../../lib/supabase/admin';
import { getUpstashClient } from '../../../lib/upstashRedis';
import { isApprovedDomain, upsertFirm } from '../../../lib/firmStore';
import { provisionAccountInvite, splitFullName } from '../../../lib/accountProvisioning';
import type { FirmTypeValue, FirmSizeValue } from '../../../lib/supabase/database.types';

interface AccessRequest {
  name:        string;
  firm:        string;
  email:       string;
  useCase:     string;
  firmType:    FirmTypeValue | null;
  firmSize:    FirmSizeValue | null;
  submittedAt: number;
}

// Matchy needs one type word and one size word to describe a client to an
// expert without naming them ("a mid-size PE firm"). Both are optional on the
// form: an unanswered question falls back to "an investment firm" rather than
// blocking the request.
const FIRM_TYPES = new Set<string>([
  'pe_firm', 'family_office', 'consulting_firm', 'law_firm',
  'hedge_fund', 'corporate', 'other',
]);
const FIRM_SIZES = new Set<string>(['boutique', 'mid_size', 'large']);

function readFirmType(value: unknown): FirmTypeValue | null {
  return typeof value === 'string' && FIRM_TYPES.has(value) ? value as FirmTypeValue : null;
}
function readFirmSize(value: unknown): FirmSizeValue | null {
  return typeof value === 'string' && FIRM_SIZES.has(value) ? value as FirmSizeValue : null;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

// Admin recipients for access-request notifications. Both addresses are
// notified so a request is never missed if one inbox is unattended.
const ADMIN_NOTIFY_EMAILS = ['adgold28@colby.edu', 'ashergoldsteinbusiness@gmail.com'];

// Public, unauthenticated endpoint: cap submissions per IP and per email so it
// cannot be used to spray invites (auto-approved domains) or flood the inbox.
const RATE_LIMIT_PER_IP    = 5;
const RATE_LIMIT_PER_EMAIL = 3;
const RATE_WINDOW_MS       = 60 * 60 * 1000; // 1 hour

/** HMAC-pseudonymised key — no IPs or emails in Redis key names. */
function rlKey(kind: 'ip' | 'email', value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  const hash   = createHmac('sha256', secret).update(value).digest('hex').slice(0, 24);
  return `access-rl:${kind}:${hash}`;
}

/** True when the caller is over the limit. Fails open if Redis is unavailable. */
async function isRateLimited(ip: string, email: string): Promise<boolean> {
  const redis = getUpstashClient();
  if (!redis) return false;
  try {
    const [byIp, byEmail] = await Promise.all([
      redis.incrWithWindow(rlKey('ip', ip), RATE_WINDOW_MS),
      redis.incrWithWindow(rlKey('email', email), RATE_WINDOW_MS),
    ]);
    return byIp.count > RATE_LIMIT_PER_IP || byEmail.count > RATE_LIMIT_PER_EMAIL;
  } catch {
    return false;
  }
}

let _resend: Resend | null = null;

function getResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!_resend) _resend = new Resend(key);
  return _resend;
}

export async function POST(request: NextRequest) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json', message: 'We could not read that submission. Please try again.' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: 'invalid_body', message: 'We could not read that submission. Please try again.' }, { status: 400 });
  }

  const { name, firm, email, useCase, firmType, firmSize } = body as Record<string, unknown>;

  if (typeof name !== 'string' || !name.trim()) {
    return Response.json({ error: 'name_required', message: 'Add your name.' }, { status: 400 });
  }
  if (typeof firm !== 'string' || !firm.trim()) {
    return Response.json({ error: 'firm_required', message: 'Add your firm name.' }, { status: 400 });
  }
  if (typeof email !== 'string' || !email.trim() || !email.includes('@')) {
    return Response.json({ error: 'email_invalid', message: 'Add a valid work email address.' }, { status: 400 });
  }
  if (typeof useCase !== 'string' || !useCase.trim()) {
    return Response.json({ error: 'use_case_required', message: 'Tell us what you are researching.' }, { status: 400 });
  }

  const record: AccessRequest = {
    name:        name.trim().slice(0, 200),
    firm:        firm.trim().slice(0, 200),
    email:       email.trim().toLowerCase().slice(0, 200),
    useCase:     useCase.trim().slice(0, 2000),
    firmType:    readFirmType(firmType),
    firmSize:    readFirmSize(firmSize),
    submittedAt: Date.now(),
  };

  const domain = record.email.split('@')[1] ?? '';

  const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
          ?? request.headers.get('x-real-ip')
          ?? 'unknown';
  if (await isRateLimited(ip, record.email)) {
    return Response.json(
      { error: 'rate_limited', message: 'That is a few too many requests. Please try again a little later.' },
      { status: 429, headers: { 'Retry-After': String(RATE_WINDOW_MS / 1000) } },
    );
  }

  // Check if domain is already approved — if so, send invite immediately
  let autoApproved = false;
  if (domain) {
    try {
      autoApproved = await isApprovedDomain(domain);
    } catch {
      autoApproved = false;
    }
  }

  // Known organization → provision the invite immediately. Account creation
  // always runs through provisionAccountInvite, so the requester's name and
  // organization are mandatory here too.
  if (autoApproved) {
    const { firstName, lastName } = splitFullName(record.name);

    if (firstName && lastName) {
      const result = await provisionAccountInvite({
        firstName,
        lastName,
        email:        record.email,
        organization: { domain, name: record.firm },
      });
      if (result.ok) {
        // The organization already exists, so there is no approval step to
        // carry these to — write them now. Never overwrites with a blank.
        if (record.firmType || record.firmSize) {
          await upsertFirm(domain, {
            ...(record.firmType ? { firmType: record.firmType } : {}),
            ...(record.firmSize ? { firmSize: record.firmSize } : {}),
          }).catch(() => { /* the invite already went out; this is not worth failing on */ });
        }
        return Response.json({ ok: true });
      }
    }

    // Anything we cannot auto-provision (single-word name, existing account,
    // seat cap, storage) falls through to manual review below. The response is
    // identical either way, so the form never reveals whether an account exists.
  }

  // Store as pending (service-role write — access_requests has no
  // authenticated RLS policies) and notify admin.
  try {
    const db = getServiceRoleClient();
    if (db) {
      // One open request per email — replace any prior pending row.
      await db.from('access_requests')
        .delete()
        .eq('kind', 'access')
        .eq('email', record.email)
        .eq('status', 'requested');
      await db.from('access_requests').insert({
        kind:             'access',
        email:            record.email,
        requested_domain: domain || null,
        name:             record.name,
        firm_name:        record.firm,
        use_case:         record.useCase,
        firm_type:        record.firmType,
        firm_size:        record.firmSize,
      });
    }
  } catch {
    // Storage failure must not fail the request — the admin email below still lands.
  }

  // Notify admin — non-blocking
  if (process.env.DISABLE_EMAILS !== 'true') {
    const resend = getResend();
    const from   = process.env.OUTREACH_FROM_EMAIL;
    if (resend && from) {
      resend.emails.send({
        from,
        to:      ADMIN_NOTIFY_EMAILS,
        subject: `New access request: ${record.name} — ${record.firm}`,
        html: `<p><strong>Name:</strong> ${escapeHtml(record.name)}</p>
<p><strong>Firm:</strong> ${escapeHtml(record.firm)}</p>
<p><strong>Email:</strong> ${escapeHtml(record.email)}</p>
<p><strong>Research focus:</strong></p>
<p style="white-space:pre-wrap;">${escapeHtml(record.useCase)}</p>`,
        text: `Name: ${record.name}\nFirm: ${record.firm}\nEmail: ${record.email}\n\nResearch focus:\n${record.useCase}`,
      }).catch(() => {});
    }
  }

  return Response.json({ ok: true });
}

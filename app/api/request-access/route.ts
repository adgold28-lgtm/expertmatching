import { NextRequest } from 'next/server';
import { Resend } from 'resend';
import { createHmac } from 'crypto';
import { getServiceRoleClient } from '../../../lib/supabase/admin';
import { getUpstashClient } from '../../../lib/upstashRedis';
import type { FirmTypeValue, FirmSizeValue } from '../../../lib/supabase/database.types';
import { getFromAddress } from '../../../lib/mailFrom';

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

// Human labels for the admin notification — the raw enum values are for the
// database, not for a person reading the email at 7am.
const FIRM_TYPE_LABELS: Record<string, string> = {
  pe_firm:         'PE firm',
  family_office:   'Family office',
  consulting_firm: 'Consulting firm',
  law_firm:        'Law firm',
  hedge_fund:      'Hedge fund',
  corporate:       'Corporate',
  other:           'Other',
};
const FIRM_SIZE_LABELS: Record<string, string> = {
  boutique: 'Boutique',
  mid_size: 'Mid-size',
  large:    'Large',
};

function labelFor(labels: Record<string, string>, value: string | null): string {
  return value ? labels[value] ?? value : 'Not given';
}

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

  // EVERY request is reviewed by a platform admin. Requests used to be
  // auto-approved when the email domain matched an existing organization,
  // which turned the founder's gmail.com admin org into open registration for
  // every Gmail address on earth (lib/emailDomains.ts). Access is invite-only:
  // an admin approves from /admin/requests, or a champion invites a colleague
  // from Settings → Team. The response is identical for every address, so the
  // form never reveals whether a firm or an account exists.

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

  // Notify admin. Awaited: on Vercel a floating promise can be cut off when
  // the response returns, and a failed notification must at least be logged.
  if (process.env.DISABLE_EMAILS !== 'true') {
    const resend = getResend();
    if (resend) {
      const { error } = await resend.emails.send({
        from:    getFromAddress(),
        to:      ADMIN_NOTIFY_EMAILS,
        subject: `New access request: ${record.name} — ${record.firm}`,
        html: `<p><strong>Name:</strong> ${escapeHtml(record.name)}</p>
<p><strong>Firm:</strong> ${escapeHtml(record.firm)}</p>
<p><strong>Firm type:</strong> ${escapeHtml(labelFor(FIRM_TYPE_LABELS, record.firmType))}</p>
<p><strong>Firm size:</strong> ${escapeHtml(labelFor(FIRM_SIZE_LABELS, record.firmSize))}</p>
<p><strong>Email:</strong> ${escapeHtml(record.email)}</p>
<p><strong>Research focus:</strong></p>
<p style="white-space:pre-wrap;">${escapeHtml(record.useCase)}</p>`,
        text: [
          `Name: ${record.name}`,
          `Firm: ${record.firm}`,
          `Firm type: ${labelFor(FIRM_TYPE_LABELS, record.firmType)}`,
          `Firm size: ${labelFor(FIRM_SIZE_LABELS, record.firmSize)}`,
          `Email: ${record.email}`,
          '',
          'Research focus:',
          record.useCase,
        ].join('\n'),
      }).catch((err: unknown) => ({ error: err instanceof Error ? err : new Error('send_failed') }));
      if (error) {
        console.error('[request-access] admin notification failed', {
          reason: ('message' in error ? String(error.message) : 'unknown').slice(0, 120),
        });
      }
    }
  }

  return Response.json({ ok: true });
}

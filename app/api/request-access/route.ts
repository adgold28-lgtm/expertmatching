import { NextRequest } from 'next/server';
import { Resend } from 'resend';
import { getServiceRoleClient } from '../../../lib/supabase/admin';
import { isApprovedDomain } from '../../../lib/firmStore';
import { provisionAccountInvite, splitFullName } from '../../../lib/accountProvisioning';

interface AccessRequest {
  name:        string;
  firm:        string;
  email:       string;
  useCase:     string;
  submittedAt: number;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
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
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const { name, firm, email, useCase } = body as Record<string, unknown>;

  if (typeof name !== 'string' || !name.trim()) {
    return Response.json({ error: 'Name is required' }, { status: 400 });
  }
  if (typeof firm !== 'string' || !firm.trim()) {
    return Response.json({ error: 'Firm name is required' }, { status: 400 });
  }
  if (typeof email !== 'string' || !email.trim() || !email.includes('@')) {
    return Response.json({ error: 'Valid email is required' }, { status: 400 });
  }
  if (typeof useCase !== 'string' || !useCase.trim()) {
    return Response.json({ error: 'Use case is required' }, { status: 400 });
  }

  const record: AccessRequest = {
    name:        name.trim().slice(0, 200),
    firm:        firm.trim().slice(0, 200),
    email:       email.trim().toLowerCase().slice(0, 200),
    useCase:     useCase.trim().slice(0, 2000),
    submittedAt: Date.now(),
  };

  const domain = record.email.split('@')[1] ?? '';

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
      if (result.ok) return Response.json({ ok: true });
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
        to:      'asher@expertmatch.fit',
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

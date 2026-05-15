import { NextRequest } from 'next/server';
import { Resend } from 'resend';
import { getUpstashClient } from '../../../lib/upstashRedis';

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

  // Store in Redis — best effort
  try {
    const redis = getUpstashClient();
    if (redis) {
      // Individual record keyed by email — overwrites on re-submit
      await redis.set(`access-request:${record.email}`, JSON.stringify(record));

      // Append to list (newest-first), cap at 500
      const listKey = 'access-requests:list';
      const existing = await redis.get(listKey);
      let list: AccessRequest[] = [];
      if (existing) {
        try {
          list = JSON.parse(typeof existing === 'string' ? existing : JSON.stringify(existing));
        } catch {
          list = [];
        }
      }
      // Remove any existing entry for this email, prepend new one
      list = [record, ...list.filter(r => r.email !== record.email)].slice(0, 500);
      await redis.set(listKey, JSON.stringify(list));
    }
  } catch {
    // Redis failure must not fail the request
  }

  // Notify — non-blocking, never fails the response
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

  console.log('[request-access] submission received', { status: 'ok' });
  return Response.json({ ok: true });
}

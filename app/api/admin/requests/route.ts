import { NextRequest } from 'next/server';
import { adminGuard, getSessionUser } from '../../../../lib/auth';
import { getServiceRoleClient } from '../../../../lib/supabase/admin';
import { upsertFirm } from '../../../../lib/firmStore';
import type { FirmTypeValue, FirmSizeValue } from '../../../../lib/supabase/database.types';
import { provisionAccountInvite, splitFullName, sanitizeName } from '../../../../lib/accountProvisioning';

// Wire shape consumed by app/admin/requests/page.tsx — kept stable.
interface AccessRequest {
  name:        string;
  firm:        string;
  email:       string;
  useCase:     string;
  // Matchy's firm phrase, as submitted. Shown for context; applied to the
  // organization on approval.
  firmType:    FirmTypeValue | null;
  firmSize:    FirmSizeValue | null;
  submittedAt: number;
}

export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  try {
    const db = getServiceRoleClient();
    if (!db) return Response.json({ requests: [] });

    const { data } = await db
      .from('access_requests')
      .select('*')
      .eq('kind', 'access')
      .eq('status', 'requested')
      .order('created_at', { ascending: false })
      .limit(500);

    const requests: AccessRequest[] = (data ?? []).map(r => ({
      name:        r.name ?? '',
      firm:        r.firm_name ?? '',
      email:       r.email,
      useCase:     r.use_case ?? '',
      firmType:    r.firm_type ?? null,
      firmSize:    r.firm_size ?? null,
      submittedAt: Date.parse(r.created_at) || 0,
    }));
    return Response.json({ requests });
  } catch {
    return Response.json({ error: 'Failed to load requests' }, { status: 500 });
  }
}

const FIRM_TYPES = new Set<FirmTypeValue>([
  'pe_firm', 'family_office', 'consulting_firm', 'law_firm', 'hedge_fund', 'corporate', 'other',
]);
const FIRM_SIZES = new Set<FirmSizeValue>(['boutique', 'mid_size', 'large']);

/** A submitted override wins only when it is one of the check-constrained values. */
function readFirmType(raw: unknown): FirmTypeValue | null {
  return typeof raw === 'string' && FIRM_TYPES.has(raw as FirmTypeValue)
    ? (raw as FirmTypeValue)
    : null;
}

function readFirmSize(raw: unknown): FirmSizeValue | null {
  return typeof raw === 'string' && FIRM_SIZES.has(raw as FirmSizeValue)
    ? (raw as FirmSizeValue)
    : null;
}

// POST { action: 'approve' | 'reject', email, firstName?, lastName?, firmName?,
//        firmType?, firmSize? }
//
// Approval creates the account through provisionAccountInvite: the requester's
// submitted name is split into first / last and their firm name becomes the
// organization name. The admin can correct any of them before approving —
// including the two firm answers, which are what Matchy turns into "a mid-size
// PE firm" in an intro.
export async function POST(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const b      = body as Record<string, unknown>;
  const action = b.action;
  const email  = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'valid_email_required' }, { status: 400 });
  }

  const db = getServiceRoleClient();
  if (!db) return Response.json({ error: 'storage_unavailable' }, { status: 503 });

  if (action === 'reject') {
    await db.from('access_requests')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
      .eq('kind', 'access')
      .eq('email', email)
      .eq('status', 'requested');
    return Response.json({ ok: true });
  }

  if (action !== 'approve') {
    return Response.json({ error: 'invalid_action' }, { status: 400 });
  }

  // ── Recover the submission for the requester's name + firm ──────────────────
  const { data: pending } = await db
    .from('access_requests')
    .select('name, firm_name, firm_type, firm_size')
    .eq('kind', 'access')
    .eq('email', email)
    .eq('status', 'requested')
    .maybeSingle();

  const submitted = splitFullName(pending?.name ?? '');
  const firstName = sanitizeName(b.firstName) || submitted.firstName;
  const lastName  = sanitizeName(b.lastName)  || submitted.lastName;
  const firmName  = sanitizeName(b.firmName)  || sanitizeName(pending?.firm_name ?? '');

  if (!firstName || !lastName) {
    return Response.json(
      {
        error:   'name_required',
        message: 'This request has no usable first and last name — enter them before approving.',
      },
      { status: 400 },
    );
  }

  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) return Response.json({ error: 'invalid_email' }, { status: 400 });

  // Organizations are billed per active seat (lib/pricing.ts); there is no
  // plan to choose. Apply the admin's corrected firm name before provisioning.
  await upsertFirm(domain, {
    name:   firmName || domain,
    status: 'active',
  }).catch(() => { /* provisioning creates the organization if this failed */ });

  const session = await getSessionUser(request);

  const result = await provisionAccountInvite({
    firstName,
    lastName,
    email,
    organization:    { domain, name: firmName || domain },
    invitedByEmail:  session.email,
    isPlatformAdmin: true,
  });

  if (!result.ok) {
    return Response.json({ error: result.error, message: result.message }, { status: result.status });
  }

  // Carry the requester's two firm answers onto the organization now that it
  // definitely exists. This is what lets Matchy say "a mid-size PE firm" in an
  // intro instead of falling back to "an investment firm". The admin's
  // correction, when it is a valid value, wins over what was submitted.
  const firmType = readFirmType(b.firmType) ?? ((pending?.firm_type ?? null) as FirmTypeValue | null);
  const firmSize = readFirmSize(b.firmSize) ?? ((pending?.firm_size ?? null) as FirmSizeValue | null);
  if (firmType || firmSize) {
    await upsertFirm(domain, {
      ...(firmType ? { firmType } : {}),
      ...(firmSize ? { firmSize } : {}),
    }).catch(() => { /* the account is provisioned; the firm phrase is editable later */ });
  }

  await db.from('access_requests')
    .update({ status: 'approved', reviewed_at: new Date().toISOString() })
    .eq('kind', 'access')
    .eq('email', email)
    .eq('status', 'requested');

  return Response.json({
    ok:        true,
    emailSent: result.emailSent,
    ...(result.emailSent ? {} : { warning: 'Invite created, but the email could not be delivered.' }),
  });
}

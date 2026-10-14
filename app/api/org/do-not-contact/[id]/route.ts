// DELETE /api/org/do-not-contact/[id]: take one entry off the firm's list.
//
// Champion (org_admin) or platform staff only, scoped to the caller's own
// organization (staff may name one with ?orgId=). The delete is filtered on
// BOTH the id and the organization, so an id from another firm's list is a
// 404, never a delete. Takes effect on the very next send: nothing caches the
// list (lib/doNotContact.ts).
//
// A bodiless DELETE is fine: DELETE is never a "simple" cross-origin method, so
// the browser preflights it whatever it carries (see lib/projectsGuard).
//
// Same 503 { error: 'not_available' } as the list route until the launch-pack
// migration is pasted. Never logs the entry's value.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser, type SessionUser } from '../../../../../lib/auth';
import { getServiceRoleClient } from '../../../../../lib/supabase/admin';
import { getUserOrgMembership } from '../../../../../lib/firmStore';
import { createRateLimiterStore } from '../../../../../lib/rateLimiter';
import { pseudonymize } from '../../../../../lib/contactCache';
import {
  DNC_COPY,
  DO_NOT_CONTACT_WRITES_PER_HOUR,
  decideListAccess,
  isMissingTableError,
} from '../../../../../lib/doNotContact';

const UUID_RE     = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ONE_HOUR_MS = 60 * 60 * 1000;

function notAvailable(): Response {
  return Response.json({ error: 'not_available', message: DNC_COPY.notAvailable }, { status: 503 });
}

/** Same resolution as the list route (app/api/org/do-not-contact/route.ts). */
async function resolveAccess(
  user: SessionUser,
  requestedOrgId: string | null,
): Promise<{ orgId: string; canManage: boolean } | Response> {
  if (requestedOrgId && !UUID_RE.test(requestedOrgId)) {
    return Response.json({ error: 'invalid_org_id' }, { status: 400 });
  }

  let viewer = { role: user.role, orgId: user.orgId ?? null, orgRole: user.orgRole ?? null };
  if (user.role !== 'admin' && (!user.orgId || !user.orgRole) && user.email) {
    const membership = await getUserOrgMembership(user.email).catch(() => null);
    if (membership) {
      viewer = {
        role:    user.role,
        orgId:   membership.orgId,
        orgRole: membership.status === 'active' ? membership.orgRole : 'org_member',
      };
    }
  }

  const access = decideListAccess(viewer, requestedOrgId);
  if (!access.ok) {
    return Response.json({ error: 'no_organization', message: 'No organization to manage.' }, { status: 400 });
  }
  return { orgId: access.orgId, canManage: access.canManage };
}

const _rlStore = (() => { try { return createRateLimiterStore(); } catch { return null; } })();

/** Shares its window with the list route's adds. Fails OPEN. */
async function withinWriteLimit(email: string): Promise<boolean> {
  if (!_rlStore || !email) return true;
  try {
    const { count } = await _rlStore.increment(`rl:dnc-write:${pseudonymize(email)}:1h`, ONE_HOUR_MS);
    return count <= DO_NOT_CONTACT_WRITES_PER_HOUR;
  } catch {
    return true;
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  // Bodiless, or JSON. Anything else is not something our page sends.
  const ct = request.headers.get('content-type') ?? '';
  if (ct && !ct.startsWith('application/json')) {
    return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
  }

  if (!UUID_RE.test(params.id)) {
    return Response.json({ error: 'invalid_id' }, { status: 400 });
  }

  const user   = await getSessionUser(request);
  const access = await resolveAccess(user, request.nextUrl.searchParams.get('orgId'));
  if (access instanceof Response) return access;
  if (!access.canManage) {
    return Response.json({ error: 'forbidden', message: DNC_COPY.championNote }, { status: 403 });
  }

  if (!await withinWriteLimit(user.email)) {
    return Response.json(
      { error: 'rate_limited', message: 'That is a lot of changes at once. Try again in an hour.' },
      { status: 429 },
    );
  }

  const db = getServiceRoleClient();
  if (!db) return notAvailable();

  try {
    const { data, error } = await db
      .from('organization_do_not_contact')
      .delete()
      .eq('id', params.id)
      .eq('organization_id', access.orgId)
      .select('id');

    if (error) {
      if (isMissingTableError(error)) return notAvailable();
      console.error('[org/do-not-contact] delete failed:', (error.message ?? '').slice(0, 120));
      return Response.json({ error: 'delete_failed', message: "Couldn't remove that. Try again." }, { status: 500 });
    }
    if (!data || data.length === 0) {
      return Response.json({ error: 'not_found', message: 'That entry is not on the list.' }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[org/do-not-contact] DELETE threw:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return Response.json({ error: 'delete_failed', message: "Couldn't remove that. Try again." }, { status: 500 });
  }
}

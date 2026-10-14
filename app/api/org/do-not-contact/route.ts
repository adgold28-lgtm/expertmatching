// GET / POST /api/org/do-not-contact: the firm's own do-not-contact list.
//
// The list itself, its matching rules and its failure rule live in
// lib/doNotContact.ts. This route only reads and writes it.
//
// WHO SEES WHAT. The organization comes from the caller's membership, the same
// way app/api/org/members resolves it (app_metadata first, organization_members
// for an older session whose claims predate org roles). Platform staff may
// name any organization with ?orgId= (GET) or { orgId } (POST).
//   - the champion (org_admin) and platform staff: the whole list, and may add
//   - everyone else in the firm: the count, and a note that the champion
//     manages it. Never the entries.
//
// POST { kind, value }             one entry
// POST { upload, defaultKind }     a pasted list or a .csv / .txt file's text
//   Deduplicated against the list (the table is unique on organization, kind
//   and normalized value), capped at 5,000 entries per organization (all or
//   nothing: an upload that would pass the cap adds nothing), body capped at
//   2 MB and the upload text at 1 MB, rate limited per user.
//
// NOT AVAILABLE. Until supabase/migrations/20261014000000_launch_pack.sql is
// pasted, the table does not exist: every call answers 503
// { error: 'not_available', message } and the page shows that message. The
// send path meanwhile treats the missing table as an empty list.
//
// Never logs: entry values, the uploaded text, or the caller's address.

import { NextRequest } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  routeAuthGuard,
  getSessionUser,
  getSupabaseSessionUser,
  type SessionUser,
} from '../../../../lib/auth';
import { getServiceRoleClient } from '../../../../lib/supabase/admin';
import type { Database } from '../../../../lib/supabase/database.types';
import { getFirmById, getUserOrgMembership } from '../../../../lib/firmStore';
import { createRateLimiterStore } from '../../../../lib/rateLimiter';
import { pseudonymize } from '../../../../lib/contactCache';
import {
  DNC_COPY,
  DO_NOT_CONTACT_LIMIT,
  DO_NOT_CONTACT_WRITES_PER_HOUR,
  UPLOAD_MAX_BYTES,
  countByKind,
  decideListAccess,
  isDoNotContactKind,
  isMissingTableError,
  normalizeEntry,
  parseUpload,
  planAdditions,
  type DoNotContactKind,
  type ParsedEntry,
  type RejectedLine,
  type StoreError,
} from '../../../../lib/doNotContact';

const MAX_BODY_BYTES   = 2 * UPLOAD_MAX_BYTES;
const UUID_RE          = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE        = 1000;
const MAX_PAGES        = Math.ceil(DO_NOT_CONTACT_LIMIT / PAGE_SIZE) + 1;
const INSERT_CHUNK     = 500;
const REJECTED_SHOWN   = 50;
const ONE_HOUR_MS      = 60 * 60 * 1000;

type Db = SupabaseClient<Database>;

// ─── Shared helpers (the DELETE route keeps its own copy of the first three) ──

function notAvailable(): Response {
  return Response.json({ error: 'not_available', message: DNC_COPY.notAvailable }, { status: 503 });
}

/** The organization this request acts on, and whether the caller may change it. */
async function resolveAccess(
  user: SessionUser,
  requestedOrgId: string | null,
): Promise<{ orgId: string; canManage: boolean } | Response> {
  if (requestedOrgId && !UUID_RE.test(requestedOrgId)) {
    return Response.json({ error: 'invalid_org_id' }, { status: 400 });
  }

  let viewer = { role: user.role, orgId: user.orgId ?? null, orgRole: user.orgRole ?? null };

  // An older session can carry no org claims at all; organization_members is
  // authoritative (as at /api/org/membership). Only an ACTIVE champion manages.
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

/** Fails OPEN like every other in-app limiter; the key is an HMAC of the email. */
async function withinWriteLimit(email: string): Promise<boolean> {
  if (!_rlStore || !email) return true;
  try {
    const { count } = await _rlStore.increment(`rl:dnc-write:${pseudonymize(email)}:1h`, ONE_HOUR_MS);
    return count <= DO_NOT_CONTACT_WRITES_PER_HOUR;
  } catch {
    return true;
  }
}

interface ListRow {
  id:               string;
  kind:             DoNotContactKind;
  value:            string;
  value_normalized: string;
  created_at:       string;
}

/** Every entry of one organization, newest first, a page at a time. */
async function loadEntries(db: Db, orgId: string): Promise<{ rows: ListRow[] } | { error: StoreError }> {
  const rows: ListRow[] = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const from = page * PAGE_SIZE;
    const { data, error } = await db
      .from('organization_do_not_contact')
      .select('id, kind, value, value_normalized, created_at')
      .eq('organization_id', orgId)
      .order('created_at', { ascending: false })
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) return { error };
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return { rows };
}

function readFailure(error: StoreError, what: string): Response {
  if (isMissingTableError(error)) return notAvailable();
  console.error(`[org/do-not-contact] ${what} failed:`, (error.message ?? '').slice(0, 120));
  return Response.json(
    { error: 'load_failed', message: "Couldn't load the list. Try again." },
    { status: 500 },
  );
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const user   = await getSessionUser(request);
  const access = await resolveAccess(user, request.nextUrl.searchParams.get('orgId'));
  if (access instanceof Response) return access;

  const db = getServiceRoleClient();
  if (!db) return notAvailable();

  try {
    const firm = await getFirmById(access.orgId).catch(() => null);
    const organization = { id: access.orgId, name: firm?.name || firm?.domain || '' };

    if (!access.canManage) {
      const { count, error } = await db
        .from('organization_do_not_contact')
        .select('id', { count: 'exact', head: true })
        .eq('organization_id', access.orgId);
      if (error) return readFailure(error, 'count');
      return Response.json({
        organization,
        canManage: false,
        limit:     DO_NOT_CONTACT_LIMIT,
        counts:    { total: count ?? 0 },
        message:   DNC_COPY.championNote,
      });
    }

    const loaded = await loadEntries(db, access.orgId);
    if ('error' in loaded) return readFailure(loaded.error, 'list');

    return Response.json({
      organization,
      canManage: true,
      limit:     DO_NOT_CONTACT_LIMIT,
      counts:    countByKind(loaded.rows),
      entries:   loaded.rows.map(r => ({
        id:        r.id,
        kind:      r.kind,
        value:     r.value,
        createdAt: r.created_at,
      })),
    });
  } catch (err) {
    console.error('[org/do-not-contact] GET threw:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return Response.json({ error: 'load_failed', message: "Couldn't load the list. Try again." }, { status: 500 });
  }
}

// ─── POST ─────────────────────────────────────────────────────────────────────

async function readBody(request: NextRequest): Promise<Record<string, unknown> | Response> {
  const ct = request.headers.get('content-type') ?? '';
  if (!ct.startsWith('application/json')) {
    return Response.json({ error: 'unsupported_media_type' }, { status: 415 });
  }
  const declared = request.headers.get('content-length');
  if (declared !== null && parseInt(declared, 10) > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload_too_large', message: 'That file is too large. Keep it under 1 MB.' }, { status: 413 });
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return Response.json({ error: 'failed_to_read_body' }, { status: 400 });
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) {
    return Response.json({ error: 'payload_too_large', message: 'That file is too large. Keep it under 1 MB.' }, { status: 413 });
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return Response.json({ error: 'invalid_json' }, { status: 400 });
    }
    return parsed as Record<string, unknown>;
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }
}

interface Candidates {
  entries:    ParsedEntry[];
  rejected:   RejectedLine[];
  duplicates: number;
  overLimit:  number;
}

/** The entries a POST body asks for, or the 400 that explains why not. */
function candidatesOf(body: Record<string, unknown>): Candidates | Response {
  if (typeof body.upload === 'string') {
    if (Buffer.byteLength(body.upload, 'utf8') > UPLOAD_MAX_BYTES) {
      return Response.json({ error: 'payload_too_large', message: 'That file is too large. Keep it under 1 MB.' }, { status: 413 });
    }
    const defaultKind: DoNotContactKind = isDoNotContactKind(body.defaultKind) ? body.defaultKind : 'company';
    return parseUpload(body.upload, defaultKind);
  }

  if (!isDoNotContactKind(body.kind)) {
    return Response.json(
      { error: 'invalid_kind', message: 'Choose company, person, email or domain.' },
      { status: 400 },
    );
  }
  const raw = typeof body.value === 'string' ? body.value : '';
  const n   = normalizeEntry(body.kind, raw);
  if (!n.ok) return Response.json({ error: 'invalid_entry', message: n.reason }, { status: 400 });
  return {
    entries:    [{ kind: body.kind, value: n.value, normalized: n.normalized, line: 1 }],
    rejected:   [],
    duplicates: 0,
    overLimit:  0,
  };
}

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const body = await readBody(request);
  if (body instanceof Response) return body;

  const user   = await getSessionUser(request);
  const access = await resolveAccess(user, typeof body.orgId === 'string' ? body.orgId : null);
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

  const candidates = candidatesOf(body);
  if (candidates instanceof Response) return candidates;

  const rejectedReport = {
    rejected:      candidates.rejected.slice(0, REJECTED_SHOWN),
    rejectedCount: candidates.rejected.length,
    overLimit:     candidates.overLimit,
  };

  if (candidates.entries.length === 0) {
    return Response.json(
      {
        error:   'nothing_to_add',
        message: candidates.duplicates > 0
          ? 'Those were all repeats of each other.'
          : 'Nothing in that list could be added.',
        ...rejectedReport,
      },
      { status: 400 },
    );
  }

  const db = getServiceRoleClient();
  if (!db) return notAvailable();

  try {
    const loaded = await loadEntries(db, access.orgId);
    if ('error' in loaded) return readFailure(loaded.error, 'list');

    const plan = planAdditions(
      loaded.rows.map(r => ({ kind: r.kind, normalized: r.value_normalized })),
      candidates.entries,
    );

    if (plan.overCap) {
      return Response.json(
        {
          error:   'list_full',
          message: plan.room === 0
            ? 'The list is full at 5,000 entries. Remove some first.'
            : `That would take the list past 5,000 entries. There is room for ${plan.room.toLocaleString('en-US')} more.`,
          room:    plan.room,
        },
        { status: 409 },
      );
    }

    const authUser = await getSupabaseSessionUser(request);
    const addedBy  = authUser?.id ?? null;

    let added = 0;
    for (let i = 0; i < plan.add.length; i += INSERT_CHUNK) {
      const chunk = plan.add.slice(i, i + INSERT_CHUNK).map(e => ({
        organization_id:  access.orgId,
        kind:             e.kind,
        value:            e.value,
        value_normalized: e.normalized,
        added_by:         addedBy,
      }));
      const { data, error } = await db
        .from('organization_do_not_contact')
        .upsert(chunk, { onConflict: 'organization_id,kind,value_normalized', ignoreDuplicates: true })
        .select('id');
      if (error) {
        if (isMissingTableError(error)) return notAvailable();
        console.error('[org/do-not-contact] insert failed:', (error.message ?? '').slice(0, 120));
        return Response.json(
          { error: 'save_failed', message: "Couldn't save that. Try again.", added },
          { status: 500 },
        );
      }
      added += data?.length ?? 0;
    }

    return Response.json({
      ok:            true,
      added,
      // Repeats inside the upload, already on the list, or added by someone
      // else between our read and our write: all of them already covered.
      alreadyListed: candidates.duplicates + plan.alreadyListed + (plan.add.length - added),
      ...rejectedReport,
    });
  } catch (err) {
    console.error('[org/do-not-contact] POST threw:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return Response.json({ error: 'save_failed', message: "Couldn't save that. Try again." }, { status: 500 });
  }
}

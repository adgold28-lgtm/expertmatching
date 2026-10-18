// GET /api/projects/:projectId/conversations/export?format=csv|txt
//
// Every thread in the project in one chronological log, for the client's
// compliance officer. The Conversations tab's "Export all" button.
//
// SAME ACCESS AS READING A THREAD: every project member (owner, collaborators,
// staff); anyone else gets 404, never 403, so the route never confirms that a
// project exists.
//
// SAME CONTENT AS THE THREADS. Each expert's messages are redacted for this
// viewer exactly as GET …/messages redacts them, each against that expert's
// own reveal (lib/conversationExport.ts): before a call is booked a client's
// file names the expert "Scott S." and carries Matchy's masked summary in
// place of every expert email. Staff get the clean bodies, and can see a
// client's file with `?view=client`.
//
// Threads are read through lib/conversations.listThread (the one sanctioned
// way into conversation_messages), a few at a time, and only for experts who
// can have one (lib/conversationExport.mayHaveThread). The filename is a short
// project id and the date: never the client's firm, never an expert. Rate
// limited per user, failing OPEN on a store outage. Every export records
// `conversation_exported` (counts only).
//
// Never logs: message text, expert names, expert emails, project name.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../lib/auth';
import { guardReadRequest } from '../../../../../../lib/projectsGuard';
import { getProjectForUser } from '../../../../../../lib/projectStore';
import { trackProductEvent } from '../../../../../../lib/productEvents';
import { createRateLimiterStore, type RateLimiterStore } from '../../../../../../lib/rateLimiter';
import {
  checkExportLimit,
  exportFilename,
  exportHeaders,
  listThreads,
  parseExportFormat,
  projectRows,
  toCsv,
  toTxt,
} from '../../../../../../lib/conversationExport';

const ID_RE = /^[a-f0-9]{24}$/;

// ─── Rate limit, fail open ────────────────────────────────────────────────────

const _rlStore: RateLimiterStore | null = (() => {
  try { return createRateLimiterStore(); } catch { return null; }
})();

async function withinExportLimit(userEmail: string): Promise<boolean> {
  if (!_rlStore) return true;
  try {
    return (await checkExportLimit(_rlStore, userEmail)).allowed;
  } catch {
    return true;
  }
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string } },
): Promise<NextResponse> {
  const guard = await guardReadRequest(request);
  if (guard) return guard as NextResponse;

  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }

  const format = parseExportFormat(request.nextUrl.searchParams.get('format'));
  if (!format) {
    return NextResponse.json({ error: 'invalid_format', message: 'Use csv or txt.' }, { status: 400 });
  }

  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    if (!(await withinExportLimit(email))) {
      return NextResponse.json(
        { error: 'export_rate_limited', message: 'Too many exports in a short time. Try again in a few minutes.' },
        { status: 429 },
      );
    }

    const viewRole = role === 'admin' && request.nextUrl.searchParams.get('view') === 'client' ? 'user' : role;

    // The Conversations list's order: most recently active thread first, so a
    // shared label is numbered the way the client sees the list.
    const experts = [...project.experts].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
    const threads = await listThreads(params.projectId, experts);
    const rows    = projectRows(threads, viewRole);
    const now     = Date.now();
    const body    = format === 'csv'
      ? toCsv(rows)
      : toTxt(rows, { scope: 'project', projectId: params.projectId, exportedAt: now });

    void trackProductEvent({
      type:       'conversation_exported',
      actorEmail: email,
      projectId:  params.projectId,
      payload:    {
        scope:    'project',
        format,
        messages: rows.length,
        threads:  threads.filter(t => t.rows.length > 0).length,
        asClient: viewRole === 'user',
      },
    });

    return new NextResponse(body, {
      status:  200,
      headers: exportHeaders(format, exportFilename('project', params.projectId, format, now)),
    });
  } catch (err) {
    console.error('[conversations/export] failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'export_failed' }, { status: 500 });
  }
}

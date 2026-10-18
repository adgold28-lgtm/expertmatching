// GET /api/projects/:projectId/experts/:expertId/messages/export?format=csv|txt
//
// One thread's log, as a file, for the client's compliance officer ("an
// exportable log of every message"). The thread header's "Export log" button.
//
// SAME ACCESS AS READING THE THREAD, copied from GET …/messages: every project
// member may export (owner, collaborators, staff), and anyone else gets 404,
// never 403, so the route never confirms that a project exists.
//
// SAME CONTENT AS THE THREAD. Each row goes through
// lib/conversations.redactMessageForViewer with the viewer GET …/messages
// builds (lib/conversationExport.ts): a client's file has Matchy's masked
// summary for every expert message and no body, Matchy's copy with the
// amounts masked, and their own messages; staff get the clean bodies. Staff
// can see a client's file with `?view=client`, like the project route.
//
// The filename carries a short project id, a short hash of the thread and the
// date: never the client's firm, never the expert. Rate limited per user
// (lib/conversationExport.checkExportLimit), failing OPEN on a store outage.
// Every export records `conversation_exported` (counts only).
//
// Never logs: message text, expert name, expert email, project name.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../../../lib/auth';
import { guardReadRequest } from '../../../../../../../../lib/projectsGuard';
import { getProjectForUser } from '../../../../../../../../lib/projectStore';
import { listThread } from '../../../../../../../../lib/conversations';
import { trackProductEvent } from '../../../../../../../../lib/productEvents';
import { createRateLimiterStore, type RateLimiterStore } from '../../../../../../../../lib/rateLimiter';
import {
  checkExportLimit,
  exportFilename,
  exportHeaders,
  parseExportFormat,
  threadRows,
  toCsv,
  toTxt,
} from '../../../../../../../../lib/conversationExport';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

function badIds(projectId: string, expertId: string): NextResponse | null {
  if (!ID_RE.test(projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }
  return null;
}

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
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  const guard = await guardReadRequest(request);
  if (guard) return guard as NextResponse;

  const idError = badIds(params.projectId, params.expertId);
  if (idError) return idError;

  const format = parseExportFormat(request.nextUrl.searchParams.get('format'));
  if (!format) {
    return NextResponse.json({ error: 'invalid_format', message: 'Use csv or txt.' }, { status: 400 });
  }

  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === params.expertId);
    if (!pe) return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

    if (!(await withinExportLimit(email))) {
      return NextResponse.json(
        { error: 'export_rate_limited', message: 'Too many exports in a short time. Try again in a few minutes.' },
        { status: 429 },
      );
    }

    // Staff checking what a client's file holds, as the project route allows.
    const viewRole = role === 'admin' && request.nextUrl.searchParams.get('view') === 'client' ? 'user' : role;

    const rows = threadRows(pe, await listThread(params.projectId, params.expertId), viewRole);
    const now  = Date.now();
    const body = format === 'csv'
      ? toCsv(rows)
      : toTxt(rows, { scope: 'thread', projectId: params.projectId, exportedAt: now });

    void trackProductEvent({
      type:       'conversation_exported',
      actorEmail: email,
      projectId:  params.projectId,
      payload:    { scope: 'thread', format, messages: rows.length, threads: 1, asClient: viewRole === 'user' },
    });

    return new NextResponse(body, {
      status:  200,
      headers: exportHeaders(format, exportFilename('thread', params.projectId, format, now, params.expertId)),
    });
  } catch (err) {
    console.error('[messages/export] failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'export_failed' }, { status: 500 });
  }
}

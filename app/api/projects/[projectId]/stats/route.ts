// GET /api/projects/[projectId]/stats — the live project stats a client reads at
// the top of Conversations: intros sent, replies (and the rate), calls booked,
// and how long the first call took to book after the first intro. The offer
// promises these "on your project page as it happens".
//
// ACCESS: the same rule as GET /api/projects/[projectId]. routeAuthGuard (an
// active session), guardReadRequest (kill switch, dev token), then
// getProjectForUser: the owner, a collaborator or staff get the numbers;
// anyone else gets 404, so a project they cannot reach is never confirmed to
// exist. Read-only, so a collaborator needs no owner check.
//
// WHAT CROSSES: lib/outreachStats.toClientProjectStats and nothing else. Five
// aggregates over one project: no per-expert row, no intro arm, no decline
// wording, no money, no delivery machinery. Staff receive the same payload; the
// staff detail lives on /admin/outreach.
//
// SOURCES (lib/outreachStats.ts documents each number): the project's own
// expert records, which getProjectForUser has already loaded, plus two narrow
// service-role reads scoped to this project id: the engagement_events that
// carry first-occurrence times, and the time and intent of each inbound expert
// message. Either read failing falls back to the records alone; it never fails
// the request.
//
// NEVER logs: project names, expert names, message content.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../lib/auth';
import { guardReadRequest } from '../../../../../lib/projectsGuard';
import { getProjectForUser } from '../../../../../lib/projectStore';
import { getServiceRoleClient } from '../../../../../lib/supabase/admin';
import {
  collectPages,
  deriveEngagementFacts,
  replyMessageFromRow,
  statsEventFromRow,
  summarizeProject,
  toClientProjectStats,
  STATS_EVENT_TYPES,
  type StatsEngagement,
  type StatsEvent,
  type StatsReplyMessage,
} from '../../../../../lib/outreachStats';

const ID_RE = /^[a-f0-9]{24}$/;

/** One project's signals never come near this; it bounds a runaway table. */
const MAX_SIGNAL_ROWS = 10_000;

async function loadSignals(projectId: string): Promise<{ events: StatsEvent[]; replies: StatsReplyMessage[] }> {
  const db = getServiceRoleClient();
  if (!db) return { events: [], replies: [] };

  const [events, replies] = await Promise.all([
    collectPages((from, to) => db
      .from('engagement_events')
      .select('id, project_id, expert_id, type, payload, created_at')
      .eq('project_id', projectId)
      .in('type', [...STATS_EVENT_TYPES])
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to), MAX_SIGNAL_ROWS),
    collectPages((from, to) => db
      .from('conversation_messages')
      .select('id, project_id, expert_id, created_at, intent, direction, author')
      .eq('project_id', projectId)
      .eq('direction', 'inbound')
      .eq('author', 'expert')
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, to), MAX_SIGNAL_ROWS),
  ]);

  if (events.failed || replies.failed) {
    console.warn('[api/projects/[id]/stats] signal read incomplete — using the records alone where missing',
      JSON.stringify({ events: events.failed, replies: replies.failed }));
  }

  return {
    events:  events.rows.map(statsEventFromRow).filter((e): e is StatsEvent => e !== null),
    replies: replies.rows.map(replyMessageFromRow).filter((r): r is StatsReplyMessage => r !== null),
  };
}

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const err = await guardReadRequest(request);
  if (err) return err;

  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }

  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return Response.json({ error: 'not_found' }, { status: 404 });

    const engagements: StatsEngagement[] = project.experts.map(pe => ({
      projectId: project.id,
      expertId:  pe.expert.id,
      pe,
    }));

    const { events, replies } = await loadSignals(project.id);
    const facts   = deriveEngagementFacts(engagements, events, replies, Date.now());
    const summary = summarizeProject(project.id, facts);

    return Response.json(
      { stats: toClientProjectStats(summary) },
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch (e) {
    console.error('[api/projects/[id]/stats] GET error:', e instanceof Error ? e.message.slice(0, 120) : 'unknown');
    return Response.json({ error: 'failed_to_get_stats' }, { status: 500 });
  }
}

// GET /api/admin/outreach-stats — the Test A scoreboard (founder/launch.md):
// intros, delivery, replies, the five-business-day reply line, agreement at the
// offered rate, declines, bounces, complaints and the mismatch guarantee, by
// intro arm and in total. Read by /admin/outreach.
//
// Platform admins only: adminGuard here, and middleware.ts 404s /api/admin/*
// for everyone else.
//
// Query:
//   from, to    'YYYY-MM-DD', the US Eastern calendar days the intro went out
//               on, both inclusive. Default: the last 30 days, today included.
//   projects    optional comma-separated project ids; empty means all.
//
// Response 200: OutreachStatsResponse (lib/outreachStats.ts). Every number is computed by
// lib/outreachStats.ts, which documents where each one comes from.
//
// IDENTITY: staff may see it, so the decline list carries the project and
// expert names. The response never carries an email address, a contact
// address that bounced, a rate, or a message body: the decline wording is
// Matchy's one-line summary of the reply, already screened.
//
// NEVER logs: project names, expert names, summaries.

import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { getServiceRoleClient } from '../../../../lib/supabase/admin';
import {
  addCivilDays,
  civilDateInZone,
  civilDateIsBefore,
  civilDateToIso,
  isoToCivilDate,
  type CivilDate,
} from '../../../../lib/availabilityWindows';
import {
  collectDeclineWords,
  collectPages,
  deriveEngagementFacts,
  introSentBetween,
  outreachByArm,
  replyMessageFromRow,
  statsEventFromRow,
  statsFieldsFromRecord,
  summarizeProject,
  testAMarks,
  OUTREACH_STATS_ZONE,
  STATS_EVENT_TYPES,
  type DeclineWordsOut,
  type EngagementFacts,
  type OutreachStatsResponse,
  type ProjectOption,
  type ProjectRowOut,
  type StatsEngagement,
  type StatsEvent,
  type StatsReplyMessage,
} from '../../../../lib/outreachStats';

const ID_RE = /^[a-f0-9]{24}$/;
const DEFAULT_RANGE_DAYS = 30;
const MAX_PROJECT_FILTER = 100;
/** Bound on each read; the response says `incomplete` if one is reached. */
const MAX_ROWS = 50_000;
/** `.in()` list length per projects lookup, to keep the URL short. */
const NAME_CHUNK = 100;

// Only these paths come out of project_experts.data: the stats fields, plus
// the expert's name for the staff decline list. Never the address, the draft,
// the rates or the expert record. `bouncedFirst` is read only to know whether
// the bounced list is non-empty and is replaced before anything else sees it.
const ENGAGEMENT_SELECT = [
  'id', 'project_id', 'expert_id', 'status',
  'email1SentAt:data->email1SentAt',
  'introArm:data->introArm',
  'replyDetectedAt:data->replyDetectedAt',
  'replyIntent:data->>replyIntent',
  'rejectionReason:data->>rejectionReason',
  'rateAgreedAt:data->rateAgreedAt',
  'expertCounterRate:data->expertCounterRate',
  'clientCounterRate:data->clientCounterRate',
  'counterRateProposed:data->counterRateProposed',
  'bookedAt:data->booking->bookedAt',
  'cancelledAt:data->booking->cancelledAt',
  'bouncedFirst:data->bouncedEmails->>0',
  'contactBouncedAt:data->contactBouncedAt',
  'complaintAt:data->complaintAt',
  'mismatchFlaggedAt:data->mismatchFlaggedAt',
  'mismatchVoidedAt:data->mismatchVoidedAt',
  'expertRemovedAt:data->expertRemovedAt',
  'expertName:data->expert->>name',
].join(', ');

function bad(message: string): Response {
  return Response.json({ error: 'invalid_query', message }, { status: 400 });
}

function parseRange(
  fromRaw: string | null,
  toRaw: string | null,
  today: CivilDate,
): { from: CivilDate; to: CivilDate } | string {
  const to   = toRaw ? isoToCivilDate(toRaw) : today;
  if (!to) return 'The end date must be a real date (YYYY-MM-DD).';
  const from = fromRaw ? isoToCivilDate(fromRaw) : addCivilDays(to, -(DEFAULT_RANGE_DAYS - 1));
  if (!from) return 'The start date must be a real date (YYYY-MM-DD).';
  if (civilDateIsBefore(to, from)) return 'The start date must be on or before the end date.';
  return { from, to };
}

function parseProjects(raw: string | null): string[] | string {
  if (!raw || raw.trim() === '') return [];
  const ids = Array.from(new Set(raw.split(',').map(s => s.trim()).filter(Boolean)));
  if (ids.length > MAX_PROJECT_FILTER) return `Pick at most ${MAX_PROJECT_FILTER} projects.`;
  if (!ids.every(id => ID_RE.test(id))) return 'A project id in the filter is not valid.';
  return ids;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await adminGuard(request);
  if (authError) return authError;

  const now   = Date.now();
  const today = civilDateInZone(new Date(now), OUTREACH_STATS_ZONE);
  const params = request.nextUrl.searchParams;

  const range = parseRange(params.get('from'), params.get('to'), today);
  if (typeof range === 'string') return bad(range);
  const projectFilter = parseProjects(params.get('projects'));
  if (typeof projectFilter === 'string') return bad(projectFilter);

  const db = getServiceRoleClient();
  if (!db) {
    return Response.json(
      { error: 'unavailable', message: 'The stats need the database, which is not configured here.' },
      { status: 503 },
    );
  }

  try {
    // Every event and reply that matters to an intro sent on or after `from`
    // happened on or after it. A day of slack covers any US zone's offset.
    const lowerBoundIso = new Date(
      Date.UTC(range.from.year, range.from.month - 1, range.from.day) - 24 * 60 * 60 * 1000,
    ).toISOString();
    const filtered = projectFilter.length > 0;

    const [engagementPages, eventPages, replyPages] = await Promise.all([
      // Not filtered by project at the database: the filter's own option list
      // needs every project that has sent an intro. The select is narrow.
      collectPages<Record<string, unknown>>((from, to) => {
        const q = db
          .from('project_experts')
          .select(ENGAGEMENT_SELECT)
          .not('status', 'in', '(discovered,shortlisted)')
          .order('id', { ascending: true })
          .range(from, to);
        return q as unknown as PromiseLike<{ data: Record<string, unknown>[] | null; error: { message: string } | null }>;
      }, MAX_ROWS),
      collectPages((from, to) => {
        let q = db
          .from('engagement_events')
          .select('id, project_id, expert_id, type, payload, created_at')
          .in('type', [...STATS_EVENT_TYPES])
          .gte('created_at', lowerBoundIso);
        if (filtered) q = q.in('project_id', projectFilter);
        return q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to);
      }, MAX_ROWS),
      collectPages((from, to) => {
        let q = db
          .from('conversation_messages')
          .select('id, project_id, expert_id, created_at, intent, summary, direction, author')
          .eq('direction', 'inbound')
          .eq('author', 'expert')
          .gte('created_at', lowerBoundIso);
        if (filtered) q = q.in('project_id', projectFilter);
        return q.order('created_at', { ascending: true }).order('id', { ascending: true }).range(from, to);
      }, MAX_ROWS),
    ]);

    if (engagementPages.failed && engagementPages.rows.length === 0) {
      return Response.json({ error: 'internal_error', message: 'Could not read the engagements.' }, { status: 500 });
    }

    const incomplete = [engagementPages, eventPages, replyPages].some(p => p.failed || p.truncated);
    if (incomplete) {
      console.warn('[api/admin/outreach-stats] a read was incomplete', JSON.stringify({
        engagements: engagementPages.failed || engagementPages.truncated,
        events:      eventPages.failed || eventPages.truncated,
        replies:     replyPages.failed || replyPages.truncated,
      }));
    }

    // ── Rows → stats inputs ──
    const expertNames = new Map<string, string>();
    const engagements: StatsEngagement[] = [];
    for (const row of engagementPages.rows) {
      const projectId = typeof row.project_id === 'string' ? row.project_id : '';
      const expertId  = typeof row.expert_id === 'string' ? row.expert_id : '';
      const status    = typeof row.status === 'string' ? row.status : '';
      if (!projectId || !expertId || !status) continue;
      const fields = statsFieldsFromRecord(status, {
        ...row,
        booking: { bookedAt: row.bookedAt, cancelledAt: row.cancelledAt },
        // Existence only; the address itself goes no further than this line.
        bouncedEmails: typeof row.bouncedFirst === 'string' && row.bouncedFirst ? ['bounced'] : null,
      });
      engagements.push({ projectId, expertId, pe: fields });
      if (typeof row.expertName === 'string' && row.expertName) {
        expertNames.set(`${projectId}:${expertId}`, row.expertName);
      }
    }
    const events  = eventPages.rows.map(statsEventFromRow).filter((e): e is StatsEvent => e !== null);
    const replies = replyPages.rows.map(replyMessageFromRow).filter((r): r is StatsReplyMessage => r !== null);

    const allFacts = deriveEngagementFacts(engagements, events, replies, now);

    // ── The filter ──
    const projectSet = new Set(projectFilter);
    const inScope: EngagementFacts[] = allFacts.filter(f =>
      f.introSentAt !== null
      && introSentBetween(f.introSentAt, range.from, range.to)
      && (!filtered || projectSet.has(f.projectId)),
    );

    // ── Names ──
    const sentByProject = new Map<string, number>();
    for (const f of allFacts) {
      if (f.introSentAt === null) continue;
      sentByProject.set(f.projectId, (sentByProject.get(f.projectId) ?? 0) + 1);
    }
    const projectNames = new Map<string, string>();
    for (const ids of chunk(Array.from(sentByProject.keys()), NAME_CHUNK)) {
      const { data, error } = await db.from('projects').select('id, name').in('id', ids);
      if (error) continue;   // names are a convenience; the numbers stand without them
      for (const p of data ?? []) projectNames.set(p.id, p.name);
    }
    const nameOf = (id: string): string => projectNames.get(id) ?? 'Untitled project';

    const projectOptions: ProjectOption[] = Array.from(sentByProject.entries())
      .map(([id, introsSent]) => ({ id, name: nameOf(id), introsSent }))
      .sort((a, b) => a.name.localeCompare(b.name));

    const scopeProjects = Array.from(new Set(inScope.map(f => f.projectId)));
    const projects: ProjectRowOut[] = scopeProjects
      .map(id => ({ ...summarizeProject(id, inScope), name: nameOf(id) }))
      .sort((a, b) => b.introsSent - a.introsSent || a.name.localeCompare(b.name));

    const armOf = new Map(inScope.map(f => [`${f.projectId}:${f.expertId}`, f.arm]));
    const declineWords: DeclineWordsOut[] = collectDeclineWords(inScope, replies).map(w => ({
      ...w,
      projectName: nameOf(w.projectId),
      expertName:  expertNames.get(`${w.projectId}:${w.expertId}`) ?? 'Unnamed expert',
      arm:         armOf.get(`${w.projectId}:${w.expertId}`) ?? null,
    }));

    const byArm = outreachByArm(inScope);

    const body: OutreachStatsResponse = {
      range:       { from: civilDateToIso(range.from), to: civilDateToIso(range.to), zone: OUTREACH_STATS_ZONE },
      generatedAt: now,
      projectIds:  projectFilter,
      projectOptions,
      byArm,
      testA:       testAMarks(byArm.all),
      projects,
      declineWords,
      incomplete,
    };
    return Response.json(body, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[api/admin/outreach-stats] error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}

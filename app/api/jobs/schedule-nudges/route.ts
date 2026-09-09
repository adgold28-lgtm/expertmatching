// GET /api/jobs/schedule-nudges — the daily nudge planner.
//
// Once a day this asks one question of every waiting engagement: does a
// follow-up belong in this person's inbox tomorrow morning? It answers it with
// lib/nudges.shouldSchedule, and when the answer is yes it hands QStash a job
// timed to land at 08:00 in the CLIENT OWNER'S timezone plus up to an hour of
// jitter (lib/nudges.nextNudgeInstant).
//
// WHY A PLANNER AND A WORKER, rather than sending from here. Two reasons, and
// both are about the gap between now and 08:00:
//   1. This runs at 05:00 UTC. 08:00 in New York is three hours later and 08:00
//      in Los Angeles is six. A cron cannot be every zone's morning; a delayed
//      job can.
//   2. In those hours the expert may reply, the client may act, the status may
//      move. So this route decides only that a nudge is PLAUSIBLE. The worker
//      (POST /api/jobs/send-nudge) re-reads everything and decides again, and
//      it is the one that can say no at the last moment.
//
// Consequently NOTHING IS SENT HERE. The only writes are the `nudges` block on
// each engagement, recording what was queued so the worker can recognise its
// own job and so tomorrow's run does not queue a second one.
//
// AUTH: `Authorization: Bearer ${CRON_SECRET}`, exactly like
// app/api/jobs/reconcile. middleware.ts does not authenticate /api/jobs/ (those
// routes are signature- or secret-verified instead), so THIS CHECK IS THE ONLY
// THING PROTECTING THIS ROUTE. Without CRON_SECRET set it returns 503 rather
// than running unguarded.
//
// Schedule: vercel.json → "0 5 * * *" (05:00 UTC daily). That is before 08:00
// local everywhere in the Americas and in Europe, so those land the same day.
// Asian zones are already past 08:00 at 05:00 UTC and get the next business
// day, which is a day later than ideal and never a wrong-hour email.
//
// Every engagement is isolated: one unreadable project, one QStash failure or
// one write conflict costs that engagement and nothing else.
//
// NEVER logs or returns: email addresses, expert names, project names,
// subjects, or message bodies.
//
// Response: 200 {
//   ok, scanned, queued,
//   skipped: { walkthrough, notWaiting, capped, alreadyQueued, noAddress },
//   errors, ranMs
// }

import { NextRequest } from 'next/server';
import { getServiceRoleClient } from '../../../../lib/supabase/admin';
import { getProject } from '../../../../lib/projectStore';
import { listThread } from '../../../../lib/conversations';
import { getCalendarConnection } from '../../../../lib/calendarConnections';
import { isWalkthrough } from '../../../../lib/walkthrough';
import { recordSystemFailure } from '../../../../lib/engagementEvents';
import { publishQstashJob } from '../../../../lib/qstashPublish';
import {
  DEFAULT_ZONE,
  NUDGE_STATUSES,
  nextNudgeInstant,
  shouldSchedule,
  writeNudgeState,
} from '../../../../lib/nudges';
import type { NudgeState, ProjectExpert } from '../../../../types';

// One Supabase scan, then a project read and a thread read per engagement.
// 60 s is the same ceiling the other long jobs in this app use.
export const maxDuration = 60;

/**
 * Safety rail, so one pathological morning cannot run for an hour.
 *
 * It is a CEILING, not a page. The scan below has no `.order()` and no cursor,
 * so once the waiting set exceeds this the 500 rows Postgres happens to return
 * are the 500 that get considered, and the rest are silently not nudged that
 * day — with nothing in the response distinguishing "500 waiting" from "5000
 * waiting". The same is true of the 60 s `maxDuration`: each engagement costs a
 * project read, a calendar read, a thread read, a QStash publish and a write,
 * all sequential and none of them checking the clock, so a long morning is
 * truncated mid-scan by the platform rather than by this loop. Both truncations
 * are safe (a skipped engagement is nudged tomorrow, and nothing was sent) but
 * neither is visible, which is the thing to fix first if the set ever grows.
 */
const MAX_ROWS = 500;

/** The statuses worth scanning for at all — the keys of NUDGE_STATUSES. */
const WAITING_STATUSES = Object.keys(NUDGE_STATUSES);

interface SkipCounts {
  walkthrough:   number;
  notWaiting:    number;
  capped:        number;
  alreadyQueued: number;
  noAddress:     number;
}

interface PlannerResult {
  ok:      boolean;
  scanned: number;
  queued:  number;
  skipped: SkipCounts;
  errors:  number;
  ranMs:   number;
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/** Constant-time-ish compare, same as app/api/jobs/reconcile. */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[api/jobs/schedule-nudges] CRON_SECRET is not set — refusing to run');
    return Response.json({ error: 'cron_secret_unset' }, { status: 503 });
  }

  const header   = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided || !secretMatches(provided, secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();
  const result: PlannerResult = {
    ok:      true,
    scanned: 0,
    queued:  0,
    skipped: { walkthrough: 0, notWaiting: 0, capped: 0, alreadyQueued: 0, noAddress: 0 },
    errors:  0,
    ranMs:   0,
  };

  const db = getServiceRoleClient();
  if (!db) {
    // Local development on the in-memory store. Nothing to scan, nothing wrong.
    result.ranMs = Date.now() - startedAt;
    return Response.json(result);
  }

  // ── 1. Every engagement in a waiting status ────────────────────────────────
  let rows: { project_id: string; expert_id: string }[] = [];
  try {
    const { data, error } = await db
      .from('project_experts')
      .select('project_id, expert_id')
      .in('status', WAITING_STATUSES)
      .limit(MAX_ROWS);

    if (error) throw new Error(`waiting engagements unreadable: ${error.message.slice(0, 120)}`);
    rows = data ?? [];
  } catch (err) {
    result.ok    = false;
    result.ranMs = Date.now() - startedAt;
    await recordSystemFailure({ area: 'nudge', reason: err });
    return Response.json(result);
  }

  result.scanned = rows.length;

  // ── 2. Group by project, so each project is read once ──────────────────────
  const byProject = new Map<string, string[]>();
  for (const row of rows) {
    const list = byProject.get(row.project_id);
    if (list) list.push(row.expert_id);
    else byProject.set(row.project_id, [row.expert_id]);
  }

  const now = Date.now();

  // Array.from rather than iterating the Map directly: the tsconfig target
  // predates for-of over an iterator (TS2802).
  for (const [projectId, expertIds] of Array.from(byProject.entries())) {
    try {
      const project = await getProject(projectId);
      if (!project) {
        // A row whose project is gone is a row nothing can be decided about.
        result.skipped.notWaiting += expertIds.length;
        continue;
      }

      // Walkthrough sends nothing, ever. Skipped here as well as at the
      // chokepoint so the planner does not queue jobs that must be thrown away.
      if (isWalkthrough(project)) {
        result.skipped.walkthrough += expertIds.length;
        continue;
      }

      // The owner's morning is the one that matters: they are the person whose
      // day the call has to fit into. One lookup per project.
      const connection = await getCalendarConnection(project.ownerEmail).catch(() => null);
      const zone       = connection?.timezone ?? DEFAULT_ZONE;

      for (const expertId of expertIds) {
        try {
          const pe: ProjectExpert | undefined = project.experts.find(e => e.expert.id === expertId);
          if (!pe) {
            result.skipped.notWaiting++;
            continue;
          }

          // No address or no reply token means the thread never started.
          if (!pe.contactEmail || !pe.outreachToken) {
            result.skipped.noAddress++;
            continue;
          }

          const thread   = await listThread(projectId, expertId);
          const decision = shouldSchedule(pe, thread, now);

          if (!decision.schedule) {
            if (decision.reason === 'capped')              result.skipped.capped++;
            else if (decision.reason === 'already_queued') result.skipped.alreadyQueued++;
            else                                          result.skipped.notWaiting++;
            continue;
          }

          const next  = nextNudgeInstant(new Date(now), zone);
          const delay = Math.max(0, Math.round((next.at.getTime() - now) / 1000));

          const published = await publishQstashJob(
            '/api/jobs/send-nudge',
            {
              projectId,
              expertId,
              day:          next.day,
              stage:        decision.stage,
              waitingSince: decision.waitingSince,
            },
            { delaySeconds: delay, retries: 0 },
          );

          if (!published.ok) {
            result.errors++;
            result.ok = false;
            await recordSystemFailure({
              area:      'nudge',
              reason:    `nudge not queued: ${published.error}`,
              projectId,
              expertId,
            });
            continue;
          }

          // A stage that just reset has no previous send to remember.
          const carried =
            pe.nudges
            && pe.nudges.stage === decision.stage
            && pe.nudges.waitingSince === decision.waitingSince
              ? pe.nudges.lastSentAt
              : null;

          const state: NudgeState = {
            stage:        decision.stage,
            waitingSince: decision.waitingSince,
            count:        decision.count,
            lastSentAt:   carried,
            scheduledFor: next.at.toISOString(),
            scheduledDay: next.day,
            linesUsed:    decision.linesUsed,
          };

          // If this write is lost the job still exists, and the worker refuses
          // to send because the stored `scheduledDay` will not match its own.
          // Failing that way round is the point.
          const written = await writeNudgeState(projectId, expertId, state);
          if (!written) {
            result.errors++;
            result.ok = false;
            continue;
          }

          result.queued++;
        } catch (err) {
          result.errors++;
          result.ok = false;
          await recordSystemFailure({ area: 'nudge', reason: err, projectId, expertId });
        }
      }
    } catch (err) {
      result.errors++;
      result.ok = false;
      await recordSystemFailure({ area: 'nudge', reason: err, projectId });
    }
  }

  result.ranMs = Date.now() - startedAt;

  // Counters only — no address, name, project name or subject reaches a log.
  console.info('[api/jobs/schedule-nudges] done', JSON.stringify({
    ok:      result.ok,
    scanned: result.scanned,
    queued:  result.queued,
    skipped: result.skipped,
    errors:  result.errors,
    ranMs:   result.ranMs,
  }));

  return Response.json(result);
}

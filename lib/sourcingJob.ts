// Server-side expert sourcing job.
//
// Sourcing takes minutes, so it must not depend on the browser staying open.
// POST /api/projects/[projectId]/source-experts flips the project to
// sourcingStatus:'running' and enqueues this job on QStash; the worker route
// POST /api/jobs/source-experts runs it and writes the result back to the
// project. The UI polls the project until the status leaves 'running'.
//
// Required env vars (production):
//   QSTASH_TOKEN                  — publish the job
//   QSTASH_URL                    — the account's regional QStash endpoint
//   QSTASH_CURRENT_SIGNING_KEY / QSTASH_NEXT_SIGNING_KEY — verify it at the worker
//   NEXT_PUBLIC_BASE_URL or NEXT_PUBLIC_APP_URL — where QStash calls back
// Without QSTASH_TOKEN (local dev) the caller runs the job in-process instead.
//
// ONE RUN OWNS THE PROJECT. The start route stamps `sourcingStartedAt` and puts
// that number in the job as `runId`; the publish carries it as a deterministic
// Upstash-Deduplication-Id, and every write here is fenced by shouldPersistRun()
// so a redelivered or superseded job spends nothing and writes nothing.
//
// NEVER log: project names, research questions, brief content, or expert names.

import type { Expert, Project } from '../types';
import { getProject, addExpertsToProject, updateProjectFields } from './projectStore';
import { trackProductEvent } from './productEvents';
import {
  generateExperts,
  GenerateExpertsError,
  type BriefContext,
} from './generateExperts';
import { validateProjectExpert, MAX_EXPERTS_PER_PROJECT } from './projectValidation';

export interface SourcingJob {
  projectId:        string;
  businessProblem?: string;   // brief override — the value the user just typed
  expertType?:      string;
  /**
   * Which run this job belongs to: the `sourcingStartedAt` the start route wrote
   * when it flipped the project to 'running'. It is the only thing that tells a
   * redelivered or superseded job that the project has moved on, so
   * shouldPersistRun() refuses to write when it no longer matches (H-11).
   * Optional so a job already queued without one still runs: those fall back to
   * the status check alone.
   */
  runId?:           number;
}

/** A run still marked 'running' after this long is treated as timed out. */
// Read in three places: the start route (lets a new run replace a dead one), the
// project page (renders the 'stale' state), and GET /api/jobs/reconcile, the
// daily cron that actually flips an abandoned 'running' row to 'failed'. Nothing
// sweeps at the 15-minute mark itself — between staleness and the next reconcile
// pass the project stays 'running' in the database and merely looks stale to the
// UI, so this constant is a display/eligibility threshold, not a timeout.
export const SOURCING_STALE_MS = 15 * 60 * 1000;

// ─── QStash scheduling ────────────────────────────────────────────────────────

/** True when a job can be handed to QStash (production path). */
export function isQStashConfigured(): boolean {
  return Boolean(process.env.QSTASH_TOKEN);
}

/** Publishes the job for immediate delivery. Mirrors lib/emailSequence.ts. */
export async function publishSourcingJob(job: SourcingJob): Promise<void> {
  const token = process.env.QSTASH_TOKEN;
  if (!token) throw new Error('[sourcingJob] QSTASH_TOKEN not configured');

  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL
    ?? process.env.NEXT_PUBLIC_APP_URL
    ?? 'https://expertmatch.fit';
  const endpoint = `${baseUrl}/api/jobs/source-experts`;

  // QStash accounts are region-pinned: the global host now answers 404
  // "user not found in this region" for this account's token, so publish
  // through the account's own endpoint. QSTASH_URL wins; the fallback is the
  // region this account lives in, which is what QSTASH_URL holds locally.
  const qstashHost = (process.env.QSTASH_URL ?? 'https://qstash-us-east-1.upstash.io').replace(/\/+$/, '');

  // The destination goes in the path verbatim — QStash rejects a
  // percent-encoded URL ("endpoint has invalid scheme").
  // No delay — sourcing should start immediately.
  //
  // Upstash-Deduplication-Id makes a double publish of the SAME run (a
  // double-clicked button, a client retry) one delivery instead of two. It is
  // keyed on the run, `sourcing-<projectId>-<runId>`, so a legitimate re-run —
  // which always gets a fresh sourcingStartedAt — is never deduplicated away.
  // Without a runId there is nothing safe to key on, so the header is omitted
  // rather than guessed: a constant per-project id would swallow real re-runs.
  // HYPHENS, NOT COLONS: QStash answers 400 "DeduplicationId cannot contain ':'"
  // and the whole run fails at enqueue (broke every sourcing run on 2026-09-10).
  const dedupId = typeof job.runId === 'number' && Number.isFinite(job.runId)
    ? `sourcing-${job.projectId}-${job.runId}`
    : null;

  const res = await fetch(`${qstashHost}/v2/publish/${endpoint}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      ...(dedupId ? { 'Upstash-Deduplication-Id': dedupId } : {}),
    },
    body: JSON.stringify(job),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`[sourcingJob] QStash publish failed: ${res.status} ${text.slice(0, 200)}`);
  }
}

// ─── Brief context ────────────────────────────────────────────────────────────

// Mirrors the client-side buildBriefContext()/buildRejectionFeedback() that the
// browser used to send, so server-side runs generate against the same inputs.
// ONLY reason-code counts are included from rejections — no names, no notes.
function buildBriefContext(project: Project, expertTypeOverride?: string): BriefContext {
  const bc: BriefContext = {};
  if (project.industry?.trim()) bc.industry = project.industry.trim();

  const expertType = (expertTypeOverride ?? project.expertType)?.trim();
  if (expertType) bc.expertType = expertType;

  const rejected = project.experts.filter(pe => pe.status === 'rejected' && pe.rejectionReason);
  if (rejected.length > 0) {
    const counts: Record<string, number> = {};
    for (const pe of rejected) {
      if (pe.rejectionReason) counts[pe.rejectionReason] = (counts[pe.rejectionReason] ?? 0) + 1;
    }
    bc.rejectionFeedback = counts;
  }
  return bc;
}

// ─── Run ownership ────────────────────────────────────────────────────────────

/** Why a job was allowed to write, or refused. */
export type PersistDecision =
  | { persist: true;  reason: 'owns_run' | 'legacy_no_run_id' }
  | { persist: false; reason: 'not_running' | 'superseded' };

/**
 * May THIS job write to THIS project?
 *
 * A QStash redelivery of a run that already finished, and a run that a newer
 * start has replaced, must both be dropped: addExpertsToProject APPENDS, so a
 * second pass adds a second copy of the same candidates and a stale pass can
 * overwrite a newer run's status (H-11).
 *
 * The rule, in order:
 *   sourcingStatus not 'running' → the run is over (or was never started);
 *                                  refuse. This also covers the redelivery of a
 *                                  job whose first pass completed.
 *   runId present and different  → a newer start replaced us; refuse.
 *   runId absent                 → a job queued before runIds existed; the
 *                                  status check is all it gets.
 *
 * Pure, and exported for scripts/test-sourcing-idempotency.ts. The caller reads
 * the project immediately before writing; the store has no conditional update
 * (lib/projectStore.updateProjectFields is a read-modify-write on the brief
 * document), so a window of a few milliseconds between this check and the write
 * remains. It narrows the failure from "every redelivery duplicates" to "two
 * writers interleaving inside one round trip", which the deduplication id and
 * the start route's own guard make very unlikely.
 */
export function shouldPersistRun(
  project: Pick<Project, 'sourcingStatus' | 'sourcingStartedAt'>,
  job:     Pick<SourcingJob, 'runId'>,
): PersistDecision {
  if (project.sourcingStatus !== 'running') return { persist: false, reason: 'not_running' };
  if (typeof job.runId !== 'number' || !Number.isFinite(job.runId)) {
    return { persist: true, reason: 'legacy_no_run_id' };
  }
  return (project.sourcingStartedAt ?? 0) === job.runId
    ? { persist: true,  reason: 'owns_run' }
    : { persist: false, reason: 'superseded' };
}

/**
 * Re-reads the project and asks shouldPersistRun. A read that FAILS is reported
 * as such rather than as a refusal, because the two callers want opposite things
 * from it: the append must not go ahead on a guess, while the terminal status
 * must still be written or the project sits on 'running' until the nightly
 * reconcile for what may have been one transient database blip.
 */
async function stillOwnsRun(
  job: SourcingJob,
): Promise<PersistDecision | { persist: false; reason: 'read_failed' }> {
  const fresh = await getProject(job.projectId).catch(() => null);
  if (!fresh) return { persist: false, reason: 'read_failed' };
  return shouldPersistRun(fresh, job);
}

// ─── Job execution ────────────────────────────────────────────────────────────

/**
 * Runs one sourcing job to completion and writes the outcome onto the project.
 * Never throws — every exit path leaves sourcingStatus at 'completed' or
 * 'failed' so the UI can never be stranded on a spinner.
 */
// IDEMPOTENT BY GATE, not by construction: addExpertsToProject() below still
// APPENDS, so every write is fenced by shouldPersistRun(). The gate is checked
// twice — once here, before spending two Haiku calls, an Opus call and up to six
// searches on a run nobody is waiting for, and once again immediately before the
// write, because the run takes minutes and the project can move on inside them.
// A refused job returns quietly and writes NOTHING, including no terminal
// status: the run that owns the project owns its status too.
export async function runSourcingJob(job: SourcingJob): Promise<void> {
  const startedAtMs = Date.now();
  try {
    const project = await getProject(job.projectId);
    if (!project) {
      console.error('[sourcingJob] project not found', { projectId: job.projectId });
      return;
    }

    const gate = shouldPersistRun(project, job);
    if (!gate.persist) {
      console.log('[sourcingJob] skipped', { projectId: job.projectId, reason: gate.reason });
      return;
    }

    const query = (job.businessProblem ?? project.researchQuestion ?? '').trim();
    if (!query) {
      await finish(job, 'failed', 'No business problem on the brief — add one and try again.');
      return;
    }

    const result = await generateExperts({
      query,
      geography:    project.geography || 'any',
      seniority:    project.seniority || 'any',
      briefContext: buildBriefContext(project, job.expertType),
    });

    // Same shaping + validation the client-driven path went through when it
    // POSTed to /api/projects/[id]/experts — the worker is now the only writer.
    const experts: Expert[] = (result.experts ?? [])
      .map((e, i) => validateProjectExpert({
        ...e,
        id:           (e.id as string) || `src-${i}`,
        source_links: e.source_links ?? [],
      }))
      .filter((e): e is Expert => e !== null);

    const adjacent: Expert[] = (result.adjacent_experts ?? [])
      .map(e => validateProjectExpert({
        ...e,
        // Preserve the API-assigned id; fall back to a name+company slug so the
        // "✓ Added" state (keyed on expert.id) stays stable across renders.
        id: (e.id as string)
          || `adj-${`${e.name ?? ''}${e.company ?? ''}`.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40)}`,
        source_links: e.source_links ?? [],
      }))
      .filter((e): e is Expert => e !== null);

    if (experts.length === 0 && adjacent.length === 0) {
      await finish(
        job,
        'failed',
        'No experts found. Try broadening the brief or adjusting the research question.',
      );
      return;
    }

    // Second gate, immediately before the first write. Everything above this
    // line is spend; everything below it is state. Minutes have passed, so the
    // project is re-read rather than trusted from the top of the function.
    const stillOurs = await stillOwnsRun(job);
    if (!stillOurs.persist) {
      console.log('[sourcingJob] discarded results', {
        projectId: job.projectId,
        reason:    stillOurs.reason,
        core:      experts.length,
        adjacent:  adjacent.length,
      });
      return;
    }

    // Core experts land in the discovery pool. Adjacent candidates are held on
    // the project for manual selection — they are not auto-added.
    // Respect the same per-project cap the /experts route enforces.
    const room  = Math.max(0, MAX_EXPERTS_PER_PROJECT - project.experts.length);
    const toAdd = experts.slice(0, room);
    if (toAdd.length > 0) {
      await addExpertsToProject(
        job.projectId,
        toAdd.map(expert => ({ expert, status: 'discovered' as const })),
      );
    }

    await updateProjectFields(job.projectId, {
      sourcingStatus:      'completed',
      sourcingStartedAt:   null,
      sourcingError:       null,
      sourcingAdjacent:    adjacent.length > 0 ? adjacent : null,
      sourcingLimitedPool: result.limited_pool,
    });

    console.log('[sourcingJob] completed', {
      projectId: job.projectId,
      core:      toAdd.length,
      adjacent:  adjacent.length,
    });
    void trackProductEvent({
      type:      'sourcing_completed',
      projectId: job.projectId,
      payload:   {
        count:       toAdd.length,
        adjacent:    adjacent.length,
        limitedPool: result.limited_pool === true,
        durationMs:  Date.now() - startedAtMs,
      },
    });
  } catch (err) {
    // Human-readable, never raw internals — only messages we author ourselves
    // reach the client; anything else collapses to the generic line.
    const SAFE_CODES = new Set(['no_search_provider', 'provider_overloaded', 'query_required']);
    const message =
      err instanceof GenerateExpertsError && err.code === 'expert_generation_parse_failed'
        ? 'Expert generation failed while formatting results. Please try again or simplify the brief.'
      : err instanceof GenerateExpertsError && SAFE_CODES.has(err.code)
        ? err.message
      : 'Expert sourcing failed. Please try again.';
    console.error('[sourcingJob] failed', {
      projectId: job.projectId,
      code:      err instanceof GenerateExpertsError ? err.code : 'unknown',
    });
    void trackProductEvent({
      type:      'sourcing_failed',
      projectId: job.projectId,
      payload:   { code: err instanceof GenerateExpertsError ? err.code : 'unknown', durationMs: Date.now() - startedAtMs },
    });
    await finish(job, 'failed', message);
  }
}

/**
 * Writes the terminal status, but only when this job still owns the run — a
 * superseded or already-finished run's failure must not overwrite the status of
 * the run that replaced it. Swallows write errors: nothing left to retry.
 */
async function finish(
  job: SourcingJob,
  status: 'completed' | 'failed',
  error: string | null,
): Promise<void> {
  const projectId = job.projectId;
  const gate = await stillOwnsRun(job);
  if (!gate.persist && gate.reason !== 'read_failed') {
    console.log('[sourcingJob] terminal status not written', { projectId, reason: gate.reason });
    return;
  }
  try {
    await updateProjectFields(projectId, {
      sourcingStatus:    status,
      sourcingStartedAt: null,
      sourcingError:     error,
    });
  } catch (err) {
    console.error('[sourcingJob] could not write terminal status', {
      projectId,
      reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown',
    });
  }
}

/**
 * Local-dev fallback: run the job in-process without blocking the response.
 * Next 14 has no `after()` helper, so this is a deliberate floating promise —
 * runSourcingJob never throws, so the status always reaches a terminal value.
 */
export function runSourcingJobDetached(job: SourcingJob): void {
  void runSourcingJob(job).catch(() => {
    // runSourcingJob handles its own errors; this guard is belt-and-braces.
  });
}

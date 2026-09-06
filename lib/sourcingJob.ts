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
// NEVER log: project names, research questions, brief content, or expert names.

import type { Expert, Project } from '../types';
import { getProject, addExpertsToProject, updateProjectFields } from './projectStore';
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
}

/** A run still marked 'running' after this long is treated as timed out. */
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
  const res = await fetch(`${qstashHost}/v2/publish/${endpoint}`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
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

// ─── Job execution ────────────────────────────────────────────────────────────

/**
 * Runs one sourcing job to completion and writes the outcome onto the project.
 * Never throws — every exit path leaves sourcingStatus at 'completed' or
 * 'failed' so the UI can never be stranded on a spinner.
 */
export async function runSourcingJob(job: SourcingJob): Promise<void> {
  try {
    const project = await getProject(job.projectId);
    if (!project) {
      console.error('[sourcingJob] project not found', { projectId: job.projectId });
      return;
    }

    const query = (job.businessProblem ?? project.researchQuestion ?? '').trim();
    if (!query) {
      await finish(job.projectId, 'failed', 'No business problem on the brief — add one and try again.');
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
        job.projectId,
        'failed',
        'No experts found. Try broadening the brief or adjusting the research question.',
      );
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
    await finish(job.projectId, 'failed', message);
  }
}

/** Writes the terminal status. Swallows write errors — nothing left to retry. */
async function finish(
  projectId: string,
  status: 'completed' | 'failed',
  error: string | null,
): Promise<void> {
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

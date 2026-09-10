// scripts/test-sourcing-idempotency.ts — unit tests for shouldPersistRun, the
// gate that stops a redelivered or superseded sourcing job writing to a project
// (H-11, and the two-concurrent-starts TOCTOU in M-17).
//
// The failure it guards: addExpertsToProject APPENDS. A QStash redelivery of a
// run that already finished adds a second copy of the same candidates and can
// overwrite a newer run's status. Nothing keyed off a run before this, so the
// job could not tell "I am the current run" from "I am a ghost".
//
// The rule under test, in order: status must be 'running'; a job carrying a
// runId must match the project's sourcingStartedAt; a job with no runId (queued
// before runIds existed) gets the status check alone.
//
// Pure function, no network, no database, no env vars.
//
//   npx tsx scripts/test-sourcing-idempotency.ts
//
// Exits non-zero on any failing assertion.

import { shouldPersistRun, type SourcingJob } from '../lib/sourcingJob';
import type { Project } from '../types';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const RUN_A = 1_770_000_000_000;   // the run that started this job
const RUN_B = 1_770_000_060_000;   // a later start, one minute on

type ProjectGate = Pick<Project, 'sourcingStatus' | 'sourcingStartedAt'>;

const project = (
  sourcingStatus: ProjectGate['sourcingStatus'],
  sourcingStartedAt: ProjectGate['sourcingStartedAt'],
): ProjectGate => ({ sourcingStatus, sourcingStartedAt });

const job = (runId?: number): Pick<SourcingJob, 'runId'> => (runId === undefined ? {} : { runId });

// ── The happy path ───────────────────────────────────────────────────────────

section('the run that owns the project may write');

eq('running + matching runId → persist',
  shouldPersistRun(project('running', RUN_A), job(RUN_A)).persist, true);
eq('...and says why',
  shouldPersistRun(project('running', RUN_A), job(RUN_A)).reason, 'owns_run');
eq('runId 0 is a real id, not a missing one',
  shouldPersistRun(project('running', 0), job(0)).persist, true);

// ── Redelivery of a finished run ─────────────────────────────────────────────
// This is the duplicate-candidates case: the first pass completed and cleared
// sourcingStartedAt, then QStash redelivered.

section('a redelivered job whose run already finished writes nothing');

for (const status of ['completed', 'failed'] as const) {
  eq(`${status} + cleared start → refuse`,
    shouldPersistRun(project(status, null), job(RUN_A)).persist, false);
  eq(`${status} + cleared start → reason`,
    shouldPersistRun(project(status, null), job(RUN_A)).reason, 'not_running');
  eq(`${status} + the run's own id still on the row → refuse`,
    shouldPersistRun(project(status, RUN_A), job(RUN_A)).persist, false);
}

eq('never sourced (status absent) → refuse',
  shouldPersistRun(project(undefined, undefined), job(RUN_A)).persist, false);
eq('status null → refuse',
  shouldPersistRun(project(null, RUN_A), job(RUN_A)).persist, false);

// ── Superseded by a newer start ──────────────────────────────────────────────
// The stale run is still 'running' — a NEW run put it there — so only the runId
// separates them. Without it the ghost would append its candidates on top.

section('a stale run superseded by a newer start writes nothing');

eq('running + newer start → refuse',
  shouldPersistRun(project('running', RUN_B), job(RUN_A)).persist, false);
eq('running + newer start → reason',
  shouldPersistRun(project('running', RUN_B), job(RUN_A)).reason, 'superseded');
eq('running + OLDER start than the job → refuse too (not just newer)',
  shouldPersistRun(project('running', RUN_A), job(RUN_B)).persist, false);
eq('running + no start recorded at all → refuse a job that has an id',
  shouldPersistRun(project('running', null), job(RUN_A)).persist, false);
eq('one millisecond of drift is a different run',
  shouldPersistRun(project('running', RUN_A + 1), job(RUN_A)).persist, false);

// ── Jobs queued before runIds existed ────────────────────────────────────────
// A deploy lands while jobs are in flight. Those bodies have no runId, so the
// status check is all they get — never a silent refusal that would strand the
// project on 'running' until the nightly reconcile.

section('a job with no runId falls back to the status check');

eq('no runId + running → persist',
  shouldPersistRun(project('running', RUN_A), job()).persist, true);
eq('no runId + running → reason names the fallback',
  shouldPersistRun(project('running', RUN_A), job()).reason, 'legacy_no_run_id');
eq('no runId + completed → still refused',
  shouldPersistRun(project('completed', null), job()).persist, false);
eq('no runId + failed → still refused',
  shouldPersistRun(project('failed', null), job()).persist, false);

// A malformed runId is not an id. NaN never equals anything, so treating it as
// a real id would refuse every write; it is treated as absent instead.
eq('NaN runId is treated as absent, not as a mismatch',
  shouldPersistRun(project('running', RUN_A), { runId: NaN }).persist, true);
eq('Infinity runId is treated as absent',
  shouldPersistRun(project('running', RUN_A), { runId: Infinity }).persist, true);

// ── Two concurrent starts (M-17) ─────────────────────────────────────────────
// Both requests published a job; the second start's timestamp is the one on the
// row, so exactly one of the two jobs may write.

section('two concurrent starts: exactly one job may write');

{
  const row = project('running', RUN_B);
  const first  = shouldPersistRun(row, job(RUN_A));
  const second = shouldPersistRun(row, job(RUN_B));
  eq('the earlier job is refused', first.persist,  false);
  eq('the later job proceeds',     second.persist, true);
  check('exactly one of the two writes',
    [first.persist, second.persist].filter(Boolean).length === 1);
}

// ── Purity ───────────────────────────────────────────────────────────────────

section('the gate is pure');

{
  const row  = project('running', RUN_A);
  const body = job(RUN_A);
  const before = JSON.stringify({ row, body });
  shouldPersistRun(row, body);
  shouldPersistRun(row, body);
  eq('neither argument is mutated', JSON.stringify({ row, body }), before);
  eq('the same inputs give the same answer twice',
    shouldPersistRun(row, body).reason, shouldPersistRun(row, body).reason);
}

// ── Result ───────────────────────────────────────────────────────────────────

summary();

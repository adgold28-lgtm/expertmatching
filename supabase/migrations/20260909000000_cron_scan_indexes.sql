-- supabase/migrations/20260909000000_cron_scan_indexes.sql
--
-- ExpertMatch — three indexes for the queries the scheduled jobs and the admin
-- attention view run on every invocation (audit M-9).
--
-- WHAT THIS CHANGES
--
--   Indexes only. No table, no column, no constraint, no policy. Nothing in the
--   application code depends on this file having been applied: every query
--   below already returns the right rows, it just reads the whole table to do
--   it. Applying this changes the plan, not the answer.
--
--   1. projects ((brief ->> 'sourcingStatus'))
--      `brief ->> 'sourcingStatus' = 'running'` is asked twice on a schedule:
--      by the admin attention view (lib/attention.ts listAttentionItems, for
--      sourcing runs that have stalled) and by the nightly reconcile sweep
--      (app/api/jobs/reconcile sweepSourcing, which resets them). Partial —
--      most projects have never sourced and carry no such key, and an index
--      that skips them is a fraction of the size.
--
--   2. project_experts (status)
--      The nudge planner scans `status in (WAITING_STATUSES)` on every run
--      (app/api/jobs/schedule-nudges). A plain b-tree: `status` is NOT NULL,
--      every row has one, and the planner asks for a handful of values out of
--      the dozen in lib/expertPipeline.EXPERT_STATUSES. Before this, the only
--      index on project_experts other than the two expression indexes from
--      20260907100000 was on project_id.
--
--   3. project_experts ((data -> 'nudges' ->> 'scheduledFor'))
--      The stalled-nudge view (lib/attention.ts) asks for rows where that path
--      is not null. Partial for the same reason as (1): a nudge scheduled but
--      never resolved is the rare case, which is exactly what makes it worth
--      an index.
--
--      NOTE ON `concurrently`: this file runs inside a transaction (begin/commit
--      below, matching every other migration here) and CREATE INDEX
--      CONCURRENTLY is not permitted in one. These are written plain. Both
--      tables are small (thousands of rows), so the brief ACCESS EXCLUSIVE lock
--      is measured in milliseconds. If either grows large enough for that to
--      matter, run the CREATE INDEX statements on their own, outside this file,
--      with `concurrently` added.
--
-- HOW TO APPLY
--   The Supabase CLI is not linked to this project. PASTE THIS WHOLE FILE INTO
--   THE SUPABASE STUDIO SQL EDITOR and run it, then verify with:
--       npx tsx scripts/verify-schema.ts
--   Idempotent (`create index if not exists` throughout) and safe to re-run.
--   Safe to leave unapplied: nothing in the code path checks for these.

begin;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. projects.brief ->> 'sourcingStatus'
-- ═════════════════════════════════════════════════════════════════════════

-- Matches `.filter('brief->>sourcingStatus', 'eq', 'running')` in both
-- lib/attention.ts and app/api/jobs/reconcile/route.ts.
create index if not exists idx_projects_sourcing_status
  on public.projects ((brief ->> 'sourcingStatus'))
  where brief ->> 'sourcingStatus' is not null;

-- ═════════════════════════════════════════════════════════════════════════
-- 2. project_experts.status
-- ═════════════════════════════════════════════════════════════════════════

-- The nudge planner's `.in('status', WAITING_STATUSES)` scan.
create index if not exists idx_project_experts_status
  on public.project_experts (status);

-- ═════════════════════════════════════════════════════════════════════════
-- 3. project_experts.data -> 'nudges' ->> 'scheduledFor'
-- ═════════════════════════════════════════════════════════════════════════

-- Matches `.not('data->nudges->>scheduledFor', 'is', null)` in lib/attention.ts.
create index if not exists idx_project_experts_nudge_scheduled
  on public.project_experts ((data -> 'nudges' ->> 'scheduledFor'))
  where data -> 'nudges' ->> 'scheduledFor' is not null;

commit;

-- supabase/migrations/20260907100000_availability_windows_and_indexes.sql
--
-- ExpertMatch — weekly recurring availability, the system-failure log, and two
-- expression indexes the hot lookups have been missing.
--
-- WHAT THIS CHANGES
--
--   1. user_calendar_connections.weekly_windows (new jsonb column, nullable)
--      Recurring weekly availability: an array of
--        { dayOfWeek: 0-6, from: 'HH:MM', to: 'HH:MM', timezone: 'IANA/Zone' }
--      written by POST /api/onboarding/calendar and expanded into concrete
--      AvailabilitySlots for the next 14 days by lib/availabilityWindows.ts.
--      Kept separate from `manual_slots` on purpose: one-off dates and a
--      recurring rule are different kinds of statement, and the scheduler
--      merges them (lib/calendarConnections.getClientSlotsForUser) rather than
--      one shadowing the other.
--
--      THE APPLICATION TOLERATES THIS COLUMN BEING ABSENT. Reads use
--      `select *` and simply see no key; writes retry without the column when
--      Postgres reports it does not exist (PGRST204 / 42703). So deploying the
--      code before this migration degrades to one-off slots only — it does not
--      500. Applying this migration turns the feature on.
--
--   2. public.system_events (new table)
--      Every previously-silent best-effort failure — a seat sync that could not
--      reach Stripe, a payout that did not go out, mail that was refused, a
--      sourcing run that died, an invoice that failed. `engagement_events`
--      cannot hold these: its project_id and expert_id are NOT NULL and its
--      `type` check constraint is a closed list of Matchy actions. Rather than
--      loosen a constraint that protects the data asset, system failures get
--      their own small table.
--
--      RLS is ENABLED with NO policies at all — the outreach_suppressions /
--      user_calendar_connections / engagement_events pattern. Only the service
--      role writes and reads it (lib/engagementEvents.recordSystemFailure,
--      lib/attention.ts behind GET /api/admin/attention). The application also
--      tolerates this table being absent: recordSystemFailure logs one line and
--      returns, and listAttentionItems degrades to the billing/sourcing checks.
--
--   3. Two expression indexes on public.project_experts(data ->> ...)
--      `zoomMeetingId` — the Zoom webhook's only way to find the row for an
--      ended meeting; `expertOnboardingStatus` — the pending-payout sweep in
--      lib/expertPayout.retryPendingPayoutsForAccount and the nightly reconcile
--      job. Both were sequential scans over every expert row in the product.
--
--      NOTE ON `concurrently`: this file runs inside a transaction (begin/commit
--      below, matching every other migration here) and CREATE INDEX
--      CONCURRENTLY is not permitted in one. These are written plain. The table
--      is small (thousands of rows), so the brief ACCESS EXCLUSIVE lock is
--      measured in milliseconds. If project_experts ever grows large enough for
--      that to matter, run the two CREATE INDEX statements on their own,
--      outside this file, with `concurrently` added.
--
-- HOW TO APPLY
--   The Supabase CLI is not linked to this project. PASTE THIS WHOLE FILE INTO
--   THE SUPABASE STUDIO SQL EDITOR and run it, then verify with:
--       npx tsx scripts/verify-schema.ts
--   Idempotent (add column / create table / create index — all `if not exists`)
--   and safe to re-run.

begin;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Weekly recurring availability
-- ═════════════════════════════════════════════════════════════════════════

alter table public.user_calendar_connections
  add column if not exists weekly_windows jsonb;

comment on column public.user_calendar_connections.weekly_windows is
  'Recurring weekly availability as a jsonb array of '
  '{ dayOfWeek: 0-6 (0 = Sunday), from: "HH:MM", to: "HH:MM", timezone: IANA }. '
  'Validated and expanded into dated slots by lib/availabilityWindows.ts; '
  'merged with manual_slots at scheduling time. Service-role write only — the '
  'table has RLS enabled with no authenticated policies.';

-- ═════════════════════════════════════════════════════════════════════════
-- 2. system_events — every failure the product used to swallow
-- ═════════════════════════════════════════════════════════════════════════

-- organization_id is a real FK (these rows are only useful while the org
-- exists, and an org deletion should take its noise with it). project_id and
-- expert_id are plain text and unconstrained: projects.id is a 24-hex text key
-- and an event must be able to outlive the row it describes.
create table if not exists public.system_events (
  id              uuid primary key default gen_random_uuid(),
  -- 'system_failure' today. A column rather than a check constraint so a later
  -- kind ('system_recovered', say) needs no migration to start writing.
  kind            text not null,
  -- Which subsystem: seat_sync | payout | mail | sourcing | invoice.
  area            text not null,
  -- Short, PII-free reason. lib/engagementEvents.ts caps this and strips
  -- Stripe object ids before the insert — never a raw exception, never an
  -- email address, never a customer id.
  reason          text not null,
  organization_id uuid references public.organizations(id) on delete cascade,
  project_id      text,
  expert_id       text,
  created_at      timestamptz not null default now()
);

comment on table public.system_events is
  'Operational failures that the request path deliberately swallowed: seat '
  'syncs, payouts, mail, sourcing, invoices. Written by '
  'lib/engagementEvents.recordSystemFailure, read by lib/attention.ts behind '
  'GET /api/admin/attention. RLS enabled with no policies — service role only.';

-- The only read pattern: the newest N rows, optionally narrowed to one org.
create index if not exists idx_system_events_created
  on public.system_events (created_at desc);

-- Supports the FK (an organization delete must not sequential-scan this table)
-- and the per-org attention view. Partial: rows with no org carry no org story.
create index if not exists idx_system_events_org
  on public.system_events (organization_id, created_at desc)
  where organization_id is not null;

-- Deny-by-default for anon/authenticated. The service role bypasses RLS.
-- No policies are created for this table on purpose — see the table comment.
alter table public.system_events enable row level security;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Expression indexes on project_experts.data
-- ═════════════════════════════════════════════════════════════════════════

-- The Zoom webhook arrives with a meeting id and nothing else. Partial: the
-- overwhelming majority of expert rows never get a meeting, and an index that
-- skips them is a fraction of the size.
create index if not exists idx_project_experts_zoom_meeting
  on public.project_experts ((data ->> 'zoomMeetingId'))
  where data ->> 'zoomMeetingId' is not null;

-- The pending-payout sweep filters on exactly this expression
-- (lib/expertPayout.ts: .filter('data->>expertOnboardingStatus', 'eq', ...)),
-- and the nightly reconcile job runs it once per Connect account.
create index if not exists idx_project_experts_payout_status
  on public.project_experts ((data ->> 'expertOnboardingStatus'))
  where data ->> 'expertOnboardingStatus' is not null;

commit;

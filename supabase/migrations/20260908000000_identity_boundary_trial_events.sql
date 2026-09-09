-- supabase/migrations/20260908000000_identity_boundary_trial_events.sql
--
-- ExpertMatch — make expert anonymity a database boundary, and record what
-- people do in the product.
--
-- WHAT THIS CHANGES
--
--   1. projects, project_members, project_experts, conversation_messages become
--      SERVICE-ROLE ONLY (RLS enabled, zero authenticated policies — the
--      pattern engagement_events / organization_billing / user_calendar_
--      connections already use).
--
--      WHY. The application never queries these tables as the signed-in user:
--      every read and write goes through server routes holding the service-role
--      key (lib/projectStore.ts), and lib/redactExpert.ts strips the expert's
--      identity, contact path, expert-side rate and every token from each
--      response before it reaches a browser. The authenticated policies were
--      meant as defence in depth, but they granted MORE than the application
--      does: `project_experts.data` holds the raw expert (name, employer,
--      LinkedIn, sources), `contact_email`, `expertRate`, `outreachToken`,
--      `zoomStartUrl`; `projects.brief` holds `confidentialNotes` and a raw
--      client availability token; and collaborators — read-only in the app —
--      could UPDATE and DELETE expert rows. Anyone holding their own session
--      JWT plus the publishable key could read all of it from PostgREST.
--      Removing the policies makes the redactor the ONLY path, which is what
--      the product's anonymity promise requires.
--
--      The helper functions (has_project_access, is_project_owner, …) and the
--      project_members same-org trigger stay: the trigger still constrains the
--      service role, and the functions are harmless and documented.
--
--   2. public.product_events (new) — one row per thing a PERSON did: signed in,
--      finished onboarding, created a project, saved a brief, ran sourcing,
--      bookmarked or passed a candidate, hit the paywall. engagement_events
--      cannot hold these (its project_id / expert_id are NOT NULL and its
--      `type` is a closed list of Matchy actions). Service-role only. Written
--      by lib/productEvents.ts, read by scripts/trial-report.ts.
--
--      The application tolerates this table being absent: lib/productEvents
--      logs one warning and drops the event. Nothing else depends on it.
--
-- TRIAL ACCOUNTS need no schema: a trial is an organization_billing row with
-- subscription_status = 'trialing' and billing_complete = false
-- (lib/entitlements.ts). The column already exists and is free text.
--
-- HOW TO APPLY
--   The Supabase CLI is not linked to this project. PASTE THIS WHOLE FILE INTO
--   THE SUPABASE STUDIO SQL EDITOR and run it, then verify with:
--       npx tsx scripts/verify-schema.ts
--   Idempotent (drop policy if exists / create table if not exists) and safe to
--   re-run. Deploying the application code BEFORE this migration is safe: the
--   code never used the dropped policies, and it tolerates the missing table.
--   scripts/rls-verify.sh (scripts/rls/verify.sql) asserts the resulting
--   isolation model actor by actor.

begin;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Project-family tables: service-role only
-- ═════════════════════════════════════════════════════════════════════════
--
-- NET EFFECT, stated plainly, because this section only DROPS: nothing below
-- is recreated. After this migration the four tables have RLS enabled and
-- ZERO policies, so `anon` and `authenticated` read and write nothing at all
-- on them; only the service role (which bypasses RLS) can. Concretely, these
-- 13 policies from 20260831000000 / 20260902000000 / 20260907000000 cease to
-- exist and have no replacement:
--   projects:              select / insert / update / delete
--   project_members:       select / insert / update / delete
--   project_experts:       select / insert / update / delete
--   conversation_messages: select
-- This is strictly a TIGHTENING — no actor gains a read or a write. The
-- previous grants (owner or explicit collaborator, via has_project_access)
-- are simply withdrawn; the org/profile/membership policies are untouched.
--
-- CONSEQUENCE TO UNDERSTAND BEFORE RELYING ON IT: RLS is no longer a second
-- opinion on project access. `canAccess` / `getProjectForUser` in
-- lib/projectStore.ts is now the ONLY thing standing between one client and
-- another client's project, because every query the app makes runs as the
-- service role. The database still backstops the ORGANIZATION boundary on
-- sharing (trg_project_members_same_org, kept deliberately).

-- projects
drop policy if exists projects_select on public.projects;
drop policy if exists projects_insert on public.projects;
drop policy if exists projects_update on public.projects;
drop policy if exists projects_delete on public.projects;

-- project_members
drop policy if exists project_members_select on public.project_members;
drop policy if exists project_members_insert on public.project_members;
drop policy if exists project_members_update on public.project_members;
drop policy if exists project_members_delete on public.project_members;

-- project_experts
drop policy if exists project_experts_select on public.project_experts;
drop policy if exists project_experts_insert on public.project_experts;
drop policy if exists project_experts_update on public.project_experts;
drop policy if exists project_experts_delete on public.project_experts;

-- conversation_messages
drop policy if exists conversation_messages_select on public.conversation_messages;

-- RLS stays enabled (deny-by-default for anon/authenticated). Re-assert so a
-- database where it was ever switched off ends up in the intended state.
alter table public.projects              enable row level security;
alter table public.project_members       enable row level security;
alter table public.project_experts       enable row level security;
alter table public.conversation_messages enable row level security;

comment on table public.projects is
  'Research projects. Service-role only: the application reads and writes '
  'through lib/projectStore.ts and redacts every response (lib/redactExpert.ts). '
  'RLS is enabled with no authenticated policies so `brief` (confidential notes, '
  'client availability token) is unreachable from a browser session.';

comment on table public.project_members is
  'Explicit project sharing (owner adds collaborators in the same organization; '
  'trg_project_members_same_org enforces the organization boundary for the '
  'service role too). Service-role only.';

comment on table public.project_experts is
  'The working set of experts inside a project. `data` holds the RAW expert '
  '(name, employer, sources), contact path, expert-side rate and tokens. '
  'Service-role only: a browser session can never read this table, so the '
  'anonymization in lib/redactExpert.ts is the only path to it.';

comment on table public.conversation_messages is
  'Every message on one client<->expert thread. body_raw is application-'
  'encrypted ciphertext. Service-role only: clients read the thread through '
  'lib/conversations.redactMessageForViewer, which masks names, employers and '
  'contact details before the identity reveal.';

-- ═════════════════════════════════════════════════════════════════════════
-- 2. product_events — what people do in the product (service-role only)
-- ═════════════════════════════════════════════════════════════════════════

create table if not exists public.product_events (
  id              uuid primary key default gen_random_uuid(),
  -- Who. Null for a system actor (a QStash worker finishing a sourcing run).
  -- ON DELETE SET NULL: a deleted tester's rows stay for the funnel.
  actor_id        uuid references public.profiles(id) on delete set null,
  organization_id uuid references public.organizations(id) on delete set null,
  -- Plain text, no FK: projects.id is a 24-hex text key and an event must be
  -- able to outlive the project it describes.
  project_id      text,
  -- lib/productEvents.ProductEventType. A column rather than a check
  -- constraint so a new kind needs no migration to start being recorded.
  type            text not null,
  -- Numbers, booleans and short enum strings only (lib/engagementEvents.
  -- sanitizeEventPayload). Never a name, an email address or brief text.
  payload         jsonb not null default '{}'::jsonb,
  created_at      timestamptz not null default now()
);

comment on table public.product_events is
  'One row per user action in the product — the trial/usage funnel. Written by '
  'lib/productEvents.ts, read by scripts/trial-report.ts. RLS enabled with no '
  'policies: service-role only. payload holds numbers, booleans and short enum '
  'strings only.';

-- The two read patterns: one person's timeline, and one kind over time.
create index if not exists idx_product_events_actor
  on public.product_events (actor_id, created_at);
create index if not exists idx_product_events_org_type
  on public.product_events (organization_id, type, created_at);
create index if not exists idx_product_events_project
  on public.product_events (project_id, created_at)
  where project_id is not null;

-- Deny-by-default for anon/authenticated. Service role bypasses RLS.
-- No policies are created for this table on purpose — see the table comment.
alter table public.product_events enable row level security;

commit;

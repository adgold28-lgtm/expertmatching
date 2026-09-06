-- supabase/migrations/20260907000000_matchy_phase1.sql
--
-- ExpertMatch — Matchy Phase 1 (the conversation layer). See docs/MATCHY_SPEC.md.
--
-- WHAT THIS CHANGES
--
--   1. conversation_messages  (new)  — every message on an expert thread, in
--      both directions. `body_raw` holds the inbound email exactly as it
--      arrived, as APPLICATION-ENCRYPTED CIPHERTEXT produced by
--      lib/encryption.ts (AES-256-GCM, `iv.tag.data` hex) and stored as text.
--      Postgres never sees the plaintext. `body_clean` is the quoted-history-
--      and-signature-stripped text that is safe to show; `summary` is Matchy's
--      one-line plain-language read; `screen_result` is the compliance-screen
--      verdict from lib/matchyScreen.ts.
--      RLS: project members may READ (public.has_project_access). Every write
--      is service-role only — messages are written by server routes and jobs,
--      never by a browser session.
--
--   2. engagement_events      (new)  — the data asset. One row per thing Matchy
--      did or observed. RLS is ENABLED with NO authenticated policies at all
--      (the outreach_suppressions / user_calendar_connections pattern), so the
--      event stream is unreachable from a browser session even with a valid
--      JWT. Written only through lib/engagementEvents.emitEngagementEvent.
--      `payload` carries numbers, booleans and short enum strings only — never
--      free text, never PII (enforced in the application layer).
--
--   3. organizations.firm_type / organizations.firm_size  (new columns,
--      nullable) — how Matchy describes the client to an expert without naming
--      them: one size word plus one type word, e.g. "a mid-size PE firm".
--      Captured on the access request, applied to the organization on approval.
--      See lib/matchyTemplates.firmPhrase.
--
--   4. access_requests.firm_type / access_requests.firm_size  (new columns,
--      nullable) — the same two answers as submitted on the public form, held
--      on the pending request so an admin approval can copy them onto the
--      organization. Same check constraints as (3).
--
--   5. projects.review_first / projects.client_rate_min / projects.client_rate_max
--      (new columns) — the per-project "review first" switch (false = Matchy
--      auto-sends the intro on bookmark) and the client-rate band Matchy must
--      negotiate inside. Rates are whole dollars per hour, CLIENT-side numbers.
--
-- HOW TO APPLY
--   The Supabase CLI is not linked to this project. PASTE THIS WHOLE FILE INTO
--   THE SUPABASE STUDIO SQL EDITOR and run it, then verify with:
--       npx tsx scripts/verify-matchy-migration.ts
--   It is idempotent (create table if not exists / add column if not exists /
--   drop policy if exists before create) and safe to re-run.
--
-- ORDERING NOTE: the application code for Matchy Phase 1 reads and writes
-- projects.review_first / client_rate_min / client_rate_max as real columns.
-- APPLY THIS MIGRATION BEFORE DEPLOYING THAT CODE.

begin;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. conversation_messages — the thread between a client and one expert
-- ═════════════════════════════════════════════════════════════════════════

-- project_id is text (projects.id is a 24-hex text key, not a uuid).
-- expert_id matches project_experts.expert_id — deliberately not a FK to
-- project_experts.id, because a thread is addressed the way the rest of the
-- app addresses an expert: (project_id, expert_id).
create table if not exists public.conversation_messages (
  id                uuid primary key default gen_random_uuid(),
  project_id        text not null references public.projects(id) on delete cascade,
  expert_id         text not null,
  direction         text not null check (direction in ('inbound','outbound')),
  author            text not null check (author in ('client','expert','matchy')),
  -- Inbound email exactly as received, AES-256-GCM ciphertext from
  -- lib/encryption.ts. Null on outbound messages (we composed those).
  body_raw          text,
  -- Cleaned, displayable text: quoted history and signatures stripped.
  body_clean        text,
  -- Matchy's plain-language one-liner for the card and the thread.
  summary           text,
  -- Classified reply intent — the ReplyIntent union in types.ts
  -- ('interested' | 'declined' | 'counter_rate' | 'conflict' | 'unclear').
  -- Free text is not permitted here; it is a classifier label.
  intent            text,
  -- Compliance-screen verdict from lib/matchyScreen.ts:
  --   { "blocked": bool, "findings": [{ "kind", "match", "hint" }] }
  screen_result     jsonb,
  -- Resend's message id for an outbound send, for delivery lookups.
  resend_message_id text,
  created_at        timestamptz not null default now()
);

comment on table public.conversation_messages is
  'Every message on one client<->expert thread. body_raw is application-'
  'encrypted ciphertext (lib/encryption.ts) stored as text — Postgres never '
  'holds the plaintext of an inbound email. Project members may read; all '
  'writes are service-role only.';

comment on column public.conversation_messages.body_raw is
  'Inbound email as received, AES-256-GCM ciphertext (iv.tag.data hex). Null '
  'for outbound messages.';
comment on column public.conversation_messages.screen_result is
  'lib/matchyScreen.ts verdict: { blocked: bool, findings: [{kind, match, hint}] }.';
comment on column public.conversation_messages.intent is
  'Classifier label, not free text: interested | declined | counter_rate | '
  'conflict | unclear.';

-- The thread read: every message for one expert on one project, in order.
create index if not exists idx_conversation_messages_thread
  on public.conversation_messages (project_id, expert_id, created_at);

alter table public.conversation_messages enable row level security;

-- Read: anyone who can reach the project (owner or explicit project member).
drop policy if exists conversation_messages_select on public.conversation_messages;
create policy conversation_messages_select on public.conversation_messages
  for select to authenticated
  using (public.has_project_access(project_id));

-- INSERT / UPDATE / DELETE: no policies on purpose. Messages are written by
-- server routes and jobs through the service-role client, which bypasses RLS.
-- A browser session can read the thread and never write to it.

-- ═════════════════════════════════════════════════════════════════════════
-- 2. engagement_events — the data asset (service-role only)
-- ═════════════════════════════════════════════════════════════════════════

-- org_id is denormalized onto the row on purpose: events must outlive the
-- project they came from for cohort analysis, so this is plain text rather
-- than a FK to organizations(id).
create table if not exists public.engagement_events (
  id         uuid primary key default gen_random_uuid(),
  project_id text not null,
  expert_id  text not null,
  org_id     text,
  type       text not null check (type in (
    'bookmarked',
    'contact_found',
    'contact_not_found',
    'intro_sent',
    'reply_received',
    'intent_classified',
    'rate_offered',
    'rate_countered',
    'rate_agreed',
    'conflict_flagged',
    'times_proposed',
    'scheduled',
    'completed',
    'charged',
    'rejected',
    'client_ready'
  )),
  -- Numbers, booleans and short enum strings ONLY. Never free text, never PII.
  -- lib/engagementEvents.ts types this and drops any string over 64 chars at
  -- runtime before the insert.
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

comment on table public.engagement_events is
  'One row per Matchy action or observation — the learning-loop data asset. '
  'RLS is enabled with NO authenticated policies: service-role access only '
  '(the outreach_suppressions pattern), so the stream is unreachable from a '
  'browser session. payload holds numbers, booleans and short enum strings '
  'only, never free text with PII.';

comment on column public.engagement_events.org_id is
  'Organization the engagement belonged to. Plain text, no FK: events outlive '
  'the projects and orgs they describe.';
comment on column public.engagement_events.payload is
  'Numbers, booleans, short enum strings. Enforced by lib/engagementEvents.ts, '
  'which drops any string value longer than 64 characters.';

create index if not exists idx_engagement_events_thread
  on public.engagement_events (project_id, expert_id, created_at);
create index if not exists idx_engagement_events_org_type
  on public.engagement_events (org_id, type, created_at);

-- Deny-by-default for anon/authenticated. Service role bypasses RLS.
-- No policies are created for this table on purpose — see the table comment.
alter table public.engagement_events enable row level security;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. organizations.firm_type / firm_size
-- ═════════════════════════════════════════════════════════════════════════

alter table public.organizations add column if not exists firm_type text;
alter table public.organizations add column if not exists firm_size text;

-- Constraints are added separately from the columns so a re-run does not fail
-- on an already-constrained column.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'organizations_firm_type_check'
  ) then
    alter table public.organizations
      add constraint organizations_firm_type_check
      check (firm_type is null or firm_type in (
        'pe_firm','family_office','consulting_firm','law_firm',
        'hedge_fund','corporate','other'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'organizations_firm_size_check'
  ) then
    alter table public.organizations
      add constraint organizations_firm_size_check
      check (firm_size is null or firm_size in ('boutique','mid_size','large'));
  end if;
end $$;

comment on column public.organizations.firm_type is
  'How Matchy names this client to an expert without identifying them: PE '
  'firm / family office / consulting firm / law firm / hedge fund / corporate. '
  'Nullable — unknown falls back to "an investment firm".';
comment on column public.organizations.firm_size is
  'The size word in the same phrase: boutique / mid-size / large. Nullable.';

-- ═════════════════════════════════════════════════════════════════════════
-- 4. access_requests.firm_type / firm_size
-- ═════════════════════════════════════════════════════════════════════════
--
-- The two answers as submitted on the public access-request form. They live
-- here until an admin approves the request, at which point app/api/admin/
-- requests copies them onto the organization.

alter table public.access_requests add column if not exists firm_type text;
alter table public.access_requests add column if not exists firm_size text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'access_requests_firm_type_check'
  ) then
    alter table public.access_requests
      add constraint access_requests_firm_type_check
      check (firm_type is null or firm_type in (
        'pe_firm','family_office','consulting_firm','law_firm',
        'hedge_fund','corporate','other'
      ));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'access_requests_firm_size_check'
  ) then
    alter table public.access_requests
      add constraint access_requests_firm_size_check
      check (firm_size is null or firm_size in ('boutique','mid_size','large'));
  end if;
end $$;

comment on column public.access_requests.firm_type is
  'Firm type as submitted on the public form; copied to organizations.firm_type on approval.';
comment on column public.access_requests.firm_size is
  'Firm size as submitted on the public form; copied to organizations.firm_size on approval.';

-- ═════════════════════════════════════════════════════════════════════════
-- 5. projects.review_first / client_rate_min / client_rate_max
-- ═════════════════════════════════════════════════════════════════════════
--
-- review_first defaults to FALSE: bookmarking IS the consent to send the
-- intro (founder, 2026-09-06). Turning the switch on makes Matchy draft and
-- wait instead of sending.
--
-- client_rate_min / client_rate_max are CLIENT-side hourly rates in whole
-- dollars — the band Matchy negotiates inside. Both nullable (no band set =
-- tier defaults apply). The application validates min <= max, multiples of
-- $50 and >= $100; the constraints below are the backstop.

alter table public.projects add column if not exists review_first boolean not null default false;
alter table public.projects add column if not exists client_rate_min integer;
alter table public.projects add column if not exists client_rate_max integer;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'projects_client_rate_band_check'
  ) then
    alter table public.projects
      add constraint projects_client_rate_band_check
      check (
        (client_rate_min is null or (client_rate_min >= 100 and client_rate_min % 50 = 0))
        and (client_rate_max is null or (client_rate_max >= 100 and client_rate_max % 50 = 0))
        and (client_rate_min is null or client_rate_max is null or client_rate_min <= client_rate_max)
      );
  end if;
end $$;

comment on column public.projects.review_first is
  'Per-project switch. false (default) = Matchy sends the intro itself when an '
  'expert is bookmarked; true = it drafts and waits for the client.';
comment on column public.projects.client_rate_min is
  'Lowest CLIENT-side hourly rate (whole dollars) Matchy may agree to. Null = no floor.';
comment on column public.projects.client_rate_max is
  'Highest CLIENT-side hourly rate (whole dollars) Matchy may agree to. Null = no ceiling.';

commit;

-- supabase/migrations/20260906000000_outreach_suppressions.sql
--
-- ExpertMatch — global do-not-contact list for expert outreach.
--
-- One row per email address that must never receive outreach again, from any
-- project, for any client. Keyed on the address itself (normalized lowercase)
-- rather than on a ProjectExpert, because "I already told you no" is a fact
-- about the person, not about one engagement.
--
-- Written from three places:
--   'opt_out'  — the recipient clicked the footer opt-out link
--                (GET /api/outreach/unsubscribe)
--   'declined' — the reply classifier tagged an inbound reply as declined
--                (app/api/inbound-email)
--   'manual'   — an operator added the address by hand
--
-- source_project_id records which project the suppression originated from, for
-- support questions only. It is plain text (not a FK): the app addresses
-- projects by its own 24-hex id, and a suppression must outlive a deleted
-- project.
--
-- ACCESS MODEL:
--   RLS is ENABLED with NO authenticated policies — the
--   user_calendar_connections / access_requests pattern. Only the service role
--   (server routes) reads or writes it, so the list of people who opted out is
--   unreachable from a browser session even with a valid JWT. The pre-send
--   check in lib/outreachSuppressions.ts fails CLOSED: if this table cannot be
--   read, no outreach is sent.
--
-- Apply with the Supabase CLI (`supabase db push`) or by pasting into the
-- Supabase Studio SQL editor. Idempotent: safe to re-run.

begin;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. outreach_suppressions (service-role only)
-- ═════════════════════════════════════════════════════════════════════════

-- email is the primary key: one suppression per address, and a repeat opt-out
-- is a no-op upsert rather than a duplicate row. The check constraint enforces
-- the lowercase normalization the application layer applies, so a stray
-- mixed-case insert can never create a second, unmatched row for one person.
create table if not exists public.outreach_suppressions (
  email             text primary key check (email = lower(email)),
  reason            text not null check (reason in ('opt_out','declined','manual')),
  source_project_id text,
  created_at        timestamptz not null default now()
);

comment on table public.outreach_suppressions is
  'Global do-not-contact list for expert outreach, keyed on the normalized '
  'lowercase email address. RLS is enabled with no authenticated policies: '
  'service-role access only, so the opt-out list is unreachable from a browser '
  'session (the user_calendar_connections pattern). The pre-send check fails '
  'closed — a read error blocks the send.';

comment on column public.outreach_suppressions.reason is
  'How the address got here: opt_out (footer link), declined (classified '
  'reply), or manual (operator).';
comment on column public.outreach_suppressions.source_project_id is
  'Project the suppression originated from, for support lookups. Plain text, '
  'no FK: suppressions outlive the projects that caused them.';

-- Deny-by-default for anon/authenticated. Service role bypasses RLS.
-- No policies are created for this table on purpose — see the table comment.
alter table public.outreach_suppressions enable row level security;

commit;

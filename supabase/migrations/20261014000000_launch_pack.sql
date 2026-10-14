-- supabase/migrations/20261014000000_launch_pack.sql
--
-- ExpertMatch — launch pack (2026-10-14).
--
--   1. Three more engagement event kinds:
--        'intro_bounced'      — an outbound to the expert hard-bounced
--                               (lib/deliveryEvents.ts); payload: retried (bool)
--        'complaint_received' — the expert marked Matchy's mail as spam
--                               (lib/deliveryEvents.ts)
--        'mismatch_flagged'   — the client used the ten-minute mismatch
--                               guarantee (lib/mismatchGuarantee.ts)
--      Until this part is applied, lib/engagementEvents.ts logs one
--      insert-failed warning and drops those kinds; it never throws, and every
--      decision reads project_experts.data, not these rows.
--
--   2. public.organization_do_not_contact — a firm's own do-not-contact list
--      (lib/doNotContact.ts), checked before any intro goes out. Service role
--      only: RLS on, zero policies, the pattern every table since 20260908
--      uses. Until this part is applied the list cannot be saved, and the
--      send path treats a missing table as an empty list (nothing can have
--      been uploaded); any OTHER read failure holds the send.
--
-- Idempotent, and FAILS if 20260907000000_matchy_phase1.sql is not applied.
-- HOW TO APPLY: paste this whole file into the Supabase Studio SQL editor.

begin;

-- ═════════════════════════════════════════════════════════════════════════════
-- 1. engagement_events.type
-- ═════════════════════════════════════════════════════════════════════════════

do $$
declare
  c record;
begin
  for c in
    select conname
    from   pg_constraint
    where  conrelid = 'public.engagement_events'::regclass
      and  contype  = 'c'
      and  pg_get_constraintdef(oid) like '%type%'
  loop
    execute format('alter table public.engagement_events drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.engagement_events
  add constraint engagement_events_type_check check (type in (
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
    'client_ready',
    'nudge_sent',
    'rescheduled',
    'time_declined',
    'call_cancelled',
    'no_show',
    'intro_bounced',
    'complaint_received',
    'mismatch_flagged'
  ));

-- ═════════════════════════════════════════════════════════════════════════════
-- 2. organization_do_not_contact
-- ═════════════════════════════════════════════════════════════════════════════
--
-- kind:
--   'email'   — one address, matched exactly against the address Matchy found
--   'domain'  — every address at that domain (and its subdomains)
--   'company' — the expert's current or listed employer, matched on the
--               normalized company name (legal suffixes and punctuation dropped)
--   'person'  — a full name, matched on the expert's normalized name
-- value is what the client typed or uploaded; value_normalized is what the
-- matcher compares (lib/doNotContact.normalizeEntry), and is unique per org.

create table if not exists public.organization_do_not_contact (
  id               uuid        primary key default gen_random_uuid(),
  organization_id  uuid        not null references public.organizations(id) on delete cascade,
  kind             text        not null check (kind in ('email', 'domain', 'company', 'person')),
  value            text        not null check (char_length(value) between 1 and 200),
  value_normalized text        not null check (char_length(value_normalized) between 1 and 200),
  added_by         uuid        references public.profiles(id) on delete set null,
  created_at       timestamptz not null default now(),
  unique (organization_id, kind, value_normalized)
);

create index if not exists idx_org_dnc_org
  on public.organization_do_not_contact (organization_id, kind);

alter table public.organization_do_not_contact enable row level security;

commit;

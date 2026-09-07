-- supabase/migrations/20260907300000_matchy_phase2_events.sql
--
-- ExpertMatch — Matchy Phase 2 (scheduling + nudges): three more engagement
-- event kinds.
--
-- WHAT THIS CHANGES
--
--   engagement_events.type check constraint gains
--     'nudge_sent'     — Matchy sent a one-line follow-up because the expert
--                        had not replied (lib/nudges.ts; max 4 per stage)
--     'rescheduled'    — a booked call was moved (lib/bookCall.ts)
--     'time_declined'  — the expert said none of the proposed times work
--
-- Everything else about the table is unchanged. Until this is applied,
-- lib/engagementEvents.ts logs one warning and drops those three kinds; it
-- never throws, so no send or booking depends on this migration.
--
-- Idempotent: drops every check constraint on engagement_events that mentions
-- the type column (whatever Postgres named it), then adds the one below.

begin;

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
    'time_declined'
  ));

commit;

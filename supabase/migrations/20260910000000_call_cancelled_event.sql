-- supabase/migrations/20260910000000_call_cancelled_event.sql
--
-- ExpertMatch — Wave 5 (call cancellation and no-show policies): two more
-- engagement event kinds.
--
--   'call_cancelled' — a booked call was cancelled (lib/bookCall.cancelCall);
--                      payload: by ('client'|'expert'|'staff'), late (bool)
--   'no_show'        — attendance resolved after the meeting ended
--                      (Zoom webhook or staff confirmation); payload: who
--
-- Until this is applied, lib/engagementEvents.ts logs one insert-failed
-- warning and drops those kinds; it never throws, so no cancel, charge or
-- email depends on this migration (same tolerance as 20260907300000).
--
-- Idempotent, and FAILS if 20260907000000_matchy_phase1.sql is not applied.
-- HOW TO APPLY: paste this whole file into the Supabase Studio SQL editor.

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
    'time_declined',
    'call_cancelled',
    'no_show'
  ));

commit;

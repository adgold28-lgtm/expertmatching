-- supabase/migrations/20260901000000_onboarding_billing_calendar.sql
--
-- ExpertMatch — onboarding: billing (Stripe) + calendar connections.
--
-- Extends the cutover foundation (20260831000000) with the two pieces of
-- durable state the onboarding stepper needs:
--
--   1. profiles.stripe_customer_id / profiles.billing_complete
--      The client's Stripe customer and whether a card has been saved via a
--      SetupIntent. Off-session charges at call completion read these.
--
--   2. public.user_calendar_connections
--      One row per user holding their calendar link (Google OAuth, Calendly,
--      or manually entered slots). Tokens are AES-256-GCM ciphertext produced
--      by lib/encryption.ts — Postgres never sees plaintext.
--
-- ACCESS MODEL:
--   * profiles keeps its existing RLS (users read/update their own row), but
--     stripe_customer_id and billing_complete join is_platform_admin and email
--     as service-role-only columns, enforced by
--     prevent_profile_privileged_changes. A user must not be able to mark
--     themselves billing-complete or repoint their row at another customer.
--   * user_calendar_connections has RLS ENABLED with NO authenticated policies
--     — the access_requests pattern. Only the service role (server routes)
--     touches it, so OAuth ciphertext is never exposed to a browser session
--     even with a valid JWT.
--
-- Apply with the Supabase CLI (`supabase db push`) or by pasting into the
-- Supabase Studio SQL editor. Idempotent: safe to re-run.

begin;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Billing columns on profiles
-- ═════════════════════════════════════════════════════════════════════════

alter table public.profiles
  add column if not exists stripe_customer_id text,
  add column if not exists billing_complete   boolean not null default false;

-- Partial unique index rather than a plain UNIQUE constraint: every profile
-- without a Stripe customer holds NULL, and a partial index keeps the index
-- limited to the rows that actually carry a value.
create unique index if not exists idx_profiles_stripe_customer
  on public.profiles(stripe_customer_id)
  where stripe_customer_id is not null;

comment on column public.profiles.stripe_customer_id is
  'Stripe customer for this user (cus_...). Service-role write only.';
comment on column public.profiles.billing_complete is
  'True once a SetupIntent succeeded and a default payment method is saved. Service-role write only.';

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Extend the privileged-column guard on profiles
--
--    Supersedes the foundation migration's version: same email /
--    is_platform_admin checks, plus the two billing columns. A user may still
--    UPDATE their own profile row (name, title, onboarding_complete).
-- ═════════════════════════════════════════════════════════════════════════

create or replace function public.prevent_profile_privileged_changes()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    if new.is_platform_admin is distinct from old.is_platform_admin then
      raise exception 'is_platform_admin can only be changed by the service role';
    end if;
    if new.email is distinct from old.email then
      raise exception 'email can only be changed by the service role';
    end if;
    if new.stripe_customer_id is distinct from old.stripe_customer_id then
      raise exception 'stripe_customer_id can only be changed by the service role';
    end if;
    if new.billing_complete is distinct from old.billing_complete then
      raise exception 'billing_complete can only be changed by the service role';
    end if;
  end if;
  return new;
end;
$$;

-- Re-assert the trigger (create or replace trigger is idempotent).
create or replace trigger trg_prevent_profile_privileged_changes
  before update on public.profiles
  for each row execute function public.prevent_profile_privileged_changes();

-- ═════════════════════════════════════════════════════════════════════════
-- 3. user_calendar_connections (service-role only)
-- ═════════════════════════════════════════════════════════════════════════

-- One row per user. profile_id is the primary key: a user has exactly one
-- active calendar connection, and re-linking overwrites it.
--
-- access_token / refresh_token hold application-layer AES-256-GCM ciphertext
-- (lib/encryption.ts) — NEVER plaintext, and never selected into any response
-- body. token_expiry is Unix epoch milliseconds to match the app's numeric
-- timestamp convention. oauth_state is the short-lived CSRF nonce for an
-- in-flight Google authorization round-trip.
create table if not exists public.user_calendar_connections (
  profile_id     uuid primary key references public.profiles(id) on delete cascade,
  provider       text not null check (provider in ('google','calendly','manual')),
  access_token   text,           -- AES-256-GCM ciphertext
  refresh_token  text,           -- AES-256-GCM ciphertext
  token_expiry   bigint,         -- Unix epoch milliseconds
  calendar_email text,
  calendly_url   text,
  manual_slots   jsonb,
  timezone       text,           -- IANA zone, e.g. 'America/New_York'
  oauth_state    text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.user_calendar_connections is
  'Per-user calendar link for scheduling. access_token/refresh_token are '
  'application-layer AES-256-GCM ciphertext. RLS is enabled with no '
  'authenticated policies: service-role access only, so token ciphertext is '
  'unreachable from a browser session (the access_requests pattern).';

create or replace trigger trg_user_calendar_connections_updated
  before update on public.user_calendar_connections
  for each row execute function public.set_updated_at();

-- Deny-by-default for anon/authenticated. Service role bypasses RLS.
-- No policies are created for this table on purpose — see the table comment.
alter table public.user_calendar_connections enable row level security;

commit;

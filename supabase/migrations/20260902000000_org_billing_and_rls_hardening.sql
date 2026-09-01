-- supabase/migrations/20260902000000_org_billing_and_rls_hardening.sql
--
-- ExpertMatch — organization billing (per-seat pricing) + RLS hardening.
--
-- Builds on:
--   20260831000000_supabase_cutover_foundation.sql   (8 core tables + RLS)
--   20260901000000_onboarding_billing_calendar.sql   (profile billing cols,
--                                                     user_calendar_connections)
--
-- WHAT CHANGES
--   1. public.organization_billing — the ORGANIZATION (not the individual
--      user) is the paying entity. One row per org holding its Stripe
--      customer, the per-seat subscription, and whether a default card is on
--      file. Service-role only (RLS enabled, zero authenticated policies), so
--      Stripe identifiers are never readable through orgs_select_members.
--   2. organizations.seat_limit becomes an OPTIONAL admin cap. Per-seat
--      pricing replaces plan-based hard caps, so the default (and the
--      backfill for existing rows) is "unlimited" (2147483647 = int4 max).
--      Platform admins can still lower it per org.
--   3. RLS hardening — see section 3 (appended by the RLS verification pass):
--      cross-organization project sharing is closed, onboarding_complete joins
--      the service-role-only profile columns.
--
-- ACCESS MODEL (unchanged): projects/experts are owner-or-explicit-member
-- scoped, never org-wide; org_admins manage seats but see no project content;
-- platform admin acts only through the service-role key in server routes.
--
-- Apply with the Supabase CLI (`supabase db push`) or by pasting into the
-- Supabase Studio SQL editor. Idempotent: safe to re-run.

begin;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. organization_billing (service-role only)
-- ═════════════════════════════════════════════════════════════════════════

create table if not exists public.organization_billing (
  organization_id             uuid primary key references public.organizations(id) on delete cascade,
  stripe_customer_id          text,            -- cus_... (org-level customer)
  stripe_subscription_id      text,            -- sub_... (per-seat subscription)
  stripe_subscription_item_id text,            -- si_...  (the seat line; quantity = active seats)
  billing_complete            boolean not null default false,  -- default payment method saved
  subscription_status         text,            -- mirror of Stripe: active | past_due | canceled | ...
  seat_quantity_synced        integer not null default 0 check (seat_quantity_synced >= 0),
  billing_email               text,            -- who receives Stripe receipts/invoices
  set_up_by                   uuid references public.profiles(id) on delete set null,
  created_at                  timestamptz not null default now(),
  updated_at                  timestamptz not null default now()
);

create unique index if not exists idx_org_billing_customer
  on public.organization_billing(stripe_customer_id)
  where stripe_customer_id is not null;

create unique index if not exists idx_org_billing_subscription
  on public.organization_billing(stripe_subscription_id)
  where stripe_subscription_id is not null;

comment on table public.organization_billing is
  'Per-organization Stripe billing: customer, seat subscription, card-on-file '
  'flag. RLS enabled with no authenticated policies — service-role only, so '
  'Stripe ids never reach a browser session.';

create or replace trigger trg_org_billing_updated
  before update on public.organization_billing
  for each row execute function public.set_updated_at();

alter table public.organization_billing enable row level security;
-- No policies on purpose — service role only.

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Seat limit → optional cap (per-seat pricing replaces plan caps)
-- ═════════════════════════════════════════════════════════════════════════

alter table public.organizations
  alter column seat_limit set default 2147483647;

comment on column public.organizations.seat_limit is
  'Optional platform-admin cap on active seats. 2147483647 means unlimited '
  '(the default — seats are priced per account, not capped by plan).';

-- Backfill: existing orgs were capped by their plan (3/10). Per-seat pricing
-- lifts the cap; an admin can re-apply one deliberately.
update public.organizations set seat_limit = 2147483647 where seat_limit < 2147483647;

-- ═════════════════════════════════════════════════════════════════════════
-- 3. RLS hardening
-- ═════════════════════════════════════════════════════════════════════════
-- (Appended by the RLS verification pass — see scripts/rls-verify.sh.)

commit;

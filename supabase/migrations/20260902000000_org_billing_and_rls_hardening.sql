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
-- Verified end-to-end by scripts/rls-verify.sh (scripts/rls/verify.sql), which
-- applies the three migrations to a throwaway Postgres and asserts the whole
-- isolation model actor-by-actor. Every statement below is idempotent.
--
-- WHAT THIS SECTION CLOSES
--   3.1  A project owner could share a project with a profile in ANOTHER
--        organization: project_members_insert only checked that the caller
--        owned the project, never that the invitee belonged to the project's
--        org. That is a cross-account data path (project_experts is reachable
--        through has_project_access). Closed by policy AND by a trigger, so it
--        also constrains the service role — which is the path the app actually
--        writes through.
--   3.2  onboarding_complete was user-writable. It gates the onboarding flow
--        (calendar + billing prerequisites), so a user could self-certify past
--        it. It joins email / is_platform_admin / stripe_customer_id /
--        billing_complete as service-role-only.
--   3.3  An org_admin could enrol a PLATFORM ADMIN's profile into their own
--        org, which would expose that profile row to them through
--        profiles_select_org_admin.
--   3.4  projects_update's WITH CHECK only re-tested ownership, and
--        is_project_owner() reads the pre-update snapshot — so an owner could
--        rewrite owner_id (planting a project in another user's account) or
--        move the project into an organization they do not belong to.

-- ── 3.1 Cross-organization project sharing ─────────────────────────────────

-- SECURITY DEFINER so it can read projects/organization_members without being
-- filtered by the caller's own RLS (and without recursing into the policies
-- that call it).
create or replace function public.is_active_member_of_project_org(
  p_project text,
  p_profile uuid
)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.projects p
    join public.organization_members m
      on m.organization_id = p.organization_id
    where p.id = p_project
      and m.profile_id = p_profile
      and m.status = 'active'
  );
$$;

comment on function public.is_active_member_of_project_org(text, uuid) is
  'True when p_profile has an ACTIVE organization_members row in the '
  'organization that owns p_project. Gate for project_members writes: '
  'project sharing never crosses an organization boundary.';

-- Owner rows in project_members are OPTIONAL (has_project_access already
-- grants the owner access without one), but the app may write one. The owner
-- is always allowed, even if their org membership was later disabled — the
-- project would otherwise be un-representable.
create or replace function public.may_be_project_member(
  p_project text,
  p_profile uuid
)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_active_member_of_project_org(p_project, p_profile)
      or exists (
           select 1 from public.projects p
           where p.id = p_project and p.owner_id = p_profile
         );
$$;

comment on function public.may_be_project_member(text, uuid) is
  'is_active_member_of_project_org(), plus the project owner themselves. '
  'Used by trg_project_members_same_org so an owner row is always writable.';

drop policy if exists project_members_insert on public.project_members;
create policy project_members_insert on public.project_members
  for insert to authenticated
  with check (
    public.is_project_owner(project_id)
    and public.is_active_member_of_project_org(project_id, profile_id)
  );

drop policy if exists project_members_update on public.project_members;
create policy project_members_update on public.project_members
  for update to authenticated
  using (public.is_project_owner(project_id))
  with check (
    public.is_project_owner(project_id)
    and public.is_active_member_of_project_org(project_id, profile_id)
  );

-- Backstop for the service role (which BYPASSES RLS). Every collaborator write
-- the app makes goes through the service-role client, so the policies above
-- alone would not stop a cross-org invite; this trigger does.
create or replace function public.enforce_project_member_same_org()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.may_be_project_member(new.project_id, new.profile_id) then
    raise exception
      'project_members: profile is not an active member of the project''s organization'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace trigger trg_project_members_same_org
  before insert or update on public.project_members
  for each row execute function public.enforce_project_member_same_org();

-- ── 3.2 onboarding_complete is service-role only ───────────────────────────
-- Supersedes the 20260901 version: same checks plus onboarding_complete. A
-- user may still update their own first_name / last_name / full_name / title.
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
    if new.onboarding_complete is distinct from old.onboarding_complete then
      raise exception 'onboarding_complete can only be changed by the service role';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger trg_prevent_profile_privileged_changes
  before update on public.profiles
  for each row execute function public.prevent_profile_privileged_changes();

comment on column public.profiles.onboarding_complete is
  'True once the onboarding stepper finished (calendar + billing + profile). '
  'Service-role write only — it gates access to the app.';

-- ── 3.3 org_admins cannot enrol a platform admin ───────────────────────────
-- SECURITY DEFINER: a policy subquery against public.profiles would itself be
-- RLS-filtered, and a hidden row would read as "not a platform admin".
create or replace function public.is_platform_admin_profile(p_profile uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_profile and p.is_platform_admin
  );
$$;

comment on function public.is_platform_admin_profile(uuid) is
  'True when p_profile is a platform admin. Used to keep org_admins from '
  'enrolling a platform admin into their org (which would expose that '
  'profile through profiles_select_org_admin). The service role, which seeds '
  'platform admins, bypasses RLS and is unaffected.';

-- USING (old row) keeps an org_admin inside their own org; WITH CHECK (new
-- row) additionally prevents moving a row into an org they do not administer.
drop policy if exists org_members_insert on public.organization_members;
create policy org_members_insert on public.organization_members
  for insert to authenticated
  with check (
    public.is_org_admin(organization_id)
    and not public.is_platform_admin_profile(profile_id)
  );

drop policy if exists org_members_update on public.organization_members;
create policy org_members_update on public.organization_members
  for update to authenticated
  using (public.is_org_admin(organization_id))
  with check (
    public.is_org_admin(organization_id)
    and not public.is_platform_admin_profile(profile_id)
  );

-- ── 3.4 An owner cannot re-home or hand off a project ──────────────────────
-- is_project_owner(id) in a WITH CHECK evaluates against the pre-update
-- snapshot, so it does not constrain the NEW owner_id/organization_id at all.
-- Compare the new values directly. Ownership transfer stays possible through
-- the service role.
drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated
  using (public.is_project_owner(id))
  with check (
    owner_id = auth.uid()
    and public.is_org_member(organization_id)
  );

-- ── 3.5 Indexes supporting the new checks ──────────────────────────────────
create index if not exists idx_org_members_profile_status
  on public.organization_members(profile_id, status);

commit;


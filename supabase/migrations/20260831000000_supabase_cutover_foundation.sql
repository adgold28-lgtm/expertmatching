-- supabase/migrations/20260831000000_supabase_cutover_foundation.sql
--
-- ExpertMatch — Supabase cutover foundation.
--
-- Postgres becomes the source of truth for all durable domain data:
-- organizations, profiles, membership, access requests, invites, projects,
-- and project experts. Redis is retained ONLY for rate limits, caches,
-- locks, and short-lived tokens.
--
-- ACCESS MODEL (read this before changing any policy):
--   * organizations        = client account / billing / approved domain / seats
--   * organization_members = who belongs to the client + org role
--                            (org_admin | org_member) + lifecycle status
--   * projects             = owned by EXACTLY ONE user (owner_id)
--   * project_members      = explicit, opt-in project sharing (no rows by
--                            default => owner-only visibility)
--   * project_experts      = the working set of experts inside a project.
--                            Reachable ONLY through project ownership or an
--                            explicit project_members row. NEVER org-wide.
--   * org_admin manages users/seats/invites for ITS org but gets NO automatic
--     access to members' project contents.
--   * platform admin operates exclusively through the service-role key in
--     server-side admin routes. service_role BYPASSES RLS, so NO policy below
--     grants platform admins broad data access.
--
-- Project ids are 24-char lowercase hex TEXT (not uuid) to remain compatible
-- with the app's existing id format, live outreach/availability tokens, and
-- the ID_RE validation in lib/projectStore.ts.
--
-- Sensitive fields inside project_experts.data (calendar OAuth tokens) are
-- AES-256-GCM encrypted by the application layer before storage; this table
-- holds ciphertext for those fields.
--
-- Apply with the Supabase CLI (`supabase db push`) or by pasting into the
-- Supabase Studio SQL editor. Idempotent: safe to re-run.

begin;

-- ─────────────────────────────────────────────────────────────────────────
-- Shared trigger helper
-- ─────────────────────────────────────────────────────────────────────────
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Identity & organization tables (org-scoped)
-- ═════════════════════════════════════════════════════════════════════════

create table if not exists public.organizations (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  domain      text unique,
  plan        text not null default 'starter' check (plan in ('starter','growth','enterprise')),
  seat_limit  integer not null default 3 check (seat_limit >= 0),
  status      text not null default 'active' check (status in ('active','disabled')),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- profiles.id == auth.users.id (1:1 with Supabase Auth)
create table if not exists public.profiles (
  id                uuid primary key references auth.users(id) on delete cascade,
  email             text not null unique,
  first_name        text,
  last_name         text,
  full_name         text,
  title             text,
  onboarding_complete boolean not null default false,
  is_platform_admin boolean not null default false,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create table if not exists public.organization_members (
  id              uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  role            text not null default 'org_member' check (role in ('org_admin','org_member')),
  status          text not null default 'active'    check (status in ('pending','active','disabled')),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (organization_id, profile_id)
);

-- Top-of-funnel access requests. Submitted pre-auth (anonymous) via a server
-- route using the service-role key, and reviewed by platform admins. No
-- authenticated RLS policies => service-role only.
create table if not exists public.access_requests (
  id               uuid primary key default gen_random_uuid(),
  email            text not null,
  requested_domain text,
  name             text,
  firm_name        text,
  organization_id  uuid references public.organizations(id) on delete set null,
  status           text not null default 'requested' check (status in ('requested','approved','rejected')),
  reviewed_by      uuid references public.profiles(id) on delete set null,
  reviewed_at      timestamptz,
  created_at       timestamptz not null default now()
);

-- Single-use invite tokens. We store only the token HASH, never the token.
create table if not exists public.invites (
  id              uuid primary key default gen_random_uuid(),
  email           text not null,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  role            text not null default 'org_member' check (role in ('org_admin','org_member')),
  token_hash      text not null unique,
  status          text not null default 'pending' check (status in ('pending','accepted','revoked','expired')),
  invited_by      uuid references public.profiles(id) on delete set null,
  expires_at      timestamptz not null,
  accepted_at     timestamptz,
  created_at      timestamptz not null default now()
);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Project tables (owner-scoped — NEVER org-wide)
-- ═════════════════════════════════════════════════════════════════════════

-- id: 24-char lowercase hex, generated by default but insertable by the app
-- (lib/projectStore.ts ID_RE = /^[0-9a-f]{24}$/).
create table if not exists public.projects (
  id                text primary key default encode(gen_random_bytes(12), 'hex')
                    check (id ~ '^[0-9a-f]{24}$'),
  organization_id   uuid not null references public.organizations(id) on delete cascade,
  owner_id          uuid not null references public.profiles(id) on delete restrict,
  name              text not null,
  research_question text not null default '',
  status            text not null default 'active' check (status in ('active','archived')),
  -- Brief/context document — industry, function, geography, seniority, notes,
  -- outreachMode, timeline, keyQuestions, client scheduling fields, etc.
  -- Read/written as a whole; shape is defined by types.ts (Project).
  brief             jsonb not null default '{}'::jsonb,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- Explicit project sharing. Zero rows by default => owner-only access.
create table if not exists public.project_members (
  id          uuid primary key default gen_random_uuid(),
  project_id  text not null references public.projects(id) on delete cascade,
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  role        text not null default 'collaborator' check (role in ('owner','collaborator','viewer')),
  created_at  timestamptz not null default now(),
  unique (project_id, profile_id)
);

-- The working set of experts inside a project (was Project.experts[] in Redis).
-- status/contact_email are promoted for SQL filtering (e.g. shortlist counts);
-- everything else lives in `data` (shape: types.ts ProjectExpert minus the
-- promoted fields). Calendar OAuth tokens inside `data` are stored as
-- application-layer AES-256-GCM ciphertext.
create table if not exists public.project_experts (
  id            uuid primary key default gen_random_uuid(),
  project_id    text not null references public.projects(id) on delete cascade,
  expert_id     text not null,
  status        text not null default 'candidate',
  contact_email text,
  data          jsonb not null default '{}'::jsonb,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, expert_id)
);

-- ═════════════════════════════════════════════════════════════════════════
-- 3. Indexes (FKs used by RLS helpers + common lookups)
-- ═════════════════════════════════════════════════════════════════════════
create index if not exists idx_org_members_org       on public.organization_members(organization_id);
create index if not exists idx_org_members_profile   on public.organization_members(profile_id);
create index if not exists idx_invites_org           on public.invites(organization_id);
create index if not exists idx_invites_email         on public.invites(email);
create index if not exists idx_access_requests_email on public.access_requests(email);
create index if not exists idx_projects_owner        on public.projects(owner_id);
create index if not exists idx_projects_org          on public.projects(organization_id);
create index if not exists idx_project_members_proj  on public.project_members(project_id);
create index if not exists idx_project_members_prof  on public.project_members(profile_id);
create index if not exists idx_project_experts_proj  on public.project_experts(project_id);

-- ═════════════════════════════════════════════════════════════════════════
-- 4. updated_at triggers
-- ═════════════════════════════════════════════════════════════════════════
create or replace trigger trg_orgs_updated
  before update on public.organizations
  for each row execute function public.set_updated_at();

create or replace trigger trg_profiles_updated
  before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace trigger trg_org_members_updated
  before update on public.organization_members
  for each row execute function public.set_updated_at();

create or replace trigger trg_projects_updated
  before update on public.projects
  for each row execute function public.set_updated_at();

create or replace trigger trg_project_experts_updated
  before update on public.project_experts
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════
-- 5. Auth integration: auto-provision a profile for each new auth user,
--    and a one-time backfill for any pre-existing auth users.
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  begin
    insert into public.profiles (id, email, first_name, last_name, full_name)
    values (
      new.id,
      new.email,
      new.raw_user_meta_data ->> 'firstName',
      new.raw_user_meta_data ->> 'lastName',
      coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name')
    )
    on conflict (id) do nothing;
  exception when unique_violation then
    -- profiles.email collision (stale profile row for a deleted auth user).
    -- Never fail the auth.users insert over it; the profile can be repaired
    -- by the service role.
    null;
  end;
  return new;
end;
$$;

create or replace trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Defense in depth: a user may UPDATE their own profile row (see RLS below),
-- but must never be able to elevate themselves to platform admin, nor rewrite
-- their own email (it is the join key for org-domain matching). Only the
-- service role may change either.
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
  end if;
  return new;
end;
$$;

-- Supersedes the draft's escalation-only trigger; drop the old name if present.
drop trigger if exists trg_prevent_platform_admin_escalation on public.profiles;

create or replace trigger trg_prevent_profile_privileged_changes
  before update on public.profiles
  for each row execute function public.prevent_profile_privileged_changes();

-- ═════════════════════════════════════════════════════════════════════════
-- 6. RLS helper functions (SECURITY DEFINER => bypass RLS on the tables they
--    read, which prevents infinite policy recursion). All decisions key off
--    auth.uid() (== profiles.id).
-- ═════════════════════════════════════════════════════════════════════════
create or replace function public.is_org_member(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org
      and m.profile_id = auth.uid()
      and m.status = 'active'
  );
$$;

create or replace function public.is_org_admin(p_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.organization_members m
    where m.organization_id = p_org
      and m.profile_id = auth.uid()
      and m.role = 'org_admin'
      and m.status = 'active'
  );
$$;

-- True if the caller is an active org_admin of an org that p_target is also an
-- ACTIVE member of.
create or replace function public.admin_shares_org_with(p_target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1
    from public.organization_members me
    join public.organization_members them
      on me.organization_id = them.organization_id
    where me.profile_id = auth.uid()
      and me.role = 'org_admin'
      and me.status = 'active'
      and them.profile_id = p_target
      and them.status = 'active'
  );
$$;

create or replace function public.is_project_owner(p_project text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project and p.owner_id = auth.uid()
  );
$$;

-- Owner OR explicit project_members row. With zero project_members rows this
-- reduces to "owner only" — the required default visibility.
create or replace function public.has_project_access(p_project text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.projects p
    where p.id = p_project and p.owner_id = auth.uid()
  )
  or exists (
    select 1 from public.project_members pm
    where pm.project_id = p_project and pm.profile_id = auth.uid()
  );
$$;

-- ═════════════════════════════════════════════════════════════════════════
-- 7. Enable RLS on every table (deny-by-default for anon/authenticated;
--    service_role bypasses RLS).
-- ═════════════════════════════════════════════════════════════════════════
alter table public.organizations        enable row level security;
alter table public.profiles             enable row level security;
alter table public.organization_members enable row level security;
alter table public.access_requests      enable row level security;
alter table public.invites              enable row level security;
alter table public.projects             enable row level security;
alter table public.project_members      enable row level security;
alter table public.project_experts      enable row level security;

-- ═════════════════════════════════════════════════════════════════════════
-- 8. Policies
-- ═════════════════════════════════════════════════════════════════════════

-- ── profiles ──────────────────────────────────────────────────────────────
drop policy if exists profiles_select_self on public.profiles;
create policy profiles_select_self on public.profiles
  for select to authenticated
  using (id = auth.uid());

drop policy if exists profiles_select_org_admin on public.profiles;
create policy profiles_select_org_admin on public.profiles
  for select to authenticated
  using (public.admin_shares_org_with(id));

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());
-- INSERT/DELETE on profiles is service-role only (handled by the auth trigger
-- and admin routes). email / is_platform_admin changes are blocked for
-- non-service-role callers by trg_prevent_profile_privileged_changes.

-- ── organizations ──────────────────────────────────────────────────────────
-- Members may read their own org. All writes (plan/seats/domain/status) are
-- service-role only (platform admin via admin routes).
drop policy if exists orgs_select_members on public.organizations;
create policy orgs_select_members on public.organizations
  for select to authenticated
  using (public.is_org_member(id));

-- ── organization_members (org_admin manages users; no project access) ───────
drop policy if exists org_members_select on public.organization_members;
create policy org_members_select on public.organization_members
  for select to authenticated
  using (profile_id = auth.uid() or public.is_org_admin(organization_id));

drop policy if exists org_members_insert on public.organization_members;
create policy org_members_insert on public.organization_members
  for insert to authenticated
  with check (public.is_org_admin(organization_id));

drop policy if exists org_members_update on public.organization_members;
create policy org_members_update on public.organization_members
  for update to authenticated
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

drop policy if exists org_members_delete on public.organization_members;
create policy org_members_delete on public.organization_members
  for delete to authenticated
  using (public.is_org_admin(organization_id));

-- ── invites (org_admin manages invites for its org) ─────────────────────────
drop policy if exists invites_select on public.invites;
create policy invites_select on public.invites
  for select to authenticated
  using (public.is_org_admin(organization_id));

drop policy if exists invites_insert on public.invites;
create policy invites_insert on public.invites
  for insert to authenticated
  with check (public.is_org_admin(organization_id));

drop policy if exists invites_update on public.invites;
create policy invites_update on public.invites
  for update to authenticated
  using (public.is_org_admin(organization_id))
  with check (public.is_org_admin(organization_id));

drop policy if exists invites_delete on public.invites;
create policy invites_delete on public.invites
  for delete to authenticated
  using (public.is_org_admin(organization_id));

-- ── access_requests: service-role only (no authenticated policies) ──────────

-- ── projects (owner-scoped) ─────────────────────────────────────────────────
drop policy if exists projects_select on public.projects;
create policy projects_select on public.projects
  for select to authenticated
  using (public.has_project_access(id));

drop policy if exists projects_insert on public.projects;
create policy projects_insert on public.projects
  for insert to authenticated
  with check (owner_id = auth.uid() and public.is_org_member(organization_id));

drop policy if exists projects_update on public.projects;
create policy projects_update on public.projects
  for update to authenticated
  using (public.is_project_owner(id))
  with check (public.is_project_owner(id));

drop policy if exists projects_delete on public.projects;
create policy projects_delete on public.projects
  for delete to authenticated
  using (public.is_project_owner(id));

-- ── project_members (owner controls sharing) ────────────────────────────────
drop policy if exists project_members_select on public.project_members;
create policy project_members_select on public.project_members
  for select to authenticated
  using (public.has_project_access(project_id));

drop policy if exists project_members_insert on public.project_members;
create policy project_members_insert on public.project_members
  for insert to authenticated
  with check (public.is_project_owner(project_id));

drop policy if exists project_members_update on public.project_members;
create policy project_members_update on public.project_members
  for update to authenticated
  using (public.is_project_owner(project_id))
  with check (public.is_project_owner(project_id));

drop policy if exists project_members_delete on public.project_members;
create policy project_members_delete on public.project_members
  for delete to authenticated
  using (public.is_project_owner(project_id));

-- ── project_experts: access ONLY via project ownership/membership ───────────
drop policy if exists project_experts_select on public.project_experts;
create policy project_experts_select on public.project_experts
  for select to authenticated
  using (public.has_project_access(project_id));

drop policy if exists project_experts_insert on public.project_experts;
create policy project_experts_insert on public.project_experts
  for insert to authenticated
  with check (public.has_project_access(project_id));

drop policy if exists project_experts_update on public.project_experts;
create policy project_experts_update on public.project_experts
  for update to authenticated
  using (public.has_project_access(project_id))
  with check (public.has_project_access(project_id));

drop policy if exists project_experts_delete on public.project_experts;
create policy project_experts_delete on public.project_experts
  for delete to authenticated
  using (public.has_project_access(project_id));

-- ═════════════════════════════════════════════════════════════════════════
-- 9. One-time backfill: ensure a profile exists for any pre-existing auth user.
-- ═════════════════════════════════════════════════════════════════════════
insert into public.profiles (id, email)
select u.id, u.email
from auth.users u
where u.email is not null
on conflict (id) do nothing;

commit;

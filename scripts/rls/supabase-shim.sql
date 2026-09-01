-- scripts/rls/supabase-shim.sql
--
-- Recreates, on a plain PostgreSQL 16 cluster, the pieces of a Supabase
-- project that the ExpertMatch migrations assume already exist. Apply this
-- FIRST, then the migrations in supabase/migrations/ in filename order.
--
-- What Supabase gives you that stock Postgres does not:
--   * extensions pgcrypto (gen_random_bytes) and uuid-ossp
--   * roles anon / authenticated / service_role, and the privilege grants
--     PostgREST relies on (service_role has BYPASSRLS)
--   * schema auth with auth.users, auth.uid() and auth.role() reading the
--     request's JWT claims out of GUCs set per transaction by the pooler
--
-- This file is for LOCAL VERIFICATION ONLY. Never apply it to a Supabase
-- project — Supabase owns these objects and manages them itself.

begin;

-- ── Extensions ─────────────────────────────────────────────────────────────
create extension if not exists pgcrypto     with schema public;
create extension if not exists "uuid-ossp"  with schema public;

-- ── Roles ──────────────────────────────────────────────────────────────────
-- NOLOGIN: the harness reaches them with SET ROLE, exactly as PostgREST does
-- after authenticating as `authenticator`. service_role BYPASSES RLS, which is
-- what makes "the app's own writes are still constrained" a claim the
-- project_members trigger in migration 20260902 actually has to earn.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end;
$$;

-- ── auth schema ────────────────────────────────────────────────────────────
create schema if not exists auth;

-- Only the columns the migrations touch: public.handle_new_user() reads
-- id / email / raw_user_meta_data, and public.profiles has an FK to auth.users.
create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  created_at         timestamptz default now()
);

-- Claim readers, matching Supabase's implementations. Both GUC spellings are
-- supported: `request.jwt.claim.sub` (legacy, one GUC per claim) and
-- `request.jwt.claims` (current, the whole JWT payload as JSON). The `true`
-- second argument to current_setting makes a missing GUC return NULL instead
-- of raising — an unauthenticated request must read as NULL, not error.
create or replace function auth.uid()
returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'
  )::uuid;
$$;

create or replace function auth.role()
returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
  )::text;
$$;

create or replace function auth.email()
returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.email', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'email'
  )::text;
$$;

-- ── Grants (mirror Supabase's defaults) ────────────────────────────────────
-- Supabase grants the three API roles blanket table privileges and relies on
-- RLS — not on GRANT — for isolation. Reproducing that here is essential: if
-- the harness left the grants out, every "denied" assertion would pass for the
-- wrong reason (a missing privilege rather than a policy).
grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth   to anon, authenticated, service_role;

grant all on all tables    in schema public to anon, authenticated, service_role;
grant all on all sequences in schema public to anon, authenticated, service_role;
grant all on all functions in schema public to anon, authenticated, service_role;

-- The migrations create their tables AFTER this file runs, so default
-- privileges are what actually grants them (this is how Supabase does it too).
alter default privileges in schema public
  grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public
  grant all on functions to anon, authenticated, service_role;

-- auth.users is readable by the API roles in Supabase but never writable
-- through the API; the harness only needs select.
grant select on auth.users to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role(), auth.email()
  to anon, authenticated, service_role;

commit;

-- scripts/rls/verify.sql
--
-- ExpertMatch — Row-Level-Security proof suite.
--
-- 20260908: projects / project_members / project_experts / conversation_messages
-- are service-role only (no authenticated policies). Every "owner can …" claim
-- about those tables below is therefore asserted as a DENIAL or 0 rows — the
-- application performs those writes through lib/projectStore.ts and redacts
-- every read.
--
-- Provisions two client organizations plus a platform admin, then re-plays the
-- whole schema actor by actor as `anon`, as each `authenticated` user, and as
-- `service_role`, asserting exactly what each one may see and write. It proves
-- cross-account isolation against the REAL policies rather than by inspection.
--
-- SAFETY: everything (scaffolding, fixtures, assertions) happens inside ONE
-- transaction that ends in ROLLBACK, and every assertion is scoped to the
-- fixture ids below — so this file is safe to run against a live database. It
-- writes nothing that survives, and it never reads or counts real rows.
--
-- Run it through scripts/rls-verify.sh (which builds a throwaway database from
-- the shim + migrations, or points at DATABASE_URL). Requires:
--   psql -v ON_ERROR_STOP=1
--
-- Exit contract: prints `RLS VERIFY: <n> passed, <n> failed`, then raises (so
-- psql exits non-zero) if anything failed or if too few assertions ran.

\set ON_ERROR_STOP on

-- ── Fixture identifiers (fixed literals so every assertion can name them) ───
\set ORG_A '00000000-0000-4000-8000-00000000000a'
\set ORG_B '00000000-0000-4000-8000-00000000000b'
\set ORG_C '00000000-0000-4000-8000-00000000000c'
\set A1    '00000000-0000-4000-8000-0000000000a1'
\set A2    '00000000-0000-4000-8000-0000000000a2'
\set A3    '00000000-0000-4000-8000-0000000000a3'
\set A4    '00000000-0000-4000-8000-0000000000a4'
\set A5    '00000000-0000-4000-8000-0000000000a5'
\set B1    '00000000-0000-4000-8000-0000000000b1'
\set PADM  '00000000-0000-4000-8000-0000000000c1'
\set PA1   'a1a1a1a1a1a1a1a1a1a1a1a1'
\set PA2   'a2a2a2a2a2a2a2a2a2a2a2a2'
\set PB1   'b1b1b1b1b1b1b1b1b1b1b1b1'
\set PC1   'c1c1c1c1c1c1c1c1c1c1c1c1'
\set PNEW  'a9a9a9a9a9a9a9a9a9a9a9a9'

begin;

-- Per-statement output is noise: every assertion is a `select` returning void,
-- and the suite reports itself at the end. Errors still reach stderr, and
-- ON_ERROR_STOP still aborts. Restored just before the summary.
\o /dev/null

-- ═════════════════════════════════════════════════════════════════════════
-- 0. Harness scaffolding
--    Created inside the transaction: the ROLLBACK removes it. Named with a
--    _rls_verify_ prefix so it cannot collide with application objects.
-- ═════════════════════════════════════════════════════════════════════════

create table public._rls_verify_results (
  seq    serial primary key,
  name   text not null,
  ok     boolean not null,
  detail text not null default ''
);
-- The assertion helpers run as whichever role is under test, so every role
-- must be able to record a result. This grant is scaffolding, not schema.
grant all on table public._rls_verify_results to public;
grant all on sequence public._rls_verify_results_seq_seq to public;

-- Switch the JWT claims Supabase's auth.uid()/auth.role() read. Both GUC
-- spellings are set, because the shim and Supabase accept either.
create function public._rls_verify_claims(p_sub uuid, p_role text default 'authenticated')
returns void language plpgsql as $fn$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_sub, 'role', p_role)::text, true);
  perform set_config('request.jwt.claim.sub',  coalesce(p_sub::text, ''), true);
  perform set_config('request.jwt.claim.role', p_role, true);
end;
$fn$;

-- Compare a measured value against an expectation.
create function public._rls_verify_eq(p_name text, p_actual anyelement, p_expected anyelement)
returns void language plpgsql as $fn$
begin
  insert into public._rls_verify_results (name, ok, detail)
  values (
    p_name,
    p_actual is not distinct from p_expected,
    case when p_actual is not distinct from p_expected then ''
         else format('expected %L, got %L', p_expected, p_actual) end
  );
end;
$fn$;

-- Assert a statement is REFUSED with an error (RLS WITH CHECK violation,
-- privilege error, or a trigger's raise). Any write the statement managed to
-- make is undone before the result is recorded, so assertions stay order
-- independent.
create function public._rls_verify_denied(p_name text, p_sql text)
returns void language plpgsql as $fn$
declare
  v_ok     boolean := false;
  v_detail text    := '';
begin
  begin
    execute p_sql;
    v_detail := 'statement unexpectedly succeeded';
    raise exception using errcode = 'P0001', message = '__rls_undo__';
  exception when others then
    if sqlerrm <> '__rls_undo__' then
      v_ok := true;
      v_detail := left(sqlerrm, 140);
    end if;
  end;
  insert into public._rls_verify_results (name, ok, detail) values (p_name, v_ok, v_detail);
end;
$fn$;

-- Assert a statement runs and touches exactly p_expected rows. A USING-clause
-- policy does not raise — it silently narrows the row set — so "denied" for
-- UPDATE/DELETE means "affected 0 rows". The write is always rolled back.
create function public._rls_verify_rows(p_name text, p_sql text, p_expected bigint)
returns void language plpgsql as $fn$
declare
  v_rows   bigint  := -1;
  v_ok     boolean := false;
  v_detail text    := '';
begin
  begin
    execute p_sql;
    get diagnostics v_rows = row_count;
    v_ok := v_rows = p_expected;
    v_detail := case when v_ok then ''
                     else format('expected %s row(s), affected %s', p_expected, v_rows) end;
    raise exception using errcode = 'P0001', message = '__rls_undo__';
  exception when others then
    if sqlerrm <> '__rls_undo__' then
      v_ok := false;
      v_detail := 'unexpected error: ' || left(sqlerrm, 140);
    end if;
  end;
  insert into public._rls_verify_results (name, ok, detail) values (p_name, v_ok, v_detail);
end;
$fn$;

grant execute on function public._rls_verify_claims(uuid, text)                to public;
grant execute on function public._rls_verify_eq(text, anyelement, anyelement)  to public;
grant execute on function public._rls_verify_denied(text, text)                to public;
grant execute on function public._rls_verify_rows(text, text, bigint)          to public;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. Fixtures (written as the service role — the only writer the app has)
-- ═════════════════════════════════════════════════════════════════════════
--   Org A : A1 org_admin · A2 org_member · A3 DISABLED member · A4 org_member
--   A5    : a profile with no membership anywhere (a fresh invitee)
--   Org B : B1 org_admin
--   Org C : P  platform admin (is_platform_admin = true), ordinary org_member
--   PA1 owned by A1 · PA2 owned by A2 with A1 as collaborator
--   PB1 owned by B1 · PC1 owned by P
select public._rls_verify_claims(null, 'service_role');

insert into auth.users (id, email, raw_user_meta_data) values
  (:'A1',   'a1@org-a.rls-verify.invalid', '{"firstName":"Ada"}'::jsonb),
  (:'A2',   'a2@org-a.rls-verify.invalid', '{"firstName":"Ben"}'::jsonb),
  (:'A3',   'a3@org-a.rls-verify.invalid', '{"firstName":"Cal"}'::jsonb),
  (:'A4',   'a4@org-a.rls-verify.invalid', '{"firstName":"Dee"}'::jsonb),
  (:'A5',   'a5@unaffiliated.rls-verify.invalid', '{"firstName":"Fay"}'::jsonb),
  (:'B1',   'b1@org-b.rls-verify.invalid', '{"firstName":"Eve"}'::jsonb),
  (:'PADM', 'p@platform.rls-verify.invalid', '{"firstName":"Pat"}'::jsonb);

-- handle_new_user() created the profiles; make the platform admin one real.
update public.profiles set is_platform_admin = true where id = :'PADM';

insert into public.organizations (id, name, domain) values
  (:'ORG_A', 'RLS Verify Org A', 'org-a.rls-verify.invalid'),
  (:'ORG_B', 'RLS Verify Org B', 'org-b.rls-verify.invalid'),
  (:'ORG_C', 'RLS Verify Platform', 'platform.rls-verify.invalid');

insert into public.organization_members (organization_id, profile_id, role, status) values
  (:'ORG_A', :'A1',   'org_admin',  'active'),
  (:'ORG_A', :'A2',   'org_member', 'active'),
  (:'ORG_A', :'A3',   'org_member', 'disabled'),
  (:'ORG_A', :'A4',   'org_member', 'active'),
  (:'ORG_B', :'B1',   'org_admin',  'active'),
  (:'ORG_C', :'PADM', 'org_member', 'active');

insert into public.projects (id, organization_id, owner_id, name, research_question) values
  (:'PA1', :'ORG_A', :'A1',   'A1 project', 'q'),
  (:'PA2', :'ORG_A', :'A2',   'A2 project', 'q'),
  (:'PB1', :'ORG_B', :'B1',   'B1 project', 'q'),
  (:'PC1', :'ORG_C', :'PADM', 'Platform project', 'q');

-- PA2 is shared with A1 (same org) — the only legitimate sharing shape.
insert into public.project_members (project_id, profile_id, role) values
  (:'PA2', :'A1', 'collaborator');

insert into public.project_experts (project_id, expert_id, status, contact_email) values
  (:'PA1', 'exp-pa1', 'candidate', 'e1@experts.rls-verify.invalid'),
  (:'PA2', 'exp-pa2', 'candidate', 'e2@experts.rls-verify.invalid'),
  (:'PB1', 'exp-pb1', 'candidate', 'e3@experts.rls-verify.invalid'),
  (:'PC1', 'exp-pc1', 'candidate', 'e4@experts.rls-verify.invalid');

insert into public.access_requests (email, kind, organization_id) values
  ('req-a@org-a.rls-verify.invalid', 'access', :'ORG_A'),
  ('req-b@org-b.rls-verify.invalid', 'seat',   :'ORG_B');

insert into public.user_calendar_connections (profile_id, provider, access_token, calendar_email) values
  (:'A1', 'google',   'ciphertext-not-a-real-token', 'a1@org-a.rls-verify.invalid'),
  (:'B1', 'calendly', null,                          'b1@org-b.rls-verify.invalid');

insert into public.organization_billing (organization_id, stripe_customer_id, billing_complete) values
  (:'ORG_A', 'cus_rlsverifyA', true),
  (:'ORG_B', 'cus_rlsverifyB', false);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. Structural assertions (catalog level)
--    These make the behavioural assertions meaningful: they prove the denials
--    below come from POLICIES, not from missing table grants, and that the
--    service-role-only tables really have zero policies.
-- ═════════════════════════════════════════════════════════════════════════

select public._rls_verify_eq('schema: RLS enabled on all 9 tables',
  (select count(*) from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relrowsecurity
      and c.relname in ('organizations','profiles','organization_members','access_requests',
                        'projects','project_members','project_experts',
                        'user_calendar_connections','organization_billing'))::bigint,
  9::bigint);

select public._rls_verify_eq('schema: access_requests has zero policies',
  (select count(*) from pg_policies where schemaname='public' and tablename='access_requests')::bigint, 0::bigint);
select public._rls_verify_eq('schema: user_calendar_connections has zero policies',
  (select count(*) from pg_policies where schemaname='public' and tablename='user_calendar_connections')::bigint, 0::bigint);
select public._rls_verify_eq('schema: organization_billing has zero policies',
  (select count(*) from pg_policies where schemaname='public' and tablename='organization_billing')::bigint, 0::bigint);

-- 20260908: the project family is service-role only too. The application never
-- queried these as the signed-in user, and the policies granted MORE than the
-- application does (raw expert identity in project_experts.data, collaborator
-- writes). lib/redactExpert.ts is now the only path to an expert row.
select public._rls_verify_eq('schema: projects has zero policies',
  (select count(*) from pg_policies where schemaname='public' and tablename='projects')::bigint, 0::bigint);
select public._rls_verify_eq('schema: project_members has zero policies',
  (select count(*) from pg_policies where schemaname='public' and tablename='project_members')::bigint, 0::bigint);
select public._rls_verify_eq('schema: project_experts has zero policies',
  (select count(*) from pg_policies where schemaname='public' and tablename='project_experts')::bigint, 0::bigint);
select public._rls_verify_eq('schema: conversation_messages has zero policies',
  (select count(*) from pg_policies where schemaname='public' and tablename='conversation_messages')::bigint, 0::bigint);
select public._rls_verify_eq('schema: product_events exists with RLS enabled',
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'product_events' and c.relrowsecurity)::bigint, 1::bigint);
select public._rls_verify_eq('schema: product_events has zero policies',
  (select count(*) from pg_policies where schemaname='public' and tablename='product_events')::bigint, 0::bigint);

-- If these grants were missing, every "denied" result would be a false pass.
select public._rls_verify_eq('grants: authenticated may select projects (denials come from RLS)',
  has_table_privilege('authenticated', 'public.projects', 'select'), true);
select public._rls_verify_eq('grants: authenticated may insert project_members (denials come from RLS)',
  has_table_privilege('authenticated', 'public.project_members', 'insert'), true);
select public._rls_verify_eq('grants: authenticated may select organization_billing (denials come from RLS)',
  has_table_privilege('authenticated', 'public.organization_billing', 'select'), true);
select public._rls_verify_eq('grants: anon may select projects (denials come from RLS)',
  has_table_privilege('anon', 'public.projects', 'select'), true);

-- The hardening added in 20260902 section 3 must actually be installed.
select public._rls_verify_eq('schema: trg_project_members_same_org exists',
  (select count(*) from pg_trigger where tgname = 'trg_project_members_same_org' and not tgisinternal)::bigint,
  1::bigint);
select public._rls_verify_eq('schema: is_active_member_of_project_org exists',
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='is_active_member_of_project_org')::bigint, 1::bigint);
select public._rls_verify_eq('schema: orgs_select_members is the only organizations policy',
  (select count(*) from pg_policies where schemaname='public' and tablename='organizations')::bigint, 1::bigint);
select public._rls_verify_eq('schema: organizations has no write policy',
  (select count(*) from pg_policies
    where schemaname='public' and tablename='organizations' and cmd <> 'SELECT')::bigint, 0::bigint);

-- ═════════════════════════════════════════════════════════════════════════
-- 3. anon — an unauthenticated request sees nothing at all
-- ═════════════════════════════════════════════════════════════════════════
set local role anon;
select public._rls_verify_claims(null, 'anon');

select public._rls_verify_eq('anon: organizations invisible',
  (select count(*) from public.organizations where id in (:'ORG_A', :'ORG_B', :'ORG_C'))::bigint, 0::bigint);
select public._rls_verify_eq('anon: profiles invisible',
  (select count(*) from public.profiles where id in (:'A1', :'A2', :'B1', :'PADM'))::bigint, 0::bigint);
select public._rls_verify_eq('anon: organization_members invisible',
  (select count(*) from public.organization_members where organization_id in (:'ORG_A', :'ORG_B'))::bigint, 0::bigint);
select public._rls_verify_eq('anon: projects invisible',
  (select count(*) from public.projects where id in (:'PA1', :'PA2', :'PB1', :'PC1'))::bigint, 0::bigint);
select public._rls_verify_eq('anon: project_members invisible',
  (select count(*) from public.project_members where project_id in (:'PA1', :'PA2'))::bigint, 0::bigint);
select public._rls_verify_eq('anon: project_experts invisible',
  (select count(*) from public.project_experts where project_id in (:'PA1', :'PA2', :'PB1'))::bigint, 0::bigint);
select public._rls_verify_eq('anon: access_requests invisible',
  (select count(*) from public.access_requests where organization_id in (:'ORG_A', :'ORG_B'))::bigint, 0::bigint);
select public._rls_verify_eq('anon: user_calendar_connections invisible',
  (select count(*) from public.user_calendar_connections where profile_id in (:'A1', :'B1'))::bigint, 0::bigint);
select public._rls_verify_eq('anon: organization_billing invisible',
  (select count(*) from public.organization_billing where organization_id in (:'ORG_A', :'ORG_B'))::bigint, 0::bigint);
select public._rls_verify_eq('anon: product_events invisible',
  (select count(*) from public.product_events where organization_id in (:'ORG_A', :'ORG_B'))::bigint, 0::bigint);
select public._rls_verify_denied('anon: cannot insert a product_event',
  format('insert into public.product_events (organization_id, type) values (%L, %L)', :'ORG_A', 'signed_in'));
select public._rls_verify_denied('anon: cannot insert a project',
  format('insert into public.projects (id, organization_id, owner_id, name) values (%L, %L, %L, %L)',
         :'PNEW', :'ORG_A', :'A1', 'anon project'));
select public._rls_verify_denied('anon: cannot insert an access_request',
  $q$insert into public.access_requests (email) values ('anon@rls-verify.invalid')$q$);

reset role;
select public._rls_verify_claims(null, 'service_role');

-- ═════════════════════════════════════════════════════════════════════════
-- 4. A1 — org_admin of A, owner of PA1, collaborator on PA2
-- ═════════════════════════════════════════════════════════════════════════
set local role authenticated;
select public._rls_verify_claims(:'A1');

-- organizations
select public._rls_verify_eq('A1: sees exactly one organization (A)',
  (select count(*) from public.organizations where id in (:'ORG_A', :'ORG_B', :'ORG_C'))::bigint, 1::bigint);
select public._rls_verify_eq('A1: the visible organization is A',
  (select id from public.organizations where id in (:'ORG_A', :'ORG_B', :'ORG_C'))::text, (:'ORG_A')::text);
select public._rls_verify_rows('A1: cannot rename own organization',
  format('update public.organizations set name = %L where id = %L', 'hijacked', :'ORG_A'), 0::bigint);
select public._rls_verify_rows('A1: cannot delete own organization',
  format('delete from public.organizations where id = %L', :'ORG_A'), 0::bigint);
select public._rls_verify_denied('A1: cannot create an organization',
  $q$insert into public.organizations (name, domain) values ('Rogue', 'rogue.rls-verify.invalid')$q$);
select public._rls_verify_rows('A1: cannot raise own seat_limit',
  format('update public.organizations set seat_limit = 999 where id = %L', :'ORG_A'), 0::bigint);

-- profiles
select public._rls_verify_eq('A1: org_admin sees own and active members'' profiles',
  (select count(*) from public.profiles where id in (:'A1', :'A2', :'A4'))::bigint, 3::bigint);
-- admin_shares_org_with() requires the TARGET membership to be active too, so a
-- deactivated seat drops out of the org_admin's view. The admin UI lists users
-- through the service role, so this is a tightening, not a regression.
select public._rls_verify_eq('A1: a disabled member''s profile is hidden even from the org_admin',
  (select count(*) from public.profiles where id = :'A3')::bigint, 0::bigint);
select public._rls_verify_eq('A1: cannot see org-B profile',
  (select count(*) from public.profiles where id = :'B1')::bigint, 0::bigint);
select public._rls_verify_eq('A1: cannot see the platform admin profile',
  (select count(*) from public.profiles where id = :'PADM')::bigint, 0::bigint);
select public._rls_verify_rows('A1: org_admin cannot edit a member profile',
  format('update public.profiles set first_name = %L where id = %L', 'Rewritten', :'A2'), 0::bigint);

-- organization_members
select public._rls_verify_eq('A1: sees all four org-A memberships',
  (select count(*) from public.organization_members where organization_id = :'ORG_A')::bigint, 4::bigint);
select public._rls_verify_eq('A1: sees no org-B membership',
  (select count(*) from public.organization_members where organization_id = :'ORG_B')::bigint, 0::bigint);
select public._rls_verify_rows('A1: can add a member to own org',
  format('insert into public.organization_members (organization_id, profile_id) values (%L, %L)',
         :'ORG_A', :'A5'), 1::bigint);
select public._rls_verify_denied('A1: cannot enrol a platform admin into own org',
  format('insert into public.organization_members (organization_id, profile_id) values (%L, %L)',
         :'ORG_A', :'PADM'));
select public._rls_verify_denied('A1: cannot add a member to another org',
  format('insert into public.organization_members (organization_id, profile_id) values (%L, %L)',
         :'ORG_B', :'A2'));
select public._rls_verify_denied('A1: cannot move an org-A membership into org B',
  format('update public.organization_members set organization_id = %L where profile_id = %L and organization_id = %L',
         :'ORG_B', :'A2', :'ORG_A'));
select public._rls_verify_denied('A1: cannot promote a platform admin''s membership into own org',
  format('update public.organization_members set profile_id = %L where profile_id = %L and organization_id = %L',
         :'PADM', :'A2', :'ORG_A'));

-- projects
select public._rls_verify_eq('A1: sees NO project rows directly (service-role only; the app redacts)',
  (select count(*) from public.projects where id in (:'PA1', :'PA2', :'PB1', :'PC1'))::bigint, 0::bigint);
select public._rls_verify_eq('A1: cannot see org-B project by id',
  (select count(*) from public.projects where id = :'PB1')::bigint, 0::bigint);
select public._rls_verify_rows('A1: cannot update org-B project',
  format('update public.projects set name = %L where id = %L', 'stolen', :'PB1'), 0::bigint);
select public._rls_verify_rows('A1: cannot delete org-B project',
  format('delete from public.projects where id = %L', :'PB1'), 0::bigint);
select public._rls_verify_rows('A1: collaborator cannot update the shared project',
  format('update public.projects set name = %L where id = %L', 'collab edit', :'PA2'), 0::bigint);
select public._rls_verify_rows('A1: collaborator cannot delete the shared project',
  format('delete from public.projects where id = %L', :'PA2'), 0::bigint);
select public._rls_verify_rows('A1: owner cannot rename own project directly (writes go through the app)',
  format('update public.projects set name = %L where id = %L', 'renamed', :'PA1'), 0::bigint);
select public._rls_verify_rows('A1: owner cannot hand a project to another user',
  format('update public.projects set owner_id = %L where id = %L', :'A2', :'PA1'), 0::bigint);
select public._rls_verify_rows('A1: owner cannot move a project into another org',
  format('update public.projects set organization_id = %L where id = %L', :'ORG_B', :'PA1'), 0::bigint);
select public._rls_verify_rows('A1: owner cannot flip own project live directly (brief is service-role only)',
  format('update public.projects set brief = %L where id = %L', '{"walkthrough":false}', :'PA1'), 0::bigint);

-- project_members / project_experts
select public._rls_verify_denied('A1: collaborator cannot add members to the shared project',
  format('insert into public.project_members (project_id, profile_id) values (%L, %L)', :'PA2', :'A4'));
select public._rls_verify_eq('A1: sees NO expert rows directly, not even own (raw identity lives here)',
  (select count(*) from public.project_experts where project_id in (:'PA1', :'PA2'))::bigint, 0::bigint);
select public._rls_verify_rows('A1: cannot update own project''s experts directly',
  format('update public.project_experts set status = %L where project_id = %L', 'scheduled', :'PA1'), 0::bigint);
select public._rls_verify_rows('A1: cannot delete own project''s experts directly',
  format('delete from public.project_experts where project_id = %L', :'PA1'), 0::bigint);
-- NOTE: section 1 inserts no conversation_messages fixtures, so this assertion
-- passes whether or not the policy was dropped — it is a structural claim in
-- behavioural clothing. The real proof for that table is the "zero policies"
-- assertion above; a message fixture would make this one mean something.
select public._rls_verify_eq('A1: sees no conversation_messages',
  (select count(*) from public.conversation_messages where project_id in (:'PA1', :'PA2'))::bigint, 0::bigint);
select public._rls_verify_eq('A1: sees no org-B experts',
  (select count(*) from public.project_experts where project_id = :'PB1')::bigint, 0::bigint);
select public._rls_verify_denied('A1: cannot insert an expert into an org-B project',
  format('insert into public.project_experts (project_id, expert_id) values (%L, %L)', :'PB1', 'exp-injected'));
select public._rls_verify_rows('A1: cannot update org-B experts',
  format('update public.project_experts set status = %L where project_id = %L', 'won', :'PB1'), 0::bigint);
select public._rls_verify_rows('A1: cannot delete org-B experts',
  format('delete from public.project_experts where project_id = %L', :'PB1'), 0::bigint);

-- service-role-only tables
select public._rls_verify_eq('A1: access_requests invisible',
  (select count(*) from public.access_requests where organization_id in (:'ORG_A', :'ORG_B'))::bigint, 0::bigint);
select public._rls_verify_eq('A1: own calendar connection invisible (token ciphertext unreachable)',
  (select count(*) from public.user_calendar_connections where profile_id = :'A1')::bigint, 0::bigint);
select public._rls_verify_eq('A1: organization_billing invisible (Stripe ids unreachable)',
  (select count(*) from public.organization_billing where organization_id = :'ORG_A')::bigint, 0::bigint);
select public._rls_verify_eq('A1: product_events invisible',
  (select count(*) from public.product_events where organization_id = :'ORG_A')::bigint, 0::bigint);
select public._rls_verify_denied('A1: cannot insert a product_event',
  format('insert into public.product_events (actor_id, organization_id, type) values (%L, %L, %L)', :'A1', :'ORG_A', 'signed_in'));
select public._rls_verify_denied('A1: cannot insert organization_billing',
  format('insert into public.organization_billing (organization_id) values (%L)', :'ORG_C'));
select public._rls_verify_rows('A1: cannot mark own org billing complete',
  format('update public.organization_billing set billing_complete = true where organization_id = %L', :'ORG_A'), 0::bigint);
select public._rls_verify_rows('A1: cannot delete organization_billing',
  format('delete from public.organization_billing where organization_id = %L', :'ORG_A'), 0::bigint);
select public._rls_verify_denied('A1: cannot insert a calendar connection',
  format('insert into public.user_calendar_connections (profile_id, provider) values (%L, %L)', :'A4', 'manual'));
select public._rls_verify_denied('A1: cannot insert an access_request',
  $q$insert into public.access_requests (email) values ('a1@org-a.rls-verify.invalid')$q$);

reset role;
select public._rls_verify_claims(null, 'service_role');

-- ═════════════════════════════════════════════════════════════════════════
-- 5. A2 — plain org_member, owner of PA2
-- ═════════════════════════════════════════════════════════════════════════
set local role authenticated;
select public._rls_verify_claims(:'A2');

select public._rls_verify_eq('A2: sees only own profile',
  (select count(*) from public.profiles where id in (:'A1', :'A2', :'A3', :'B1', :'PADM'))::bigint, 1::bigint);
select public._rls_verify_eq('A2: sees only own membership row',
  (select count(*) from public.organization_members where organization_id in (:'ORG_A', :'ORG_B'))::bigint, 1::bigint);
select public._rls_verify_eq('A2: sees own organization',
  (select count(*) from public.organizations where id in (:'ORG_A', :'ORG_B', :'ORG_C'))::bigint, 1::bigint);

-- profiles: the privileged-column trigger
select public._rls_verify_rows('A2: can edit own first_name',
  format('update public.profiles set first_name = %L where id = %L', 'Benjamin', :'A2'), 1::bigint);
select public._rls_verify_denied('A2: cannot change own email',
  format('update public.profiles set email = %L where id = %L', 'someone-else@org-b.rls-verify.invalid', :'A2'));
select public._rls_verify_denied('A2: cannot make self a platform admin',
  format('update public.profiles set is_platform_admin = true where id = %L', :'A2'));
select public._rls_verify_denied('A2: cannot self-certify onboarding_complete',
  format('update public.profiles set onboarding_complete = true where id = %L', :'A2'));
select public._rls_verify_denied('A2: cannot self-certify billing_complete',
  format('update public.profiles set billing_complete = true where id = %L', :'A2'));
select public._rls_verify_denied('A2: cannot set own stripe_customer_id',
  format('update public.profiles set stripe_customer_id = %L where id = %L', 'cus_hijack', :'A2'));
select public._rls_verify_rows('A2: cannot edit another profile',
  format('update public.profiles set first_name = %L where id = %L', 'Nope', :'A1'), 0::bigint);

-- organization_members
select public._rls_verify_denied('A2: member cannot add anyone to the org',
  format('insert into public.organization_members (organization_id, profile_id) values (%L, %L)', :'ORG_A', :'PADM'));
select public._rls_verify_rows('A2: member cannot promote self to org_admin',
  format('update public.organization_members set role = %L where profile_id = %L', 'org_admin', :'A2'), 0::bigint);

-- projects
select public._rls_verify_eq('A2: sees NO project rows directly (service-role only)',
  (select count(*) from public.projects where id in (:'PA1', :'PA2', :'PB1', :'PC1'))::bigint, 0::bigint);
select public._rls_verify_denied('A2: cannot create a project directly (creation goes through the app)',
  format('insert into public.projects (id, organization_id, owner_id, name) values (%L, %L, %L, %L)',
         :'PNEW', :'ORG_A', :'A2', 'new project'));
select public._rls_verify_denied('A2: cannot create a project owned by someone else',
  format('insert into public.projects (id, organization_id, owner_id, name) values (%L, %L, %L, %L)',
         :'PNEW', :'ORG_A', :'A1', 'planted project'));
select public._rls_verify_denied('A2: cannot create a project in another org',
  format('insert into public.projects (id, organization_id, owner_id, name) values (%L, %L, %L, %L)',
         :'PNEW', :'ORG_B', :'A2', 'cross-org project'));

-- project_members — the cross-org sharing hole this pass closes
select public._rls_verify_denied('A2: owner cannot share a project directly (sharing goes through the app)',
  format('insert into public.project_members (project_id, profile_id) values (%L, %L)', :'PA2', :'A4'));
select public._rls_verify_denied('A2: owner CANNOT share a project across organizations',
  format('insert into public.project_members (project_id, profile_id) values (%L, %L)', :'PA2', :'B1'));
select public._rls_verify_denied('A2: owner cannot share with a profile that belongs to no org',
  format('insert into public.project_members (project_id, profile_id) values (%L, %L)', :'PA2', :'A5'));
select public._rls_verify_denied('A2: owner cannot share with a disabled org member',
  format('insert into public.project_members (project_id, profile_id) values (%L, %L)', :'PA2', :'A3'));
select public._rls_verify_rows('A2: owner cannot repoint an existing share at an outsider',
  format('update public.project_members set profile_id = %L where project_id = %L', :'B1', :'PA2'), 0::bigint);
select public._rls_verify_eq('A2: sees no project_members rows directly',
  (select count(*) from public.project_members where project_id = :'PA2')::bigint, 0::bigint);
select public._rls_verify_rows('A2: cannot revoke a share directly',
  format('delete from public.project_members where project_id = %L and profile_id = %L', :'PA2', :'A1'), 0::bigint);

-- project_experts
select public._rls_verify_eq('A2: sees NO expert rows directly, not even own',
  (select count(*) from public.project_experts where project_id in (:'PA1', :'PA2', :'PB1'))::bigint, 0::bigint);
select public._rls_verify_rows('A2: cannot update own project''s experts directly',
  format('update public.project_experts set status = %L where project_id = %L', 'shortlisted', :'PA2'), 0::bigint);
select public._rls_verify_rows('A2: cannot force the identity reveal directly',
  format('update public.project_experts set status = %L where project_id = %L', 'scheduled', :'PA2'), 0::bigint);
select public._rls_verify_denied('A2: cannot insert an expert into a project they cannot see',
  format('insert into public.project_experts (project_id, expert_id) values (%L, %L)', :'PA1', 'exp-injected'));

reset role;
select public._rls_verify_claims(null, 'service_role');

-- ═════════════════════════════════════════════════════════════════════════
-- 6. A3 — DISABLED member of org A (a deactivated seat)
-- ═════════════════════════════════════════════════════════════════════════
set local role authenticated;
select public._rls_verify_claims(:'A3');

select public._rls_verify_eq('A3 (disabled): sees no organization',
  (select count(*) from public.organizations where id in (:'ORG_A', :'ORG_B', :'ORG_C'))::bigint, 0::bigint);
select public._rls_verify_eq('A3 (disabled): sees no project',
  (select count(*) from public.projects where id in (:'PA1', :'PA2', :'PB1', :'PC1'))::bigint, 0::bigint);
select public._rls_verify_eq('A3 (disabled): sees no expert',
  (select count(*) from public.project_experts where project_id in (:'PA1', :'PA2', :'PB1'))::bigint, 0::bigint);
select public._rls_verify_eq('A3 (disabled): still sees own profile only',
  (select count(*) from public.profiles where id in (:'A1', :'A2', :'A3', :'B1'))::bigint, 1::bigint);
select public._rls_verify_denied('A3 (disabled): cannot create a project in the org',
  format('insert into public.projects (id, organization_id, owner_id, name) values (%L, %L, %L, %L)',
         :'PNEW', :'ORG_A', :'A3', 'disabled project'));
select public._rls_verify_rows('A3 (disabled): cannot re-enable own membership',
  format('update public.organization_members set status = %L where profile_id = %L and organization_id = %L',
         'active', :'A3', :'ORG_A'), 0::bigint);

reset role;
select public._rls_verify_claims(null, 'service_role');

-- ═════════════════════════════════════════════════════════════════════════
-- 7. B1 — the other account. Nothing of org A may be reachable.
-- ═════════════════════════════════════════════════════════════════════════
set local role authenticated;
select public._rls_verify_claims(:'B1');

select public._rls_verify_eq('B1: sees only org B',
  (select count(*) from public.organizations where id in (:'ORG_A', :'ORG_B', :'ORG_C'))::bigint, 1::bigint);
select public._rls_verify_eq('B1: the visible organization is B',
  (select id from public.organizations where id in (:'ORG_A', :'ORG_B', :'ORG_C'))::text, (:'ORG_B')::text);
-- After 20260908000000 projects has zero authenticated policies, so a session
-- user sees no project rows directly; access is application-level only.
select public._rls_verify_eq('B1: sees NO project rows directly',
  (select count(*) from public.projects where id in (:'PA1', :'PA2', :'PB1', :'PC1'))::bigint, 0::bigint);
select public._rls_verify_eq('B1: cannot see org-A profiles',
  (select count(*) from public.profiles where id in (:'A1', :'A2', :'A3'))::bigint, 0::bigint);
select public._rls_verify_eq('B1: cannot see org-A memberships',
  (select count(*) from public.organization_members where organization_id = :'ORG_A')::bigint, 0::bigint);
select public._rls_verify_rows('B1: cannot edit org-A memberships',
  format('update public.organization_members set status = %L where organization_id = %L', 'disabled', :'ORG_A'), 0::bigint);
select public._rls_verify_rows('B1: cannot delete org-A memberships',
  format('delete from public.organization_members where organization_id = %L', :'ORG_A'), 0::bigint);
select public._rls_verify_eq('B1: cannot see org-A project members',
  (select count(*) from public.project_members where project_id in (:'PA1', :'PA2'))::bigint, 0::bigint);
select public._rls_verify_denied('B1: cannot add self to an org-A project',
  format('insert into public.project_members (project_id, profile_id) values (%L, %L)', :'PA1', :'B1'));
select public._rls_verify_eq('B1: cannot see org-A experts',
  (select count(*) from public.project_experts where project_id in (:'PA1', :'PA2'))::bigint, 0::bigint);
select public._rls_verify_denied('B1: cannot insert an expert into an org-A project',
  format('insert into public.project_experts (project_id, expert_id) values (%L, %L)', :'PA1', 'exp-injected'));
select public._rls_verify_rows('B1: cannot update org-A experts',
  format('update public.project_experts set contact_email = %L where project_id = %L',
         'leak@rls-verify.invalid', :'PA1'), 0::bigint);
select public._rls_verify_rows('B1: cannot delete org-A experts',
  format('delete from public.project_experts where project_id = %L', :'PA1'), 0::bigint);
select public._rls_verify_rows('B1: cannot update an org-A project',
  format('update public.projects set name = %L where id = %L', 'stolen', :'PA1'), 0::bigint);
select public._rls_verify_eq('B1: org-A billing invisible',
  (select count(*) from public.organization_billing where organization_id = :'ORG_A')::bigint, 0::bigint);
select public._rls_verify_eq('B1: org-A calendar connections invisible',
  (select count(*) from public.user_calendar_connections where profile_id = :'A1')::bigint, 0::bigint);

reset role;
select public._rls_verify_claims(null, 'service_role');

-- ═════════════════════════════════════════════════════════════════════════
-- 8. Platform admin holding an ORDINARY user JWT.
--    The design says platform admins act only through the service-role key in
--    server routes. is_platform_admin must therefore grant nothing at all to a
--    browser session — assert that explicitly.
-- ═════════════════════════════════════════════════════════════════════════
set local role authenticated;
select public._rls_verify_claims(:'PADM');

select public._rls_verify_eq('platform admin (user JWT): is_platform_admin is true',
  (select is_platform_admin from public.profiles where id = :'PADM'), true);
select public._rls_verify_eq('platform admin (user JWT): sees only own organization',
  (select count(*) from public.organizations where id in (:'ORG_A', :'ORG_B', :'ORG_C'))::bigint, 1::bigint);
select public._rls_verify_eq('platform admin (user JWT): sees no project rows directly',
  (select count(*) from public.projects where id in (:'PA1', :'PA2', :'PB1', :'PC1'))::bigint, 0::bigint);
select public._rls_verify_eq('platform admin (user JWT): sees no expert rows directly',
  (select count(*) from public.project_experts where project_id in (:'PA1', :'PA2', :'PB1', :'PC1'))::bigint, 0::bigint);
select public._rls_verify_eq('platform admin (user JWT): sees only own profile',
  (select count(*) from public.profiles where id in (:'A1', :'A2', :'A3', :'B1', :'PADM'))::bigint, 1::bigint);
select public._rls_verify_eq('platform admin (user JWT): access_requests invisible',
  (select count(*) from public.access_requests where organization_id in (:'ORG_A', :'ORG_B'))::bigint, 0::bigint);
select public._rls_verify_eq('platform admin (user JWT): organization_billing invisible',
  (select count(*) from public.organization_billing where organization_id in (:'ORG_A', :'ORG_B'))::bigint, 0::bigint);
select public._rls_verify_eq('platform admin (user JWT): calendar connections invisible',
  (select count(*) from public.user_calendar_connections where profile_id in (:'A1', :'B1'))::bigint, 0::bigint);
select public._rls_verify_rows('platform admin (user JWT): cannot edit another org',
  format('update public.organizations set seat_limit = 1 where id = %L', :'ORG_A'), 0::bigint);
select public._rls_verify_rows('platform admin (user JWT): cannot edit another project',
  format('update public.projects set name = %L where id = %L', 'admin edit', :'PA1'), 0::bigint);
select public._rls_verify_rows('platform admin (user JWT): cannot edit another profile',
  format('update public.profiles set first_name = %L where id = %L', 'Admin', :'A1'), 0::bigint);
select public._rls_verify_denied('platform admin (user JWT): cannot join another org',
  format('insert into public.organization_members (organization_id, profile_id) values (%L, %L)', :'ORG_A', :'PADM'));

reset role;
select public._rls_verify_claims(null, 'service_role');

-- ═════════════════════════════════════════════════════════════════════════
-- 9. service_role — bypasses RLS (this is the app's own connection), so the
--    only remaining guard is the project_members trigger. That is exactly why
--    the cross-org rule is a trigger and not only a policy.
-- ═════════════════════════════════════════════════════════════════════════
set local role service_role;
select public._rls_verify_claims(null, 'service_role');

select public._rls_verify_eq('service_role: sees all fixture organizations',
  (select count(*) from public.organizations where id in (:'ORG_A', :'ORG_B', :'ORG_C'))::bigint, 3::bigint);
select public._rls_verify_eq('service_role: sees all fixture projects',
  (select count(*) from public.projects where id in (:'PA1', :'PA2', :'PB1', :'PC1'))::bigint, 4::bigint);
select public._rls_verify_eq('service_role: sees all fixture access_requests',
  (select count(*) from public.access_requests where organization_id in (:'ORG_A', :'ORG_B'))::bigint, 2::bigint);
select public._rls_verify_eq('service_role: sees all fixture calendar connections',
  (select count(*) from public.user_calendar_connections where profile_id in (:'A1', :'B1'))::bigint, 2::bigint);
select public._rls_verify_eq('service_role: sees all fixture org billing rows',
  (select count(*) from public.organization_billing where organization_id in (:'ORG_A', :'ORG_B'))::bigint, 2::bigint);
select public._rls_verify_eq('service_role: sees all fixture experts (the app''s own connection)',
  (select count(*) from public.project_experts where project_id in (:'PA1', :'PA2', :'PB1', :'PC1'))::bigint, 4::bigint);
select public._rls_verify_rows('service_role: may record a product event',
  format('insert into public.product_events (actor_id, organization_id, project_id, type) values (%L, %L, %L, %L)',
         :'A1', :'ORG_A', :'PA1', 'project_opened'), 1::bigint);

select public._rls_verify_rows('service_role: may share a project inside the org',
  format('insert into public.project_members (project_id, profile_id) values (%L, %L)', :'PA2', :'A4'), 1::bigint);
select public._rls_verify_denied('service_role: CANNOT share a project across organizations (trigger backstop)',
  format('insert into public.project_members (project_id, profile_id) values (%L, %L)', :'PA2', :'B1'));
select public._rls_verify_denied('service_role: cannot share with a disabled org member',
  format('insert into public.project_members (project_id, profile_id) values (%L, %L)', :'PA2', :'A3'));
select public._rls_verify_denied('service_role: cannot repoint an existing share cross-org',
  format('update public.project_members set profile_id = %L where project_id = %L', :'B1', :'PA2'));
select public._rls_verify_rows('service_role: may write the owner''s own project_members row',
  format('insert into public.project_members (project_id, profile_id, role) values (%L, %L, %L)',
         :'PA1', :'A1', 'owner'), 1::bigint);

-- Owner-row semantics survive a deactivated seat: the owner is still a legal
-- project_members row even once their org membership is disabled.
savepoint owner_row_edge_case;
update public.organization_members set status = 'disabled' where profile_id = :'A1' and organization_id = :'ORG_A';
select public._rls_verify_rows('service_role: owner row still writable after the owner''s seat is disabled',
  format('insert into public.project_members (project_id, profile_id, role) values (%L, %L, %L)',
         :'PA1', :'A1', 'owner'), 1::bigint);
select public._rls_verify_denied('service_role: a disabled member cannot be added as a collaborator',
  format('insert into public.project_members (project_id, profile_id) values (%L, %L)', :'PA2', :'A1'));
rollback to savepoint owner_row_edge_case;

reset role;
select public._rls_verify_claims(null, 'service_role');

-- ═════════════════════════════════════════════════════════════════════════
-- 10. Summary — prints the tally, lists failures, then fails the process.
-- ═════════════════════════════════════════════════════════════════════════
\o
\pset tuples_only on
\pset format unaligned

select format('RLS VERIFY: %s passed, %s failed',
              count(*) filter (where ok),
              count(*) filter (where not ok))
from public._rls_verify_results;

\pset tuples_only off
\pset format aligned

select seq, name, detail from public._rls_verify_results where not ok order by seq;

do $$
declare
  v_failed int;
  v_total  int;
begin
  select count(*) filter (where not ok), count(*) into v_failed, v_total
  from public._rls_verify_results;
  if v_total < 100 then
    raise exception 'RLS VERIFY INCOMPLETE: only % assertions ran (expected 100+)', v_total;
  end if;
  if v_failed > 0 then
    raise exception 'RLS VERIFY FAILED: % of % assertions failed', v_failed, v_total;
  end if;
end;
$$;

-- Nothing above is kept: fixtures, scaffolding and every probe write are undone.
rollback;

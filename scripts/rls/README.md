# RLS verification harness

`scripts/rls-verify.sh` proves ExpertMatch's cross-account isolation by running
the real policies against real Postgres, actor by actor. It is the evidence
behind any claim that one client cannot see another client's data.

```
RLS VERIFY: 135 passed, 0 failed
```

> **Status note (2026-09-08) — this page describes the pre-`20260908000000`
> model and is now partly stale.** Migration
> `20260908000000_identity_boundary_trial_events.sql` drops every
> `authenticated` policy on `projects`, `project_members`, `project_experts`
> and `conversation_messages` without recreating any, making those four tables
> service-role only. `verify.sql` was updated to match (it now asserts **zero
> rows and zero policies** for the project family, and carries 153 assertions,
> not 135), so wherever the tables below say a user "sees PA1 + PA2" or "can
> share PA2 inside the org", the current suite asserts a denial or 0 rows
> instead. One assertion — `B1: sees only own project` — was missed in that
> update and still expects 1 row, so a run reports 1 failure until it is
> changed to 0. The `anon`, profile, membership, organization and
> service-role-table claims below are unchanged and still accurate.

## Run it locally

```bash
scripts/rls-verify.sh
```

Requires a local PostgreSQL 16 with a superuser you can reach (`psql -U postgres`
or `sudo -u postgres psql` — both are auto-detected; override with `PSQL=...`).
The script:

1. creates a throwaway database `expertmatch_rls_<pid>`,
2. applies `scripts/rls/supabase-shim.sql` — the parts of a Supabase project the
   migrations assume (pgcrypto + uuid-ossp, the `anon` / `authenticated` /
   `service_role` roles and their grants, `auth.users`, `auth.uid()`,
   `auth.role()`),
3. applies every file in `supabase/migrations/` in filename order — **twice**,
   which proves the migrations are idempotent (they are applied by hand in the
   Supabase SQL editor, so re-running is a real scenario),
4. runs `scripts/rls/verify.sql`,
5. drops the database, including on failure (`KEEP_DB=1` keeps it).

Exit code is the verification result. Nothing else on the machine is touched.

## Run it against Supabase (staging or production)

```bash
DATABASE_URL='postgres://postgres:<pw>@db.<ref>.supabase.co:5432/postgres' scripts/rls-verify.sh
```

The shim and migrations are skipped; only `verify.sql` runs. It is safe against a
live database:

* everything happens inside **one transaction that ends in `ROLLBACK`** — the
  fixtures, the scaffolding table and functions, and every probe write are undone;
* every assertion is **scoped to fixture ids** (`…-4000-8000-0000000000a1`,
  project ids `a1a1…`, the `*.rls-verify.invalid` email domain), so it never
  reads, counts, or modifies a real row;
* it needs a direct Postgres connection, which the team does not have yet — see
  the Supabase-CLI note in `HANDOFF.md`. The service-role key is not enough.

## What is asserted (135 assertions)

Fixtures: **org A** (A1 org_admin, A2 org_member, A3 *disabled* member, A4
org_member), **org B** (B1 org_admin), **org C** (P, a platform admin holding an
ordinary user JWT), plus A5 — a profile belonging to no organization. Projects:
PA1 (owner A1), PA2 (owner A2, shared with A1 through `project_members`), PB1
(owner B1), PC1 (owner P), each with a `project_experts` row, plus
`access_requests`, `user_calendar_connections` and `organization_billing` rows.

| Group | Asserted |
| --- | --- |
| Structural | RLS enabled on all 9 tables; `access_requests`, `user_calendar_connections`, `organization_billing` have **zero** policies; `organizations` has exactly one policy and it is SELECT-only; the section-3 trigger and helper exist |
| Grants | `authenticated` and `anon` really do hold table privileges — so every "denied" below is a *policy* decision, not a missing GRANT (without this the suite would pass for the wrong reason) |
| `anon` | zero rows on all nine tables; cannot insert a project or an access request |
| A1 (org_admin) | sees only org A; sees own + active members' profiles, never org B's; sees all org-A memberships and none of B's; can add a member, cannot add one to another org, cannot enrol a platform admin, cannot move a membership to another org; sees PA1 + PA2 (as collaborator) and never PB1; cannot read/update/delete PB1 or its experts; **as a collaborator cannot update or delete PA2**; cannot re-home or hand off its own project; cannot read any billing / calendar / access-request row |
| A2 (org_member, owner of PA2) | sees only own profile, own membership, own project; can edit `first_name`; **cannot** change `email`, `is_platform_admin`, `onboarding_complete`, `billing_complete` or `stripe_customer_id` (each raises); cannot edit another profile; cannot add org members or self-promote; cannot create a project owned by someone else or in another org; can share PA2 inside the org and revoke it; **cannot share it with B1 (cross-org), with a disabled member, or with a profile in no org**; cannot repoint an existing share at an outsider |
| A3 (disabled seat) | sees no organization, no project, no expert; still sees own profile; cannot create a project; cannot re-enable own membership |
| B1 (the other account) | sees only org B and PB1; cannot see org-A profiles, memberships, project members, projects, experts, billing or calendar rows; cannot insert/update/delete anything of org A's; cannot add itself to an org-A project |
| Platform admin with a user JWT | `is_platform_admin` is true and grants **nothing**: sees only its own org, project, experts and profile; no access requests, billing or calendar rows; cannot edit another org, project or profile; cannot join another org |
| `service_role` | sees every fixture row (it bypasses RLS — this is the app's own connection), **but still cannot** share a project across organizations, share with a disabled member, or repoint a share cross-org: the `trg_project_members_same_org` trigger refuses. Owner rows stay writable, including after the owner's seat is disabled |

The suite is self-checking: it fails if fewer than 100 assertions ran, and its
negative control has been exercised — dropping `trg_project_members_same_org`
and reverting the section-3 policies turns 9 assertions red and exits non-zero.

## The statement this supports

> Cross-account isolation is enforced in the database, not only in the API
> layer. With migrations `20260831000000`, `20260901000000` and `20260902000000`
> applied, 135 assertions covering six actors (anonymous, four users across three
> organizations, and the service role) confirm that a client can reach only its
> own organization, its own projects, and projects explicitly shared with it by
> their owner *inside the same organization*; that a deactivated seat sees
> nothing; that Stripe identifiers, calendar OAuth ciphertext and access requests
> are unreachable from any browser session; that a user cannot self-grant
> platform admin, billing or onboarding status; and that even the application's
> own service-role connection cannot create a cross-organization share.
> Re-verify any time with `scripts/rls-verify.sh`.

## Route audit

Every `app/api/**` route that takes a `projectId`, `expertId` or token, and how
it is authorized. `getProjectForUser(id, email, role)` is the ownership check —
it returns the project only if the caller owns it or is a collaborator (platform
admins pass, by design). `getProject(id)` has **no** access check and is only
safe where the id comes from a signed token or a verified webhook payload.
Session auth itself is enforced by `middleware.ts`, whose matcher covers every
path except `_next/*`.

| Route | Method(s) | Authorization | Verdict |
| --- | --- | --- | --- |
| `app/api/projects/route.ts` | GET, POST | session + `listProjectsForUser` / owner-scoped create | OK |
| `app/api/projects/[projectId]/route.ts` | GET, PUT, DELETE | session + `getProjectForUser` | OK |
| `app/api/projects/[projectId]/experts/route.ts` | POST | session + `getProjectForUser` | OK |
| `app/api/projects/[projectId]/experts/[expertId]/route.ts` | PUT, DELETE | session + `getProjectForUser`; expert id validated and scoped by project | OK |
| `app/api/projects/[projectId]/experts/[expertId]/complete/route.ts` | POST | `routeAuthGuard` + `getProjectForUser` | OK |
| `app/api/projects/[projectId]/experts/[expertId]/request-availability/route.ts` | POST | `routeAuthGuard` + `getProjectForUser` + rate limit | OK |
| `app/api/projects/[projectId]/interview-guide/route.ts` | POST | `routeAuthGuard` + `getProjectForUser` | OK |
| `app/api/projects/[projectId]/vetting-questions/route.ts` | POST | `routeAuthGuard` + `getProjectForUser` | OK |
| `app/api/projects/[projectId]/request-client-availability/route.ts` | POST | `routeAuthGuard` + `getProjectForUser` + rate limit | OK |
| `app/api/projects/[projectId]/collaborators/route.ts` | POST, DELETE | session + `getProjectForUser` + owner-only check | **Finding 1** (cross-org invitee) |
| `app/api/generate-experts`, `rank-experts`, `screen-expert`, `generate-outreach`, `enrich-contact`, `parse-brief` | POST | `routeAuthGuard`; stateless compute, no project row is read or written (`parse-brief` returns fields the client persists through the ownership-checked PUT) | OK |
| `app/api/resolve-contact-paths/route.ts` | POST | origin check + session (`isAuthEnabled`, else `CONTACT_ENRICHMENT_ADMIN_TOKEN`) + rate limit; no project access | OK |
| `app/api/availability/[token]/route.ts` | POST | HMAC availability token → `projectId` **from the token**; per-token rate limit; client tokens re-checked against a stored hash (revocable) | OK |
| `app/api/availability/[token]/google-auth/route.ts` | GET | same signed token, project id from the token | OK |
| `app/api/availability/oauth/google/callback/route.ts` | GET | HMAC state + stored nonce (replay/state-swap resistant), ids from the state | OK |
| `app/api/expert-onboarding/[token]/route.ts` | GET | HMAC token (`type === 'expert'`), ids from the token | OK |
| `app/api/inbound-email/route.ts` | POST | Resend/svix signature + HMAC outreach token; project id from the token | OK |
| `app/api/email-sequence/trigger/route.ts` | POST | QStash signature (enforced whenever `NODE_ENV=production`, and fails closed if the keys are absent); project id from the signed job | OK |
| `app/api/webhooks/stripe`, `app/api/webhooks/zoom` | POST | provider signature (`constructEvent`; Zoom v0 HMAC with `timingSafeEqual`, missing secret ⇒ 400) | OK |
| `app/api/admin/**` | all | `adminGuard` (explicit `role === 'admin'`, fails closed) | OK |
| `app/api/onboarding/**`, `app/api/auth/me` | all | `routeAuthGuard` + `getSessionUser`, all writes scoped to the caller | OK |
| `app/api/auth/set-password` | POST | signed invite token, consumed from Redis | OK |
| `app/api/request-access/route.ts` | POST | **none — public by design** | **Finding 2** |
| `app/api/demo-readiness/route.ts` | GET | `adminGuard` (platform admin only; 404 otherwise) | fixed at integration (was Finding 3) |
| `app/api/test-search/route.ts` | GET | `routeAuthGuard` only | **Finding 4** |

No route in this repo loads a project with `getProject` while reachable by an
authenticated non-admin user: every such call sits behind a signed token or a
verified webhook signature. The IDOR fixes from PR #35 are intact.

### Findings not fixed here (outside this agent's file ownership)

1. **Cross-organization collaborator invite** —
   `app/api/projects/[projectId]/collaborators/route.ts:14-22`.
   `isValidCollaborator()` accepts *any* existing user account, or any address on
   an approved domain, with no check that the invitee belongs to the project's
   organization. That is a genuine cross-account data path (a collaborator reads
   `project_experts`). Owned by the account-provisioning agent. Proposed fix:
   resolve the invitee's profile and require an **active** `organization_members`
   row in the project's `organization_id`, returning 422 otherwise. As of this
   branch the database refuses the write regardless
   (`trg_project_members_same_org`), so until that route change lands a cross-org
   invite surfaces as a 500 `failed_to_add_collaborator` instead of succeeding.
2. **`/api/request-access`** — FIXED at integration: per-IP (5/h) and per-email (3/h) rate limits via Redis, keys HMAC-pseudonymised; auto-approval still requires the requester's full name and an existing approved organization.
3. **`/api/demo-readiness`** — FIXED at integration: now `adminGuard` (404 to
   non-admins), the never-compared `DEMO_READINESS_TOKEN` check and the IP log
   line are gone.
4. **`/api/test-search`** — FIXED at integration: now `adminGuard` (still 404 in
   production).

Findings 2-4 are unauthenticated-surface / cost issues rather than cross-account
data leaks; none of them can read another organization's data.

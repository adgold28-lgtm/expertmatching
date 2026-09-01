# ExpertMatch — Session Handoff

**Written:** 2026-09-01 · **Branch:** `claude/multi-account-rls-billing-imi3la`
(contains everything from `supabase-cutover` / PR #36 plus `main`) ·
**Status:** built, type-checked, RLS proven locally; **not deployed** — the
deploy checklist below is a human task.

Read this together with `CLAUDE.md` (operating rules) and `TASK_QUEUE.md`
(priorities). The previous handoff (Supabase cutover, 2026-08-31) is summarised
at the end; its decisions still stand.

---

## What this session delivered

### 1. Cross-account isolation — hardened and proven

`supabase/migrations/20260902000000_org_billing_and_rls_hardening.sql`
(section 3) closes four holes found by reading the foundation policies:

| Hole | Fix |
| --- | --- |
| A project owner could share a project with a user in **another organization** (project_members had no org check) | `project_members_insert/update` require the invitee to be an active member of the project's org **and** `trg_project_members_same_org` enforces it for the service role too (which is how the app writes) |
| `profiles.onboarding_complete` was user-writable | added to `prevent_profile_privileged_changes()` (service-role only) |
| An owner could rewrite `owner_id` / `organization_id` on their project (WITH CHECK used the pre-update snapshot) | `projects_update` WITH CHECK compares the new values directly |
| An org_admin could enrol a platform admin's profile into their org | `org_members_insert/update` refuse platform-admin profiles |

**Proof:** `scripts/rls-verify.sh` builds a throwaway PostgreSQL 16 database
with a Supabase shim (`auth.uid()`, `auth.role()`, roles, grants), applies all
three migrations twice (idempotency), and runs `scripts/rls/verify.sql`:

```
RLS VERIFY: 135 passed, 0 failed
```

Actors: anon, org A (admin, member, disabled member), org B, a platform admin
holding an ordinary JWT, and service_role. Every table is probed for select,
insert, update and delete across organization boundaries. The suite runs inside
one transaction ending in ROLLBACK and only touches fixture ids, so it is safe
against production: `DATABASE_URL=postgres://... scripts/rls-verify.sh`.
Details and the route audit table: `scripts/rls/README.md`.

App-layer checks were also tightened: collaborators must be in the project's
organization (422), `/api/demo-readiness` and `/api/test-search` are
platform-admin only, `/api/request-access` is rate limited per IP and email.

The statement this supports: **with the three migrations applied, an
authenticated user can read or write only their own profile, their own
organization's membership rows (org admins), and projects they own or were
explicitly added to by a colleague in the same organization. Nothing crosses an
organization boundary, and platform admins have no data access outside the
service-role key.**

### 2. Per-seat organization billing

- `lib/pricing.ts` — single source of truth. **Volume tiers** (every seat is
  billed at the tier the org's active-seat count falls in):

  | Active seats | Per seat / month |
  | --- | --- |
  | 1–9 | $100 |
  | 10–24 | $90 |
  | 25–49 | $85 |
  | 50–99 | $75 |
  | 100–149 | $70 |
  | 150+ | $60 |

  Expert calls: `EXPERT_SHARE = 0.70`, `PLATFORM_SHARE = 0.30`
  (`splitCallAmountCents`, used by `lib/expertPayout.ts`).
  `scripts/test-pricing.ts` — 180 checks, run with `npx tsx scripts/test-pricing.ts`.
- `lib/orgBilling.ts` — the **organization is the paying entity**. One Stripe
  customer per org, one tiered Price (`lookup_key = expertmatch_seat_monthly_v1`,
  `tiers_mode: 'volume'`), one subscription per org whose quantity equals its
  active seats. `syncOrgSeatQuantity(orgId)` runs after every membership
  insert / status change / delete (firmStore, team API, admin routes,
  set-password) and never throws. Zero seats → `cancel_at_period_end`; a
  returning seat resumes it. State: `public.organization_billing`
  (service-role only).
- Onboarding billing step is **firm-level**: the first user saves the firm's
  card (SetupIntent on the org customer, ownership-verified on confirm);
  colleagues see "Billing is set up for <Firm>" and continue. Calendar remains
  mandatory for everyone. Call charges (`lib/chargeSavedCard.ts`) go to the
  firm's card, falling back to the legacy per-user card for pre-org accounts.
- Webhook now mirrors `customer.subscription.updated/deleted` and
  `invoice.payment_failed` onto `organization_billing.subscription_status`.

Interpretation choices worth knowing: the tiers were read as *volume* (all
seats at the current tier's rate), not graduated; 100–149 seats is $70 and
150+ is $60. "Stripe Connect" for clients was implemented as the saved-card
SetupIntent flow (clients pay; Connect Express remains the expert payout side,
unchanged).

### 3. Account creation

`lib/accountProvisioning.ts#provisionAccountInvite` is now the **only** way an
account is created and requires first name, last name, email and organization
(domain, plus a name when the org is new). Every caller uses it: admin invite,
admin "Create Account" (the admin-sets-password path is gone), access-request
approval, seat-request approval, auto-approval of known domains, and the new
org-admin team invite. The invite email greets the person by name and the
set-password page shows it. Members must use their organization's email domain
unless a platform admin overrides it.

- `organizations.seat_limit` is now an **optional platform-admin cap**
  (default unlimited; existing rows backfilled). `SEAT_LIMITS` by plan is gone.
- Org admins (`organization_members.role = 'org_admin'`, first member of a new
  org) manage seats at **`/settings/team`** via `/api/org/members`
  (invite, disable/enable, promote, remove pending) — guarded by
  `orgAdminGuard`, which reads `org_id`/`org_role` from app_metadata.
  `/api/org/membership` self-heals missing claims for pre-existing accounts.
- Admin pages (`/admin/users`, `/admin/requests`) show names, seat usage,
  per-seat price and monthly total, and let admins set a cap.
- `/pricing` and the landing page now describe the per-seat model.

---

## Deploy checklist (in this order)

1. **Supabase Studio → SQL editor:** paste and run
   `supabase/migrations/20260901000000_onboarding_billing_calendar.sql`
   (not yet applied per the previous handoff), then
   `supabase/migrations/20260902000000_org_billing_and_rls_hardening.sql`.
   Both are idempotent; re-running is safe.
2. **Prove isolation on production** (read-only, rolls back):
   `DATABASE_URL='postgres://postgres:<db-password>@db.twiijjhulgpxaiavdgpo.supabase.co:5432/postgres' scripts/rls-verify.sh`
   — needs the database password (Supabase → Settings → Database).
3. **Vercel → expertmatching → Environment Variables (Production):**
   `SUPABASE_SERVICE_ROLE_KEY` (add), `NEXT_PUBLIC_SUPABASE_URL` +
   `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (verify), `SEARCH_PROVIDER=exa`,
   `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (add — billing step returns 503 without it).
4. **Stripe → Webhooks:** add `customer.subscription.updated`,
   `customer.subscription.deleted`, `invoice.payment_failed` to the existing
   endpoint (keep the four payment events).
5. **Google Cloud Console:** register
   `https://expertmatch.fit/api/onboarding/calendar/google/callback` on the
   OAuth client (alongside the availability callback).
6. Merge this branch (it supersedes PR #36), deploy, then re-seed the admin so
   its metadata carries `org_id`/`org_role`:
   `npx tsx scripts/seed-admin.ts <admin-email> --org-name ExpertMatch`.
7. Run `SMOKE_BASE_URL=https://expertmatch.fit SMOKE_ADMIN_EMAIL=<throwaway-admin> npx tsx scripts/smoke-cutover.ts`
   (it signs the admin in and out — use a throwaway admin, not your browser account).
8. In Stripe **test mode**, walk one org through onboarding and confirm: customer
   created, Price `expertmatch_seat_monthly_v1` created, subscription quantity 1;
   invite a second seat and accept it → quantity 2; disable it → quantity 1.

## Unverified (no credentials on the build machine)

- Nothing touched Stripe, Supabase, Upstash or Resend end-to-end. All Stripe
  calls were written against the SDK types (`stripe@22`, API
  `2026-04-22.dahlia`); the pure pricing maths and the RLS policies are the
  parts that were executed for real.
- The new UI (`/settings/team`, admin "Create Account", pricing page) was
  built and type-checked but not rendered in a browser.
- `quantity: 0` on a tiered subscription item was avoided deliberately
  (cancel-at-period-end instead) because the SDK types do not guarantee it.

## Gotchas (carried forward, still true)

- Never run `npm run build` while the dev server is running (both write
  `.next/`). Use `npx tsc --noEmit` while the server runs.
- Never sign in/out as your own account in a test — Supabase `signOut()`
  revokes all sessions for that user.
- The Supabase CLI is not linked; migrations are pasted into Studio. Now that
  `scripts/rls-verify.sh` wants a direct connection, getting the DB password
  into a local `.env.local` as `DATABASE_URL` is worth doing.
- `ANTRHOPICKEYREAL` is the (misspelled) Anthropic key var — referenced in
  several routes, do not rename casually.
- Deleting a user who owns projects fails on purpose (`projects.owner_id` is
  ON DELETE RESTRICT); see TASK_QUEUE for the transfer-projects follow-up.

## Reference

- Supabase project ref `twiijjhulgpxaiavdgpo`; Vercel project `expertmatching`
  (serves `expertmatch.fit`) — never the stale `expertmatch` project.
- Platform admin: `ashergoldsteinbusiness@gmail.com`, org "ExpertMatch".
- Verification commands: `scripts/rls-verify.sh`, `npx tsx scripts/test-pricing.ts`,
  `npx tsx scripts/smoke-cutover.ts`, `npx tsc --noEmit`, `npm run build`.

## Previous session (2026-08-31) in one paragraph

Finished the Supabase cutover: Postgres is the source of truth (8 tables, RLS
from day one, `projects.id` stays 24-hex text, `brief`/`data` are jsonb), Supabase
Auth is the only session mechanism (HMAC cookie, scrypt, master password
deleted), Redis narrowed to rate limits / caches / short-lived tokens, real
onboarding calendar (Google OAuth, Calendly, manual) and billing (SetupIntent),
reply-tracking pipeline strip, brief document upload, and sourcing fixes
(`SEARCH_PROVIDER=exa`, value-chain-inference `max_tokens` 4000).

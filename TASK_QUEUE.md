# ExpertMatch Task Queue
Last updated: 2026-09-01

## NOW (blocking or broken)
- [ ] **Deploy the multi-account + billing release** (branch
      claude/multi-account-rls-billing-imi3la — supersedes PR #36). Steps, in
      order, are in HANDOFF.md "Deploy checklist": apply migrations
      20260901 + 20260902 in Supabase Studio, run `scripts/rls-verify.sh`
      against production (read-only, rolls back), set Vercel env vars
      (SUPABASE_SERVICE_ROLE_KEY, NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY,
      SEARCH_PROVIDER=exa), add the three new Stripe webhook events, merge.
- [ ] Smoke the billing flow once in Stripe test mode: first-user onboarding
      creates the org customer + tiered seat Price + subscription; a second
      invite bumps the quantity; disabling a seat lowers it. Nothing here could
      be exercised without Stripe credentials — see HANDOFF.md "Unverified".
- [x] Row-level isolation across accounts — DONE 2026-09-01. Migration
      20260902 closes cross-org project sharing (policy + service-role
      trigger), locks onboarding_complete, blocks owner re-homing of projects,
      and keeps org_admins from enrolling platform admins.
      `scripts/rls-verify.sh` proves it: 135 assertions across anon, two orgs,
      a disabled seat, a platform admin with an ordinary JWT, and service_role.
- [x] Per-seat organization billing — DONE 2026-09-01. lib/pricing.ts volume
      tiers (1–9 $100 … 150+ $60 /seat/mo), one Stripe tiered Price by lookup
      key, one subscription per org, quantity synced on every membership
      change (lib/orgBilling.ts). Onboarding billing is firm-level: first user
      saves the card, colleagues skip the step. Calls charge the firm's card.
      70/30 expert/platform split centralised (splitCallAmountCents).
- [x] Account creation requires first name + last name + email + organization
      — DONE 2026-09-01. lib/accountProvisioning.ts is the only creation path
      (admin invite, admin create, access-request approval, seat-request
      approval, auto-approval, org-admin team invite). Admin-sets-password
      path removed. Org admins manage seats at /settings/team.
- [x] Supabase cutover (branch: supabase-cutover) — DONE 2026-08-31.
      Migration 20260831 applied to prod; smoke-cutover.ts 16/16.
- [x] Optimistic concurrency on project_experts writes — DONE 2026-08-31.
- [x] Onboarding: calendar (Google OAuth / Calendly / manual) and billing made
      real — 2026-09-01. Both remain mandatory before the profile step unlocks.
- [x] Auth overhaul, navigation flow, landing nav, post-login redirect,
      welcome name, user management (May 2026).

## NEXT (makes the product real)
- [ ] Sync app_metadata for pre-existing users once after deploy
      (org_id / org_role) — otherwise the first Team-page request 403s until
      /api/org/membership self-heals it. A tiny script over listAllUsers()
      calling syncUserMetadata() is enough.
- [ ] Deleting a user who owns projects fails (projects.owner_id is
      ON DELETE RESTRICT — intentional). Add a "transfer projects" step to the
      admin delete flow instead of surfacing a 500.
- [ ] Nightly seat reconcile (cron → syncOrgSeatQuantity for every org with
      billing_complete) so a Stripe outage during a membership change is
      self-correcting without waiting for the next change.
- [ ] Expert sourcing pipeline improvements
- [ ] Outreach generation with tone controls (formal → casual slider)
- [x] Reply tracking pipeline strip — DONE 2026-08-31.
- [ ] Shareable shortlist link (expertmatch.fit/brief/xyz) viewable without login

## LATER (makes the product great)
- [ ] Automated scheduling via Google Calendar / Outlook APIs (client side is
      now real; expert side still token-based)
- [ ] Zoom link auto-generation
- [x] Per-minute billing via Stripe — off-session auto-charge + seat
      subscription are live in code (2026-09-01)
- [ ] Compliance question handling
- [ ] Expert compensation tracking
- [ ] Project templates (PE firms, law firms, consulting)
- [ ] Audit trail on expert scoring — show evidence per expert
- [ ] Admin analytics dashboard
- [ ] Recent projects dropdown in nav on hover

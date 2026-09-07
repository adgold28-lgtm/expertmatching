# ExpertMatch Task Queue
Last updated: 2026-09-07

## NOW (blocking or broken)
- [x] WALKTHROUGH MODE LIVE 2026-09-07 (6938846): every project starts in walkthrough (projects.brief.walkthrough, undefined = walkthrough); nothing reaches an expert until the owner goes live (two-step confirm in the settings strip, lands on review-first). Enforced in sendSequenceEmail (resolves the project from the reply token, fails closed) + every caller; contact discovery never runs in walkthrough. scripts/test-walkthrough.ts; e2e-matchy covers both modes.
- [ ] Founder: set `OUTREACH_SIGNATURE` (e.g. `Asher`) and `OUTREACH_FROM_EMAIL=Asher Goldstein <asher@expertmatch.fit>` in Vercel if emails should go out as you (lib/senderIdentity.ts). Unset = unsigned, from ExpertMatch.
- [ ] Founder: paste migration 20260907300000_matchy_phase2_events.sql (three new event kinds; harmless until then).
- [ ] Matchy Phase 2 build in flight (scheduling + expert picker + nudges + thread UI) — see HANDOFF.md Session 5.
- [x] Missing migrations applied in prod by the founder 2026-09-07 (20260902 organization_billing + RLS, 20260906 outreach_suppressions). Verified: both tables exist, seat_limit backfilled to unlimited, org customer + SetupIntent succeed.
- [ ] Vercel env: set `QSTASH_URL=https://qstash-us-east-1.upstash.io` and `OUTREACH_FROM_EMAIL=ExpertMatch <notifications@expertmatch.fit>` (code falls back correctly, but the env should match).
- [x] Wave 1 shipped 2026-09-07 (commits 53569e0, 9401d05, 535c9e8, 1eb7aa6; e2e-matchy ALL PASSED in prod): owner-only writes + rate-decision + redacted interview guide; Stripe cancel-on-delete + payout retry on account.updated + indexed Zoom lookup; password reset + org-carrying invites + onboarding exit; home/workspace UX fixes + re-bookmark retry.
- [x] Wave 2 LIVE 2026-09-07 (30d0fd2, 641b6e7, dcc9e6f, 605dd07): retired flow removed, admin console merged, contact discovery on bookmark, /settings + weekly availability, guardrails (verify-schema, attention feed, daily reconcile cron). Migration 20260907100000 applied + verified.
- [ ] Vercel env: add `CRON_SECRET` (daily /api/jobs/reconcile refuses to run without it); confirm `HUNTER_API_KEY` + `CONTACT_ENRICHMENT_ENABLED=true` for contact discovery.
- [ ] Browser-verify wave 2 (/settings, /admin/requests, 3-tab workspace, contact discovery) with throwaway users; re-run scripts/verify-sourcing-prod.ts.
- [ ] Founder: in Stripe → Developers → Webhooks, add `account.updated` (connected accounts) to the endpoint, or late-onboarding experts are never paid.
- [ ] Audit blockers remaining after wave 1 (see HANDOFF): (1) no password reset path and admins cannot re-invite an existing user; (2) Conversations rate buttons email the CLIENT rate to the expert; (3) POST …/complete has no owner check (a collaborator can charge the owner's card); (4) interview-guide route leaks raw expert identity to non-admins; (5) bookmark with no address is a permanent dead end (no contact discovery, re-bookmark 409s); (6) writing expertRate never recomputes clientRate; (7) removing an org leaves its Stripe subscription live; (8) expert never paid if they finish Connect onboarding after the payment event; (9) /app stage pill keys off 'shortlisted' (never set) and shows the retired 5-step bar; (10) Terms placeholders live in prod.
- [x] Sourcing fixed + verified in prod (QStash regional host + raw URL) — 2026-09-06.
- [x] Resend From: address fixed (verified domain) — 2026-09-06.
- [x] Admin console: plan removed, billing state shown, requests first — 2026-09-06.
- [x] Matchy Phase 1 (relay MVP) — LIVE 2026-09-06 (parts 1–3, see HANDOFF.md
      "Matchy Phase 1"; e2e-matchy green in prod).
- [ ] Matchy Phase 2 — contact discovery job on bookmark, propose-times +
      booking from calendar overlap, card statuses (docs/MATCHY_SPEC.md).
- [ ] Legal [CONFIRM] placeholders in app/terms, app/privacy, app/contact
      (grep -rn CONFIRM app/terms app/privacy app/contact) — founder.
- [x] Per-seat billing branch merged to main + new pricing — DONE 2026-09-06
      ($250/$200/talk-to-us seats, 50% call take, 15-min minimum, client-rate
      billing; smoke 16/16; deployed e4817b1). Stripe seat Price v2 is created
      lazily on first org billing setup (test mode). Migration 20260902 was
      already applied in prod.
- [ ] FULL WEBSITE AUDIT — release gate before the first client and before the
      YC application (founder, 2026-09-06). Second pass of docs/COPY_AUDIT.md
      run AFTER Matchy Phase 1 lands (and again after Phase 2): every public
      page, every in-app screen, every email, every empty/error state. Two
      questions per string: (1) is it still true of the product as shipped?
      (2) does a first-time PE associate need it, or is it noise/confusing?
      Anything failing either question is rewritten or cut in the same pass —
      no "later". Also verify in a real browser at expertmatch.fit as a
      throwaway non-admin user, not just in code. Founder rules: no machinery
      talk, verbs not chat, honest claims only.
- [x] Terms of Service + Privacy Policy + Contact pages and footer links — DONE
      2026-09-06 (placeholders pending, see above).
- [ ] Copy audit rewrites (docs/COPY_AUDIT.md — 102 REWRITE rows). Workspace
      vocabulary (Brief→Source→Outreach→Screen→Deliver, "shortlist", Email 1/2/3)
      is replaced by Matchy Phase 1; do the marketing-page rows before then.
- [x] Merge per-seat billing branch `origin/claude/multi-account-rls-billing-imi3la`
      into main BEFORE Matchy Phase 1 (both touch billing code). Diverged
      2026-09-01 (57 files); dry-run merge conflicts in HANDOFF.md,
      TASK_QUEUE.md, collaborators route, request-access route,
      database.types.ts. Then: replace lib/pricing.ts tiers with $250 (1–5) /
      $200 (6–20) / talk-to-us (21+), create the new Stripe Price, update
      /pricing + landing copy (drop $1,500/$3,500 plans; add 15-min minimum
      call note), and set the call take to 50% (see docs/MATCHY_SPEC.md).
- [x] Supabase cutover (branch: supabase-cutover) — DONE 2026-08-31.
      Migration applied to prod Supabase; admin seeded
      (ashergoldsteinbusiness@gmail.com); scripts/smoke-cutover.ts passes 16/16
      (login, project CRUD, cross-user IDOR 404, direct-RLS zero rows, logout
      clears all sb-* cookies). Closes substance of issues #25/#30/#31.
- [x] Optimistic concurrency on project_experts writes — DONE 2026-08-31.
      updateExpertStatus/addExpertNote now guard the data-blob rewrite on the
      previously-read updated_at and retry on conflict (mutateExpert helper in
      lib/projectStore.ts); concurrent writers (inbound-email webhook vs UI
      status clicks) no longer clobber each other's fields.
- [ ] Supabase cutover — deploy: set SUPABASE_SERVICE_ROLE_KEY in the Vercel
      project **expertmatching** (Settings → Environment Variables; URL +
      publishable key may already exist — verify), merge supabase-cutover,
      then run seed once more against prod if the Vercel env differs.
      NOTE: Upstash observed hard rate-limited 2026-08-31 — now only affects
      rate-limit counters and caches (they fail open), but worth resolving.
- [x] Auth overhaul: firm-based seats, invite-only flow, remove master password
      — firmStore.ts, set-password flow, admin panel rebuilt (May 2026)
- [x] Navigation flow: middleware redirects / and /login → /app for authenticated users
- [x] Landing page nav: "Open ExpertMatch" (gold) + Welcome [Name] + Sign Out when signed in
- [x] Post-login redirect: always lands on /app (login page default)
- [x] Welcome name: firstName stored on UserRecord, included in session payload,
      NavBar uses it when present — falls back to email-derived name
- [x] Onboarding flow: /onboarding stepper (calendar → billing → profile),
      middleware gates incomplete users, session refreshed with onboardingComplete:true
      NOTE: calendar + billing steps made REAL on 2026-09-01 (branch
      supabase-cutover): per-user Google OAuth/Calendly/manual calendar
      connections (user_calendar_connections table, encrypted tokens), Stripe
      SetupIntent at onboarding + off-session auto-charge on call completion,
      stepper resumes from server state, profile step server-enforces
      calendar+billing prerequisites. Prereqs before go-live: apply migration
      20260901000000 in Supabase Studio; set NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY
      (.env.local + Vercel); register the two
      /api/onboarding/calendar/google/callback redirect URIs in Google console.
- [x] User management: Redis-backed user store, admin UI at /admin/users,
      POST/DELETE /api/admin/users, scripts/createUser.ts for CLI bootstrapping (May 2026)
      NOTE: seed-admin.ts uses bcrypt — users created with it must be migrated via createUser.ts

## NEXT (makes the product real)
- [x] Expert sourcing survives navigation — DONE 2026-09-06. Sourcing is now a
      server-side job: POST /api/projects/[id]/source-experts marks the project
      running and enqueues on QStash (falls back to an in-process detached run
      when QSTASH_TOKEN is unset); the worker POST /api/jobs/source-experts
      (QStash-signature-verified, added to middleware PUBLIC_PREFIXES) runs the
      shared lib/generateExperts.ts and persists results. The project carries
      sourcingStatus / sourcingStartedAt / sourcingError / sourcingAdjacent /
      sourcingLimitedPool in the brief jsonb (no migration); the workspace polls
      every 5s and shows a persistent "Sourcing experts…" pill next to the
      stepper, resuming after refresh. Runs stuck >15 min render as timed out.
- [ ] Expert sourcing pipeline improvements
- [ ] Outreach generation with tone controls (formal → casual slider)
- [x] Reply tracking: per-expert status
      (Outreach Sent → Replied Yes → Scheduled → Completed → Billed)
      — DONE 2026-08-31. lib/expertPipeline.ts derives the stage from
      status + replyIntent + paymentStatus (no schema change); PipelineBar
      strip on the Outreach step shows live per-stage counts + click-to-filter;
      OutreachCard shows a stage pill where it adds info (Replied Yes /
      Needs Attention / Billed). Also fixed: expert PUT/POST allowlists
      rejected 5 of 14 statuses (live 400s from OutreachCard), and the
      Outreach tab dropped mid-pipeline experts from the grid.
- [ ] Shareable shortlist link (expertmatch.fit/brief/xyz) viewable without login

## LATER (makes the product great)
- [ ] Automated scheduling via Google Calendar / Outlook APIs
- [ ] Zoom link auto-generation
- [ ] Per-minute billing via Stripe
- [ ] Compliance question handling
- [ ] Expert compensation tracking
- [ ] Project templates (PE firms, law firms, consulting)
- [ ] Audit trail on expert scoring — show evidence per expert
- [ ] Admin analytics dashboard
- [ ] Recent projects dropdown in nav on hover

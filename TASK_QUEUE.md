# ExpertMatch Task Queue
Last updated: 2026-08-31

## NOW (blocking or broken)
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
      NOTE: calendar (OAuth) and billing (Stripe) steps are stubs — see TODOs in route files
- [x] User management: Redis-backed user store, admin UI at /admin/users,
      POST/DELETE /api/admin/users, scripts/createUser.ts for CLI bootstrapping (May 2026)
      NOTE: seed-admin.ts uses bcrypt — users created with it must be migrated via createUser.ts

## NEXT (makes the product real)
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

# ExpertMatch Task Queue
Last updated: 2026-08-31

## NOW (blocking or broken)
- [ ] Supabase cutover — apply + verify (branch: supabase-cutover)
      Code is done: Postgres (organizations/profiles/organization_members/
      access_requests/projects/project_experts/project_members) is the source
      of truth; Supabase Auth is the only session; HMAC/scrypt/master-password
      deleted; Redis retained for rate limits, caches, locks, short tokens.
      REMAINING: add SUPABASE_SERVICE_ROLE_KEY + SUPABASE_DB_URL to .env.local,
      `supabase db push` the migration, run scripts/seed-admin.ts, smoke-test
      (login → create project → IDOR check → logout), set the same env vars in
      Vercel (project: expertmatching), merge.
      NOTE: Upstash was observed hard rate-limited on 2026-08-31 — old Redis
      data is untouched (nothing was wiped) but rate limiting degrades until
      the account recovers or is upgraded.
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
- [ ] Reply tracking: per-expert status 
      (Outreach Sent → Replied Yes → Scheduled → Completed → Billed)
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

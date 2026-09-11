# ExpertMatch Task Queue
Last updated: 2026-09-10

## NOW (blocking or broken)
- [x] 2026-09-10 (session 11): WAVE 5 call policies built on branch `fix/wave5` (worktree `.claude/worktrees/wave5`), five commits 8aa5b16..c6c07c2, NOT pushed. Cancel both sides with 24 h window, client late-cancel fee, expert removal, attendance-based no-show, staff attendance + payout-reversal routes, champion-only first card + transfer, Calendly flag. tsc clean, build:local green, 37 offline scripts green, route-authz 116/116, auth-flows 134/134, e2e-matchy ALL PASSED. See HANDOFF Session 11.
- [ ] **Founder: paste migration `20260910000000_call_cancelled_event.sql`** (widens the `engagement_events` type check for `call_cancelled` and `no_show`). Until then those two events are dropped with a warning; nothing else depends on it.
- [ ] **Founder: Zoom app, subscribe to `meeting.participant_joined`.** Without it every `meeting.ended` parks as `attendanceReviewPending` and bills nothing; staff resolve at `POST /api/admin/attendance`.
- [ ] Wave 5 follow-ups: "Find another time" after a cancel (propose-times refuses a cancelled engagement; needs `READY_TO_SCHEDULE` to admit `rejected_after_outreach` + `booking.cancelledAt`); a staff cancel route (`cancelCall` accepts `by: 'staff'`); persist the reversal reason somewhere auditable; a browser pass of the logged-in client cancel dialog and the Team page transfer (only the picker was driven in a browser; the routes were exercised over HTTP).
- [x] 2026-09-10: inbound expert replies proven end to end via reply.expertmatch.fit (see HANDOFF Session 10). H-26 closed.
- [ ] Founder: Google Workspace for asher@expertmatch.fit (optional). (Calendly, clawback, first-card and cancel decisions: made 2026-09-10, built in Wave 5.)
- [ ] 2026-09-09 (session 9): MATCHY 2.0 is on `main` (b4518b8) and is now the BASE of `fix/waves`. Still owed before the next push: browser pass (owner + collaborator + admin), `e2e-matchy` against a running server, copy-audit rows for the new strings. Founder: set `OUTREACH_LINKEDIN_URL`; decide `INTRO_ARM` (unset = 4-arm split). See HANDOFF Session 9a.
- [x] 2026-09-10 (session 9): ARCHITECTURE MAP + REPAIR WAVES done on branch `fix/waves` (worktree, rebased 2026-09-10 onto main b4518b8 = Matchy 2.0, pushed 2026-09-10 after rebase onto b44a02c). 17 fix/test commits. All four audit Criticals closed, 21 of 23 Highs closed, 60 of 132 findings fixed with a script behind each. tsc clean, build:local green, 33 offline scripts green, test-route-authz 116/116, test-auth-flows 134/134. See HANDOFF Session 9b and ARCHITECTURE-AUDIT "Status 2026-09-10".
- [ ] **Founder: paste migration `20260908000000_identity_boundary_trial_events.sql`** if it has not been applied. Nobody has confirmed it either way. Then `npx tsx scripts/verify-schema.ts`.
- [ ] **Founder: paste migration `20260909000000_cron_scan_indexes.sql`** (new, session 9). Three idempotent partial indexes for the hot cron scans. Nothing in the code depends on it. `scripts/verify-schema.ts` needs a one-line addition for it.
- [ ] **Founder: Stripe webhook events, test AND live mode.** Add `charge.refunded` and `charge.dispute.created` (both new; without them a refund from the dashboard leaves the call reading "paid" forever and a chargeback is invisible) and `account.updated` with the **connected accounts** option (this is what pays an expert who finished Connect onboarding after the call).
- [ ] **Founder: re-check the Google consent screen / app verification.** The expert calendar grant now asks `openid email` alongside `calendar.freebusy`. Old grants keep working, but an unverified app can show a new expert the "Google hasn't verified this app" interstitial, and an expert who backs out there is a lost call.
- [x] Calendly: hidden behind `CALENDLY_ENABLED` (Wave 5).
- [ ] **Founder: confirm `CRON_SECRET` is set in Vercel** or the nightly reconcile answers 503 and no payout retry, seat sync, stuck-sourcing cleanup or membership-claims repair runs.
- [ ] **Founder: Upstash plan.** Still rate-limited. Redis is now also load-bearing for the intro send-once lock and Stripe event de-duplication (both fail open by design, but a throttled Redis makes both weaker).
- [ ] Founder: `GOOGLE_CALENDAR_REFRESH_TOKEN` and `STRIPE_CONNECT_CLIENT_ID` can be deleted from the Vercel dashboard. Nothing reads them and they are out of `REQUIRED_VARS`, where they could previously fail a fresh boot.
- [ ] **H-26 (OPEN, highest-value unknown): capture one real Resend inbound payload.** `app/api/inbound-email/route.ts` parses a flat payload; Resend's documented `email.received` webhook nests under `data` and carries no body. This is the whole read path for expert replies. Do NOT change the parser until a real delivery has been captured (dashboard webhook log, or a temporary count-only log of top-level key names, never values).
- [ ] 2026-09-09 (session 9): MATCHY 2.0 built on branch `matchy-2`, not merged. Two-exit composer + Ask Matchy (lib/matchyIntent.ts, components/MatchyAskCard.tsx), draft route (…/messages/draft), summary-only expert messages, per-expert client rate (PUT { clientRate }, locked once agreed), rubric intro with 2 trial arms + staff-written why-them fallback, "waiting on you" line. tsc + build:local clean, 13 suites green. TODO before merge: browser pass (owner + collaborator + admin), `e2e-matchy` against a running server, copy-audit rows for the new strings. Founder: decide `INTRO_ARM` (optional). See HANDOFF Session 9.
- [ ] 2026-09-09 FOUNDER FEEDBACK logged, not yet fixed: docs/FOUNDER_FEEDBACK_2026-09-09.md — remove "Related Perspectives", drop every "includes ExpertMatch fee" string, verify sourced experts are redacted for non-admins (may be P0), bookmark = one click and nothing after, clarify staff-panel rate rows, swap Card Element for Payment Element so Link works. Interview guide stays as is.
- [ ] 2026-09-09 FOUNDER, before trial invites: paste `supabase/migrations/20260908000000_identity_boundary_trial_events.sql` in Studio; `npx tsx scripts/verify-schema.ts`; `SMOKE_BASE_URL=https://expertmatch.fit npx tsx scripts/e2e-trial.ts` must print ALL CHECKS PASSED. Until then an owner JWT can read raw expert rows and flip a project live through PostgREST (the app-layer gates still hold every send).
- [ ] Founder: Supabase Auth → Email OTP expiration → 86400 (invite links otherwise expire in 1 h). Upstash plan upgrade (still rate-limited; nothing on the trial path depends on it now).
- [x] 2026-09-09 (session 8): trial accounts (`lib/entitlements.ts`), registration hardening (`lib/emailDomains.ts`, no auto-invite, admin org off gmail.com), Supabase-native invite/reset links (`lib/authLinks.ts`), identity reveal needs a booking, collaborators read-only, brief versioning + drafts, `deriveTopic` deny list, `product_events` + `scripts/trial-report.ts`, `scripts/e2e-trial.ts`. See HANDOFF Session 8.
- [ ] Trial seats follow-ups: trial expiry / reminder (no `trial_started_at` column yet — `product_events.trial_started` is the record); admin "convert" view; `scripts/rls-verify.sh` run on a throwaway Postgres.
- [x] 2026-09-08 (session 7): Session 6 pushed + deployed. Browser pass of Sessions 5–6 DONE (see HANDOFF Session 7). Two prod bugs fixed and deployed: expert picker 500 when Upstash rejects (4dd815a, fail-open); topic clause run-on (62d1bb3, first sentence only). Prod on 62d1bb3, e2e-matchy ALL PASSED.
- [ ] Founder: Upstash is rate-limited on the current plan (`[searchCache] set failed` on every sourcing run). Check the dashboard / upgrade before design partners start. STILL OPEN, and now more load-bearing (see NOW).
- [x] Trial seats SHIPPED by the founder 2026-09-09 (main 5d8be69): `lib/entitlements.ts`, trial provisioning in /admin/requests, go-live requires a card. `scripts/e2e-trial.ts` and `scripts/trial-report.ts` came with it. The same commit closed audit C-2 (the build-breaking `firm`) and M-48.
- [ ] 2026-09-09 FOUNDER FEEDBACK logged, not yet fixed: docs/FOUNDER_FEEDBACK_2026-09-09.md — remove "Related Perspectives", drop every "includes ExpertMatch fee" string, verify sourced experts are redacted for non-admins (may be P0), bookmark = one click and nothing after, clarify staff-panel rate rows, swap Card Element for Payment Element so Link works. Interview guide stays as is.
- [ ] Founder: Supabase Auth → Email OTP expiration → 86400 (invite links otherwise expire in 1 h). Upstash plan upgrade (still rate-limited; nothing on the trial path depends on it now).
- [ ] Trial seats follow-ups: trial expiry / reminder (no `trial_started_at` column yet — `product_events.trial_started` is the record); admin "convert" view; `scripts/rls-verify.sh` run on a throwaway Postgres.
- [x] 2026-09-07 (session 6): Source pool filters are four dropdowns (tier/category/status/sort); firm economics are champion-only — seat price hidden from ordinary members in onboarding BillingStep and /settings Payment method (GET /api/settings/payment-method returns `{restricted:true}` for non-champions, no card/subscription data); org_admin is labelled "Champion" everywhere (DB value unchanged); sourcing loader rotates 9 Matchy-mascot lines, honest line first. Not yet pushed.
- [x] WALKTHROUGH MODE LIVE 2026-09-07 (6938846): every project starts in walkthrough (projects.brief.walkthrough, undefined = walkthrough); nothing reaches an expert until the owner goes live (two-step confirm in the settings strip, lands on review-first). Enforced in sendSequenceEmail (resolves the project from the reply token, fails closed) + every caller; contact discovery never runs in walkthrough. scripts/test-walkthrough.ts; e2e-matchy covers both modes.
- [ ] Founder: set `OUTREACH_SIGNATURE` (e.g. `Asher`) and `OUTREACH_FROM_EMAIL=Asher Goldstein <asher@expertmatch.fit>` in Vercel if emails should go out as you (lib/senderIdentity.ts). Unset = unsigned, from ExpertMatch.
- [x] Founder pasted migration 20260907300000_matchy_phase2_events.sql (2026-09-07). Outstanding migrations are now 20260908000000 (unconfirmed) and 20260909000000 (new) — see NOW.
- [x] MATCHY PHASE 2 LIVE 2026-09-07 (a9504a6 scheduling + /schedule/[token] picker + book/move; 6f7ee1a nudges; 93c87d1 thread UI; e8d9336 one-call guard). Prod e2e-matchy ALL PASSED. See HANDOFF.md Session 5.
- [ ] Vercel env: `CRON_SECRET` (nudge planner + reconcile refuse without it). Optional: `OUTREACH_SIGNATURE`, `OUTREACH_FROM_EMAIL`, `NUDGE_LLM_VARIATION=false`. STILL OPEN.
- [ ] Zoom S2S app: confirm meeting update/delete scopes (reschedule PATCHes the meeting).
- [x] Browser pass (throwaway users) of: new-project modal, WALKTHROUGH pill, Go-live confirm, thread scheduling cards, /schedule/[token] on mobile + desktop — DONE 2026-09-08 (session 7).
- [x] 2026-09-07 (session 6): rate band ENFORCED — bookmark seeds the opening offer inside clientRateMin/Max (lib/pricing.clampClientRateToBand); rate-decision accept above clientRateMax → 409 above_band with both numbers in the message (e2e covers it). `scheduling.proposedBefore` accumulates every offered slot so no round repeats one. Dead PipelineStage/STAGE_META removed from lib/expertPipeline.ts; stale comments + console.log cleared.
- [x] 2026-09-10 (session 9): the payout, refund, reconcile, auth, sourcing and scheduling leftovers are closed — see ARCHITECTURE-AUDIT "Status 2026-09-10" for the id-by-id list.
- [ ] Matchy Phase 2 leftovers still open: nudge zone is the owner's; cancel-booking route (product call needed: what status after a cancel — see HANDOFF Session 6); discovery bounce retry.
- [x] Missing migrations applied in prod by the founder 2026-09-07 (20260902 organization_billing + RLS, 20260906 outreach_suppressions). Verified: both tables exist, seat_limit backfilled to unlimited, org customer + SetupIntent succeed.
- [ ] Vercel env: set `QSTASH_URL=https://qstash-us-east-1.upstash.io` and `OUTREACH_FROM_EMAIL=ExpertMatch <notifications@expertmatch.fit>` (code falls back correctly, but the env should match).
- [x] Wave 1 shipped 2026-09-07 (commits 53569e0, 9401d05, 535c9e8, 1eb7aa6; e2e-matchy ALL PASSED in prod): owner-only writes + rate-decision + redacted interview guide; Stripe cancel-on-delete + payout retry on account.updated + indexed Zoom lookup; password reset + org-carrying invites + onboarding exit; home/workspace UX fixes + re-bookmark retry.
- [x] Wave 2 LIVE 2026-09-07 (30d0fd2, 641b6e7, dcc9e6f, 605dd07): retired flow removed, admin console merged, contact discovery on bookmark, /settings + weekly availability, guardrails (verify-schema, attention feed, daily reconcile cron). Migration 20260907100000 applied + verified.
- [ ] Vercel env: add `CRON_SECRET` (daily /api/jobs/reconcile refuses to run without it); confirm `HUNTER_API_KEY` + `CONTACT_ENRICHMENT_ENABLED=true` for contact discovery.
- [ ] Browser-verify wave 2 (/settings, /admin/requests, 3-tab workspace, contact discovery) with throwaway users; re-run scripts/verify-sourcing-prod.ts.
- [ ] Founder: in Stripe → Developers → Webhooks, add `account.updated` (connected accounts) to the endpoint, or late-onboarding experts are never paid. STILL OPEN, and now joined by `charge.refunded` + `charge.dispute.created` (see NOW).
- [ ] Audit blockers remaining after wave 1 (see HANDOFF): (1) no password reset path and admins cannot re-invite an existing user; (2) Conversations rate buttons email the CLIENT rate to the expert; (3) POST …/complete has no owner check (a collaborator can charge the owner's card); (4) interview-guide route leaks raw expert identity to non-admins; (5) bookmark with no address is a permanent dead end (no contact discovery, re-bookmark 409s); (6) writing expertRate never recomputes clientRate; (7) removing an org leaves its Stripe subscription live; (8) expert never paid if they finish Connect onboarding after the payment event; (9) /app stage pill keys off 'shortlisted' (never set) and shows the retired 5-step bar; (10) Terms placeholders live in prod.
- [x] Sourcing fixed + verified in prod (QStash regional host + raw URL) — 2026-09-06.
- [x] Resend From: address fixed (verified domain) — 2026-09-06.
- [x] Admin console: plan removed, billing state shown, requests first — 2026-09-06.
- [x] Matchy Phase 1 (relay MVP) — LIVE 2026-09-06 (parts 1–3, see HANDOFF.md
      "Matchy Phase 1"; e2e-matchy green in prod).
- [ ] Matchy Phase 2 — contact discovery job on bookmark, propose-times +
      booking from calendar overlap, card statuses (docs/MATCHY_SPEC.md).
- [ ] Legal [CONFIRM] placeholders in app/terms, app/privacy, app/contact
      (grep -rn CONFIRM app/terms app/privacy app/contact) — founder. STILL OPEN;
      audit L-38 notes one placeholder renders to visitors on /terms.
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

### Deferred: needs a founder decision before anyone can build it
- [ ] **Payout reversal on refund.** When a client is refunded, should the platform automatically reverse the Connect transfer to the expert, ask each time, or never? The code does nothing until this is answered and carries a `TODO(founder decision)` naming the `transfers.createReversal` call that would implement it (`app/api/webhooks/stripe/route.ts`, `handleRefundOrDispute`).
- [ ] **Who may save the firm's first card.** Today any member can, not just the champion (audit M-44).
- [ ] **Cancel a booking: what does it mean?** Engagement over (`rejected_after_outreach`, one-line email plus a CANCEL .ics to both) or an immediate re-propose? Zoom delete and ICS METHOD:CANCEL both exist; a new `call_canceled` event kind needs a migration. Recommendation on record: cancel means over, and anything else is "Move the call". (HANDOFF Session 6.)
- [ ] **Calendly: remove or fix** (see NOW; recommendation is remove).
- [ ] **Legal placeholders** in `app/terms/page.tsx` (a `[CONFIRM: legal entity name and form]` renders to visitors) and `app/privacy/page.tsx`.
- [ ] **`EMAIL_PROVIDER_ORDER` does nothing.** Either wire it into `discoverContact` or delete the knob and its env var (audit M-23).
- [ ] **`npm run security` stops at step 1** on a pre-existing `npm audit` finding in the postcss chain under `next`, so steps 2 to 6 have never run for anyone. Fixing it needs `next@16`, a breaking major.

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

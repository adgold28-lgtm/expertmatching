# ExpertMatch Task Queue
Last updated: 2026-10-18

## NOW (blocking or broken)
- [x] 2026-10-18 CLEANUP PASS (PR 2, branch `pr2-devibe`, on top of security pass 1; no behavior changes, eight commits): dead code out (`lib/contactProviders/index.ts` and the `EMAIL_PROVIDER_ORDER` knob, the never-imported `lib/supabase/client.ts`, five exports nothing called); `lib/log.ts` is the one logger (`log.info/warn/error(scope, message, fields)` prints one line, fields as JSON, scope tags unchanged) and all 80 `console.log` sites in app/, lib/ and components/ use it, with 34 unbounded `err.message` logs wrapped in `errorMessage()`; `scripts/security-scan.sh` runs all eight checks (a `((PASS++))` under `set -e` had stopped it after its first line), its npm audit step fails only on a HIGH/CRITICAL advisory not on the accepted list (the 13 Next 14 / Tailwind 3 ids deferred to the major upgrade, see below) and any `console.log` in app code is a FAIL (today 6 PASS, 2 WARN, 0 FAIL); `.github/workflows/ci.yml` runs `npm run typecheck`, `npm run test:offline` (new: the 52 offline suites, the four server-bound ones skipped by name), `build:local` and the scan on every PR and push to main, no secrets; README.md is a real map of the project; the support address lives in `lib/contactInfo.ts` (`NEXT_PUBLIC_SUPPORT_EMAIL`, same visible value, documented in .env.example and OPTIONAL_VARS); `lib/createZoomMeeting.ts` uses fetch, so axios is gone (25 lockfile entries pruned). Left alone on purpose: the existing `console.warn`/`console.error` calls that already bound their text (kept so the diff stays reviewable), the 16 `any` hits (most in lib/generateExperts.ts), the scan's `any` check matching the word inside comments, the Next 15.5 / Tailwind 4 upgrade, and the exports used only inside their own file (listed in the cleanup report; none deleted). tsc clean, build:local green, 52/52 offline suites green, security scan 0 FAIL.
- [x] 2026-10-18 SECURITY PASS 1 (branch `claude/project-thread-6nh6jc`, draft PR, independent review to follow): one HMAC helper for every hashed cache and rate-limit key (lib/keyHash.ts; the inbound-email IP is now hashed too); payout links carry their own token purpose (lib/payoutToken.ts); an inbound reply must present the engagement's own outreach token (constant-time compare) on top of the Resend signature; admin notification recipients come from `ADMIN_NOTIFICATION_EMAIL` instead of a hardcoded list; the `/api/projects/*` and `/api/requests/*` read routes check the session themselves instead of trusting middleware alone, and `canAccess` rejects an empty email; a non-admin viewer of a late-cancel fee sees only the client charge; the Hunter key stays in the Authorization header (the query-string retry is gone); a Snov poll timeout is recorded as `timeout` and never cached as `not_found`; Zoom topics no longer carry the expert's name and a cancelled booking returns no ICS; the QStash job routes refuse unsigned calls unless NODE_ENV=development with no signing key; `/_next/image` is off (`images.unoptimized`; nothing uses next/image); `npm audit fix` applied (axios ^1.20.0). tsc clean, build:local green, 48/48 offline suites green.
- [ ] **Founder: set `ADMIN_NOTIFICATION_EMAIL` in Vercel before merging security pass 1** (one address or a comma-separated list). Unset, access requests and seat-limit alerts are stored but nobody is emailed; the boot log warns.
- [ ] Security pass 1 side effects to know about: a payout onboarding link emailed before the merge stops working at the merge (the nightly sweep re-sends one, at most once a week per expert); a second access request from an address with a pending request is stored as its own row and the admin email is marked as a repeat; approving or rejecting the address covers every pending row.
- [x] 2026-10-18 Founder decision D6 taken: the 9 `npm audit` findings that remain (Next 14.2.x, Tailwind 3 / PostCSS) are ACCEPTED until the Next 15.5 LTS / Tailwind 4 upgrade, which the founder scheduled for THIS MONTH as its own PR after PR 3. The accepted ids live in `scripts/security-scan.sh` with a review-by date of 2026-11-30; a HIGH/CRITICAL advisory outside that list fails the scan.
- [ ] 2026-10-18 CI follow-up (from the PR 2 review): the four server-bound suites (test-route-authz, test-auth-flows, test-auth-request-cache, test-upstash) guard login and tenant isolation and do not run in CI. Add a second CI job that runs them against `next start` with stubbed Supabase/Upstash, or against a throwaway Supabase project with secrets scoped to that job. Until then they are manual-only (README, Testing).
- [ ] 2026-10-18 Founder decision D5 taken: support@expertmatch.fit as a forwarder. Founder: add the routing rule at the DNS host, then set `NEXT_PUBLIC_SUPPORT_EMAIL=support@expertmatch.fit` in Vercel. Engineering, once the forwarder exists: make that address the default in `lib/contactInfo.ts` so a missing variable falls back to the business address, not the personal one.
- [x] 2026-10-14 (session 14): LAUNCH PACK merged to main (branch `feat/launch-pack`): payment terms, bounce/complaint handling, project stats + Test A scoreboard (/admin/outreach), bulk bookmark + title fallback + held-intro queue (/admin/held-intros), firm do-not-contact list, vetting card, conversation export, ten-minute mismatch guarantee. See HANDOFF Session 14.
- [ ] **Founder: paste migration `20261014000000_launch_pack.sql`** (widens engagement_events types; creates organization_do_not_contact). Until then the do-not-contact page says "available shortly" and three event kinds are dropped with a warning.
- [ ] **Founder: Resend webhook** (the one posting `email.received` to /api/inbound-email) must also send `email.bounced` and `email.complained`.
- [x] 2026-10-17 founder decisions on the launch pack, BUILT: replies exclude out-of-office and "message blocked" notices (lib/autoReply.ts, intent 'auto_reply'; nudges keep running); a flagged call that runs past ten minutes is billed as usual (MISMATCH_MAX_FREE_MINUTES = 10); a listed do-not-contact company also blocks names that start with it on whole words (lead's call); keep the title-and-company why-them fallback ("fine if broad, must name them"). Payment terms in the first message: ON by default (founder, 2026-10-17; `INTRO_PAYMENT_TERMS=off` is the kill switch).
- [ ] Launch-pack follow-ups: record `whyThemSource` on `intro_sent` so Test A can compare title-fallback lines; calendar invites and screening links do not check the firm do-not-contact list yet; first intros are not written to the thread, so nudges count from the follow-up (pre-existing); add the new routes to scripts/test-route-authz.ts.
- [x] 2026-10-13: INTEGRATION BRANCH `integrate/2026-10-13`, merged to main by the founder's go-ahead: main + PR #42 (semgrep) + the six `fix/security-review-20260910` commits that never reached main (lease-based Stripe webhook retry, payout paid/entitled gate, unprocessable-event ack, holdPayout, blocked-session sign-out, review doc) + `claude/laughing-dirac-cs2b96` (screening flow) + a payout fix (idempotency before the entitlement gate) + a 2-hour billing ceiling (founder 2026-10-13: `MAX_BILLABLE_MINUTES = 120` clamps the Zoom-derived duration and bounds POST …/complete and the staff duration edit) + a re-completion guard (409 `already_billed`) + screening copy (no em dashes). tsc clean, build:local green, 45 offline suites green (test-upstash needs live Redis), route-authz 116/116, auth-flows 136/136, e2e-matchy and e2e-trial ALL PASSED against `next dev -p 3100`. Founder: Stripe endpoint must also send `checkout.session.async_payment_succeeded` (payment links now count as paid only on settlement). Merging deploys to prod.
- [x] 2026-09-15 (session 12): STRUCTURED REQUEST & SCREENING FLOW built on branch `claude/laughing-dirac-cs2b96`, five commits, one per build step (docs/SCREENING_FLOW_PLAN.md). Intake (/requests/new), objective → screening-item generation with the proof-prompt validator and a deterministic fallback, inline edit + approve, staff-minted single-use signed links, the expert's one-column form (/s/[token]), and the client review table (coverage badge, background, rate, availability, expand-row breakdown in the expert's own words, Request call, stage-5 outcomes). tsc clean, build:local green, five offline suites green (core 248, items 216, form 73, redaction 60, plus every existing suite), `scripts/e2e-screening.ts` green against `next dev` with the in-memory store. See HANDOFF Session 12.
- [x] **Founder: paste migration `20260914000000_screening_requests.sql`** (five new tables: requests, objectives, screening_tokens, screening_responses, call_outcomes; service-role only). The screening code does NOT tolerate these tables being absent — apply before deploying the branch. Then `npx tsx scripts/verify-schema.ts`. VERIFIED APPLIED 2026-10-13: all five tables (`expert_requests`, `objectives`, `screening_tokens`, `screening_responses`, `call_outcomes`) exist in production, 0 rows.
- [ ] **Founder decisions on the screening flow** (each is a one-line change now, a migration later): (1) table names — `requests` sits next to `access_requests` and `screening_tokens` next to lib/outreachToken.ts (the Matchy reply token); rename to `screening_requests` / `screening_links` if that collision bothers you; (2) who mints links — staff only today, because a client cannot hold an expert's address; (3) the client sees background lines but never the expert's name (the existing anonymity promise) — the brief asked for companies/roles/dates, which are shown; (4) the model is `claude-opus-5` through the pinned SDK 0.54.0 with `output_config.effort` passed via a typed cast; upgrading `@anthropic-ai/sdk` would remove the cast. DECIDED 2026-09-15: tables renamed to `expert_requests` / `screening_tokens`; the client-side rate is required at intake with no default; the proof-prompt validator is the enforcement (findings, outcomes, numbers, results, opinions, recommendations), two regeneration attempts, then the fixed fallback string.
- [ ] Screening follow-ups: wire "Request call" into Matchy scheduling (today it stamps `call_requested_at` and emits `call_requested`); the gap re-match and reliability queries are documented in the migration header, not built; approved sets are stored (model text kept alongside client edits) but not yet reused as templates; a browser pass of /requests/new, /requests/[id] and /s/[token] on a phone.
- [x] 2026-09-10 (session 11): WAVE 5 call policies built on branch `fix/wave5` (worktree `.claude/worktrees/wave5`), five commits 8aa5b16..c6c07c2, NOT pushed. Cancel both sides with 24 h window, client late-cancel fee, expert removal, attendance-based no-show, staff attendance + payout-reversal routes, champion-only first card + transfer, Calendly flag. tsc clean, build:local green, 37 offline scripts green, route-authz 116/116, auth-flows 134/134, e2e-matchy ALL PASSED. See HANDOFF Session 11.
- [ ] **Founder: paste migration `20260910000000_call_cancelled_event.sql`** (widens the `engagement_events` type check for `call_cancelled` and `no_show`). Until then those two events are dropped with a warning; nothing else depends on it.
- [ ] **Founder: Zoom app, subscribe to `meeting.participant_joined`.** Without it every `meeting.ended` parks as `attendanceReviewPending` and bills nothing; staff resolve at `POST /api/admin/attendance`.
- [ ] Wave 5 follow-ups: "Find another time" after a cancel (propose-times refuses a cancelled engagement; needs `READY_TO_SCHEDULE` to admit `rejected_after_outreach` + `booking.cancelledAt`); a staff cancel route (`cancelCall` accepts `by: 'staff'`); persist the reversal reason somewhere auditable; a browser pass of the logged-in client cancel dialog and the Team page transfer (only the picker was driven in a browser; the routes were exercised over HTTP).
- [x] 2026-09-10: inbound expert replies proven end to end via reply.expertmatch.fit (see HANDOFF Session 10). H-26 closed.
- [ ] Founder: Google Workspace for asher@expertmatch.fit (optional). (Calendly, clawback, first-card and cancel decisions: made 2026-09-10, built in Wave 5.)
- [ ] 2026-09-09 (session 9): MATCHY 2.0 is on `main` (b4518b8) and is now the BASE of `fix/waves`. Still owed before the next push: browser pass (owner + collaborator + admin), `e2e-matchy` against a running server, copy-audit rows for the new strings. Founder: decide `INTRO_ARM` (optional; main b44a02c cut the intro to 2 trial arms and removed `OUTREACH_LINKEDIN_URL`). See HANDOFF Session 9a. (2026-10-13: e2e-matchy ALL PASSED against the integration branch.)
- [x] 2026-09-10 (session 9): ARCHITECTURE MAP + REPAIR WAVES done on branch `fix/waves` (worktree, rebased 2026-09-10 onto main b4518b8 = Matchy 2.0, pushed 2026-09-10 after rebase onto b44a02c). 17 fix/test commits. All four audit Criticals closed, 21 of 23 Highs closed, 60 of 132 findings fixed with a script behind each. tsc clean, build:local green, 33 offline scripts green, test-route-authz 116/116, test-auth-flows 134/134. See HANDOFF Session 9b and ARCHITECTURE-AUDIT "Status 2026-09-10".
- [x] 2026-09-10 independent security/correctness review on `fix/security-review-20260909`: webhook failure retries and settlement checks, payout paid/entitlement gate, pending middleware gate, request-scoped auth reuse. 38 offline suites, Stripe flows 229/229, webhook recovery 39 checks; build and typecheck passed. No push/deploy/live actions. See `docs/SECURITY_CORRECTNESS_REVIEW_2026-09-10.md` for confirmed findings, remaining risks, measurements and integration base.
- [ ] Before releasing the review: resolve dependency advisories (9 affected packages), validate isolation/index migrations and live-service contracts in an isolated environment; configure `checkout.session.async_payment_succeeded`. Review cross-event financial ordering and the documented concurrency gaps. This review does not declare the application safe to release.
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
- [x] **`EMAIL_PROVIDER_ORDER` does nothing.** DELETED 2026-10-18 (cleanup pass, PR 2): the knob, its env var and the unused `lib/contactProviders/index.ts` waterfall are gone; the order stays hardcoded in `discoverContact` (audit M-23).
- [x] **`npm run security` stops at step 1.** FIXED 2026-10-18 (cleanup pass, PR 2): the real cause was `((PASS++))` tripping `set -e` after the first PASS line; the audit step now compares against an accepted-advisory list instead of failing on the deferred Next/Tailwind findings, so all eight checks run. The `next@16` upgrade is still its own PR.

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

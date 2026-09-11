# ExpertMatch — Session Handoff

**Written:** 2026-09-10 (session 9) · **Branch:** `fix/waves` in the worktree `.claude/worktrees/docs-architecture-map`, **rebased on `main@b4518b8` (Matchy 2.0)**, not pushed · **Status:** prod is still on `main`; the repair waves are local. All four audit Criticals closed, 21 of 23 Highs closed, `tsc` clean, `build:local` green, offline scripts green, both HTTP suites green

Read with `CLAUDE.md` (operating rules), `TASK_QUEUE.md` (priorities), `docs/MATCHY_SPEC.md` (the contract), `docs/OUTREACH_BOT_AUDIT.md` (why Matchy replaces the outreach bot).

## Session 11 (2026-09-10): Wave 5, call cancellation and no-show policies. NOT PUSHED.

**Branch `fix/wave5`** in worktree `.claude/worktrees/wave5`, cut from `main@2e98a4f`. Five commits, one lead + one per builder brief (`docs/WAVE5_BRIEFS.md`): `8aa5b16` shared types / `mutateExpert` / migration, `3b7f0ea` B1 cancel + expert removal, `751e92a` B2 late-cancel money + attendance, `e18bdfa` B3 clawback + champion, `c6c07c2` B4 Calendly flag. What each does is in `ARCHITECTURE.md` 6.6 and 6.7.

**Gate:** `npx tsc --noEmit` clean; `npm run build:local` green (59 pages); all 37 offline `scripts/test-*.ts` + `check-redaction` + `check-env-drift` green (new: `test-call-policies` 122; grown: stripe-flows 265, zoom-webhook 64, payout-state 91, auth-guards 116, availability-windows 128, expert-route-authz 143); against `next dev -p 3100`: `test-route-authz` 116/116, `test-auth-flows` 134/134, `e2e-matchy` ALL CHECKS PASSED. Browser: the public picker's cancel (late warning, confirm, "Cancelled." panel) was driven end to end on a throwaway booking; the row showed `cancelledBy: expert, lateCancel: true, expertRemovedAt` set, token hash blanked, nudges cleared, the expert's address on `outreach_suppressions`, both METHOD:CANCEL emails sent. The client cancel (`GET { window, fee }`, free 200, repeat 409 `already_cancelled`, late 409 `late_not_confirmed` with fee), the champion transfer (200, member refused 403) and the cross-org 404 were exercised over HTTP with cookie jars, not in a browser. The logged-in client dialog and Team page UI were not clicked through; the first-card gate could not be hit because the fixture org already had a card (the pure decision is unit-tested).

**One seam bug found and fixed at the gate:** `removeExpertForFault` keyed its idempotence on the terminal status, which `cancelCall` had already written before calling it, so an expert late cancel would never have suppressed or apologised. It now keys on its own `expertRemovedAt` stamp.

**Founder to do:** paste `supabase/migrations/20260910000000_call_cancelled_event.sql`; subscribe the Zoom app to `meeting.participant_joined` (otherwise every call parks for staff review and bills nothing); then push `fix/wave5` (see TASK_QUEUE). Deferred: "Find another time" after a cancel, a staff cancel route, persisting the reversal reason.

## Session 10 (2026-09-10): inbound email was never wired; now proven end to end
- Root cause: the root domain's MX records pointed at ImprovMX (Gmail forwarding), so every expert reply was forwarded to the founder's Gmail and Resend never received it. Resend's inbound webhook had zero events in four months.
- Fix, live in prod (46aeb5e, 69404ff, 92f4acb): replies go to `reply+TOKEN@reply.expertmatch.fit` (`OUTREACH_REPLY_DOMAIN`), a Resend receiving subdomain (MX `inbound-smtp.us-east-1.amazonaws.com` prio 9 on `reply`; DKIM/SPF on `send.reply`). Root MX restored to ImprovMX so `@expertmatch.fit` still forwards to Gmail. Reply-To carries the From display name so the coded address is not what an expert sees. The route now parses Resend's real `email.received` envelope (addresses under `data`, no body) and fetches text/html from `GET /emails/receiving/{email_id}` after the token and sender checks.
- Verified: test to the subdomain -> webhook delivered -> `[inbound-email] invalid outreach token: malformed` (address parsed, fake token refused). A real reply on a live thread is the next thing to watch in Vercel logs.
- Also done this session: Terms name ExpertMatch LLC (Arkansas); Google Auth Platform published, scopes registered, branding submitted, Search Console verified; Stripe refund/dispute + connected-account events added; migrations 20260908 and 20260909 applied; CRON_SECRET confirmed.
- Open: Google Workspace for a real `asher@expertmatch.fit` inbox (replace ImprovMX MX rows with Google's when set up; the `reply` subdomain is unaffected); founder decisions on Calendly, refund clawback, first-card rule, cancel-booking.

## Session 9b (2026-09-09/10): architecture map + repair waves, rebased onto Matchy 2.0. NOT PUSHED. READ THIS FIRST.

**What this session was.** Two halves. First, a comment-only annotation pass over the whole repository produced `ARCHITECTURE.md` (the technical map), `ARCHITECTURE-PLAIN.md` (the same thing for a non-engineer) and `ARCHITECTURE-AUDIT.md` (129 findings: 4 Critical, 23 High, 51 Medium, 51 Low, each with the file, what happens, why it matters and what test exists). Then `docs/REPAIR_PLAN.md` was written from the audit and executed in five waves of Opus builders, one builder per disjoint file set, builders never commit, the lead type-checks and commits by brief.

**Branch: `fix/waves` in the worktree `.claude/worktrees/docs-architecture-map`. NOT PUSHED. Originally cut from `main@5d8be69` and REBASED 2026-09-10 onto `main@b4518b8`, the founder's Matchy 2.0 commit** (two-exit composer, draft route, summary-only threads, per-expert rate, rubric intro — see Session 9a below). Every wave fix and every Matchy 2.0 behaviour survives that rebase; the conflicts and the two places where the two sides genuinely disagreed are recorded in the rebase report. `5d8be69` also closed two audit findings on its own before the waves started: C-2 (`firm` undefined in two handlers, which is why the tree did not compile) and M-48 (`test-matchy-templates` disagreeing with `deriveTopic`). Wave 0 was therefore unnecessary.

### The commits, in order

```
b821139 fix(authz): staff-only tier for money, contact, token and scheduling fields on the expert PUT route   (C-1, H-1)
f9794be fix(privacy): per-recipient booking ICS so no email address crosses the blinding boundary            (C-3)
885e049 fix(billing): Zoom webhook replay window, completion guard and NaN-safe duration                     (C-4, M-35)
dd1fc01 fix(billing): per-call billing identity for charges and the double-bill guard                        (H-8)
5e21428 fix(outreach): suppression at the send chokepoint, send-once intro, held outcomes honoured           (H-2, H-3, H-4, M-29, M-30)
c8748b2 fix(inbound): two-phase idempotency claim and sender authentication gate on the reply webhook        (H-5, M-28, L-28)
0030bc9 fix(payouts): durable transfer record, refund and dispute handling, capped reminders, bounded reconcile (H-6, H-7, H-9, H-10, H-23, M-36, M-38, M-42, M-43)
5ee8277 fix(auth): per-account login cap with Redis-down fallback, revocation made visible and repaired nightly (H-14, H-15, H-16, M-1, M-2, M-3)
1d7f36a fix(projects): merge-and-CAS brief updates, anonymous-descriptor validation, guide route hardening    (H-17, H-18, M-13, M-14, M-15)
74e9899 fix(scheduling,sourcing): usable expert calendars, full-day free/busy, idempotent sourcing, budgeted lookups (H-11, H-12, H-13, H-20, H-21, M-17, M-33, L-21)
c378379 test: HTTP-level route authorization matrix for the project family                                   (W3-1)
c83d30d test: Stripe-stubbed money flows and webhook signature fixtures                                      (W3-2)
a3f0abf docs: point the Stripe client header at handlers.ts for signature verification
60d4f3a test: invite, reset, revocation, cross-org scoping and login-cap flows over HTTP                     (W3-3)
862a35d fix(admin): user delete never reports success while the account is live; PATCH surfaces a failed claims sync (M-46, new H-24/H-25)
e71a05d chore: delete retired flows, unused packages and stale env vars                                      (M-50, M-51, L-5, L-13, L-16, L-25, L-26, L-44, L-46)
ae682b6 refactor: one HMAC token core, shared test harness, typed event tables, cron indexes, guarded ops scripts (H-22, M-9, M-10, M-11, M-23, M-49, L-42, L-49)
```

Plus the docs themselves (17 annotation commits ending at `6b3c10a`, and `699df48` for the repair plan).

### Where the audit stands

`ARCHITECTURE-AUDIT.md` now opens with a **Status 2026-09-10** table: every finding id, the commit that closed it, and the script that fails if the fix is removed. Headline: **132 findings (three were found by the waves), 60 fixed, 8 partially fixed, 1 deferred to a founder decision, 63 open.** All four Criticals are closed. Of the 23 original Highs, 21 are closed, H-7 is closed apart from the payout-reversal policy, and **H-19 is the one that did not land**: one line in `scripts/rls/verify.sql:558` still expects 1 row where a correct database now returns 0, so the RLS proof suite exits non-zero. It was queued as a Wave 2 gate item and was missed. It needs psql to verify, which this session did not have.

Three findings the waves themselves turned up, all written into the audit:
- **H-24 (fixed, 862a35d).** `DELETE /api/admin/users` answered `200 { ok: true }` while the account was still live. M-46 records this as "fails with an opaque 500"; it did not fail at all. It now answers `409 owns_projects` with the blocking project names, and any other refusal is a 500, never a success.
- **H-25 (fixed, 862a35d).** `PATCH /api/admin/users` threw away the claims-sync result, so the platform console could report a silent revocation failure as success. It now mirrors `org/members` exactly.
- **H-26 (OPEN, and the most important open item in the repository).** `app/api/inbound-email/route.ts` parses a flat payload; Resend's documented `email.received` webhook nests everything under `data` and explicitly carries no body. Either inbound arrives through some other event, or this route has never parsed a live payload. This is the whole read path for expert replies. **Do not change the parser until a real production delivery has been captured.**

### How it was verified

Gate run at the end of Wave 4, from the worktree, against a local dev server on port 3100:

- `npx tsc --noEmit 2>&1 | grep -v '^\.next/'` -> no output.
- **33 offline scripts, all green**, 0 failures: pricing 251, nudges 219, stripe-flows 208, scheduling 171, check-redaction 142, expert-route-authz 119, availability-windows 109, matchy-templates 105, matchy-classify 86, auth-guards 84, matchy-screen 82, email-clean 81, contact-discovery 81, freebusy-inversion 80, hmac-tokens 80, payout-state 75, matchy-client 69, inbound-claim 65, walkthrough 64, webhook-signature 49, conversations-redaction 48, brevity 42, signup-token 41, zoom-webhook 39, booking-ics 38, email-domains 38, org-billing 38, project-update 38, billing-guard 35, send-chokepoint 35, entitlements 30, sourcing-idempotency 27, check-env-drift 9.
- `npm run build:local` -> compiled, 57 static pages, no errors.
- `SMOKE_BASE_URL=http://localhost:3100 npx tsx scripts/test-route-authz.ts` -> **PASS 116/116**, cleanup complete.
- `SMOKE_BASE_URL=http://localhost:3100 npx tsx scripts/test-auth-flows.ts` -> **PASS 134/134**, cleanup complete.
- Local `scripts/e2e-matchy.ts` -> **ALL CHECKS PASSED** after dd623ee updated the fixtures (five stale assertions, no regression):
  - Two are **stale assertions caused by deliberate API changes in Wave 2**. `POST .../messages` now answers `200 { ok, held, message }` rather than 201 when the chokepoint holds the send, and `held` is now the reason string (`'walkthrough'`, `'trial'`, `'disabled'`, `'suppressed'`) rather than a boolean. The e2e still asserts 201 and `held === true`. Fix the script, not the routes.
  - Three are the **go-live PATCH answering 403**, because the throwaway org the e2e creates has no card and `entitlements.canGoLive` requires one. That gate came in with `5d8be69` (trial accounts), not with the waves. The e2e needs to set `organization_billing.billing_complete` for its throwaway org, the way `e2e-trial.ts` does.
- Not run: `scripts/rls-verify.sh` (no psql, and H-19 would fail it anyway), prod `e2e-matchy` (nothing is pushed), `npm run security` (it stops at step 1 on a pre-existing `npm audit` finding in the postcss chain under `next`, so steps 2 to 6 have not actually run for anyone; fixing it needs `next@16`, a breaking major).

### What the founder has to do

Nothing below is optional if the money paths are meant to work.

1. **Paste `20260908000000_identity_boundary_trial_events.sql` into Supabase Studio if it has not been applied.** Nobody has confirmed it either way and its own header says so. Then `npx tsx scripts/verify-schema.ts`.
2. **Paste `20260909000000_cron_scan_indexes.sql`** (new this session): three idempotent partial indexes for the hot cron scans. Nothing in the code depends on it; it is a speed fix as the tables grow. `scripts/verify-schema.ts` does not know about it yet, which is a one-line addition.
3. **Stripe webhook events**, on the ExpertMatch endpoint, in **both test and live mode**: add `charge.refunded` and `charge.dispute.created` (both new and now load-bearing: without them a refund from the dashboard leaves the call reading "paid" forever and a chargeback is invisible), and `account.updated` with the **connected accounts** option, not the platform-only default (this is what pays an expert who finished Connect onboarding after their call). The last one has been open in `TASK_QUEUE.md` since Wave 2 of the September 7 run.
4. **Re-check the Google consent screen / app verification.** The expert-side calendar grant now asks for `openid email` alongside `calendar.freebusy`, because without the address the connection was silently ignored. Experts who granted the old scope keep working and no re-consent campaign is needed, but an unverified external app can show a new expert the "Google hasn't verified this app" interstitial, and an expert who backs out there is a lost call.
5. **Calendly: remove or fix.** Probed by hand 2026-09-09 against a real public scheduling page: `api.calendly.com` answers 401 to every unauthenticated call, including `event_types`, and there is no Calendly credential anywhere in the codebase. Every Calendly link therefore yields no slots and is indistinguishable from no connection. `lib/fetchCalendlySlots.probeCalendlyLink()` is written and unwired for a connect-time refusal. **Recommendation: remove.** Fixing it means a Calendly OAuth app plus per-user token storage plus refresh, which is the same work as the Google connection that already exists and already works.
6. **Confirm `CRON_SECRET` is set in Vercel**, or the nightly reconcile answers 503 and none of the payout, seat-sync, stuck-sourcing or membership-claims self-healing runs.
7. **Upstash plan.** Still rate-limited (`[searchCache] set failed` on every sourcing run), so the platform re-pays the search provider for work it already did. Redis is now also load-bearing for the intro send-once lock and Stripe event de-duplication; both fail open by design, but a rate-limited Redis makes both weaker.
8. `GOOGLE_CALENDAR_REFRESH_TOKEN` and `STRIPE_CONNECT_CLIENT_ID` can be **deleted from the Vercel dashboard**. Nothing reads them and they are no longer in `REQUIRED_VARS`, where they could previously fail a fresh production boot for values nothing used.

Deferred, needing a decision rather than a click: payout reversal on refund (the code does nothing until you answer, and says so in place), whether ordinary members may save the firm's first card, and what "cancel a booking" means for the engagement's status.

### Verified before each push (updated list)

`npx tsc --noEmit`, then clean-export `npm run build:local`, then every script below. The first block is offline and takes about a minute; the second needs a dev server.

```
# offline
npx tsx scripts/check-redaction.ts          npx tsx scripts/check-env-drift.ts
npx tsx scripts/test-pricing.ts             npx tsx scripts/test-nudges.ts
npx tsx scripts/test-stripe-flows.ts        npx tsx scripts/test-webhook-signature.ts
npx tsx scripts/test-billing-guard.ts       npx tsx scripts/test-zoom-webhook.ts
npx tsx scripts/test-payout-state.ts        npx tsx scripts/test-org-billing.ts
npx tsx scripts/test-expert-route-authz.ts  npx tsx scripts/test-auth-guards.ts
npx tsx scripts/test-send-chokepoint.ts     npx tsx scripts/test-walkthrough.ts
npx tsx scripts/test-inbound-claim.ts       npx tsx scripts/verify-svix.ts
npx tsx scripts/test-project-update.ts      npx tsx scripts/test-booking-ics.ts
npx tsx scripts/test-hmac-tokens.ts         npx tsx scripts/test-signup-token.ts
npx tsx scripts/test-sourcing-idempotency.ts npx tsx scripts/test-contact-discovery.ts
npx tsx scripts/test-freebusy-inversion.ts  npx tsx scripts/test-scheduling.ts
npx tsx scripts/test-availability-windows.ts npx tsx scripts/test-matchy-templates.ts
npx tsx scripts/test-matchy-classify.ts     npx tsx scripts/test-matchy-screen.ts
npx tsx scripts/test-matchy-client.ts       npx tsx scripts/test-conversations-redaction.ts
npx tsx scripts/test-email-clean.ts         npx tsx scripts/test-email-domains.ts
npx tsx scripts/test-entitlements.ts        npx tsx scripts/test-brevity.ts

# needs a local server (throwaway accounts only, safe while you are signed in)
DISABLE_EMAILS=true PORT=3100 npx next dev -p 3100 &
SMOKE_BASE_URL=http://localhost:3100 npx tsx scripts/test-route-authz.ts
SMOKE_BASE_URL=http://localhost:3100 npx tsx scripts/test-auth-flows.ts
SMOKE_BASE_URL=http://localhost:3100 npx tsx scripts/e2e-matchy.ts
pkill -f "next dev -p 3100"
```

Every script imports `scripts/testHarness.ts` now, so they all exit 0 clean and 1 on any failure. `scripts/wipe-projects.ts`, `scripts/seed-admin.ts` and `scripts/smoke-cutover.ts` print the host they resolved and refuse a non-local one unless `ALLOW_PROD=1`; `smoke-cutover` still signs the founder out of every session when it does run.

### Read next

`ARCHITECTURE-AUDIT.md` Status 2026-09-10 (what is closed and what is not), `ARCHITECTURE.md` sections 5 to 9 (the system as it now is), `ARCHITECTURE-PLAIN.md` section 12 (the founder decisions in plain English), and `docs/REPAIR_PLAN.md`'s Execution record at the end (per brief: what was done and what deviated).

## Session 9a (2026-09-09, evening) — Matchy 2.0, now the base of `fix/waves`
The founder reviewed an interactive design draft (published artifact "Matchy 2.0") and asked for it in the app. Everything below is on branch `matchy-2`, verified locally: `tsc` clean, `npm run build:local` clean, 13 unit suites green (see "Verified" below). Not yet browser-tested and `e2e-matchy` not yet re-run against a running server; do both before merging to `main` (= production).

**What shipped (spec: `docs/MATCHY_SPEC.md` Draft 3; intro contract: `docs/OUTREACH_EMAIL_RUBRIC.md`):**
- **One composer, two exits** (`components/ConversationThread.tsx`, `components/MatchyAskCard.tsx`, `lib/matchyIntent.ts`). "Send to {first}" is the relay, unchanged. "Ask Matchy" routes the text through a pure regex router over the redacted record already in the browser and renders ONE card above the buttons: a factual line (status, money in client dollars, nudges, booking), Matchy's stored summary of a reply ("what did he say about NDAs?"), a proposal for an existing verb ending in that verb's button (set a rate, propose times with a read-back of what the picker understood, move the call, send the intro, pass with the shared reason list), a cross-project roll-up ("who hasn't replied?", "what's waiting on me?", "who's booked?") with Open buttons, or a draft. Anything the screen would stop is stopped before routing (phone, address, link, off-platform phrase → the screen's own findings). Unclear → "Nothing for me in that." Out of scope → "Not mine." Relay-shaped prose under Ask → "Not sent. That reads as a note for {first}." No keyboard shortcut on either exit. Collaborators get Ask only, no verb buttons. Nothing typed to Matchy is stored. `scripts/test-matchy-ask.ts` (88) is the routing table.
- **The draft route** `POST /api/projects/[id]/experts/[expertId]/messages/draft { instruction }` (`lib/matchyDraft.ts`, `lib/matchyScreenContext.ts`, `lib/rateLimiter.checkDraftLimits`): instruction screened client→expert BEFORE the model (422 message_blocked, no call); one gpt-4o-mini call over the anonymized descriptor + the last 6 messages exactly as the client may read them (role forced to `user`), fenced as data; output through enforceBrevity(3 sentences / 320 chars) → screen → refusal on `[removed]`, em dash, `$`, markdown, the expert's surname/company pre-reveal, or any bare number equal to a client-side figure. Refuse, never repair → `{ error: 'no_draft' }`. 10/user/min, 200/project/day, fails open on a store outage. Works in walkthrough. `scripts/test-matchy-draft.ts` (66).
- **Summary only** (`lib/conversations.redactMessageForViewer`): a non-admin viewer gets an EMPTY body for every expert message, before and after the reveal; they read Matchy's masked summary. Matchy's own outbound copy now also gets the pre-reveal name/employer masks (the rubric intro names the employer). Staff unchanged. `scripts/test-conversations-redaction.ts` (53).
- **The per-expert rate** (`PUT …/experts/[expertId] { clientRate }`, owner-only): $50 grid (`lib/pricing.isValidClientRateUsd`), inside the project band (409 `outside_band`), refused once agreed (409 `rate_locked`: `rateAgreedAt` set by rate-decision accept and by an inbound yes at `followup_sent`, or status scheduling_sent/scheduled/completed). Both rate fields written from one conversion (`expertRateFor` → `rateFieldsFor`). Thread header shows "Your rate for {first} $X/hr · Change" until agreed, then "Agreed". Typing "offer him 1650" under Ask → the set-rate card → the same PUT; the Offer button then carries the new figure. A client's `status: 'rejected'` on a contacted expert now lands on `rejected_after_outreach` server-side.
- **The rubric intro** (`lib/matchyTemplates.buildIntroEmail`, `lib/introPersonalization.ts`, `lib/outreachSteps.ts`, approve route, `lib/senderIdentity.ts`): subject `Expert in {domain}: compensated ${X}/hr for your time?` (arm 1) or `… a paid call for my client?` (arm 2); "Dear {First}," + the why-them line + the offer sentence with the EXPERT-side rate, 15 to 60 minutes, the scope clause, the question; signed "Asher" over a signature block (name, From address). Zero em dashes, banned phrases, <90 words enforced in code (`IntroRubricError`). The why-them line is a real fact: deterministic from high-confidence role/company evidence claims, else ONE gpt-4o-mini call validated the same way (no invented digits, must carry the company or a distinctive claim word), else the intro is HELD at `outreach_drafted` with `introNeedsWhyThem` even in auto-send mode and a PLATFORM ADMIN writes the line in the thread ("Add the line and send" → approve with `{ whyThem }`; an owner cannot, they do not know the expert's identity). Arms: `introArmFor(expertId)` deterministic 1–2, `INTRO_ARM` pins (arms 3/4, the flat framing, and the LinkedIn line were dropped by the founder 2026-09-10); `introArm` rides on the `intro_sent` event payload. `whyThem` / `introDomain` / `introArm` are staff-only on the wire (redactExpert + check-redaction). `scripts/test-matchy-templates.ts` (290), `scripts/test-intro-personalization.ts` (88).
- **"Waiting on you"** line under the settings strip (`ConversationsPanel`): open counters, intros to send, scheduling rounds that came back empty, with Open buttons. Shown only when > 0.
- Nudge minute: already 8:00–8:59 (jitter); no change. The design page's "8am" copy was wrong; the remaining gap is the zone (owner's, not the expert's).

**Founder actions:** decide `INTRO_ARM` (unset = 50/50 split of the two subject lines); paste nothing (no migration: every new field rides in `project_experts.data`).

**Before merge:** browser pass with a throwaway owner + collaborator (two exits, each scenario chip from the design page, the rate row, the staff line on a held intro as admin); `SMOKE_BASE_URL=http://localhost:3000 npx tsx scripts/e2e-matchy.ts`; then the copy audit rows for the new strings.

**Open (product):** a courtesy line on pass (today a pass sends nothing); a rate field on the bookmark button for auto-send projects (the intro now names the price); tuning the router without storing text (log intent+exit only, or a staff-only 30-day table); slice 3 model fallback for thread questions the keyword match misses.

## Session 8 (2026-09-09) — trial accounts + the safety boundary for testers. READ THIS FIRST.
Commit 5d8be69 (+ docs). Built for the founder's clarified goal: hand TRIAL ACCOUNTS to testers who behave like prospective customers, with a hard server-side guarantee that nothing reaches a real expert, books a call or charges a card.

**Founder actions before trials (in order):**
1. Paste `supabase/migrations/20260908000000_identity_boundary_trial_events.sql` into Studio. It makes projects / project_members / project_experts / conversation_messages SERVICE-ROLE ONLY (the old policies let an owner read raw expert identity and flip a project live through PostgREST — `scripts/e2e-trial.ts` demonstrates both and fails 3 checks until this is applied) and creates `product_events` (the trial funnel). Then `npx tsx scripts/verify-schema.ts` and re-run `SMOKE_BASE_URL=https://expertmatch.fit npx tsx scripts/e2e-trial.ts` → ALL CHECKS PASSED.
2. Supabase → Auth → "Email OTP expiration": set to 86400 if invitations should last 24 h (default 3600 = 1 h). Set-password links now carry a Supabase recovery token (`th=`) for single use; Redis is out of the invite/reset path.
3. Upstash is still rate-limited (`scripts/test-upstash.ts` 0/3). Nothing on the trial path depends on it any more (rate limits fail open, caches fail open, tokens moved), but sourcing re-pays the search provider on every run. Upgrade the plan.
4. Push `main` (deploys). The code is safe to deploy before the migration (it never used the dropped policies; it tolerates the missing table).

**What changed (all verified locally, `scripts/e2e-trial.ts` 76/76 with the migration applied, 73/76 without):**
- Registration: `lib/emailDomains.ts` — a public email domain is never an organization; `isApprovedDomain` refuses them; the public request-access form no longer auto-invites anyone (every request is reviewed). The admin org was renamed from `gmail.com` to `expertmatch.fit` (`scripts/fix-admin-org-domain.ts --apply`, run 2026-09-09).
- Trial model: `lib/entitlements.ts`. Trial = `organization_billing.subscription_status='trialing'` + `billing_complete=false` (no migration). ONE RULE: a card on file opens go-live / outreach / scheduling / charging; everything else is open. Enforced at `PUT /api/projects/[id] {walkthrough:false}` (403 `activation_required`) and re-checked at every chokepoint: `sendSequenceEmail`, `sendBookingEmail`, `bookCall`/`rebookCall`, `createAndSendInvoice`, `/complete`, contact-discovery worker, nudge worker. Refusals are recorded as `restricted_action_attempted`. Provision from /admin/requests ("Provision Trial Tester" form, or "Approve as Trial" on a request; personal-domain requesters get a generated `trial-xxxx.expertmatch.fit` org). BillingStep skips the card for trials; Settings → "Add a card to activate" converts (`POST /api/onboarding/billing {activate:true}` is the champion-only conversion path).
- Invite/reset links: `lib/authLinks.ts` — our HMAC token + Supabase `generateLink` recovery hash; `verifyOtp` burns it. `/api/auth/set-password?token=&th=`. Legacy links without `th` are refused.
- Expert anonymity as a boundary: `isIdentityRevealed(pe)` needs a server-written `booking` (or legacy `zoomMeetingId`) — a status alone never reveals. Clients may only PUT status discovered/shortlisted/rejected; added candidates may only start discovered/shortlisted. Redactor strips `availabilityRaw`, `calendarEmail`, `calendlyUrl`. Message bodies and summaries mask the employer pre-reveal (`maskCompany`).
- Client anonymity: `deriveTopic` takes deny terms (firm name from every caller, owner domain label, targetCompanies, companiesToAvoid, peopleToAvoid, proper nouns in the project title), applies the company filter to the industry/function path, drops sentence-initial names unless the word is an ordinary brief word (`BRIEF_OPENERS`), and trims dangling connectors. 14 new regression cases in `test-matchy-templates` (105/105).
- Collaborators are read-only everywhere: brief PUT 403 `read_only`, experts POST 403, delete 403, UI hides Save/Find/Delete/Undo, textareas read-only.
- Reliability: brief drafts live on the page (survive tab switches), `beforeunload` guard, "Unsaved changes", field-level PUT with `briefVersion` → 409 `brief_conflict` + "Load the latest version"; empty string clears a field; expert card surfaces failed saves and rolls back; home page shows a list error with retry instead of an empty state.
- Usage: `lib/productEvents.ts` + `product_events` table + `scripts/trial-report.ts <email> | --org <domain> | --all`.
- Browser pass (throwaway trial tester, deleted after): login → home with TRIAL banner → workspace → brief edit survives tab switch → Find experts (real run, 13 + 2 adjacent, anonymized) → bookmark ("Nothing was sent") → pass → Conversations strip shows "Activate to go live" + trial copy → Settings "Add a card to activate" → /auth/reset generic confirmation → mobile viewport. No console errors beyond one transient 401 on a thread poll during cookie refresh (retried 200).

**Not done / known:** `scripts/rls-verify.sh` could not be executed (no local Postgres/Docker) — `scripts/rls/verify.sql` was updated by hand for the new policies; run it against a throwaway DB when one is available. `product_events` is unreadable until the migration is pasted. Upstash plan.

## Session 7 (2026-09-08) — Session 6 pushed; browser pass done; two prod bugs fixed. READ THIS FIRST.
- **Pushed and deployed** Session 6 (ca8100e, 26725bc), then 4dd815a and 62d1bb3 below. Prod is on 62d1bb3; `e2e-matchy` ALL PASSED against prod on the final sha.
- **Browser pass DONE** (throwaway champion + member, deleted after). Verified live: login → onboarding (weekly hours: day chips carry `aria-pressed`, Continue stays disabled until Save availability; billing step reads COMPLETED when `organization_billing.billing_complete` is true — no card asked) → /app → new-project modal (Walkthrough preselected at the DOM level) → WALKTHROUGH header pill → settings strip (Mode row, Review-before-sending, rate band copy) → Go-live two-step confirm (Cancel leaves it in walkthrough; Confirm clears the pill, flips review-first ON; Back to walkthrough needs no confirm) → brief → real sourcing (13 candidates, ~3 min, redacted "Stephen D." / no company) → Session 6 dropdowns (Tier with counts / Category / Status / Sort, native selects) → bookmark → thread with the walkthrough-held Matchy line → proposed-times card + "Propose different times" → `/schedule/[token]` desktop + mobile, incl. "None of these work" (8 weekday fallback slots, 800-char box, Connect Google) → token revocation (old link 410 `expired` once a new one is minted; garbage → 400 `malformed`). Champion gating confirmed via API: member gets `{restricted:true}` from `GET /api/settings/payment-method`. NOT exercised: the booked card / Move the call (needs a real Zoom meeting; e2e covers `bookCall`).
- **BUG 1, fixed (4dd815a): the expert's picker 500'd whenever Upstash rejected a call.** `withinRateLimit` in `app/api/schedule/[token]/route.ts` and `checkTokenRateLimit` in `app/api/availability/[token]/google-auth/route.ts` guarded only the store's construction; a live `increment()` rejection was unhandled. Every other caller already fails open. Reproduced in prod: the Upstash DB was rate-limited at the time (also visible in sourcing logs as `[searchCache] set failed`). Both now fail open; `moreWindowsFor` degrades to `[]` on error so a calendar lookup failure never hides the proposed times. **Lesson:** guard the call, not just the constructor; anything on the expert-facing path must fail open.
- **BUG 2, fixed (62d1bb3): the topic clause fused two sentences.** `deriveTopic` fed the whole research question through; a capitalised word dropped as a company name took its full stop with it, so the picker page and outreach mail read "…logistics in the US We need to understand…". Now takes the first sentence only (abbreviation guard for "U.S.", "Inc."). `test-matchy-templates` 91/91 (3 new).
- **Upstash is rate-limited on the current plan.** Sourcing still completes (cache writes are already fail-open) but `[searchCache] set failed` is in every run. Founder: check the Upstash dashboard / plan before design partners start — a rate-limited cache means every search re-pays the search provider.
- **Cosmetic, not fixed:** `deriveTopic` drops "Southeast" as a proper noun ("…in the US" instead of "…in the US Southeast"). `looksLikeCompanyName` is over-eager on geography. Harmless but loses specificity.
- Verified before each push: `tsc` clean, clean-export `build:local` clean, `test-pricing`, `test-walkthrough`, `test-scheduling`, `test-org-billing`, `test-nudges`, `test-matchy-classify`, `test-matchy-screen`, `test-brevity`, `check-redaction`, `test-matchy-templates`.
- **Next: trial seats** (decided with the founder 2026-09-08): org-level, admin-provisioned from `/admin/requests`, full expert pool, no card. Paywall sits at Go-live — a trial firm does everything in walkthrough; flipping a project live requires a card on `organization_billing`. Convert = champion adds a card from /settings (same `POST /api/onboarding/billing`). One `lib/entitlements.ts` (`canCreateProject` / `canGoLive` / `canBookCall`) replaces the scattered `billing_complete` reads. The onboarding billing step already renders COMPLETED from `organization_billing.billing_complete` with no Stripe customer (verified this session), so the seam exists.

## Session 6 (2026-09-07, afternoon) — small UX pass, NOT pushed
- **Source pool controls** (`app/projects/[projectId]/page.tsx` `SourceListControls`): Tier / Category / Status / Sort are native `<select>`s (`FilterSelect`), tier counts inside the option labels, the "Sorted by" line removed. FilterChip/FilterGroup deleted.
- **Champion = org_admin.** The founder wants firm economics (seat price, card, subscription state) visible only to one person per firm, distinct from the platform admin. That is the existing `org_role = 'org_admin'`, now labelled **Champion** in the Team page, admin console, pricing FAQ and settings copy (DB value and API field names unchanged). Gating added: `GET /api/settings/payment-method` returns `{ restricted: true, canReplace: false, orgName }` for non-champions (PaymentPanel renders a one-line "handled by your firm's champion" state); `POST /api/onboarding/billing` sends `seatUnitPriceCents: 0` to non-champions so BillingStep never renders the per-seat line. Team page was already champion-only.
- **Sourcing loader**: `SOURCING_MESSAGES` is nine lines, the honest one first, the rest Matchy-as-mascot and shuffled per visit, 5 s rotation.
- **Rate band enforced** (Phase 2 leftover #1). `lib/pricing.ts` gained `clampClientRateToBand` and `clientRateCeilingExceeded` (pure, tested in `test-pricing`). Bookmark seeds the opening offer INSIDE the band: tier client rate → clamped → `expertRateFor` → `clientRateFor` (so the stored pair still comes from one conversion). Rate-decision `accept` whose converted client rate is above `clientRateMax` answers 409 `above_band` with a message naming both numbers; the thread already renders server messages on the error line. Only the ceiling can refuse — a rate below the floor is cheaper than the client offered. `MatchySettingsStrip` copy says the band is enforced; the TODO is gone. `e2e-matchy` covers the 409 (local run ALL PASSED).
- **No repeated slots.** `SchedulingState.proposedBefore?: string[]` (optional; old rows lack it) accumulates every slot start ever sent; `proposeTimes` excludes it plus the current round and booking history, and only grows it when the send was not held.
- **Cleanup.** `pipelineStage` / `PipelineStage` / `PIPELINE_STAGES` / `STAGE_META` removed from `lib/expertPipeline.ts` (nothing imported them); stale comments in `lib/nameValidation.ts` and `lib/redactExpert.ts`; the two `console.log`s in `lib/sendAvailabilityRequest.ts`. `.env.example` already had `HUNTER_API_KEY`.
- **Cancel-booking route NOT built — needs a product call.** Zoom delete and ICS METHOD:CANCEL exist. Open question: after the client cancels, is the engagement over (status `rejected_after_outreach`, both parties get a one-line email + CANCEL ics) or does Matchy immediately re-propose (a reschedule, which already exists as "Move the call")? A new `call_canceled` event kind also needs a migration the founder pastes. Recommendation: cancel = engagement over; anything else is "Move the call".
- Verified: `tsc` clean, `npm run build:local` clean, `test-org-billing` 23/23, `test-pricing` 251/251, `test-scheduling` 171, `check-redaction`, `test-matchy-client` 69/69, `test-walkthrough` 43/43, local `e2e-matchy` ALL PASSED (twice — before and after the band work), `scripts/verify-schema.ts` PASS against prod (23 present, 0 missing). Not browser-verified (needs a throwaway member + champion — same pattern as the Session 5 browser pass). Committed locally on `main`, not pushed.

## Session 5 (2026-09-07, daytime) — walkthrough mode + Matchy Phase 2. READ THIS FIRST.

The founder asked for two things, in order: (1) a hard stop so no real expert is ever emailed by accident, and (2) Matchy Phase 2 — both calendars, an expert-side "pick a time" page, emails back when a time does or does not work, a way to move the call, and 8am follow-up nudges (random 0–60 min, max 4 business days, one line, never the same) with a hard cap on LLM-written text (1–2 sentences).

### Walkthrough mode (commit 6938846, LIVE, e2e verified in prod)
- `projects.brief.walkthrough` (unpromoted jsonb key, NO migration). `undefined` = walkthrough; only explicit `false` = live. Every existing project became walkthrough on deploy. `lib/walkthrough.ts` → `isWalkthrough(project)`.
- Enforced at the chokepoint: `lib/emailSequence.sendSequenceEmail` resolves the project from the reply token (fails closed on an unverifiable token), returns `{ sent: true } | { sent: false, held: 'walkthrough' | 'disabled' }`. Every caller reads it. Booking emails (with .ics) go through `sendBookingEmail` in `lib/sendAvailabilityRequest.ts`, which re-implements the same gate for the expert copy.
- In walkthrough: bookmark never starts contact discovery (`walkthrough_held` outcome when there is no address; drafts the intro when there is); rate-decision / client reply / propose-times write the line to the thread with `held: 'walkthrough'` (not pending, never sendable); send / approve routes answer 409 `walkthrough_mode`. Money fields still move so a practice run leaves the real state.
- UI: new-project modal offers Walkthrough (default) / Live; workspace header pill WALKTHROUGH; settings strip "Mode" row with a two-step Go live confirm (lands on `reviewFirst: true` unless the same PATCH says otherwise); held messages tagged in the thread.
- Tests: `scripts/test-walkthrough.ts` (43); e2e-matchy runs the whole flow on a live project AND a walkthrough project.

### Sender identity (commit 2e3b496)
`lib/senderIdentity.ts`: `OUTREACH_SIGNATURE` signs every Matchy body; with `OUTREACH_FROM_EMAIL` (must be on expertmatch.fit, lib/mailFrom.ts) the founder can send as themselves with two env vars. Recommended: `OUTREACH_FROM_EMAIL="Asher Goldstein <asher@expertmatch.fit>"`, `OUTREACH_SIGNATURE="Asher"`. Unset = Phase 1 behaviour.

### Matchy Phase 2 — scheduling (commit a9504a6)
- `lib/matchyScheduling.ts`: `proposeTimes({ project, pe, reason: 'initial'|'reschedule', trigger, preferences })` — up to 3 × 60-min slots from `getClientSlotsForUser(ownerEmail)` (business hours in the owner's zone, weekdays, ≥24h lead, spread across days, regex preferences like "mornings", "not Fridays"), intersected with the expert's windows when known; emails via `lib/schedulingTemplates.ts` (every body ≤ 2 sentences + slot list + picker link, passes `enforceBrevity`); status → `scheduling_sent`; `pe.scheduling` (SchedulingState in types.ts) + event `times_proposed`. `parseSchedulingReply` = regex fast path + one gpt-4o-mini call (fenced like matchyClassify) → chosen / unavailable / reschedule / declined / unclear. `MAX_PROPOSAL_ROUNDS = 3`.
- `lib/bookCall.ts`: `bookCall` (Zoom create, `pe.booking` BookingState, legacy zoom fields kept for the webhook, status `scheduled`, ICS to both, event `scheduled`) and `rebookCall` (Zoom PATCH, same ICS UID with SEQUENCE+1, history, event `rescheduled`). `lib/createZoomMeeting.ts` gained update/delete; `lib/generateIcs.ts` gained `sequence`/`method`.
- Triggers: rate-decision accept → proposeTimes; inbound `interested` at `followup_sent` → `rate_agreed` + proposeTimes; inbound at `scheduling_sent` → parse → book / re-propose / `expert_declined_times` after round 3; inbound at `scheduled` with reschedule intent → re-propose (`reschedule_requested`) → next pick rebooks. Client: `POST .../propose-times { reason, preferences }` (owner only), "Move the call" in the thread, `GET .../booking/ics`.
- Expert picker: public `/schedule/[token]` (token = `generateAvailabilityToken`, hash in `scheduling.pickTokenHash`, 7 days) → `GET/POST /api/schedule/[token]` (pick / unavailable + free text / Google via the existing `/api/availability/[token]/google-auth` route, whose OAuth state now carries the picker token; the Google console redirect URI is unchanged). Returns no client identity, firm, project name or rate. A walkthrough proposal stores NO pickTokenHash, so the previewed link is inert.
- Retired: `/availability/*` pages + POST route, `AvailabilityForm`, `lib/triggerOverlapCheck.ts`, `sendAvailabilityRequest()`/`sendConfirmationEmail()`. `lib/availabilityToken.ts` stays (expert-onboarding link uses it).
- `lib/redactExpert.ts` strips `scheduling.pickTokenHash/pickTokenExpiry` for non-admins (deep copy); the rest of `scheduling`/`booking` is client-facing.

### Matchy Phase 2 — nudges (commit 6f7ee1a)
- `lib/nudges.ts` (pure) + `lib/qstashPublish.ts` + cron `GET /api/jobs/schedule-nudges` (Bearer `CRON_SECRET`, vercel.json `0 5 * * *`) + worker `POST /api/jobs/send-nudge` (QStash-signed, `Upstash-Retries: 0`).
- Waiting = last thread message is outbound (matchy/client, not pending/held) and status ∈ contacted (stage intro) / followup_sent, rate_negotiation (terms) / scheduling_sent (times). Planner queues one job per engagement per business day at 08:00 in `getCalendarConnection(ownerEmail).timezone ?? America/New_York` + random 0–3600 s. Worker re-validates everything (walkthrough, stage, waitingSince, day, cap 4, suppression) before sending. Ten distinct lines per stage, `linesUsed` never repeats. `NUDGE_LLM_VARIATION=true` enables a 60-token rephrase that must pass `lib/matchyBrevity.enforceBrevity` (2 sentences, ≤160 chars, no money/links/em dashes/markdown) else the pool line is used. Event `nudge_sent`.
- `lib/matchyBrevity.ts` is the general cap for LLM text that could reach an expert — use it on anything new.

### Thread UI (commit 93c87d1)
`components/ConversationThread.tsx`: propose-times control (+ preferences), proposed-times card in the viewer's zone, booked card (Zoom, ICS download, Move the call with confirm), intent tags. `lib/matchyClient.ts`: `proposeTimes`, `schedulingLine`, `formatSlot`, `bookingIcsUrl`.

### Where it ended (2026-09-07 evening) — all of this is deployed and prod e2e is green
- HEAD b290424. Commits this session: 6938846 walkthrough, 2e3b496 sender identity + event kinds, adef385 phase 2 types, a9504a6 scheduling, 6f7ee1a nudges, 93c87d1 thread UI, d2f83b1 store keys, e8d9336 one-call guard + real e2e tokens, e65c943 docs, b290424 admin env panel.
- `SMOKE_BASE_URL=https://expertmatch.fit npx tsx scripts/e2e-matchy.ts` → ALL CHECKS PASSED (live project, walkthrough project, scheduling on both). Throwaway users only; no email sent.
- Founder DID (per chat, 2026-09-07): paste migration 20260907300000; set `CRON_SECRET`, `QSTASH_URL`, `OUTREACH_FROM_EMAIL`, `OUTREACH_SIGNATURE`; `HUNTER_API_KEY` was already present. Told to add `CONTACT_ENRICHMENT_ENABLED=true` + redeploy to turn contact lookup on — CONFIRM in /admin/requests → Environment → "Optional features" (new group, presence only; grey dot = feature off, red = required var missing).
- One real bug found and fixed in prod: the propose-times happy path 500'd because the e2e seeded fake reply tokens and the send chokepoint fails closed on an unverifiable token (correct behaviour; real tokens are always signed). The e2e now seeds `generateOutreachToken(...)`. Lesson: any test that exercises a send path must seed a REAL HMAC token.
- Zoom S2S app: confirm meeting update/delete scopes — a rebook PATCHes the meeting; without the scope the booking still moves but the Zoom time will not.

### Not verified in a browser yet (DO THIS FIRST NEXT SESSION)
The new-project modal (Walkthrough preselected), the WALKTHROUGH header pill, the settings-strip Mode row + Go-live confirm, the thread's propose-times control / proposed-times card / booked card / Move the call, the Matches card lines, and `/schedule/[token]` (mobile + desktop; connected / booked / expired states) were built to the design language and type-check, but only the APIs were exercised in prod. Browser pass as a throwaway client (pattern: service-role user with `app_metadata {role:'user', status:'active', firm_domain, onboarding_complete:true}` + org + membership; login re-syncs from `profiles`, so walk /onboarding; set `profiles.billing_complete=true` to skip the card; delete after). For the picker page: on a WALKTHROUGH project a held proposal stores no `pickTokenHash`, so the link 404s by design — to see the page, mint a token with `generateAvailabilityToken` and write its `hashToken` to `scheduling.pickTokenHash` via the service role, then delete.

### Known gaps / next
- A round-3 proposal can repeat a round-1 slot (no `proposedBefore` field; exclusion uses current proposals + booking history).
- Nudge times are in the OWNER's zone (the expert's zone is unknown until they use the picker or reply with one).
- `clientRateMin/Max` still not enforced at bookmark/counter (MatchySettingsStrip TODO).
- Cancel a booking (Zoom delete exists, no route). Bounce retry for contact discovery. Second pass of `docs/COPY_AUDIT.md`. `docs/STATE_OF_THE_UNION.md` refresh.

## Session 4 (2026-09-07 overnight) — the overnight repair run. READ THIS FIRST.

The founder asked for the audit's repair plan to be executed while they slept, in waves of Opus builders with detailed briefs (one builder per disjoint file set; builders never commit; the lead type-checks, builds from a clean export, commits by area, pushes `main`, then verifies in production with throwaway users). The plan itself is the artifact "ExpertMatch Repair Plan" (phases 0–5) and TASK_QUEUE "NOW".

### UPDATE 2026-09-07 ~03:00 — wave 2 is LIVE, migration applied
- Wave 2 commits 30d0fd2 (workspace cut), 641b6e7 (admin + copy + favicon), dcc9e6f (contact discovery), 605dd07 (settings + weekly availability + guardrails) built from a clean export and deployed; deployment status success.
- Founder applied migration 20260907100000; `npx tsx scripts/verify-schema.ts` → PASS, 23 present, 0 missing (indexes/policies not checkable via REST — confirm in Studio with the two queries the script prints).
- Prod `scripts/e2e-matchy.ts`: all checks pass except two assertions that were stale (bookmark now answers `contact_discovery_started`); fixed in the working tree/this commit. `scripts/verify-sourcing-prod.ts` enqueued fine but the script died on a transient fetch error mid-poll; the poll is now tolerant — RE-RUN IT to get a clean pass (one real sourcing run, ~3 min).
- Browser pass of wave 2 was only partly done before the founder switched sessions: confirmed live — /app header shows Settings; /onboarding has Sign out and the weekly-hours option (Mon–Sun chips, from/to, + Add hours, + Add a specific date); /login → /auth/reset flow. NOT yet exercised in a browser: /settings (calendar / payment method / profile), the merged /admin/requests console (needs attention, sync seats, resend invite, env), the three-tab workspace after the cut, contact discovery end to end. Do that next with throwaway users (pattern in scratch scripts described below; set `profiles.billing_complete=true` to skip the card).
- All throwaway users/orgs from tonight are deleted. The founder's real access request (adgold28@colby.edu) is still pending in /admin/requests — approve it from the console.

### Where it is right now
- **Wave 1 is LIVE** (commits 53569e0 security/money, 9401d05 billing, 535c9e8 auth/onboarding, 1eb7aa6 workspace/home; docs d454f81). Verified in prod: `scripts/e2e-matchy.ts` ALL PASSED (owner gates, rate-decision, money screen, RLS), password reset flow exercised in the browser, onboarding card step works after the founder applied the two missing migrations.
- **Wave 2 is BUILT BUT UNCOMMITTED in the working tree** (≈95 changed/new files; `npx tsc --noEmit` has zero source errors — the only output is stale `.next/types/**` stubs for deleted routes, which vanish on the next build). Every unit script passes (`test-pricing`, `test-matchy-screen`, `test-matchy-templates`, `test-matchy-classify`, `test-conversations-redaction`, `test-email-clean`, `test-signup-token`, `test-org-billing`, `test-contact-discovery`, `test-availability-windows`, `check-redaction`). Wave 2 contains four builders' work:
  - E1 — retired flow removed: Outreach/Screen/Deliver tabs, /projects list, client-view, rank-experts, screen-expert, demo-readiness, their APIs, 7 components, email2/email3, `outreachMode`; admin-only Staff panel in `components/ConversationThread.tsx`; `GET /api/admin/env-status`.
  - E2 — admin console merged into `app/admin/requests/page.tsx` (users page + invite route deleted; Needs Attention + Environment sections; Resend invite / Send reset link; `POST /api/admin/firms {domain, action:'sync-seats'}`); marketing copy fixes; favicon `app/icon.svg`; availability copy; expert emails no longer carry the project name.
  - G — contact discovery on bookmark: `lib/contactDiscovery.ts` (cache → Snov → Hunter, 8 s per provider, 24 s budget), worker `POST /api/jobs/contact-discovery` (QStash-signed), bookmark returns `contact_discovery_started`; the lead added `matchyOutcome` (client-safe mirror of `contactStatus`, set in `lib/redactExpert.ts`) + `matchyLineFor` so the card shows the async result.
  - F — `/settings` (calendar / payment method / profile; `GET /api/settings/payment-method`), weekly recurring availability (`lib/availabilityWindows.ts`, `user_calendar_connections.weekly_windows`, merged into client slots in `lib/calendarConnections.ts`), guardrails: `scripts/verify-schema.ts`, `lib/attention.ts` + `GET /api/admin/attention`, `recordSystemFailure` in `lib/engagementEvents.ts` wired into every swallowed seat-sync catch, daily `GET /api/jobs/reconcile` (Bearer `CRON_SECRET`) with `vercel.json` cron `0 6 * * *`, migration `supabase/migrations/20260907100000_availability_windows_and_indexes.sql` (weekly_windows column, `system_events` table, two project_experts expression indexes). F was cut off before reporting, so it was never reviewed line by line — its files compile and its 109-check unit script passes; review `app/api/jobs/reconcile/route.ts` and `lib/attention.ts` before trusting them.

### To finish wave 2 (exact steps)
1. `npx tsc --noEmit 2>&1 | grep -v '^\.next/'` must print nothing. Run every `scripts/test-*.ts` and `scripts/check-redaction.ts` with `npx tsx`.
2. Build from a clean export (never in place while builders edit; never while `next dev` runs): `D=/tmp/em-build-$(date +%s); mkdir -p $D; git archive HEAD | tar -x -C $D` — for UNCOMMITTED work commit first (step 3) or use `git stash`-free approach: commit, then export. Then `ln -s /Users/ashergoldstein/Projects/expertmatch/node_modules $D/node_modules; cd $D && npm run build:local` (real `next build` with Google Fonts mocked).
3. Commit by area with `git add <paths>` (four commits: workspace-cut, admin+copy, contact-discovery, settings+guardrails), each ending with the Co-Authored-By line.
4. `git push origin main` (this deploys the Vercel project **expertmatching**). If the Claude Code permission classifier blocks the push, do not work around it — say so; the founder can push by hand.
5. Poll: `gh api "repos/adgold28-lgtm/expertmatching/deployments?environment=Production&sha=<full sha>&per_page=1" --jq '.[0].statuses_url'` then that URL's `.[0].state` until `success`.
6. Verify in prod: `SMOKE_BASE_URL=https://expertmatch.fit npx tsx scripts/e2e-matchy.ts` (throwaway users, no email) and `SMOKE_BASE_URL=https://expertmatch.fit WAIT_MS=540000 npx tsx scripts/verify-sourcing-prod.ts` (one real sourcing run). Then a browser pass as a throwaway client (see the scratch scripts pattern: create a user with app_metadata `{role:'user', status:'active', firm_domain, onboarding_complete:true}` + org + membership via service role; login re-syncs metadata from `profiles`, so the user will land on /onboarding — walk it; set `profiles.billing_complete=true` to skip the card) and as a throwaway admin (`role:'admin'`). Delete both afterwards.
7. Hand the founder `supabase/migrations/20260907100000_availability_windows_and_indexes.sql` to paste into Studio, then `npx tsx scripts/verify-schema.ts`.

### Founder actions outstanding
- Paste migration `20260907100000` in Supabase Studio (weekly availability, system_events, indexes).
- Stripe → Developers → Webhooks: add `account.updated` for **connected accounts** to the endpoint (late-onboarding expert payouts).
- Vercel env (project expertmatching): `CRON_SECRET` (any long random string), `QSTASH_URL=https://qstash-us-east-1.upstash.io`, `OUTREACH_FROM_EMAIL=ExpertMatch <notifications@expertmatch.fit>`, and confirm `HUNTER_API_KEY` + `CONTACT_ENRICHMENT_ENABLED=true` exist if contact discovery should run.
- Terms: entity name + governing law placeholders.

### What is NOT done (next waves, in order)
- Matchy Phase 2 scheduling: propose times from calendar overlap (now including weekly windows), book Zoom + ICS on confirmation, reveal both ways at `scheduled`, retire `/availability/*` + `lib/triggerOverlapCheck.ts`; enforce the rate band (`clientRateMin/Max`) at bookmark and counters (MatchySettingsStrip carries a TODO).
- Bounce retry for contact discovery; a real `contact_discovery_*` engagement event kind (needs a migration + union change; tonight it rides on `contact_found` / `contact_not_found` with a `stage:'discovery'` payload).
- `lib/expertPipeline.ts` `pipelineStage`/`STAGE_META` are now unused (PipelineBar deleted) — remove or reuse for the staff panel.
- Second pass of `docs/COPY_AUDIT.md` against the live site; `docs/STATE_OF_THE_UNION.md` refresh.
- Stale comments naming deleted components: `components/ProjectExpertCard.tsx` (~193), `lib/nameValidation.ts:2`, `lib/redactExpert.ts:120`; `.env.example` lacks `HUNTER_API_KEY`; three pre-existing `console.log` calls in `lib/sendAvailabilityRequest.ts`.

### Operating notes learned tonight
- The auto-mode permission classifier sometimes blocks long compound Bash commands (build + push + poll + e2e chained) and, occasionally, `git push`. Split commands into small steps; retry a plain `git push origin main` once; never chain destructive steps.
- Do not `cp .env.local` into scratch dirs; the export build works without it.
- QStash: this account is region-pinned to **us-east-1**; publish with `QSTASH_URL` and a raw (not percent-encoded) destination URL. Resend only sends from `expertmatch.fit`; `lib/mailFrom.ts` enforces it.
- Builders must be told their exact file list and every file they must not touch; two builders editing one file loses work. When a builder edits a file outside its list it will say so in its report — read reports fully.

## Session 3 (2026-09-06, late) — what changed and what is still broken

Fixed and verified in production:
- **Sourcing** never enqueued: `lib/sourcingJob.ts` published to the global QStash host (this account is region-pinned to us-east-1 → 404) with a percent-encoded destination (→ 400). Now uses `QSTASH_URL` (fallback `https://qstash-us-east-1.upstash.io`) and the raw URL. Verified with `scripts/verify-sourcing-prod.ts` (throwaway user, 14 experts in ~3 min). **Set `QSTASH_URL` in the Vercel project env** — the fallback covers it but the var should exist.
- **All Resend mail was rejected** (403 "gmail.com is not verified"): `OUTREACH_FROM_EMAIL` was a gmail address. `lib/mailFrom.ts` now owns the From: address (uses the env value only when it is on expertmatch.fit, else `ExpertMatch <notifications@expertmatch.fit>`); every sender goes through it; the access-request notification is awaited and logged. `.env.local` updated. **Change `OUTREACH_FROM_EMAIL` in Vercel** to `ExpertMatch <notifications@expertmatch.fit>`.
- **Admin console**: legacy `plan` removed everywhere (column stays, default 'starter'); `/api/admin/firms` returns `billing` (organization_billing mirror); page reordered requests-first with a billing line per org.

**BROKEN IN PRODUCTION — founder action:** migrations `20260902000000_org_billing_and_rls_hardening.sql` and `20260906000000_outreach_suppressions.sql` were never applied (TASK_QUEUE said otherwise). `organization_billing` and `outreach_suppressions` do not exist, so **POST /api/onboarding/billing 500s and no customer can finish onboarding**, and expert opt-outs would fail. Paste both files into Studio (a combined idempotent script was handed over in the session), then verify with a service-role select. (Seat requests are `access_requests` rows with `kind='seat'`; there is no separate table — the earlier note claiming otherwise was wrong. The feature is only reachable while an org has a seat cap, and approving one re-runs the same cap check.)

Full page-by-page audit (every button/input, four questions each) was delivered in the session transcript; the top items are in TASK_QUEUE "NOW".

## How to continue (for the next session)

Open Claude Code in `/Users/ashergoldstein/Projects/expertmatch` and say:
> Read HANDOFF.md Session 5, then (1) do the browser pass listed under "Not verified in a browser yet" with throwaway users and fix what you find, (2) run the website audit gate in TASK_QUEUE.md (second pass of docs/COPY_AUDIT.md against the live site), (3) pick up the Phase 2 leftovers in order.

Working pattern that has worked: Fable plans and writes agent briefs (a shared contract file + one brief per builder, disjoint WRITE lists, lead-owned shared files such as types.ts / projectStore.ts / conversations.ts / migrations / docs); Opus subagents (general-purpose, model `opus`) build in parallel and never commit; the lead type-checks, runs every `scripts/test-*.ts`, builds from a clean export (`git archive HEAD | tar -x -C <dir>`, absolute symlink to node_modules, `npm run build:local`), commits by area, pushes `main`, polls the GitHub deployment status, runs the prod e2e. Never build while `next dev` runs (shared `.next`); `.claude/launch.json` (gitignored) starts the dev server on :3000 for local e2e (`SMOKE_BASE_URL=http://localhost:3000`), which is how the prod 500 was diagnosed (server log showed the chokepoint refusal).

**Founder actions still open:** (1) form a legal entity (Delaware C corp via Stripe Atlas if YC is the plan) and then fill the last two legal placeholders — `app/terms/page.tsx` line ~88 (entity name) and the two `[Governing law: State]` tokens in section 13 (`grep -rn 'CONFIRM\|Governing law' app/terms`); every other placeholder was filled on 2026-09-06 (contact ashergoldsteinbusiness@gmail.com, postal 4502 Mayflower Hill, Waterville, ME 04901, 30-day disputes, 12-month non-circumvention, no recording, 12-month liability cap, courts not arbitration, 12/24-month retention, SCCs). (2) Live Stripe keys + live webhook before real money. (3) A Claude Code "suggested task" chip about adding `followup_sent` to the Outreach grid is STALE — it was done in part 3; dismiss it.

**Plain-English snapshot for outsiders / YC prep:** `docs/STATE_OF_THE_UNION.md` (2026-09-06).

## Matchy Phase 1 (live 2026-09-06)

`docs/MATCHY_SPEC.md` is the contract. Shipped: `bookmarked` status + `POST …/experts/[expertId]/bookmark` (seeds `expertRate` from tier, `clientRate = clientRateFor(expertRate)`, emits events, sends the anonymized intro or drafts it when `projects.review_first`); `conversation_messages` + `engagement_events` tables (migration `20260907000000_matchy_phase1.sql`, applied in prod); intro + follow-up templates (`lib/matchyTemplates.ts`), regex screen (`lib/matchyScreen.ts`), email cleaner (`lib/emailClean.ts`), one-LLM-call classify+summarize (`lib/matchyClassify.ts`, deterministic fallback); inbound rewired (`app/api/inbound-email`: verify → sender check → clean → screen → store encrypted → classify → stage → events → auto follow-up unless review-first; idempotent on Svix retries); thread API `GET|POST …/messages`, `POST …/messages/[id]/send`, `POST …/outreach/approve`; client UI = Brief · Matches · Conversations (Outreach/Screen/Deliver tabs are admin-only); Email 2/3 cadence retired (trigger route acknowledges and does nothing).

Money rules as built: `EXPERT_SHARE = 0.50`; `clientRateFor(expertRate) = ceil(expertRate/0.5/50)×50`; calls bill `callChargeDollars` (client rate × billable minutes, 15-minute minimum) in the complete route, the Zoom webhook and OutreachCard; payout = `expertPayoutDollars` (accepted rate × same minutes). Clients never receive `expertRate`, `expertCounterRate`, `contactEmail`, `emailProvider`; `redactMessageForViewer` masks every dollar amount in Matchy's outbound messages for non-admins. Seat pricing: `SEAT_TIERS` $250 (1–5) / $200 (6–20) / talk-to-us (21+, Stripe bills $200 until custom terms); Stripe seat Price `expertmatch_seat_monthly_v2` is created lazily on first org billing setup (test mode; no seat price or subscription exists in the test account yet).

Not in Phase 1 (Phase 2): autonomous contact discovery on bookmark (today bookmark uses an address already on the record, else `contact_not_found`), propose-times/booking from calendar overlap, suggested replies, digest.

## Where the product is (all live)

- **Auth/data:** Supabase Auth + Postgres (source of truth). RLS on. Service-role client server-side. Redis only for rate limits, caches, short tokens.
- **Onboarding:** required calendar (Google OAuth / Calendly / manual + timezone) and required Stripe card (SetupIntent) before the app unlocks; server-enforced (`profile` route 409s otherwise).
- **Billing:** off-session auto-charge on call completion (`lib/chargeSavedCard.ts`), payment-link fallback; Stripe webhook configured and verified in prod; expert payout via Connect on `payment_intent.succeeded`. **Stripe is in TEST mode** everywhere (pk_test/sk_test) — swap for live keys + live webhook when ready for real money. **Known gap:** auto-billing charges `expertRate`; per MATCHY_SPEC the client must be charged `clientRate` (expert gets 70%) — fix in Matchy Phase 1.
- **Sourcing:** server-side QStash job (`/api/projects/[id]/source-experts` → `/api/jobs/source-experts`), `sourcingStatus` on the project, persistent "Sourcing experts…" pill; results saved server-side. Sort/filter strip + "opening position" rate disclaimer on the Source step.
- **Reply tracking:** `lib/expertPipeline.ts` derives the stage; `PipelineBar` on the Outreach step.
- **Anonymization:** `lib/redactExpert.ts` applied at every project/expert API response. Non-admins (`role==='user'`) see "Scott S." + `anonymizedDescriptor` (quantified from evidence only), no LinkedIn/sources/evidence/contact fields; reveal at `scheduled`+; rejected never reveals; admins raw. Descriptors generated in the sourcing prompt (`lib/generateExperts.ts`, rules in `lib/anonymizeExpert.ts`), backfilled with Haiku, deterministic fallback. `seniorityTier`/`tierPricing` persisted at sourcing. Contact-enrichment routes are admin-only.
- **Outreach plumbing (bot still exists, to be replaced):** authed `POST .../experts/[expertId]/outreach/start`; inbound email verified with `svix`; sender must match `contactEmail`; email2 at most once; declined → `outreach_suppressions` (global do-not-contact, service-role only) + public opt-out link + footer with `OUTREACH_POSTAL_ADDRESS`; prompts no longer invent biography or assert the rate. Email 3 / review mode NOT fixed — superseded by Matchy.
- **Access requests:** public form → pending row + email to `adgold28@colby.edu` and `ashergoldsteinbusiness@gmail.com`; approved domains auto-invite.

## Scripts (all run with `npx tsx`)

- `scripts/smoke-cutover.ts` — 16 auth/CRUD/IDOR/RLS checks against localhost (edit BASE for prod). Provisions/deletes its own throwaway user. **Logs in AND out as the admin — signOut revokes all admin sessions; don't run it while the founder is logged in.**
- `scripts/check-redaction.ts` — assertions on `redactExpertForViewer` (incl. clientRate visible / expertRate hidden).
- `scripts/e2e-matchy.ts` — Matchy E2E against any base URL with THROWAWAY users only, no email sent (`SMOKE_BASE_URL=https://expertmatch.fit npx tsx scripts/e2e-matchy.ts`). Safe to run while the founder is logged in.
- `scripts/test-pricing.ts`, `test-matchy-templates.ts`, `test-matchy-screen.ts`, `test-email-clean.ts`, `test-matchy-classify.ts`, `test-conversations-redaction.ts` — pure unit tests, no network.
- `scripts/verify-matchy-migration.ts` — PRESENT/MISSING for the Phase 1 tables/columns.
- `scripts/verify-svix.ts` — Svix signature verification self-test.
- `scripts/seed-admin.ts <email> --org-name <name>` — seed an admin (reads `SEED_ADMIN_PASSWORD`).
- Pattern for prod E2E: provision a throwaway user via service role with `app_metadata` (`role`, `status:'active'`, `firm_domain`, `onboarding_complete`), org + `organization_members` row, log in via `/api/auth/login`, exercise routes, delete everything after. Never log out as the real admin.

## Environment / ops

- **Vercel project `expertmatching`** (serves expertmatch.fit). Never the stale `expertmatch` project. CLI token on this machine is expired; deploys happen by pushing `main`. A redeploy for env changes = empty commit to `main`. Deploy status: `gh api repos/adgold28-lgtm/expertmatching/deployments?environment=Production`.
- **Supabase ref `twiijjhulgpxaiavdgpo`**. CLI not linked; migrations are applied by pasting SQL into Studio (user does it; verify via a service-role `select` afterward). Applied: `20260831…`, `20260901…`, `20260906_outreach_suppressions`.
- **Google Cloud:** redirect URIs registered for `/api/onboarding/calendar/google/callback` (prod + localhost).
- **Local build on this Mac:** `npm run build` fails downloading Google Fonts (ETIMEDOUT in Next's bundled fetcher). Workaround: `npm run build:local` (uses `scripts/font-mocks.js`, which stubs the Spectral + Libre Franklin CSS). Build in a scratch export (`git archive HEAD | tar -x -C <dir>`) with an ABSOLUTE symlink to node_modules — never a relative symlink inside a git worktree (that got committed once and clobbered the real node_modules). Never build while `next dev` runs (shared `.next`).
- `.env.local` has 50 vars; verify with `grep -oE '^[A-Z_0-9]+' .env.local` after any hand edit (TextEdit has mangled it before). No `NEXT_PUBLIC_*` var may hold an `sb_secret_`.
- Repo is **Next 14.2**, not 15/16 — ignore hook suggestions about `proxy.ts` and async `params`.
- Upstash is account-rate-limited; caches/rate limits fail open.

## Next

1. **Browser pass** of everything in Session 5 "Not verified in a browser yet"; fix what breaks.
2. **Website audit gate** (TASK_QUEUE) — second pass of `docs/COPY_AUDIT.md` against the live site as a throwaway non-admin; every string true of the product as shipped (walkthrough, scheduling, nudges) and needed by a first-time PE associate.
3. **Phase 2 leftovers, in order:** enforce `clientRateMin/Max` at bookmark seed and rate-decision (409 `above_band`, card copy); expert timezone for nudges once the picker/reply supplies one; `proposedBefore` so round 3 never repeats round 1; cancel-booking route (Zoom delete + ICS METHOD:CANCEL exist); contact-discovery bounce retry; `docs/STATE_OF_THE_UNION.md` refresh; remove unused `pipelineStage`/`STAGE_META` in lib/expertPipeline.ts.
4. Legal `[CONFIRM]` placeholders; live Stripe keys + live webhook; Stripe `account.updated` for connected accounts.

Founder preferences to honor: no machinery talk in Matchy's messages; verbs not chat; not a GPT wrapper; collect as much data as possible; ExpertMatch takes 50% of the call plus $250/$200 per seat/month; honest claims only on the website.

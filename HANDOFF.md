# ExpertMatch — Session Handoff

**Written:** 2026-09-07 (overnight, session 4 — in progress) · **Branch:** `main` (deployed = production) · **Status:** live at expertmatch.fit; Matchy Phase 1 shipped and verified in production (`scripts/e2e-matchy.ts` all green, `scripts/smoke-cutover.ts` 16/16)

Read with `CLAUDE.md` (operating rules), `TASK_QUEUE.md` (priorities), `docs/MATCHY_SPEC.md` (next build), `docs/OUTREACH_BOT_AUDIT.md` (why Matchy replaces the outreach bot).

## Session 4 (2026-09-07 overnight) — the overnight repair run. READ THIS FIRST.

The founder asked for the audit's repair plan to be executed while they slept, in waves of Opus builders with detailed briefs (one builder per disjoint file set; builders never commit; the lead type-checks, builds from a clean export, commits by area, pushes `main`, then verifies in production with throwaway users). The plan itself is the artifact "ExpertMatch Repair Plan" (phases 0–5) and TASK_QUEUE "NOW".

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
> Read HANDOFF.md, then plan Matchy Phase 2 (scheduling + contact discovery) from docs/MATCHY_SPEC.md and dispatch Opus agents to build. Before that, run the post-Phase-1 website audit gate in TASK_QUEUE.md.

Working pattern that has worked: Fable plans and writes agent briefs; Opus subagents (general-purpose, model `opus`) build in parallel when files are disjoint (tell each agent exactly which paths it may not touch, and NOT to commit); the lead commits by path, verifies, pushes. Verify with `npx tsc --noEmit`, `npm run build:local` (real `next build` with Google Fonts mocked — tsc alone missed a Next route-export error once), the scripts below, and the two production E2E scripts.

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

1. **Website audit gate** (TASK_QUEUE) — second pass of `docs/COPY_AUDIT.md` now that the workspace is Brief · Matches · Conversations; real-browser walkthrough as a throwaway non-admin.
2. **Matchy Phase 2** — contact discovery job on bookmark (bounded provider attempts, one send, bounce retry), propose-times from calendar overlap + preferences, book on confirmation (Zoom + ICS), card statuses.
3. Legal `[CONFIRM]` placeholders; live Stripe.

Founder preferences to honor: no machinery talk in Matchy's messages; verbs not chat; not a GPT wrapper; collect as much data as possible; ExpertMatch takes 50% of the call plus $250/$200 per seat/month; honest claims only on the website.

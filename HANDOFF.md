# ExpertMatch — Session Handoff

**Written:** 2026-09-06 (evening, session 2) · **Branch:** `main` (deployed = production) · **Status:** live at expertmatch.fit; Matchy Phase 1 shipped and verified in production (`scripts/e2e-matchy.ts` all green, `scripts/smoke-cutover.ts` 16/16)

Read with `CLAUDE.md` (operating rules), `TASK_QUEUE.md` (priorities), `docs/MATCHY_SPEC.md` (next build), `docs/OUTREACH_BOT_AUDIT.md` (why Matchy replaces the outreach bot).

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

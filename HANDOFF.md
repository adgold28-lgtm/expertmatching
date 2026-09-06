# ExpertMatch — Session Handoff

**Written:** 2026-09-06 · **Branch:** `main` (deployed = production) · **Status:** live at expertmatch.fit, everything below verified in production

Read with `CLAUDE.md` (operating rules), `TASK_QUEUE.md` (priorities), `docs/MATCHY_SPEC.md` (next build), `docs/OUTREACH_BOT_AUDIT.md` (why Matchy replaces the outreach bot).

## How to continue (for the next session)

Open Claude Code in `/Users/ashergoldstein/Projects/expertmatch` and say:
> Read HANDOFF.md, then plan Matchy Phase 1 with me from docs/MATCHY_SPEC.md — answer the open questions first, then dispatch Opus agents to build.

Working pattern that has worked: Fable plans and writes agent briefs; Opus subagents (general-purpose, model `opus`) build in sequence when they share files, in parallel when they don't; Explore agents do read-only recon first. Verify with `npx tsc --noEmit`, the scripts below, and a production E2E with a throwaway user.

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
- `scripts/check-redaction.ts` — ~60 assertions on `redactExpertForViewer`.
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

## Next: Matchy Phase 1

`docs/MATCHY_SPEC.md` draft 2 is the plan. Start by getting the founder's answers to its **Open questions** (firm-type wording, review-switch default, rate ranges per tier, minimum billable minutes, collaborator send rights, digest cadence). Then Phase 1 in order: pricing rule (clientRate/expertRate, billing charges clientRate) → `bookmarked` status + bookmark action → `conversation_messages` + `engagement_events` migrations → intro/follow-up templates with auto-send + review switch → inbound rewired → thread UI + Conversations tab → regex screen → retire Email 2/3 cadence.

Founder preferences to honor: no machinery talk in Matchy's messages; verbs not chat; not a GPT wrapper; collect as much data as possible; ExpertMatch takes 50% of the call (raised from 30% on 2026-09-06 — see spec) plus $250/$200 per seat/month.

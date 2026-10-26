# ExpertMatch

A self-serve expert-network platform for private equity firms, consulting
firms, law firms and corporate strategy teams. A client writes a research
brief, the platform sources and scores anonymized expert candidates, and
Matchy (our agent) handles the outreach, scheduling and billing of the call.
It replaces the AlphaSights model by being faster, more transparent and fully
self-serve. CLAUDE.md is the operating manual; this file is the map.

## The core workflow

Brief → Matches → Conversations (the contract is docs/MATCHY_SPEC.md):

1. An admin invites the client (or approves a request from /request-access).
   During onboarding the client links a calendar and a card; the firm pays per
   seat, monthly.
2. The client submits a research brief.
3. The platform sources and scores anonymized expert candidates (Matches).
4. The client bookmarks an expert. That bookmark is the consent for Matchy to
   reach out.
5. Matchy emails the anonymized intro, handles the reply, asks about conflicts
   and rate, and relays every message through a compliance screen
   (Conversations).
6. Matchy schedules the call (Zoom link plus calendar invite). Identities are
   revealed both ways once the call is `scheduled`.
7. The call completes. The client's saved card is charged the client rate
   (15-minute minimum, per minute after); the expert is paid their accepted
   rate through Stripe Connect.

A second front door, the structured request and screening flow
(docs/SCREENING_FLOW_PLAN.md), lets a client state learning objectives and
have candidates answer them before any call is booked.

## Stack

- Next.js 14 (App Router, TypeScript, Tailwind), hosted on Vercel
- Supabase: Auth and the source-of-truth Postgres, with RLS
- Upstash Redis (rate limits, caches, short-lived tokens) and QStash
  (background jobs: outreach sequences, server-side sourcing)
- Stripe: per-seat subscriptions, per-call charges, Connect payouts to experts
- Resend for outbound email and the inbound-reply webhook (verified with Svix)
- Zoom (server-to-server OAuth) and Google Calendar (free/busy) for scheduling
- OpenAI and Anthropic for sourcing and Matchy; Exa, Tavily or ScrapingBee for
  web search; Findymail and Hunter.io for contact discovery

There is no test runner: every suite under scripts/ is a plain program run with
`npx tsx` (see scripts/testHarness.ts), and lib/log.ts is the one logger.

## Local setup

Node 22 (what CI uses) and npm.

```bash
npm install
cp .env.example .env.local   # then fill in what you have
npm run dev                  # http://localhost:3000
```

.env.example documents every variable, grouped by service, with where each one
comes from. The app boots with most of them empty: in development,
lib/validateEnv.ts warns about a missing required variable instead of refusing
to start, and each integration degrades (no sourcing without a search key, no
emails without Resend, and so on). Production refuses to boot without the
REQUIRED_VARS list in lib/validateEnv.ts. Nothing is ever hardcoded; secrets
live in .env.local (gitignored) or the Vercel dashboard.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server on port 3000 |
| `npm run typecheck` | `tsc --noEmit` over the app (scripts/ has its own tsconfig) |
| `npm run test:offline` | Every offline suite: scripts/test-*.ts plus the two check-*.ts invariants. No network, database or secrets needed |
| `npm run build:local` | The real `next build` with Google Fonts mocked (scripts/font-mocks.js), so it works offline. Run before every commit; tsc alone is not enough |
| `npm run security` | scripts/security-scan.sh: npm audit against an accepted-advisory list, tsc, hardcoded secrets, insecure fallbacks, XSS sinks, console.log, `any`, undocumented env vars |

One suite at a time: `npx tsx scripts/test-pricing.ts`. Four suites need a
running app or live Redis and are skipped by test:offline; run them by hand
against `next dev -p 3100`, for example
`SMOKE_BASE_URL=http://localhost:3100 npx tsx scripts/test-route-authz.ts`
(also test-auth-flows, test-auth-request-cache, test-upstash). Those four are manual-only today and CI does not run them, so a green CI badge does not mean the login and tenant-isolation paths were exercised: run them before merging any change under middleware.ts, lib/auth.ts, lib/projectsGuard.ts or lib/projectStore.ts. A CI job for them is on TASK_QUEUE.md. The e2e-*.ts
scripts drive a deployed environment the same way.

CI (.github/workflows/ci.yml) runs typecheck, test:offline, build:local and the
security scan on every pull request and every push to main, with no secrets.

## Deploying

- Vercel builds and deploys `main`. Environment variables are set in the Vercel
  dashboard; /api/admin/env-status shows the founder which ones are present
  (never their values). vercel.json schedules the two cron jobs
  (/api/jobs/reconcile and /api/jobs/schedule-nudges), which require
  CRON_SECRET.
- Database changes are SQL files in supabase/migrations/. They are not applied
  automatically: the founder pastes each one into the Supabase SQL editor, then
  runs `npx tsx scripts/verify-schema.ts`. TASK_QUEUE.md lists the migrations
  still waiting under "Founder: paste migration".
- Webhooks (Stripe, Resend inbound, Zoom) are configured in each vendor's
  dashboard; the events each endpoint needs are listed in .env.example and
  TASK_QUEUE.md.

## Where to read next

| File | What it holds |
| --- | --- |
| CLAUDE.md | Operating rules: engineering standards, auth model, what to do before and after every task |
| HANDOFF.md | Session-by-session history of what was built, verified and left open |
| TASK_QUEUE.md | Priorities: NOW / NEXT / LATER, including the founder's pending actions |
| ARCHITECTURE.md | Module-by-module map of the code, data flows, every env var and vendor |
| ARCHITECTURE-PLAIN.md | The same architecture in plain English, for a non-engineer |
| ARCHITECTURE-AUDIT.md, SECURITY_AUDIT.md | Audit findings and their status |
| docs/MATCHY_SPEC.md | The Matchy contract: what the agent may send, when, and to whom |
| docs/SCREENING_FLOW_PLAN.md | The structured request and screening flow |
| docs/OUTREACH_EMAIL_RUBRIC.md | What an outreach email must and must not contain |
| docs/STATE_OF_THE_UNION.md | A plain-English snapshot of the product for an outside reader |
| scripts/rls/README.md | How to verify the Postgres row-level security policies |

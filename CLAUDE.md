# ExpertMatch — Claude Code Operating Manual

## What ExpertMatch Is
ExpertMatch is a premium B2B expert-network platform targeting PE firms, consulting firms, 
law firms, and corporate strategy teams. It replaces AlphaSights by being faster, more 
transparent, and fully self-serve. Every UI and engineering decision should feel like it 
belongs at Stripe, Linear, or Notion — not a hackathon project.

## The Core Workflow (understand this before touching anything)
Brief → Matches → Conversations (see docs/MATCHY_SPEC.md):
1. Client is invited by admin (or approved via /request-access), links calendar + card during onboarding; org pays per seat monthly
2. Client submits a research brief
3. Platform sources and scores anonymized expert candidates (Matches)
4. Client bookmarks an expert — that is the consent for Matchy (our agent) to reach out
5. Matchy emails the anonymized intro, handles the reply, asks conflicts + rate, relays every message through a compliance screen (Conversations)
6. Matchy schedules the call (Zoom + ICS); identities reveal both ways at `scheduled`
7. Call completes → client's saved card is charged the client rate (15-min minimum, per minute after); expert is paid their accepted rate via Stripe Connect

## Target Users
- Private equity firms
- Consulting firms (MBB, boutiques)
- Law firms needing expert witnesses
- Corporate strategy and investment teams

## Engineering Rules
- Never implement placeholder or half-working features
- Always inspect existing architecture before writing any code
- Every feature needs loading states, error states, and mobile responsiveness
- Prefer proven libraries over custom implementations for auth, payments, scheduling
- No hardcoded secrets — use env vars with clear names
- Run `npm run build:local` before every commit (real `next build` with Google Fonts mocked; tsc alone is not enough)
- No console.log left in production code
- No `any` types in TypeScript unless truly unavoidable
- Follow existing file structure and naming conventions exactly

## Stack
Next.js, Vercel, [DB], [email provider]. Do not introduce new dependencies 
without noting it explicitly.

## Auth Model (as of September 2026)
- Supabase Auth + Postgres with RLS is the source of truth (see HANDOFF.md); Redis only for rate limits, caches, short tokens
- Invite-only / approved-domain access; user sets password via tokenized link
- Per-seat org billing (lib/pricing.ts SEAT_TIERS); `organizations.seat_limit` is an optional admin cap
- Role in `app_metadata` (service-role written): user / admin; project owner vs collaborator (read-only) inside a project
- No master password backdoor

## Before Every Task
1. Read this file
2. Check TASK_QUEUE.md for priority
3. Inspect relevant existing files before writing anything
4. For any feature, think through: UX, auth, security, edge cases, 
   loading states, error states, mobile, production readiness
5. Then code

## After Every Task
1. Run `npm run build:local` — zero errors required
2. Commit with a clear message
3. Update TASK_QUEUE.md
4. Note any architectural decisions made

## Banned Patterns
- Master password that works for any email
- Stranding a logged-in user on the marketing page with no path to the app
- Features that only work in happy-path conditions
- Shallow implementations that will need a full rewrite later
- Open registration without admin invite

## Product Alignment Audit (run before any significant feature)
Answer these before coding:
1. What is the actual user problem?
2. Where does this fit in the ExpertMatch workflow?
3. What would AlphaSights do manually here — what should we automate?
4. What edge cases matter?
5. What security or compliance risks exist?
6. What would a polished SaaS version include?
7. What existing files need to be inspected first?

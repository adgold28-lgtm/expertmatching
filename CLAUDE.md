# ExpertMatch — Claude Code Operating Manual

## What ExpertMatch Is
ExpertMatch is a premium B2B expert-network platform targeting PE firms, consulting firms, 
law firms, and corporate strategy teams. It replaces AlphaSights by being faster, more 
transparent, and fully self-serve. Every UI and engineering decision should feel like it 
belongs at Stripe, Linear, or Notion — not a hackathon project.

## The Core Workflow (understand this before touching anything)
1. Client is invited by admin, links billing + calendar during onboarding
2. Client submits a research brief
3. Platform sources and scores experts automatically
4. Client selects preferred experts from a shortlist
5. Platform finds contact info, generates concise outreach, manages replies
6. Platform schedules calls via linked calendars, sends Zoom links
7. Platform tracks time and bills by the minute

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
- Run npm run build before every commit
- No console.log left in production code
- No `any` types in TypeScript unless truly unavoidable
- Follow existing file structure and naming conventions exactly

## Stack
Next.js, Vercel, [DB], [email provider]. Do not introduce new dependencies 
without noting it explicitly.

## Auth Model (as of May 2026)
- Invite-only. Admin sends invite, user sets password via tokenized link
- Firm-based seat limits tied to billing plan
- bcrypt password hashing
- Role field on user record: user / admin
- No master password backdoor — removed
- Session via cookie, verified with HMAC

## Before Every Task
1. Read this file
2. Check TASK_QUEUE.md for priority
3. Inspect relevant existing files before writing anything
4. For any feature, think through: UX, auth, security, edge cases, 
   loading states, error states, mobile, production readiness
5. Then code

## After Every Task
1. Run npm run build — zero errors required
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

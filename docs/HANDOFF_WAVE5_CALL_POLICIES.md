# Handoff: Wave 5, call cancellation and no-show policies

*Written 2026-09-10 for a fresh Claude Code session. Everything below is self-contained; read this file first, then the files it names.*

## Where the repo is

- Repo: `/Users/ashergoldstein/Projects/expertmatch`, branch `main`, deployed to production at expertmatch.fit on every push (Vercel project `expertmatching`). `main` may be one or two docs commits ahead of `origin/main`; the founder pushes by hand, so never push from a session unless asked, and never force anything.
- Stack: Next.js 14 App Router, Supabase (service-role client everywhere; RLS is no longer the boundary), Stripe (test mode), Resend, Upstash Redis/QStash, Zoom. No test runner: every `scripts/test-*.ts` is run with `npx tsx` and uses `scripts/testHarness.ts`.
- Read in this order: `CLAUDE.md`, `docs/REPAIR_PLAN.md` Part A (the builder operating rules; they still apply) and Part B (lead gate), `ARCHITECTURE.md` sections 5, 6.6, 6.7, 6.8, `docs/CALL_POLICIES_DRAFT.md` (the policy, with the founder's approved decisions at the top), `HANDOFF.md` Sessions 9 and 10.
- How the last waves were run and should be run again: a lead session plans, writes one brief per builder with disjoint WRITE lists, launches Opus builders in parallel in a worktree with `npm ci` (never symlink node_modules), gates with `npx tsc --noEmit`, every `scripts/test-*.ts`, `npm run build:local`, then the HTTP suites against a local `next dev -p 3100` (`SMOKE_BASE_URL=http://localhost:3100 npx tsx scripts/test-route-authz.ts`, `test-auth-flows.ts`, `e2e-matchy.ts`; the worktree needs a symlinked `.env.local`, never read it), commits per brief, and hands the push to the founder.

## What to build (founder decisions, approved 2026-09-10)

All windows compare server time with the booked UTC start (`pe.booking.startUtc`).

1. **Cancel a booked call, both sides.**
   - Client: owner-only `POST /api/projects/[projectId]/experts/[expertId]/booking/cancel` plus a "Cancel the call" control in `components/ConversationThread.tsx` next to "Move the call", with a two-step confirm that states the consequence (free, or a 15-minute charge).
   - Expert: a "Cancel" action on the public picker page `/schedule/[token]` and its API `POST /api/schedule/[token] { action: 'cancel' }`, token-gated like `pick`.
   - More than 24 h before start: cancel is free for either side. Inside 24 h: the UI offers "Move the call" and an explicit late-cancel path.
   - Cancel ends the booking: delete the Zoom meeting (`lib/createZoomMeeting.deleteZoomMeeting` exists, unused), send both parties a cancellation email with an ICS `METHOD:CANCEL` (`lib/generateIcs.ts` supports `method`), stop nudges, invalidate the picker token, write `booking.cancelledAt`, `booking.cancelledBy` (`client` | `expert` | `staff`), `booking.cancelReason`, status `rejected_after_outreach` for the engagement, emit an engagement event (a new kind `call_cancelled` needs a check-constraint migration in `supabase/migrations/`; the founder pastes migrations into Supabase Studio, and the code must tolerate the constraint not being widened yet, the way `contact_not_found` payloads did).
   - "Find another time" afterwards is a separate explicit action (reuse `propose-times` with a fresh engagement or a re-bookmark; decide and document).
2. **Client late cancel or no-show.** Charge 15 minutes at the agreed client rate and pay 15 minutes at the agreed expert rate, through the existing money path (`lib/createAndSendInvoice` with a distinct `callId` such as `${booking.icsUid}:late-cancel`, so the per-call guard from Wave 1 does not treat it as the call itself; `lib/pricing.callChargeDollars` already applies the 15-minute minimum). Client no-show is detected when the Zoom `meeting.ended` webhook reports the expert joined and the client did not; if Zoom participant data is not available, require staff confirmation rather than charging on missing telemetry (see the draft's warning about telemetry).
3. **Expert no-show or expert late cancel.** No charge to the client. Matchy emails the client an apology on ExpertMatch's behalf stating the expert has been removed from the platform. Add the expert's `contactEmail` to `outreach_suppressions` (`lib/outreachSuppressions.suppress`, reason `manual`, source project id). No payout. Status ends the engagement.
4. **Refunds.** Keep the default from Wave 2 (a refund marks `paymentStatus: 'refunded'` and alerts; the expert payout stays). Add a staff-only action `POST /api/admin/payouts/reverse` that calls Stripe transfer reversal (`stripe.transfers.createReversal`) for one engagement, records `expertPayoutReversedAt` and a system event, behind `adminGuard`. Surface it in the admin console next to the engagement's payout state.
5. **First card: champion only.** In `app/api/onboarding/billing/route.ts` the plain (first-time) POST must require `org_role === 'org_admin'` or platform admin, the same gate already applied to `replace` and `activate`; non-champions get `403 { error: 'champion_required', championEmail }` and `components/onboarding/BillingStep.tsx` renders "ask your champion to add a card". Add champion transfer: `PATCH /api/org/members { email, orgRole: 'org_admin' }` already exists for promote; make the Team page (`app/settings/team/page.tsx`) offer "Make champion", which promotes the target and demotes the current champion in one request (new `action: 'transfer_champion'`), allowed for the current champion and platform admins, refused if it would leave zero org admins.
6. **Calendly hidden, not deleted.** New optional env `CALENDLY_ENABLED` (document in `lib/validateEnv.ts` OPTIONAL_VARS and `.env.example`; `scripts/check-env-drift.ts` enforces this). When unset or not `'true'`: `components/onboarding/CalendarStep.tsx` and `components/settings/CalendarPanel.tsx` do not offer Calendly, `POST /api/onboarding/calendar` answers `400 { error: 'calendly_disabled' }` for `provider: 'calendly'`, and `lib/calendarConnections.getClientSlotsForUser` treats an existing Calendly connection as "not connected" (so the user is prompted to connect Google or type hours). Keep `lib/fetchCalendlySlots.ts` untouched.

## Constraints that already exist and must be preserved

- Blinding: nothing new reaching an expert may contain the client's name, firm, project name or client rate; everything reaching a client goes through `lib/redactExpert.redactExpertForViewer`. The apology email names no client details.
- Money: only `lib/pricing.ts` converts rates; `rateFieldsFor` writes both numbers together; every charge goes through `lib/createAndSendInvoice` and keys on a `callId`; every payout through `lib/expertPayout`.
- Every outbound email goes through `lib/emailSequence.sendSequenceEmail` (walkthrough, entitlements, suppression, `DISABLE_EMAILS`) or `lib/sendAvailabilityRequest.sendBookingEmail` for ICS-bearing mail; read the `SendOutcome` and store a held message rather than pretending a send happened.
- Reply-To addresses use `reply.expertmatch.fit` (`OUTREACH_REPLY_DOMAIN`); the inbound route parses Resend's `email.received` envelope and fetches bodies from the receiving API.
- Never export helper values from a `route.ts` (Next 14 rejects it at build); put pure logic in `lib/` or a colocated non-route module and test it.
- Concurrency: cancel, move and book on the same engagement must resolve to one outcome before any Zoom/email/Stripe side effect; use `lib/projectStore.mutateExpert` (compare-and-set on `updated_at`) and a Redis `SET NX` lock as `lib/outreachSteps` does for the intro.
- Each brief must add a `scripts/test-*.ts` that fails on the old code and passes on the new one; the cancel window, late-cancel charge amounts, no-show branches, champion transfer refusals and the Calendly flag are all pure decisions that can be unit-tested.

## Suggested split into builders (disjoint files)

- **B1 cancel + no-show core:** `lib/bookCall.ts` (add `cancelCall`), `lib/callPolicies.ts` (new: window and fee decisions, pure), booking cancel route (new), `app/api/schedule/[token]/route.ts` (`cancel` action), `components/SchedulePicker.tsx`, `components/ConversationThread.tsx` (cancel control), `lib/schedulingTemplates.ts` (cancellation and apology copy, brevity-capped), migration for the new event kind, `scripts/test-call-policies.ts`.
- **B2 money for late cancel and expert removal:** `app/api/webhooks/zoom/meetingEnd.ts` and `route.ts` (participant-based no-show detection, staff-confirm fallback), `lib/createAndSendInvoice.ts` (late-cancel line item with its own `callId`), `lib/expertPayout.ts` (15-minute payout for late cancel; none for expert no-show), `lib/outreachSuppressions.ts` call site, `scripts/test-stripe-flows.ts` extension.
- **B3 refund clawback + champion:** new `app/api/admin/payouts/reverse/route.ts`, `lib/stripeConnect.ts` (`reverseExpertPayout`), admin console panel in `app/admin/requests/page.tsx`, `app/api/onboarding/billing/route.ts` champion gate, `components/onboarding/BillingStep.tsx`, `app/api/org/members/route.ts` (`transfer_champion`), `app/settings/team/page.tsx`, `scripts/test-auth-guards.ts` and `scripts/test-payout-state.ts` extensions.
- **B4 Calendly flag:** `lib/validateEnv.ts`, `.env.example`, `components/onboarding/CalendarStep.tsx`, `components/settings/CalendarPanel.tsx`, `app/api/onboarding/calendar/route.ts`, `lib/calendarConnections.ts`, `scripts/test-availability-windows.ts` extension.

Lead-owned shared files (`types.ts`, `lib/projectStore.ts`, `lib/redactExpert.ts`, `lib/pricing.ts`, docs) are edited only by the lead on request, exactly as in Waves 1 to 4.

## Founder-side items still open (do not block the build)

- Google Workspace for a real `asher@expertmatch.fit` inbox (root MX rows currently point at ImprovMX forwarding; the `reply` subdomain must not be touched).
- Google OAuth branding review is pending with Google.
- Stripe is in test mode; live keys and live webhook endpoints are a separate, later step.
- Two docs commits on `main` may be unpushed when you start; `git status` and `git log origin/main..main` first.

## Definition of done for this wave

`npx tsc --noEmit` clean; every `scripts/test-*.ts` green (including the new ones); `npm run build:local` green; the three HTTP suites green against a local server; a browser pass with throwaway users covering book, move, cancel (free and late), and the champion transfer; `ARCHITECTURE.md` 6.6 and 6.7, `ARCHITECTURE-AUDIT.md` status table, `HANDOFF.md` and `TASK_QUEUE.md` updated; commits by brief; push handed to the founder.

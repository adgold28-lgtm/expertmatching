# ExpertMatch call policies and implementation brief

Status: decision draft — proposed rules are not approved, implemented, or published terms.
Created: 2026-09-09. Owner: founder. Prepared for review before changing billing or scheduling behavior.

## Purpose

Make the outcome of every booked-call scenario predictable for the client, expert, and operator. Record commercial decisions first, then implement them as explicit, testable transitions. This document proposes operating rules; it does not establish contractual enforceability.

Scope: booking, cancellation, attendance, duration, quality complaints, payment collection, refunds, and expert compensation. Seat-subscription cancellation is separate.

## Implementation baseline and coordination

The main checkout is on `matchy-2`. The separate `.claude/worktrees/docs-architecture-map` worktree is on `fix/waves` and contains newer payment, webhook, privacy, and retry work. Confirm both branches' state before implementation; do not rebuild their fixes from this document.

Relevant files:

- `lib/bookCall.ts`: book and move calls; explicitly lacks a cancel-booking workflow.
- `lib/pricing.ts`: per-minute call calculation, 15-minute minimum, client/expert rates and whole-dollar rounding.
- `lib/createAndSendInvoice.ts`, `lib/chargeSavedCard.ts`: collection and payment-link fallback.
- `app/api/webhooks/zoom/route.ts`: meeting completion and elapsed duration.
- `app/api/webhooks/stripe/route.ts`, `lib/expertPayout.ts`, `lib/stripeConnect.ts`: payment confirmation and payout.
- `lib/entitlements.ts`: account activation boundary.
- `lib/attention.ts`, `lib/engagementEvents.ts`: operator attention and selected failure reporting.
- `app/terms/page.tsx`: existing published copy; reconcile with approved rules before rollout.

The repair plan explicitly defers cancellation semantics and payout reversal policy. Its refund/dispute handling does not decide who should bear a commercial loss. A Zoom meeting ending is not, by itself, proof that both people attended or that every elapsed minute was billable.

## Founder decisions (2026-09-10, approved)

These answer the questions in "Decisions for the founder" below and in docs/REPAIR_PLAN.md Part H. They are the policy to build.

1. **Cancellation window: 24 hours.** Either side may cancel outright when the call starts more than 24 hours from the moment of cancellation (server time versus booked UTC start). Inside 24 hours either side may still *move* the call; an outright cancel inside the window is a late cancellation.
2. **Client late cancel or no-show:** the client is charged 15 minutes at the agreed client rate; the expert is paid 15 minutes at the agreed expert rate. Confirmation must show the amount before the client submits.
3. **Expert no-show or expert late cancel:** no charge to the client. Matchy sends the client an apology on behalf of ExpertMatch stating that the expert has been removed from our database. The expert's address goes on the global do-not-contact list (`outreach_suppressions`, reason `manual`, source project recorded) and the engagement ends. No payout.
4. **Cancel ends the booking; move keeps it.** After a cancel, "Find another time" is an explicit separate action, never automatic.
5. **Refunds:** default is to leave the expert's payout in place and decide manually; provide a staff-only clawback action (Stripe transfer reversal) for the cases where the expert was at fault. No automatic reversal.
6. **First card: champion only.** An ordinary member sees "ask your champion to add a card". The champion role must be transferable by the current champion (and by a platform admin) from the Team page.
7. **Calendly: hidden, not deleted.** Remove the option from the onboarding and settings UI and refuse it on the API behind a feature flag (`CALENDLY_ENABLED`, default off), keep `lib/fetchCalendlySlots.ts` and its probe so it can be re-enabled once a Calendly integration exists.

## Recommended pilot policy — all amounts and windows need founder approval

| Scenario | Proposed client treatment | Proposed expert treatment | Required evidence / action |
|---|---|---|---|
| Normal completed call | Charge agreed client hourly rate for verified billable minutes, minimum 15 minutes | Pay agreed expert hourly rate for the same minutes | Store rates at booking, attendance evidence, duration and call identity |
| Client cancels at least 24 hours before start | No charge | No cancellation compensation | Server receipt time compared with booked UTC start |
| Client cancels less than 24 hours before start | Charge 15 minutes at agreed client rate | Pay 15 minutes at agreed expert rate | Explicit cancellation confirmation shows amount before submission |
| Client does not attend | Same proposed 15-minute fee, only after review | Same compensation if expert attended and waited 10 minutes | Attendance evidence or operator-confirmed account; an empty Zoom meeting is insufficient |
| Expert cancels or does not attend | No charge; offer replacement or rebooking | No payout for an unperformed call | Record expert cancellation or confirmed absence; do not automatically penalize an expert based on missing telemetry |
| Neither participant attends | No automatic charge | No automatic payout | Review; distinguish absence from provider failure |
| Client ends a relevant call early | Pay verified minutes, subject to 15-minute minimum | Same billable duration at expert rate | Record actual participation, not scheduled duration |
| Expert cannot address the agreed scope, reported within first 10 minutes and call stopped | Hold collection pending review; waive if mismatch is substantiated | Review separately; do not automatically make expert bear a sourcing mistake | Compare agreed brief/questions with expertise and complaint; no recording required |
| Compliance/conflict concern stops the call | Stop immediately; hold disputed charge for review | Decide compensation separately based on cause and time | Record a reason code; do not solicit or store confidential disclosures |
| ExpertMatch/Zoom technical failure prevents a useful call | No charge; offer a rebook | Proposed: ExpertMatch funds 15 minutes if expert attended and waited 10 minutes | Confirm platform failure; avoid charging client for service not delivered |
| Participant-side connectivity problem | Attempt reconnection; hold ambiguous cases for review | Pending review | Pilot manual handling until there is evidence for a fair automated rule |
| Call runs past scheduled end | Bill extra minutes only with recorded agreement to extend | Same approved minutes at expert rate | Warn near end; cap automatic billing at booked length without extension agreement |
| Card declined or requires authentication | Mark collection pending and provide supported payment recovery | Payout pending client payment under proposed pilot rule | Never represent failed collection as paid or repeatedly create new charges |
| Duplicate charge | Return duplicate amount after confirmation | Preserve the one legitimate payout | Match charges and transfers to a stable call identity |
| Refund requested after payout | Review refund and expert compensation as separate decisions | Do not automatically claw back a completed payout | Record refund amount, reason, decision maker, payout status and recovery decision |
| Charge disputed through payment provider | Flag for operator review; no automatic repeat charge | Hold any not-yet-issued disputed payout pending decision | Reconcile provider events; a dispute is not proof of expert fault |

These exceptions override the normal minimum only after a recorded decision. Do not treat the minimum as authorization to bill an unperformed call.

## Booking, moving, and cancellation semantics

Proposed: **cancel ends this booking; move preserves it**. Cancellation should not silently start another scheduling sequence. Offer an explicit “Find another time” action afterward.

- A successful cancellation stops reminders and invalidates public booking actions, cancels the meeting where possible, and sends separate cancellation notices/ICS files to each party.
- Record cancellation even if Zoom or email is unavailable. Queue recovery; show notification status accurately.
- A reschedule retains the booking identity and history. Proposed: one mutually accepted move is free; a unilateral move inside 24 hours is treated as late cancellation unless waived. Prevent moving a call far ahead and immediately cancelling to evade the cutoff.
- Cancellation does not undo an identity disclosure that already happened. Preserve a server-owned historical reveal fact; do not derive access solely from the new terminal status.
- Concurrent cancel/book/move requests must resolve to one authoritative outcome before external side effects occur.

## Rate, duration, and money records

Snapshot agreed client rate, expert rate, booked duration, policy version and acceptance time on the booking. Never recalculate an old obligation from a newly edited profile or pricing table.

Maintain separate facts for attendance, billable duration, client collection, client refund, expert compensation owed, expert transfer and transfer recovery. One `status` value cannot accurately represent all of them.

Proposed duration basis: minutes with both parties participating, rounded up once for the call, excluding waiting and disconnected time. Apply the ordinary 15-minute minimum only to eligible completed calls; cancellation compensation is a distinct line item. Where attendance evidence is missing, require review rather than silently treating meeting elapsed time as billable participation.

Use integer cents internally. Decide whether to preserve today's whole-dollar rounding or change it before rollout; use one explicit rule on receipts and payouts. Do not silently change pricing while implementing cancellation.

Proposed payout target: initiate within two business days after successful client collection and resolution of any flagged exception. Describe initiation separately from bank arrival. Decide whether ExpertMatch guarantees compensation when the client fails to pay; current collection-dependent payout behavior does not answer that policy question.

## Expert acknowledgement and client disclosure

Before confirmation, show each party their own rate, scheduled length, cancellation/no-show rules and payment expectations. Never disclose the other side's rate or private contact details.

Record versioned acknowledgement: booking ID, policy version, timestamp and the authenticated user or verified expert token that accepted. A changed policy must not silently alter an existing booking. Present a short expert acknowledgement of relevant firsthand experience and permission to participate without confidential disclosures; final agreement wording requires separate review.

Proposed pilot complaint window: within 48 hours after the call. Provide an obvious support/report action. This is a service-review target, not an attempt to remove any applicable external rights or provider dispute process.

## Decisions for the founder

1. Approve or change **24-hour free cancellation, 15-minute late/no-show compensation, 10-minute waiting period**.
2. Should expert pay depend on successful client collection, or does ExpertMatch guarantee it for a valid completed call?
3. Who funds compensation after an ExpertMatch failure or an incorrect match: ExpertMatch, client, expert, or case-by-case?
4. Approve cancellation ending the booking, and the proposed rescheduling exception.
5. Approve the complaint window and payout initiation target; decide ordinary rounding and extension consent.

Recommended first decisions: 1 and 2, because they determine the most important state transitions and financial exposure. No answer is assumed from silence.

## Engineering sequence after decisions and branch reconciliation

1. Write a pure policy evaluator: scenario + evidence + accepted policy version -> proposed charge, expert amount, next state and review reason. No network calls.
2. Add durable policy acceptance and call-specific money/attendance records using the identity established in the audit repairs.
3. Implement owner/staff cancellation and expert token cancellation with authorization, replay protection and concurrency control. Separate the decision from Zoom/email/Stripe execution.
4. Add reliable notification and financial side-effect processing with idempotency, retry state and reconciliation; reuse the repair work.
5. Add a minimal staff exception screen showing evidence, proposed outcome and approve/waive actions. Every override records actor and reason.
6. Update both parties' booking copy, receipts and terms consistently; exercise sandbox flows before enabling charges under the new rules.

## Acceptance cases

- Cancellation exactly 24 hours before start versus one second inside the window; UTC and daylight-saving boundaries.
- Client absent but expert waiting; expert absent; both absent; telemetry unavailable.
- Eight-minute ordinary completed call versus eight-minute confirmed scope mismatch; distinct minimum treatment.
- Reconnect intervals and multiple devices do not double-count participation.
- Unapproved overrun is not silently billed; approved extension is reflected on both sides.
- Duplicate and out-of-order webhooks, retries after database failure, and simultaneous cancel/move calls cannot duplicate fees or payouts.
- Paid expert plus client refund produces a reviewable recovery decision, not an accidental second payout or unapproved clawback.
- Cancellation stops nudges and invalidates booking actions without leaking contact details.
- Collaborator, unrelated user and trial account cannot incur charges or mutate another booking.
- Every monetary result can be traced to accepted rates, evidence and a policy version.

## Change log

- 2026-09-09: Initial proposal created. Documentation only; no application, account, scheduling or payment behavior changed.

# ExpertMatch Repair Plan

*Written 2026-09-09 by the lead (Fable 5.1) for Opus 5 builder agents. Source of truth for every finding referenced here (C-n, H-n, M-n, L-n) is `ARCHITECTURE-AUDIT.md`; the system map is `ARCHITECTURE.md`. Read both before touching anything. Product rules are in `CLAUDE.md` and `docs/MATCHY_SPEC.md`.*

This plan is executed in waves, in the order written. A wave does not start until the previous wave has passed the lead's verification gate. Inside a wave, briefs run in parallel and every brief owns a disjoint set of files.

---

## Part A. Operating rules for every builder

These rules are not advice. A brief that breaks one is rejected and redone.

### A1. Where and how you work
1. Work only in the worktree the lead names in your task. Run every command from there. Never `cd` to the main checkout, never touch another worktree.
2. Read, in this order, before writing a line: your brief in this file; the finding blocks it cites in `ARCHITECTURE-AUDIT.md`; the file headers of every file on your WRITE list; the section of `ARCHITECTURE.md` that covers your flow. The code is heavily commented on purpose. If a comment and your plan disagree, stop and re-read; the comment is usually right about intent.
3. Edit only files on your WRITE list. If the fix truly needs another file, stop and report; do not edit it. Shared files (`types.ts`, `lib/projectStore.ts`, `lib/pricing.ts`, `lib/redactExpert.ts`, `lib/emailSequence.ts`, `supabase/migrations/*`, all `*.md`) are lead-owned unless your brief lists them.
4. Never run `git commit`, `git add`, `git stash`, `git checkout`, `git reset`, `git push`. The lead commits. Never run `npm run dev` or a bare `next build` in a shared tree.
5. Never read `.env.local` or `.env.production.local`. Never put a secret in code, a comment, a test fixture or a report.
6. Do not introduce a dependency. If you believe one is unavoidable, stop and report.

### A2. How to change code
7. Smallest correct change. No drive-by refactors, renames, reformatting, or "while I was here" edits. If you see something else wrong, put it in your report under "Observed, not changed".
8. Preserve the existing structure: the same guard helpers (`routeAuthGuard`, `adminGuard`, `orgAdminGuard`, `guardMutatingRequest`, `requireProjectOwner`), the same store functions (`getProjectForUser`, never `getProject` in a route), the same redaction on every response (`redactExpertForViewer` / `redactProjectForViewer`), the same send chokepoint (`sendSequenceEmail`). Do not invent a parallel mechanism.
9. Every route that writes must keep answering with the same status codes and JSON error shapes it does today unless the brief says otherwise. Clients (`app/projects/[projectId]/page.tsx`, `lib/matchyClient.ts`) key off those strings.
10. No `any`. No `console.log` of email addresses, names, brief text, tokens or Stripe ids; use the existing count-only or pseudonymised logging pattern in the file you are in.
11. Money rule: `expertRate` and `clientRate` are written together through `rateFieldsFor`, never one alone. The two numbers never appear in one message. Only `lib/pricing.ts` converts.
12. Blinding rule: anything new that reaches a client goes through `redactExpertForViewer`; anything new that reaches an expert contains no client name, firm, project name, research question verbatim or client rate.
13. Fail-open versus fail-closed: expert-facing public routes fail open on Redis (Session 7 rule). Credential paths and suppression checks fail closed. Do not flip a policy your brief does not name.
14. When you update behaviour that a comment describes, update the comment in the same edit. A stale comment is a bug.

### A3. How to prove it
15. Every brief adds or extends a script under `scripts/` (there is no test runner; scripts are plain programs run with `npx tsx scripts/<name>.ts` that hand-roll `check()` and exit non-zero on failure; copy the pattern from `scripts/test-pricing.ts`). The test must fail on the old code and pass on the new code. Say in your report which check fails before your change.
16. Before reporting, run all of: `npx tsc --noEmit 2>&1 | grep -v '^\.next/'` (must print nothing once Wave 0 has landed), your own script, and every script listed under "Regression scripts" in your brief. Paste the last line of each.
17. Do not run `scripts/smoke-cutover.ts` (it logs the founder out), `scripts/wipe-projects.ts`, `scripts/seed-admin.ts`, `scripts/verify-sourcing-prod.ts` or `scripts/e2e-matchy.ts` against production. `e2e-matchy` may be run only against a local dev server the lead starts, with `SMOKE_BASE_URL=http://localhost:3000`.

### A4. Your report (mandatory, exact headings)
```
## Brief: <id>
### Files changed
<path>: <one line what changed>
### The change, in three sentences
### Acceptance criteria
<each criterion from the brief, PASS/FAIL, with the evidence line>
### Commands run
<command> -> <last output line>
### Failing-before / passing-after
<the check name that fails on old code>
### Observed, not changed
### Open questions for the lead
```

---

## Part B. Lead protocol (what the lead does, so builders know the gate)

- Lead branches `fix/wave-<n>` from `main` after the founder has committed the WIP that the docs branch snapshots (see memory note; the docs branch rebases onto it). If that has not happened, the lead branches from `docs/architecture-map` and warns the founder.
- Lead writes one worktree per builder, hands out this file, and starts nothing else in those trees.
- Gate after each wave: `npx tsc --noEmit` clean; every `scripts/test-*.ts` and `scripts/check-redaction.ts` green (the two `test-matchy-templates` failures are cleared in Wave 0); clean-export `npm run build:local` green; local `e2e-matchy` ALL PASSED; diff review of every brief against its acceptance criteria; then commit by brief, push, poll the deployment, run `SMOKE_BASE_URL=https://expertmatch.fit npx tsx scripts/e2e-matchy.ts`.
- Anything touching migrations is handed to the founder as a paste-into-Studio step with a `verify-schema` follow-up. Code that needs a column must tolerate the column being absent until then (existing pattern: `system_events`, `weekly_windows`).

---

## Part C. Wave 0: make it compile (one builder, 30 minutes)

### Brief W0-1: undefined `firm` (C-2) and the stale template test (M-48)
WRITE: `app/api/schedule/[token]/route.ts`, `app/api/inbound-email/route.ts`, `scripts/test-matchy-templates.ts` (only if the decision below says the test is wrong), `lib/matchyTemplates.ts` (only if the decision says the code is wrong).
READ-ONLY: `lib/firmStore.ts`, `lib/matchyTemplates.ts`.

Change:
1. `app/api/schedule/[token]/route.ts` GET handler, immediately after `const { project, pe } = resolved;`: add `const firm = await getFirm(project.firmDomain).catch(() => null);` (the import already exists; `handleUnavailable` at ~:356 is the model). Then the existing `deriveTopic(project, { denyTerms: firm?.name ? [firm.name] : [] })` compiles unchanged. Update the comment block above it that describes the break.
2. `app/api/inbound-email/route.ts` `advanceInterested`, the `buildFollowUpEmail` call at ~:820: replace `firm?.name ? [firm.name] : []` with `context.clientFirmName ? [context.clientFirmName] : []` where `context` is the `ThreadContext` already passed in or in scope (check the function signature; if `context` is not in scope, thread it through the same way `advanceCounterRate` receives it; do not call `getFirm` a second time). Delete the comment block that documents the break; replace it with one sentence saying the firm name is the deny term.
3. Run `npx tsx scripts/test-matchy-templates.ts`. Two checks fail: "structured industry + function wins" and "empty question falls back to industry". Read `deriveTopic` and the test expectations, then read HANDOFF.md Session 7 BUG 2 (first-sentence-only change). Decide: if `deriveTopic` still consults `industry`/`function` when the research question is empty and the test merely predates the first-sentence rule, fix the test; if the structured fallback was accidentally removed, restore it in `deriveTopic`. State the decision and the evidence in your report. The test must end 105/105.

Acceptance: `npx tsc --noEmit` prints nothing; `test-matchy-templates` 105/105; `npm run build:local` (lead runs it) succeeds; `GET /api/schedule/<valid token>` returns 200 with a `topic` string (lead verifies via local e2e).
Regression scripts: `test-matchy-templates`, `test-scheduling`, `test-walkthrough`.

---

## Part D. Wave 1: the four Criticals (four builders, disjoint files)

### Brief W1-1: client-writable money and contact fields (C-1, H-1)
WRITE: `app/api/projects/[projectId]/experts/[expertId]/route.ts`, new `scripts/test-expert-route-authz.ts`.
READ-ONLY: `lib/projectsGuard.ts`, `lib/projectStore.ts` (`rateFieldsFor`), `lib/createAndSendInvoice.ts`, `lib/expertPayout.ts`, `scripts/e2e-matchy.ts`.
DO NOT TOUCH: `lib/projectsGuard.ts` (`requireProjectOwner` stays owner-or-admin; other routes depend on it).

Change:
1. Introduce a third tier in the route: `STAFF_ONLY_FIELDS = ['expertRate','expertCounterRate','clientCounterRate','counterRateProposed','callDurationMin','invoiceAmount','paymentStatus','paidAt','stripePaymentLinkId','stripePaymentLinkUrl','stripePaymentIntentId','stripeTransferId','expertPaidAt','expertOnboardingStatus','stripeConnectAccountId','contactEmail','emailProvider','emailVerificationStatus','emailCheckedAt','contactStatus','outreachToken','availabilityTokenHash','availabilityTokenExpiry','calendarAccessToken','calendarRefreshToken','oauthState','zoomMeetingId','zoomJoinUrl','zoomStartUrl','scheduling','booking','nudges']`. If any of these keys is present in the body and `role !== 'admin'`, answer `403 { error: 'read_only', field: <name> }` (reuse the existing 403 shape the route already uses for collaborators; add `field`). Check this BEFORE the owner check so an owner is refused with the same status as a collaborator.
2. Rename the current `OWNER_ONLY_FIELDS` to `OWNER_FIELDS` containing only what an owner may still write: `status` (still restricted by `CLIENT_WRITABLE_STATUSES` for non-admins), `screeningStatus`, `userNotes`, `rejectionReason`, `rejectionNotes`, and whatever else is currently owner-writable and not in the staff list. Update the file header (lines ~11-25) and the comment at ~92-98 to describe the three tiers accurately.
3. `contactEmail`, when written by an admin, must pass an email-shape check (reuse `isValidEmailSyntax` from `lib/contactDiscovery.ts` if importable without a cycle; otherwise a local regex) and be lower-cased; anything else is `400 { error: 'invalid_contact_email' }`.
4. Do not touch the `expertRate` → `rateFieldsFor` code path; admins keep using it.

Test (`scripts/test-expert-route-authz.ts`): unit-level, no network. Export the pure classification helper you write (e.g. `classifyBodyFields(body, role)` returning `{ staffOnly: string[], ownerOnly: string[] }`) and assert: owner body `{expertRate: 1}` → refused; `{paymentStatus:'paid'}` → refused; `{stripePaymentIntentId:'pi_x'}` → refused; `{contactEmail:'x@y.com'}` → refused; `{userNotes:'ok'}` → allowed; admin with all of the above → allowed; `contactEmail` shape validation cases. At least 20 checks.
Also add to `scripts/e2e-matchy.ts` (READ-ONLY for you; write the exact assertion you want in your report and the lead adds it): owner `PUT .../experts/[id] {expertRate: 1}` → 403 on the live project.

Acceptance: an owner session cannot change any money, Stripe, contact, token, calendar, Zoom, scheduling, booking or nudge field; admin behaviour unchanged; existing UI flows (notes, reject, client_ready) still 200; `check-redaction` and `test-walkthrough` green; header comment matches the code.
Regression scripts: `check-redaction`, `test-walkthrough`, `test-pricing`.

### Brief W1-2: per-recipient ICS (C-3)
WRITE: `lib/bookCall.ts`, `lib/generateIcs.ts` (only if an `organizer` option is needed), new `scripts/test-booking-ics.ts`.
READ-ONLY: `lib/sendAvailabilityRequest.ts` (`sendBookingEmail`), `lib/redactExpert.ts`, `app/api/projects/[projectId]/experts/[expertId]/booking/ics/route.ts`.

Change:
1. In `sendConfirmations`, build TWO `IcsEvent`s from the same `uid`, `sequence`, `startUtc`, `endUtc`, `joinUrl`: the expert's copy with `attendees: [pe.contactEmail]` only, the client's copy with `attendees: [clientEmail]` only. Same UID and SEQUENCE keep the move-as-update behaviour; the attendee list is not needed for that (RFC 5545 updates key on UID+SEQUENCE). Add the ExpertMatch sending address as ORGANIZER on both if `generateIcs` supports it; if it does not, add an optional `organizer` field to `generateIcs` with a one-line comment, default omitted.
2. Make `bookingIcsEvent` (the on-demand client download) and the client's emailed copy produce byte-identical ATTENDEE lines (both client-only). Confirm `rebookCall` passes through the same function so a moved call sends per-recipient copies too.
3. Replace the long "ONE ICS OBJECT, TWO RECIPIENTS" comment with a short one stating the rule: each recipient's invite lists only that recipient.
4. Verify the SUMMARY/DESCRIPTION of both copies name no client firm or project (grep `buildIcsEvent` inputs; `expertName` is fine on the client copy only after reveal, which booking guarantees). If the expert's copy currently carries the expert's own name in the title that is fine; if it carries anything client-identifying, remove it and note it.

Test (`scripts/test-booking-ics.ts`): call the pure builders with a fixture expert (`contactEmail: 'expert@example.com'`) and client `client@firm.com`; assert the expert copy's ICS text contains `mailto:expert@example.com` and does not contain `client@firm.com` or `firm.com`; the client copy contains `mailto:client@firm.com` and not `expert@example.com`; both share UID and SEQUENCE; a rebook increments SEQUENCE on both. At least 12 checks.

Acceptance: no email address crosses sides in any ICS; move-the-call still updates rather than duplicates (lead verifies in the browser pass); `test-scheduling` green.
Regression scripts: `test-scheduling`, `check-redaction`.

### Brief W1-3: Zoom webhook replay, completion guard, NaN duration (C-4, M-35)
WRITE: `app/api/webhooks/zoom/route.ts`, new `scripts/test-zoom-webhook.ts`.
READ-ONLY: `lib/createAndSendInvoice.ts`, `lib/zoomLookup.ts`, `lib/pricing.ts`, `lib/projectStore.ts`.
DO NOT TOUCH: the billing guard in `createAndSendInvoice.ts` (W1-4 owns it).

Change:
1. Replay window: after signature verification, parse `ts` as an integer of seconds; if it is not finite or `Math.abs(Date.now()/1000 - ts) > 300`, answer `400 { error: 'stale_timestamp' }`. Do this before the URL-validation short-circuit? No: the `endpoint.url_validation` branch stays first and unchanged (Zoom's handshake), the window applies to every signed event after it.
2. Completion guard: in the `meeting.ended` branch, after `findProjectExpertByZoomMeetingId`, load the row's current `zoomMeetingEndedAt` and `status`; if `zoomMeetingEndedAt` is already set or `status === 'completed'`, log a count-only line and return 200 without writing or invoicing. Extract the branch body into a pure function `resolveMeetingEnd(obj, now, existing)` returning `{ skip: true, reason } | { skip: false, actualDurationMin, endedAt }` so it is testable.
3. Duration: if `start_time` is missing or unparseable (`!Number.isFinite(startTs)`), do not compute; fall back to `pe.booking?.durationMin` when present, else return `{ skip: true, reason: 'no_duration' }` and record `recordSystemFailure({ area: 'invoice', reason: 'zoom_end_without_duration', projectId, expertId })` (import from `lib/engagementEvents.ts`; it never throws). Never write NaN.
4. Keep "always 200 after signature" semantics for handled events; the only 4xx additions are the stale timestamp and the existing signature errors.

Test (`scripts/test-zoom-webhook.ts`): export and test `resolveMeetingEnd` and a pure `isFreshTimestamp(ts, now)`: fresh vs 6-minute-old vs garbage; ended-already skip; completed-already skip; NaN start with booking fallback; NaN start without booking → skip; normal 47-minute call → 47. At least 15 checks.

Acceptance: a captured `meeting.ended` replayed after 5 minutes is rejected; a redelivered one inside 5 minutes is a no-op after the first; duration is never NaN; `tsc` clean.
Regression scripts: `test-pricing`, `test-org-billing`.

### Brief W1-4: per-call billing identity (H-8, and the second half of C-4)
WRITE: `lib/createAndSendInvoice.ts`, `lib/chargeSavedCard.ts`, `app/api/projects/[projectId]/experts/[expertId]/complete/route.ts`, `types.ts` (ONLY to add the two optional fields named below), new `scripts/test-billing-guard.ts`.
READ-ONLY: `lib/bookCall.ts` (`booking.icsUid`), `app/api/webhooks/zoom/route.ts`, `lib/expertPayout.ts`, `app/api/webhooks/stripe/route.ts`.

Change:
1. Define the call identity: `callId = pe.booking?.icsUid ?? pe.zoomMeetingId ?? null`. The manual complete route, when neither exists, generates `manual:<projectId>:<expertId>:<Date.now()>` once and persists it (see 3). Both the Zoom path and the manual path must pass `callId` into `createAndSendInvoice`.
2. `chargeSavedCard`: idempotency key becomes `charge:${projectId}:${expertId}:${callId}`. Update the comment at ~:152-160.
3. `types.ts` `ProjectExpert`: add `billedCallId?: string | null` (the call id the current `paymentStatus` / `stripePaymentIntentId` refer to) and `callId?: string | null` (set by the manual route when it invents one). Two lines plus comments; nothing else in `types.ts`.
4. Durable guard in `createAndSendInvoice`: replace `if (pe.paymentStatus === 'paid' || pe.stripePaymentIntentId)` with: skip only when `pe.billedCallId === callId` AND (`paid` or an intent exists). If `billedCallId` differs (a new call), proceed and, on charge, write `billedCallId: callId` alongside `stripePaymentIntentId`, and reset `paymentStatus` to `'unpaid'` before charging so the webhook's `paid` write refers to the new call. Rows with no `billedCallId` (pre-existing) are treated as `billedCallId === callId` if they already have `paid`/intent, so nothing already billed is re-billed on deploy. Write this migration-free compatibility rule as a comment.
5. Expert payout: `runExpertPayout` (READ-ONLY here) keys on `stripeTransferId`; with repeat calls it would never pay the second. Do NOT change it; report the exact line and the proposed `paidCallIds` approach for Wave 2 (H-6 owner).

Test (`scripts/test-billing-guard.ts`): export a pure `shouldSkipBilling(pe, callId)` and `chargeIdempotencyKey(projectId, expertId, callId)`; assert: first call charged; same call re-completed (Zoom + manual) skipped; second call with a new `icsUid` charged; legacy row with `paid` and no `billedCallId` skipped for any callId; key contains callId. At least 12 checks.

Acceptance: the same call can never be charged twice through any path; a genuine second call is charged; existing paid rows are untouched; `test-pricing` green; `test-org-billing` green.
Regression scripts: `test-pricing`, `test-org-billing`, `test-entitlements`.

### Wave 1 gate additions (lead)
- Local `e2e-matchy` plus a new assertion: owner `PUT {expertRate:1}` → 403.
- Browser pass with a throwaway client: book a call (needs the Zoom S2S app), download the ICS, open the emailed ICS on both sides, move the call, confirm one event updated on each calendar.

---

## Part E. Wave 2: the Highs, grouped by area (six builders, disjoint files)

Every brief here follows the same shape as Wave 1. Findings named in brackets are the spec; the audit block has the exact lines.

### Brief W2-A: outbound email integrity (H-2, H-3, H-4, M-29, M-30, L-outreach dead code deferred)
WRITE: `lib/emailSequence.ts`, `lib/outreachSteps.ts`, `app/api/projects/[projectId]/experts/[expertId]/messages/route.ts`, `.../messages/[messageId]/send/route.ts`, `.../rate-decision/route.ts`, `.../outreach/approve/route.ts`, `scripts/test-walkthrough.ts` (extend), new `scripts/test-send-chokepoint.ts`.
READ-ONLY: `lib/outreachSuppressions.ts`, `lib/matchyScheduling.ts` (:1042 send site, report only), `app/api/inbound-email/route.ts` (W2-B owns), `lib/contactDiscovery.ts`.

Change:
1. `sendSequenceEmail`: after the walkthrough and entitlement gates and before building the From address, call `isSuppressed(to)`; if not `ok` or suppressed, return `{ sent: false, held: 'suppressed' }`. Widen the `SendOutcome` `held` union by `'suppressed'`. Keep every existing call-site check as early-exit UX.
2. Send-once guard for the intro: in `runSequenceStep`, when `step === 'intro'` and `pe.email1SentAt` (or `outreachStep === 'email1'`) is already set, return `{ ok: true, alreadySent: true }` without sending. Reorder the post-send writes: write `{ status: 'contacted', email1SentAt, outreachToken }` FIRST (through `updateExpertStatus`, which is a compare-and-set), then the Redis reply-token index; if the status write loses its CAS three times, do not send. Yes, this means a send can happen after a status write whose send then fails; handle it by writing `email1SentAt: null, status: previous` in the catch and returning `step_failed`. Document the ordering in the function comment.
3. The three routes that discard `SendOutcome` (`messages` POST, `messages/[id]/send`, `rate-decision`): read it. On `sent: false`, store the message with `held: outcome.held` in `screen_result` (same shape `inbound-email` uses), do not clear `pending`, do not advance status, do not write the agreed rate for `rate-decision` (rate write happens only after `sent: true`), emit no `rate_offered`/`rate_agreed` event, and answer `200 { ok: true, held: outcome.held }` so the UI renders the held line (it already handles `held` for walkthrough).
4. `messages/[messageId]/send` atomicity: clear `pending` with a conditional update BEFORE sending (in `lib/conversations.ts`? No, that file is lead-owned: use the existing `updateMessage` if it can take a filter; if it cannot, stop and report the exact signature you need and the lead will add `clearPendingIfPending(id)` to `lib/conversations.ts`). Treat zero rows updated as `409 not_pending`.
5. `outreach/approve`: pass `firmName: firm?.name ?? null` to `runSequenceStep`, matching the bookmark route.

Tests: `test-send-chokepoint.ts` with an injected suppression reader and an injected Resend stub: suppressed → held, not sent; walkthrough → held; live → sent; intro twice → second is `alreadySent`. Extend `test-walkthrough.ts` for the three routes' held handling if the decision logic is extracted into pure helpers (extract them).
Acceptance: an opted-out address cannot receive any message type; a held rate decision never writes the rate; no duplicate intro is possible from two bookmarks or an approve double-click.
Regression: `test-walkthrough`, `test-entitlements`, `test-matchy-templates`, `test-conversations-redaction`.

### Brief W2-B: inbound email durability and sender authenticity (H-5, M-28, L resend_message_id)
WRITE: `app/api/inbound-email/route.ts`, `scripts/verify-svix.ts` (extend or sibling `scripts/test-inbound-claim.ts`).
READ-ONLY: `lib/conversations.ts`, `lib/matchyClassify.ts`, `lib/emailClean.ts`.

Change:
1. Two-phase claim: `SET inbound-seen:{id} "processing" NX EX 120`; on success of `handleReply` overwrite with `"done" EX 7d`. If the key exists with `"done"` → 200 duplicate. If it exists with `"processing"` → 409 (Resend retries later). On an unexpected throw inside `handleReply`, delete the key and return 500 so Resend redelivers into the window. Keep the fail-open on Redis being unreachable (documented).
2. Read Resend's authentication results from the payload (inspect the actual inbound payload shape in the route's parsing code and the Resend docs the file already references; the field is typically `spf`/`dkim`/`dmarc` under the message or headers). If a result is present and any of DMARC/DKIM is a hard fail, do not act: log count-only, answer 200. If the fields are absent, keep current behaviour and record `recordSystemFailure({ area: 'mail', reason: 'inbound_auth_results_missing' })` once per day (use a Redis key with a 24h TTL) so the founder notices.
3. Store the inbound message id on the row: pass `resendMessageId` into `appendMessage` (the parameter exists).
4. Update the idempotency comment block.

Test: pure `decideClaim(existingValue)` and `senderAuthAllows(payload)` helpers with fixtures.
Acceptance: a mid-processing failure no longer loses the reply; forged-From with failing DKIM is ignored; duplicate delivery after success is a no-op.
Regression: `verify-svix`, `test-matchy-classify`, `test-email-clean`, `test-matchy-screen`.

### Brief W2-C: payouts, refunds, reconcile (H-6, H-7, H-9, H-10, H-23, M reconcile items)
WRITE: `lib/expertPayout.ts`, `app/api/webhooks/stripe/route.ts`, `app/api/jobs/reconcile/route.ts`, `lib/orgBilling.ts`, `lib/stripeConnect.ts`, `types.ts` (ONLY: `payoutReminderSentAt?`, `payoutReminderCount?`, `paidCallIds?: string[]`, `paymentStatus` union gains `'refunded'`), `scripts/test-org-billing.ts` (extend), new `scripts/test-payout-state.ts`.
READ-ONLY: `lib/createAndSendInvoice.ts`, `lib/engagementEvents.ts`, `lib/attention.ts`.

Change:
1. H-6: in `runExpertPayout`, persist `stripeTransferId` in its own `updateExpertStatus` immediately after `transfers.create`, inside its own try; only then write `expertPaidAt`/`expertOnboardingStatus`. In the transfer catch, `recordSystemFailure({ area: 'payout', ... })`. Both sweeps (`retryPendingPayoutsForAccount`, `sweepPayouts`) select `expertOnboardingStatus in ('pending','failed')` with a bounded `payoutAttempts` (add to the row, cap 5). Correct the stale "nothing else retries" comments (:19-21, :252-254).
2. Repeat calls: key the payout guard on `paidCallIds` containing the current `callId` (from W1-4) rather than `stripeTransferId` alone; transfer idempotency key becomes `expert-payout:${projectId}:${expertId}:${callId}`.
3. H-9: `sendOnboardingLink` only when `payoutReminderCount < 4` and `payoutReminderSentAt` is older than 7 days (or unset); increment and stamp. Log count-only.
4. H-7: add webhook branches `charge.refunded` and `charge.dispute.created`: find the engagement by `payment_intent` metadata (`projectId`, `expertId` are on the intent), set `paymentStatus: 'refunded'` (new union member) and `recordSystemFailure({ area: 'invoice', reason: 'refund_or_dispute' })` so it lands on the attention list. No automatic payout reversal: write a `TODO(founder decision)` comment naming the policy question and the `transfers.createReversal` call that would implement it.
5. Webhook de-dup: `SET stripe-event:{event.id} NX EX 7d` in Redis before any branch; on exists → 200. Fail-open on Redis (branches stay idempotent). Comment the header bullet list accordingly.
6. H-10: give each reconcile sweep its own deadline (`Date.now() - startedAt > 18_000` breaks the loop and sets `steps.<name> = 'partial'`), and order the queries with `.order('updated_at', { ascending: true })`. Report `overflow: true` when a full page comes back. Only `recordSystemFailure` for payouts pending beyond 14 days (not every night).
7. H-23: in `orgBilling` subscription create, after `subscriptions.create`, if `patchBillingRow` fails, retry the row write twice, then `recordSystemFailure({ area: 'seat_sync', reason: 'subscription_created_but_unrecorded:<subId last4>' })`; and before creating, list active subscriptions for the customer and adopt an existing one instead of creating a second. Idempotency key gains a daily component only if the founder confirms; default: keep the key and rely on the adopt-existing check.
8. Failed client payments: in `handlePaymentFailed` and `createAndSendInvoice`'s null path (READ-ONLY there: report the line for the lead), `recordSystemFailure({ area: 'invoice' })`.

Tests: `test-payout-state.ts` on pure state transitions (transfer ok + write fail → transfer id kept; reminder throttle; refund transition; dedupe decision). Extend `test-org-billing.ts` for the adopt-existing decision helper.
Acceptance: no payout is ever lost silently or paid twice; refunds change state and alert; the onboarding email is capped; reconcile can never be starved; webhooks are de-duplicated.
Regression: `test-org-billing`, `test-pricing`, `test-entitlements`, `test-nudges`.

### Brief W2-D: auth hardening and revocation (H-14, H-15, H-16, M pending guard, M platform-admin disable, M raw-IP key)
WRITE: `app/api/auth/login/route.ts`, `lib/firmStore.ts`, `lib/auth.ts`, `app/api/org/members/route.ts`, `app/api/jobs/reconcile/route.ts` (ONLY a new `sweepMembershipStatus`; coordinate: W2-C also edits this file, so W2-D adds one exported function in a new file `lib/membershipReconcile.ts` and the lead wires the one call), new `scripts/test-auth-guards.ts`.
READ-ONLY: `lib/supabase/admin.ts`, `lib/passwordReset.ts`, `lib/rateLimiter.ts`.

Change:
1. H-15: add a per-account counter `login-fail:<hmac(email)>` incremented only on failure, 10 per hour; refuse with the same uniform 401 when exceeded (no enumeration). H-14: on Redis failure, `login` (only login) falls back to an in-process `Map<string, {count, resetAt}>` limiter keyed by the HMAC of the IP and of the email; document that it is per-instance and therefore weak but not open. Raw IP key → HMAC via the same helper `lib/passwordReset.ts` uses (extract into `lib/rateLimiter.ts`? that file is READ-ONLY: copy the 4-line helper locally and note the duplication for Wave 4).
2. H-16: `firmStore.upsertUser` returns `{ metadataSynced: boolean }`; `app/api/org/members` PATCH/DELETE answer `200 { ok: true, warning: 'metadata_sync_failed' }` and `recordSystemFailure({ area: 'seat_sync' → new area 'membership' })` (add `'membership'` to `SystemFailureArea` in `lib/engagementEvents.ts`: that file is lead-owned; request the one-line change in your report and code against it). `lib/membershipReconcile.ts`: for every `organization_members` row with `status='disabled'` whose auth user still has `app_metadata.status !== 'disabled'`, call `syncUserMetadata`. Bounded to 500, ordered.
3. `routeAuthGuard` and `adminGuard`: treat `status === 'pending'` as unauthenticated (match `orgAdminGuard`).
4. `org/members` PATCH/DELETE: refuse when the target's `role === 'admin'` (platform admin) unless the caller is a platform admin: `403 { error: 'read_only' }`.

Test: pure limiter decisions (Redis ok, Redis down fallback, per-account cap), guard decisions for pending/disabled/active, target-is-platform-admin refusal. At least 20 checks.
Acceptance: credential stuffing against one account is capped; Redis outage does not open login; disabling a member either syncs or visibly warns and is repaired nightly; pending accounts are refused everywhere.
Regression: `test-signup-token`, `test-email-domains`, `test-entitlements`.

### Brief W2-E: project store concurrency and descriptor validation (H-17, H-18, M rateExpectation leak, M interview-guide guard)
WRITE: `lib/projectStore.ts` (ONLY `updateProject`), `app/api/projects/[projectId]/route.ts` (PUT), `lib/anonymizeExpert.ts`, `lib/redactExpert.ts` (ONLY the key list and a descriptor re-check), `app/api/projects/[projectId]/interview-guide/route.ts`, `scripts/check-redaction.ts` (extend), new `scripts/test-project-update.ts`.
READ-ONLY: `lib/projectValidation.ts`, `lib/matchyScreen.ts` (`maskFindings`, name/company masking helpers).

Change:
1. H-17: `updateProject` takes `(id, patch, expectedUpdatedAt)` and performs `update ... eq('id', id).eq('updated_at', expectedUpdatedAt)` on a MERGED brief (read current brief, merge only the keys in `patch`, never rebuild from a stale full object). Zero rows → throw `project_update_conflict`; the PUT route maps it to the existing `409 brief_conflict`. Keep `updateProjectFields` for jobs. Update the file header.
2. H-18: in `anonymizeExpert.parseFields` and in `redactExpert.anonymizeExpert`, run a `descriptorIsAnonymous(text, expert)` check: reject if it contains the expert's surname, any token of the company name longer than 3 characters, or an email/URL; on rejection fall back to the deterministic descriptor already used as the fallback. Export the helper.
3. Add `rateExpectation` and `availability` to `INTERNAL_PROJECT_EXPERT_KEYS`.
4. `interview-guide`: use `guardMutatingRequest`; validate the model JSON shape (`Array.isArray` + `typeof === 'string'` filter) before rendering; add the per-user rate limit using `createRateLimiterStore` (10 per hour).

Test: `test-project-update.ts` for the merge logic and conflict detection (pure); extend `check-redaction.ts` with descriptor-anonymity cases (surname, company fragment, URL, clean) and the two new stripped keys.
Acceptance: a brief save cannot clobber a concurrent sourcing write; a descriptor naming the employer never reaches a client; guide route cannot be spammed.
Regression: `check-redaction`, `test-walkthrough`, `test-pricing`, `test-conversations-redaction`.

### Brief W2-F: scheduling correctness and sourcing worker (H-20, H-21, H-11, H-12, H-13, M-32 Calendly, M expert manual override)
WRITE: `app/api/availability/[token]/google-auth/route.ts`, `app/api/availability/oauth/google/callback/route.ts`, `lib/fetchGoogleFreebusy.ts`, `app/api/schedule/[token]/route.ts` (ONLY `handleUnavailable`'s provider write), `lib/fetchCalendlySlots.ts`, `app/api/jobs/source-experts/route.ts`, `lib/sourcingJob.ts`, `lib/searchProviders/exa.ts`, `lib/contactDiscovery.ts` (ONLY the provider loop), `lib/validateEnv.ts` (ONLY add `EXA_API_KEY` to OPTIONAL_VARS with a boot warning when no search key exists), new `scripts/test-freebusy-inversion.ts`, new `scripts/test-sourcing-idempotency.ts`.
READ-ONLY: `lib/matchyScheduling.ts`, `lib/calendarConnections.ts`, `lib/rateLimiter.ts`, `lib/generateExperts.ts`.

Change:
1. H-20: expert `CALENDAR_SCOPE` gains `openid email` (consent screen changes; note it for the founder). In the callback, if userinfo still fails, fall back to `pe.contactEmail` as `calendarEmail` with a comment.
2. H-21: `invertBusyToFree` takes a `timezone` and inverts over the whole day in that zone (or simply 00:00 to 24:00 UTC, leaving business hours to `pickProposals`, which already applies 09:00 to 17:00 in the owner's zone). Choose the second: simpler and correct. Update the comment.
3. Expert manual override: in `handleUnavailable`, set `calendarProvider: 'manual'` only when the current provider is absent or already `'manual'`.
4. M-32: test one real public Calendly link by hand (`npx tsx` a scratch call, no code committed) and report whether the unauthenticated API works. If it does not, make `connectionIsUsable` require a successful `fetchEventTypes` probe at connect time and answer `400 { error: 'calendly_unreachable' }` from `POST /api/onboarding/calendar` (that route is READ-ONLY for you: report the exact change; the lead applies it).
5. H-11: `export const maxDuration = 300` on the sourcing worker; `publishSourcingJob` sends `Upstash-Deduplication-Id: sourcing:<projectId>:<sourcingStartedAt>` and the job body carries `runId = sourcingStartedAt`; `runSourcingJob` refuses to write when the project's `sourcingStartedAt !== job.runId` or `sourcingStatus !== 'running'` (conditional via `updateProjectFields` preconditions; if the store cannot express it, read-check then write and document the small window). Two concurrent starts (M TOCTOU) are closed the same way: the start route sets `running` with a conditional update where status is not running.
6. H-12: delete the `[exa] query:` log; keep a count-only line. Also the `firstChars` VCI log in `generateExperts.ts` is READ-ONLY: report the line.
7. H-13: in `contactDiscovery`'s provider loop, call `checkAndIncrementGlobalBudget()` (from `lib/rateLimiter.ts`, READ-ONLY, already exported) before each provider call; on refusal record `skipped_budget` and continue to the next provider; if all skipped, outcome `contact_check_unavailable` with reason `budget`. Fail-open if Redis is down (documented).

Tests: `test-freebusy-inversion.ts` (busy blocks in LA, NY, Singapore → free ranges cover the full local day); `test-sourcing-idempotency.ts` (pure `shouldPersistRun(project, job)` decisions).
Acceptance: West-coast clients get real availability; a connected expert calendar is used; sourcing cannot double-append; brief text never reaches logs; provider spend is capped.
Regression: `test-scheduling`, `test-availability-windows`, `test-contact-discovery`, `test-matchy-client`.

### Wave 2 gate additions (lead)
- `scripts/rls/verify.sql` B1 assertion fixed to 0 rows (lead, one line: H-19) and README status note updated.
- Founder tasks queued: Google consent screen re-verification for the new scope; Stripe webhook events `charge.refunded`, `charge.dispute.created`, `account.updated` (connected); confirm `CRON_SECRET` set; Calendly decision.

---

## Part F. Wave 3: tests for the money and identity paths (three builders)

Purpose: every single point of protection named in "Fragile areas" gets a script that fails when it is removed. No production code changes in this wave except test seams (an injectable client parameter with the real client as default).

### Brief W3-1: `scripts/test-route-authz.ts` (HTTP-level, local server)
Drive a local dev server (lead starts it) with the `e2e-matchy` throwaway-user pattern: owner, collaborator, intruder, admin. Assert for every project/expert route: 404 for intruder, 403 for collaborator on writes, 403 for owner on staff-only fields (W1-1), 200 for admin. Cover `complete` (owner only), `propose-times`, `rate-decision`, `bookmark`, `collaborators` (same org only), `interview-guide`, `DELETE /api/projects/[id]`. At least 60 checks. Safe to run while the founder is logged in (throwaway users only).

### Brief W3-2: `scripts/test-stripe-flows.ts` (Stripe stubbed)
Add a `stripeClient` injection seam to `lib/chargeSavedCard.ts`, `lib/createAndSendInvoice.ts`, `lib/expertPayout.ts`, `lib/stripeConnect.ts`, `lib/orgBilling.ts` and the webhook route's handlers (export `handleEvent(event, deps)`), defaulting to the real client. Then test: charge success path writes intent id and `billedCallId`; declined → payment link; webhook `payment_intent.succeeded` → paid → payout transfer with the right amount and key; duplicate event → no second transfer; `account.updated` → pending payout retried; refund → `refunded` + system event; seat sync creates once, adopts existing, resizes, cancels at zero. At least 50 checks. Also `scripts/test-webhook-signature.ts`: Stripe and Zoom signature verification with real HMAC fixtures, including the stale-timestamp rejection.

### Brief W3-3: `scripts/test-auth-flows.ts` (Supabase stubbed where possible, local server where not)
Invite → set-password → activation (single use, seat-cap-before-redeem, email mismatch refusal), reset (`active` only, no membership write), revocation (disable → `app_metadata` synced → guard refuses), org-admin cross-org scoping (`orgId` of another org → 400), platform-admin target refusal, rate-limit decisions. Password reset flow and account deletion cascade (owner with projects → 409 with names, per M-46). At least 50 checks.

Gate: all new scripts green locally; `npm run security` clean; lead adds the new scripts to the "Verified before each push" list in HANDOFF.md.

---

## Part G. Wave 4: debt (two builders, after Wave 3 is green)

### Brief W4-1: dead code and env drift
Delete, with grep evidence in the report that nothing imports them: `lib/contactPathResolver.ts` (+ `suggestDomainsForExpert`), `lib/replyDetection.ts`, `app/api/email-sequence/trigger/route.ts` plus `scheduleNextEmail`, `generateEmail1`, the `'email1'` branch in `outreachSteps` and the `EmailStep`/`OutreachStep` narrowing, `computeOverlap()`/`scoreSlot`/`formatInTimezone` and the `OverlapResult`/`OverlapSlot` types, `lib/extractDomain.ts`, the four unused rate-limiter tier functions (after W2-F wired `checkAndIncrementGlobalBudget`, keep that one), the six unused `UpstashRedis` set methods, `lib/signupToken.tokenRedisKey/tokenTtlSeconds`, the unused imports (`getProject` in the project route, `isApprovedDomain` in collaborators), `agreedRate`, `contactCandidates` (keep the redaction entry), and the four unused npm packages (`ai`, `@ai-sdk/anthropic`, `nodemailer`, `bcryptjs`) via `npm uninstall`. Middleware: remove `/api/email-sequence/` from PUBLIC_PREFIXES. `validateEnv`: remove `SESSION_SECRET`, `CONTACT_ENRICHMENT_ADMIN_TOKEN`, `GOOGLE_CALENDAR_REFRESH_TOKEN`, `STRIPE_CONNECT_CLIENT_ID` from REQUIRED_VARS and `.env.example`; add every read-but-undocumented variable to OPTIONAL_VARS and `.env.example` with one-line purposes (list in M-51). Update `scripts/rls/README.md` route audit and `SECURITY_AUDIT.md` references. Build must pass from a clean export.

### Brief W4-2: consolidation
`lib/hmacToken.ts` with `sign(payload, purpose)` / `verify(token, purpose)` and one constant-time compare; migrate `optOutToken`, `outreachToken`, `availabilityToken`, `onboardingOauthState` and the inline expert OAuth state to it (keep each module's payload shape and expiry; tokens already in the wild must still verify: prove it with fixtures generated by the OLD code before you change it). One `secretMatches` in `lib/auth.ts` used by both cron routes. One `pseudonymize` (`lib/contactCache.ts`) used by inbound-email. One `scripts/testHarness.ts` exporting `check`/`eq`/`summary`, adopted by every test script. `PROVIDER_MAP` deduplicated. `database.types.ts` gains `system_events`, `product_events` check and `weekly_windows`; the cast in `engagementEvents.ts` removed. Partial indexes migration for `projects((brief->>'sourcingStatus'))`, `project_experts(status)`, `project_experts((data->'nudges'->>'scheduledFor'))` handed to the founder. Ops scripts (`wipe-projects`, `seed-admin`, `smoke-cutover`) print the resolved host and refuse unless `ALLOW_PROD=1` when the host is not localhost or a known dev project.

---

## Part H. Explicitly deferred (founder decisions needed first)

- Cancel-booking route (status after cancel; HANDOFF Session 6).
- Payout reversal on refund (W2-C leaves a TODO).
- Whether ordinary members may save the firm's first card (M, billing route).
- Calendly: fix or remove (W2-F reports the probe result).
- Trial-seat product work (`TASK_QUEUE.md` NEXT BUILD) stays separate from this plan.
- Legal placeholders in `app/terms/page.tsx`.

## Part I. Definition of done for the whole plan

- All four Criticals and all 23 Highs closed or explicitly deferred above, each with a script that fails on the old code.
- `npx tsc --noEmit` clean; every script under `scripts/` green; `scripts/rls-verify.sh` green on a fresh database; clean-export `build:local` green; prod `e2e-matchy` ALL PASSED; browser pass of booking, move, complete and refund with throwaway users in Stripe test mode.
- `ARCHITECTURE-AUDIT.md` updated by the lead with a "Status 2026-09-xx" column per finding; `ARCHITECTURE.md` sections 6.7, 6.8 and "Fragile areas" revised for the new guards.
- Nothing pushed to `main` without the founder having first committed the WIP the docs branch snapshots.

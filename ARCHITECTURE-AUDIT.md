# ExpertMatch architecture audit

**Date:** 2026-09-08
**Scope:** the whole first-party codebase at branch `docs/architecture-map`, which is `main@0d1dd1b` plus a snapshot of the uncommitted work in progress (commit `a9e0547`, 67 files changed, +2679/-450). Third-party code under `node_modules` was not audited.
**Method:** a comment-only annotation pass over the repository, split into fourteen directory batches (config, auth, database, shared libs, projects, sourcing, contact discovery, outreach, scheduling, background jobs, billing, frontend, admin, scripts). Each batch read every file in its slice, traced the request and job flows end to end, and recorded findings. Every finding below was verified against the code that produces it, and duplicates raised by more than one batch have been merged into a single entry citing all the files involved.

**Nothing was fixed.** No behaviour, type, schema, or configuration was changed. Every edit in the tree from this pass is a comment.

**Pre-task and post-task test and build state (identical before and after the annotation pass):**

- `npx tsc --noEmit` reports 4 errors, all pre-existing and all from the uncommitted WIP: `Cannot find name 'firm'` twice in `app/api/inbound-email/route.ts` and twice in `app/api/schedule/[token]/route.ts`.
- `npm run build:local` fails for the same reason. The project does not compile, so nothing can deploy.
- `scripts/test-matchy-templates.ts` fails 2 of 105 checks (`deriveTopic` structured-field preference).
- Every other unit script under `scripts/` passes: pricing (251), nudges (219), scheduling (171), availability windows (109), contact discovery (81), redaction, conversations redaction, brevity, classify, screen, email clean, email domains, entitlements, matchy client, org billing, signup token, walkthrough.
- `npx tsc -p scripts/tsconfig.json --noEmit` reports 5 further pre-existing errors, all Stripe type-namespace and implicit-any issues in `lib/orgBilling.ts` and `lib/stripe.ts`.

## Overall picture

ExpertMatch is a Next.js 14 App Router application on Vercel with Supabase Postgres as the source of truth, Stripe for client billing and expert payouts, Resend for all mail in both directions, Upstash Redis and QStash for caching, rate limiting and background work, Zoom for the calls, and Google Calendar plus Calendly for availability. The product's central promise is a blinding boundary: the client never learns who the expert is until a call is genuinely booked, the expert never learns who the client is, and neither side ever sees the other side's rate. That boundary is implemented almost entirely in application code. The WIP migration `20260908000000_identity_boundary_trial_events.sql` drops all thirteen row-level-security policies on `projects`, `project_members`, `project_experts` and `conversation_messages` and recreates none, which is a genuine tightening (a read-only collaborator could previously UPDATE and DELETE expert rows straight through PostgREST) but which also means `lib/projectStore.canAccess` and `lib/redactExpert.ts` are now the only things standing between one customer's data and another's. The code is unusually well documented for its age and the flows are coherent, but the audit found a consistent pattern: single points of protection with no test behind them, money paths whose idempotency depends on read-then-write ordering rather than a constraint, several fail-open controls on the credential path, and an outbound-email surface where the one chokepoint that could enforce suppression does not. The tree also does not currently compile, and the branch that would fix that is a two-line change in two files.

## Summary

| Severity | Count |
| --- | ---: |
| Critical | 4 |
| High | 23 |
| Medium | 51 |
| Low | 51 |
| **Total** | **129** |

### The ten that matter most

1. **C-1** A plain project owner (role `user`) can write `expertRate`, `paymentStatus` and the Stripe id fields through `PUT /api/projects/[projectId]/experts/[expertId]`, setting both sides of the money and suppressing the charge entirely.
2. **C-2** `firm` is undefined in `app/api/schedule/[token]/route.ts` and `app/api/inbound-email/route.ts`. The build fails, and if shipped the expert's picker page 500s on every load.
3. **C-3** The booking `.ics` is shared between both parties, so the client's invite carries the expert's `contactEmail` and the expert's invite carries the client's address. This is the exact disintermediation the product exists to prevent.
4. **C-4** The Zoom webhook has no replay window and no completion guard, so a redelivered `meeting.ended` re-completes the engagement and re-invoices. Only the durable guard inside `createAndSendInvoice` stops a second charge.
5. **H-1** The project owner can also write `contactEmail`, redirecting Matchy's intro email to an address they control.
6. **H-3** The global do-not-contact list is not enforced at the outbound chokepoint, and four send paths omit the check entirely.
7. **H-2** Two concurrent bookmarks, or a post-send bookkeeping failure, can send two cold intro emails to the same stranger.
8. **H-6 / H-7** A Connect transfer whose database write fails is marked `failed` and no sweep ever revisits it, and there is no refund, dispute or payout-reversal handling anywhere in the repository.
9. **H-16** `firmStore.upsertUser` swallows the `app_metadata` sync failure, so disabling a departing employee can silently fail while returning success. This is the revocation path.
10. **H-19** `scripts/rls/verify.sql` has one stale assertion left over from the policy drop, so the project's own cross-account isolation proof now exits non-zero against a correct database.

## Critical

**C-1**

```text
Finding: The project owner (a normal client, role 'user') can write expertRate, paymentStatus, paidAt and the Stripe id fields through PUT /api/projects/[projectId]/experts/[expertId], setting both sides of the money and suppressing the charge.
Severity: Critical
File(s): app/api/projects/[projectId]/experts/[expertId]/route.ts:139-146 (the gate), :252-259 (rate validation), :263-275 (payment-field validation); lib/projectsGuard.ts:172-174 (requireProjectOwner); lib/projectStore.ts rateFieldsFor; lib/createAndSendInvoice.ts:276; app/api/projects/[projectId]/experts/[expertId]/complete/route.ts:88; lib/expertPayout.ts:173
Relevant function/component: PUT, requireProjectOwner, rateFieldsFor, createAndSendInvoice
What happens: The route's OWNER_ONLY_FIELDS list and header read as "staff only", but the gate is requireProjectOwner, which returns null for session.role === 'user' whenever project.ownerEmail === session.email. A client who owns the project can therefore send {"expertRate": 1} and the route accepts any number from 1 to 9999, writing {expertRate: 1, clientRate: clientRateFor(1)}. The same route accepts paymentStatus: 'paid' and an arbitrary stripePaymentIntentId; createAndSendInvoice short-circuits on `pe.paymentStatus === 'paid' || pe.stripePaymentIntentId`, so an engagement marked paid before completion is never billed and nothing reconciles it against Stripe.
Why it matters: A client can bill themselves roughly $2 per hour and underpay the expert (both the charge at complete/route.ts:88 and the payout at expertPayout.ts:173 follow the client-supplied number), or mark the call paid and never be charged at all. The expert payout, which is driven by the Stripe webhook, then never fires either. This is direct revenue loss and expert underpayment from a plain authenticated session with no staff role.
Recommended future fix: Gate expertRate, expertCounterRate, callDurationMin and invoiceAmount on role === 'admin', or remove them from this route entirely and leave rate changes to the sanctioned .../rate-decision route. Treat every payment field as derived state that only the Stripe webhook and createAndSendInvoice may write. Rename OWNER_ONLY_FIELDS so it does not read as "staff only".
Existing test coverage: none. scripts/test-pricing.ts covers the conversion arithmetic, not the route's authorization; nothing anywhere asserts that a role-'user' owner is refused these fields.
```

**C-2**

```text
Finding: `firm` is referenced but never declared in two route handlers, so the project does not type-check, the build fails, and the expert picker page would 500 on every load.
Severity: Critical
File(s): app/api/schedule/[token]/route.ts:197 (GET); app/api/inbound-email/route.ts:820 (advanceInterested); correct pattern at app/api/inbound-email/route.ts:229 and app/api/schedule/[token]/route.ts:356
Relevant function/component: GET (schedule picker payload), advanceInterested (auto follow-up)
What happens: The WIP added a denyTerms option to lib/matchyTemplates.deriveTopic so a client's own firm name cannot leak into the topic clause shown to an expert. The call `deriveTopic(project, { denyTerms: firm?.name ? [firm.name] : [] })` was copy-pasted into two functions that never fetch a firm. `project` is in scope; `firm` is not. npx tsc --noEmit reports TS2304 four times (twice per site), these are the only type errors in the tree, and npm run build:local fails on them.
Why it matters: Two effects. The build is broken, so nothing else can deploy. And when it is fixed, the intent matters: the client's firm name is meant to be a deny term so a research question naming the client's own firm cannot be generalized into the expert-facing topic. That blinding layer is currently absent from both the picker payload and the auto follow-up.
Recommended future fix: Add `const firm = await getFirm(project.firmDomain).catch(() => null);` before the payload is built in the schedule GET handler, and use `context.clientFirmName` (already resolved by loadThreadContext) in advanceInterested. Both files already contain a correct instance of the pattern.
Existing test coverage: none. scripts/test-matchy-templates.ts covers deriveTopic's deny-list behaviour but no test imports either route; an HTTP-level test of GET /api/schedule/[token] would have caught this.
```

**C-3**

```text
Finding: The booking .ics is shared between both parties, so each side's calendar invite lists the other's email address, including the expert contactEmail that is stripped from every client-facing API response.
Severity: Critical
File(s): lib/bookCall.ts:426-436 (attendees), :439-484 (sendConfirmations); lib/generateIcs.ts; lib/redactExpert.ts:93 (INTERNAL_PROJECT_EXPERT_KEYS); lib/bookCall.ts:494 (bookingIcsEvent, the on-demand download, which does it correctly)
Relevant function/component: sendConfirmations / buildIcsEvent
What happens: `attendees = [pe.contactEmail, clientEmail]` builds one IcsEvent that is attached to BOTH sendBookingEmail calls, so generateIcs emits `ATTENDEE;RSVP=TRUE:mailto:<expert>` and `ATTENDEE;RSVP=TRUE:mailto:<client owner>` in each copy. contactEmail is in INTERNAL_PROJECT_EXPERT_KEYS and is stripped at every status, including after the identity reveal, on the stated grounds that the contact path is the whole point of the platform. The on-demand .ics download at bookingIcsEvent lists only the client, so the two paths disagree with each other.
Why it matters: It hands the client the expert's direct address, which is the disintermediation the product exists to prevent, and hands the expert the client's address and firm domain in the same stroke. It defeats the redaction layer through an attachment rather than through an API response, which is why the redaction tests do not see it. This is the unresolved half of OUTREACH_BOT_AUDIT item 13.
Recommended future fix: Build two IcsEvents from the same uid and sequence, each listing only its own recipient plus an ExpertMatch organizer address, or drop ATTENDEE lines entirely. Neither is required for the SEQUENCE-based reschedule update to work.
Existing test coverage: none for attendee content. scripts/check-redaction.ts covers API responses only; scripts/test-scheduling.ts covers generateIcs output shape but not the attendee list against the redaction rules.
```

**C-4**

```text
Finding: The Zoom webhook has no replay window and no completion guard, so a redelivered or captured meeting.ended re-completes the engagement and re-enters the invoice path.
Severity: Critical
File(s): app/api/webhooks/zoom/route.ts:47-54 (signature), :70-104 (meeting.ended branch); lib/createAndSendInvoice.ts:276-283 (the only guard); lib/chargeSavedCard.ts:144-156; app/api/projects/[projectId]/experts/[expertId]/complete/route.ts
Relevant function/component: POST /api/webhooks/zoom, createAndSendInvoice
What happens: The signature is verified over `v0:{ts}:{rawBody}` but `ts` is never compared against the clock, so a signed body stays valid indefinitely. The meeting.ended branch then writes status 'completed' and calls createAndSendInvoice without checking whether zoomMeetingEndedAt or status are already set, and Zoom retries on any non-2xx, so an ordinary timeout produces a second delivery. The same engagement can also be completed by the manual owner-only complete route, so two independent code paths can enter billing for one call. The only thing preventing a second charge is the durable double-bill guard at createAndSendInvoice.ts:276 (`paymentStatus === 'paid' || stripePaymentIntentId`) plus Stripe's own roughly 24-hour idempotency key.
Why it matters: Duplicate execution on this path charges the client's saved card, and a stale replay can re-complete an engagement that has since moved on, overwriting actualDurationMin and re-triggering the payout logic. A single conditional in one file is carrying the whole protection for the product's charge path.
Recommended future fix: Reject events whose x-zm-request-timestamp is more than about five minutes old, skip the whole branch when pe.zoomMeetingEndedAt is already set, and make the double-bill guard key on a per-call identifier (see H-8) rather than on (projectId, expertId).
Existing test coverage: none. No script imports the Zoom webhook route or createAndSendInvoice; scripts/test-org-billing.ts asserts only that findProjectExpertByZoomMeetingId exists.
```

## High

**H-1**

```text
Finding: The project owner can write contactEmail, redirecting Matchy's intro email to an address of their choosing.
Severity: High
File(s): app/api/projects/[projectId]/experts/[expertId]/route.ts:186; app/api/projects/[projectId]/experts/[expertId]/bookmark/route.ts:182, :236, :264; lib/redactExpert.ts:93
Relevant function/component: PUT, bookmark POST
What happens: contactEmail is sanitized for length but not otherwise restricted, and is writable by the project owner through the same PUT route as C-1. The bookmark route treats a present contactEmail as "we already have an address": it skips contact discovery entirely, runs the suppression check against that address, and sends the intro there. The client cannot read the value back, because redactExpert strips it, but they can set it.
Why it matters: A client can point Matchy's outreach at an address they control, harvesting the expert-facing copy and the reply-token flow, or at an arbitrary third party, from a project they legitimately own. It also bypasses the paid contact-discovery path and its verification.
Recommended future fix: Restrict contactEmail to admin plus the contact-discovery job, and validate it as an email address rather than as free text.
Existing test coverage: none.
```

**H-2**

```text
Finding: The intro send has no send-once guard, so two concurrent bookmarks, a retry after a post-send bookkeeping failure, or a second approve click can each deliver a duplicate cold email to the same stranger.
Severity: High
File(s): lib/outreachSteps.ts:113-163 (runSequenceStep intro), :152-170 (post-send writes), :207-212 (catch); lib/contactDiscovery.ts:711-800; app/api/projects/[projectId]/experts/[expertId]/bookmark/route.ts:121, :142, :180; app/api/projects/[projectId]/experts/[expertId]/outreach/approve/route.ts:125; lib/contactCache.ts (the implemented, unused lock)
Relevant function/component: runSequenceStep('intro') / runContactDiscoveryJob
What happens: Three routes into the same gap. (a) The bookmark route treats status 'bookmarked' as a retry and queues another discovery job; isRetry only suppresses the analytics event. Job A can write contactEmail and be mid-send while job B starts, sees the address already set, skips discovery and goes straight to runSequenceStep('intro'), which fails only on a missing address or rate and has no "already sent" check. Status becomes 'contacted' only after the first send completes, so the window is real. (b) After sendSequenceEmail resolves {sent:true}, the Redis reply-token write and updateExpertStatus run inside the same try; if either throws, the catch returns {ok:false, error:'step_failed'} while the expert already has the intro and the status was never advanced, so the next click sends again. (c) Upstash-Retries: 0 prevents QStash redelivery but not re-bookmarking. lib/contactCache.ts already implements a per-lookup Redis lock that nothing calls.
Why it matters: A duplicate unsolicited cold email to the same stranger is the single worst deliverability and brand outcome in this product, and is exactly what the one-send rule in docs/MATCHY_SPEC.md exists to prevent. The state that would prevent the second send is precisely the state that failed to write.
Recommended future fix: Refuse runSequenceStep('intro') when email1SentAt is already set; write a "sent" marker before the send and reconcile after, or catch the post-send writes separately and return ok with a warning; and take the existing contactCache lock keyed on projectId:expertId for the duration of the discovery job.
Existing test coverage: none. scripts/test-contact-discovery.ts is pure-function only, and scripts/e2e-matchy.ts covers the walkthrough hold sequentially, not the race.
```

**H-3**

```text
Finding: The global do-not-contact list is not enforced at the outbound chokepoint, and four send paths omit the check entirely.
Severity: High
File(s): lib/emailSequence.ts:200-262 (sendSequenceEmail, no isSuppressed call); app/api/projects/[projectId]/experts/[expertId]/messages/route.ts:227; .../rate-decision/route.ts:163; app/api/inbound-email/route.ts:~860 (advanceInterested); lib/matchyScheduling.ts:1042; lib/outreachSuppressions.ts:35
Relevant function/component: sendSequenceEmail / isSuppressed
What happens: isSuppressed is called, fail-closed, at bookmark:236, outreach/approve:102, messages/[messageId]/send:125, jobs/send-nudge:193 and contactDiscovery:751, but not inside sendSequenceEmail itself. The client-reply relay, the rate-decision line, inbound-email's auto follow-up and matchyScheduling's proposal email all send without checking. An expert who clicks the footer opt-out mid-thread is written into outreach_suppressions and can still receive all four.
Why it matters: CAN-SPAM and deliverability exposure, and a direct contradiction of docs/MATCHY_SPEC.md, which states suppression is honoured everywhere. The suppression module's own header says the check is keyed on the address precisely so it cannot be bypassed per project.
Recommended future fix: Move the isSuppressed check into sendSequenceEmail, which already resolves the project and already fails closed there, returning a new held:'suppressed' reason. Keep the call-site checks as early-exit UX.
Existing test coverage: none for the suppression and send interaction.
```

**H-4**

```text
Finding: sendSequenceEmail's SendOutcome is discarded by three routes, so a trial or disabled hold is recorded as a successful send.
Severity: High
File(s): app/api/projects/[projectId]/experts/[expertId]/messages/route.ts:227; .../messages/[messageId]/send/route.ts:153; .../rate-decision/route.ts:163; lib/emailSequence.ts:200-262
Relevant function/component: POST handlers; sendSequenceEmail
What happens: sendSequenceEmail returns { sent:false, held } for walkthrough mode, for an organization without canOutreachExperts, and for DISABLE_EMAILS. All three routes await it without reading the result. Each checks isWalkthrough itself, so that case is handled, but an entitlement hold or the kill switch returns normally and the routes then store the message with no held flag, clear the pending flag, set status 'followup_sent', write the agreed rate and emit rate_offered or rate_agreed as though the email went out.
Why it matters: The client's thread and the pipeline claim the expert received a rate ask, or an accepted rate, that never left the building. The engagement then waits forever for a reply that cannot come, and the engagement_events stream, which the product treats as its data asset, records a send that did not happen.
Recommended future fix: Read the outcome in all three routes and take the branch inbound-email and outreachSteps already take: store with held or pendingApproval and do not advance the status. Alternatively make sendSequenceEmail throw on a non-walkthrough hold.
Existing test coverage: scripts/e2e-matchy.ts covers the walkthrough branch only. scripts/test-entitlements.ts and scripts/test-walkthrough.ts cover the chokepoint, not these three callers.
```

**H-5**

```text
Finding: The inbound email webhook claims its idempotency key before processing, so a partial failure loses the expert's reply permanently.
Severity: High
File(s): app/api/inbound-email/route.ts:155-171 (claimDelivery), :290 (the claim), :364-371 (the swallowing catch)
Relevant function/component: POST / claimDelivery / handleReply
What happens: `SET inbound-seen:{svix-id} NX EX 7d` is written before handleReply runs. handleReply's failures are caught, logged, and the handler returns 200 regardless, so Resend never retries. If Supabase, the classifier or a status write fails half way through, the thread is left in a partial state and the redelivery is deduped away. There is no queue to replay from, and resend_message_id, the message-level key the spec names, is never populated (see L-31).
Why it matters: An expert's reply, which may be a decline, a counter-offer, an acceptance or a chosen call time, can be silently dropped with the engagement stuck mid-transition and no operator signal.
Recommended future fix: Claim with a short in-progress TTL and rewrite the key to a long-lived done marker only after handleReply resolves. Return a non-2xx on an unexpected failure so Resend retries into the claim window.
Existing test coverage: none. scripts/verify-svix.ts checks signature verification only.
```

**H-6**

```text
Finding: A successful Connect transfer whose database write fails is recorded as 'failed', and no retry path ever looks at 'failed' rows.
Severity: High
File(s): lib/expertPayout.ts:190-205 (the inner try), :279 (retry selector); app/api/jobs/reconcile/route.ts:151-153 (sweep selector)
Relevant function/component: runExpertPayout / retryPendingPayoutsForAccount / sweepPayouts
What happens: The inner try wraps BOTH transfers.create and the updateExpertStatus that stores stripeTransferId. If the transfer succeeds and the write fails, the catch sets expertOnboardingStatus:'failed' and the transfer id is lost. Both retry paths select rows where data->>expertOnboardingStatus = 'pending', so 'failed' rows are never revisited, and no recordSystemFailure is written, so the row never appears on the admin attention feed either.
Why it matters: The expert either silently goes unpaid, if the transfer genuinely failed, or was paid with no record of it. A later manual retry more than 24 hours on has no Stripe idempotency-key protection, so it would pay them twice.
Recommended future fix: Persist stripeTransferId in its own write immediately after transfers.create; call recordSystemFailure({area:'payout'}) in the catch; include 'failed' in both retry sweeps behind a bounded attempt count.
Existing test coverage: none. scripts/test-org-billing.ts asserts only that the exports exist.
```

**H-7**

```text
Finding: No refund, dispute, or payout-reversal path exists anywhere in the codebase.
Severity: High
File(s): app/api/webhooks/stripe/route.ts:108-191 (no charge.refunded or charge.dispute.* branch); app/terms/page.tsx:130 (the only mention of refunds in the product, as prose)
Relevant function/component: Stripe webhook POST
What happens: A grep across the repository finds no handler for charge.refunded, charge.dispute.created, or transfer reversals. A refund issued from the Stripe dashboard leaves paymentStatus 'paid', paidAt set, and the expert payout already transferred with no claw-back and no system_events row.
Why it matters: Every refund or chargeback silently desynchronises the application from Stripe, and the platform absorbs the expert's 50 percent with no record of why. The terms page promises a policy the code does not implement.
Recommended future fix: Add charge.refunded and charge.dispute.created branches that move paymentStatus to a new 'refunded' state and raise a system_events row, and decide the payout-reversal policy explicitly rather than by omission.
Existing test coverage: none.
```

**H-8**

```text
Finding: The per-(project, expert) charge idempotency key blocks a legitimate second call with the same expert on the same project.
Severity: High
File(s): lib/chargeSavedCard.ts:144-156 (idempotencyKey 'charge:<pid>:<eid>'); lib/createAndSendInvoice.ts:276-283 (the durable guard)
Relevant function/component: chargeSavedCard / createAndSendInvoice
What happens: The Stripe idempotency key is `charge:${projectId}:${expertId}` with no call or duration component. Stripe replays the original response for a duplicate key, so a second call with the same expert inside Stripe's roughly 24-hour key window returns the FIRST PaymentIntent and no new money is taken. The durable guard above it (paymentStatus 'paid' or stripePaymentIntentId set) short-circuits even sooner and returns the earlier intent as though the second call had been billed.
Why it matters: Repeat consultations with the same expert on the same project are a normal product outcome. The second one is not billed at all, which is direct revenue loss, and because the payout is triggered by payment success the expert is not paid for it either.
Recommended future fix: Key both the Stripe idempotency key and the durable double-bill guard on a per-call identifier, for example the Zoom meeting id or a completion sequence number, rather than on (projectId, expertId).
Existing test coverage: none. scripts/test-pricing.ts covers the amounts; nothing covers the charge path.
```

**H-9**

```text
Finding: The nightly payout sweep re-sends the Stripe onboarding email to the same expert every night, with no cap and no throttle.
Severity: High
File(s): app/api/jobs/reconcile/route.ts:165-206 (sweepPayouts); lib/expertPayout.ts:209-219, :325-337 (runExpertPayout / sendOnboardingLink)
Relevant function/component: sweepPayouts -> retryPendingPayoutsForAccount -> runExpertPayout
What happens: sweepPayouts selects every project_experts row with expertOnboardingStatus = 'pending', collects the distinct Connect account ids and calls retryPendingPayoutsForAccount for each. runExpertPayout's "account exists but onboarding is not complete" branch calls sendOnboardingLink unconditionally. Nothing counts, dates or rate-limits that branch, and the row stays 'pending' until the expert finishes Stripe. An expert who never onboards therefore receives "Set up your payout account" once every 24 hours indefinitely, while the email itself says the link expires in seven days.
Why it matters: This is the only uncapped outbound path in the product. Every other one is bounded (nudges stop at four business days). Unbounded mail to a person who is owed money is both a deliverability risk and a support problem. Money is not at risk here: the stripeTransferId guard plus the deterministic transfer idempotency key make a double payout impossible.
Recommended future fix: Record payoutReminderSentAt and payoutReminderCount on the row and skip the email unless N days have passed and a cap of three or four has not been reached, or split "retry the transfer" from "re-send the link" so the sweep only does the former.
Existing test coverage: none.
```

**H-10**

```text
Finding: The three nightly reconcile sweeps share one 60-second budget in a fixed order with no clock check, so a slow seat sweep silently starves the payout and sourcing sweeps.
Severity: High
File(s): app/api/jobs/reconcile/route.ts:47 (maxDuration = 60), :50-52 (bounds), :294-319 (the sweep sequence)
Relevant function/component: GET /api/jobs/reconcile
What happens: sweepSeats runs first and performs up to MAX_ORGS (500) sequential syncOrgSeatQuantity calls, each making one or more Stripe round trips. At a conservative 200 ms per round trip that exceeds 60 seconds somewhere around 100 to 150 organizations. Nothing in the loop checks elapsed time, so the platform kills the invocation mid-sweep: sweepPayouts and sweepSourcing never run, `steps` keeps its initial 'skipped' value, no response is returned, and no system_events row is written.
Why it matters: The sweeps are individually idempotent, so a truncated night costs delay rather than damage, but the failure is invisible except as a missing log line and it grows monotonically with customer count. The two starved sweeps are the ones that unstick paid experts and stuck sourcing runs.
Recommended future fix: Give each sweep its own deadline and report steps.seats = 'partial' when it is hit, or split the three sweeps into three cron paths with independent budgets.
Existing test coverage: none. Nothing exercises the reconcile route at all.
```

**H-11**

```text
Finding: The sourcing worker declares no maxDuration and is not idempotent, so a platform timeout leaves the project stuck 'running' and a QStash redelivery appends a second copy of the candidates.
Severity: High
File(s): app/api/jobs/source-experts/route.ts:44 (no maxDuration), :62-66; lib/sourcingJob.ts:52 (publishSourcingJob), :112-181 (runSourcingJob); app/api/jobs/reconcile/route.ts:205-227 (the only un-sticker)
Relevant function/component: POST /api/jobs/source-experts, runSourcingJob, publishSourcingJob
What happens: Every sibling job route declares a limit (reconcile 60, schedule-nudges 60, send-nudge 30, contact-discovery 60); this one declares none, while the work it awaits is two Haiku calls, up to three Exa searches, one claude-opus-4-6 call at max_tokens 12000 with two retries, and up to three further searches for name resolution. lib/sourcingJob.ts's own header says sourcing takes minutes. Separately, the job body carries only {projectId, businessProblem?, expertType?}: no job id, no Upstash-Deduplication-Id and no Upstash-Retries header, and addExpertsToProject appends with no "already sourced for this run" check. Handled failures return 200, but a timeout or crash triggers redelivery and the redelivered run re-executes from step 0 even if experts were already written.
Why it matters: Duplicate candidates on the project, double Exa and Opus spend, a completed run overwritten by a re-run, and a project left on 'running' until the daily 06:00 UTC reconcile pass, during which the user sees a spinner and then a stale state.
Recommended future fix: Add an explicit maxDuration sized above the observed p99, send a deterministic Upstash-Deduplication-Id, and make the write path refuse to write when sourcingStatus has already left 'running' for the current sourcingStartedAt.
Existing test coverage: none for redelivery. scripts/verify-sourcing-prod.ts waits up to nine minutes against production but asserts nothing about duration or duplication.
```

**H-12**

```text
Finding: The Exa search provider logs the full search query, which is derived from confidential client brief content, in production.
Severity: High
File(s): lib/searchProviders/exa.ts:36-38; lib/generateExperts.ts buildSearchQueriesFromBrief and the query-generation prompt; lib/contactPathResolver.ts:230 (the second caller of searchWithFallback)
Relevant function/component: exaProvider.search
What happens: `console.log('[exa] query:', query)` is marked a temporary diagnostic and is not gated on NODE_ENV. The queries it prints are built from the client's expertType, industry, target companies and research question. Every other module in this path carries an explicit header rule against logging project names, research questions or brief content, and tavily.ts and scrapingbee.ts log counts only.
Why it matters: Client-confidential brief content lands in production application logs, contradicting the stated logging rule for the sourcing path and the privacy page's description of what leaves the application.
Recommended future fix: Delete the line, or reduce it to a length or hash and gate it on NODE_ENV === 'development' as the adjacent performance log already is. Any fix must cover both callers of searchWithFallback.
Existing test coverage: none.
```

**H-13**

```text
Finding: ENRICHMENT_DAILY_BUDGET is enforced nowhere; the three functions that read it have no callers, so the paid contact-provider path has no spend limit at all.
Severity: High
File(s): lib/rateLimiter.ts:79-131 (checkRequestThrottle, checkCreditLimits, checkAndIncrementGlobalBudget, incrementProviderDailyCount); lib/contactDiscovery.ts:456-500 (discoverContact); .env.example (ENRICHMENT_DAILY_BUDGET)
Relevant function/component: checkAndIncrementGlobalBudget / incrementProviderDailyCount / discoverContact
What happens: checkAndIncrementGlobalBudget and incrementProviderDailyCount exist and read ENRICHMENT_DAILY_BUDGET (default 500), but a grep across app/, lib/, components/ and scripts/ finds no callers. discoverContact calls Snov and Hunter directly with no counter. The route the module header names as their purpose, app/api/enrich-contact, no longer exists, and checkContactLookupLimits, which that header also advertises, is not in the file at all.
Why it matters: One project with many bookmarks, or a bug or loop, can burn the entire Snov and Hunter credit balance in minutes with nothing to stop it. The documented environment variable implies a protection that is not in force, which is worse than no variable.
Recommended future fix: Call checkAndIncrementGlobalBudget once per provider inside discoverContact's provider loop and record skipped_budget when it refuses, or delete the four unused functions and the environment variable so the configuration stops lying.
Existing test coverage: none.
```

**H-14**

```text
Finding: Every rate limiter on the auth surface fails open, so an Upstash outage removes login, reset, invite and access-request throttling simultaneously.
Severity: High
File(s): app/api/auth/login/route.ts:72-84; app/api/auth/set-password/route.ts:135-144; lib/passwordReset.ts:40-52; app/api/request-access/route.ts:84-96
Relevant function/component: POST (login), overAttemptLimit, isResetRateLimited, isRateLimited
What happens: Each helper calls getUpstashClient() and returns "not limited" when the client is null, and wraps the INCR in a try/catch that also returns "not limited". lib/authLinks.ts's own header records that this Upstash account is on a plan that gets rate-limited, so this is a routinely hit condition rather than a theoretical one. When it happens, password guessing against /api/auth/login, reset-link spraying and access-request flooding are all uncapped at once.
Why it matters: Fail-open is defensible for recovery, since a cache outage must not lock people out, but applying it to the credential-checking endpoint means the only brute-force control disappears exactly when the provider is degraded.
Recommended future fix: Split the policy. Keep reset and request-access fail-open, and make /api/auth/login degrade to a stricter in-process fallback, or fail closed with a 503, when Redis is unavailable.
Existing test coverage: none. scripts/smoke-cutover.ts exercises login success and failure, not throttling.
```

**H-15**

```text
Finding: Login throttling is per-IP only; there is no per-account attempt cap or lockout.
Severity: High
File(s): app/api/auth/login/route.ts:11-16 (loginRlKey), :67-84; contrast lib/passwordReset.ts:40, which deliberately keys on both ip and email
Relevant function/component: loginRlKey / POST
What happens: The only counter is `login-rl:<ip>` at 10 attempts per 15 minutes. Nothing counts failures against the target email, so an attacker distributing attempts across IP addresses faces no cumulative limit on any single account, and the account owner is never notified or locked.
Why it matters: Credential stuffing against a known customer address is the realistic attack on a business product whose user emails follow firm conventions, and it is the one this design does not slow down.
Recommended future fix: Add a second counter keyed on HMAC(email), for example 10 failures per hour, incremented only on failure, alongside the existing per-IP counter.
Existing test coverage: none.
```

**H-16**

```text
Finding: firmStore.upsertUser swallows the app_metadata sync failure, so revoking a disabled or demoted user's access can silently fail and leave them with full access indefinitely.
Severity: High
File(s): lib/firmStore.ts:448-456 (`await syncUserMetadata(e).catch(() => {})`); lib/supabase/admin.ts:143-157 (syncAppMetadata); app/api/org/members/route.ts:241-276 (PATCH); middleware.ts:72-116; lib/auth.ts:127-205
Relevant function/component: upsertUser / syncUserMetadata / syncAppMetadata
What happens: Every authorization decision reads app_metadata from the JWT; the tables are never consulted per request. syncAppMetadata is itself best-effort and returns false on error rather than throwing, and upsertUser then discards even that signal. If the sync fails while disabling a member through PATCH /api/org/members, the database row says 'disabled' while the JWT claims say 'active', and every guard honours the JWT. Nothing retries: there is no status reconciler, and the one self-heal path, GET /api/org/membership, fires only on MISSING org claims, not stale ones.
Why it matters: This is the revocation path. A firm removing a departing employee's access sees a success response while the account keeps working.
Recommended future fix: Make upsertUser surface a failed sync, by throwing or by returning a flag the org/members route turns into a warning, and add status to the nightly reconcile that already exists for seat sync.
Existing test coverage: none. Nothing asserts that disabling a member actually ends their access.
```

**H-17**

```text
Finding: lib/projectStore.updateProject rewrites the entire brief jsonb document with no concurrency check, so unrelated brief keys written by a concurrent job are silently lost.
Severity: High
File(s): lib/projectStore.ts SupabaseProjectStore.updateProject and projectToBrief; app/api/projects/[projectId]/route.ts PUT; contrast lib/projectStore.ts mutateExpert (which does have compare-and-set)
Relevant function/component: updateProject, projectToBrief
What happens: The PUT loads the project, spreads the request over it and writes the whole object back, and projectToBrief rebuilds the brief from that snapshot. mutateExpert has an updated_at compare-and-set; updateProject has nothing equivalent. The briefVersion check only covers the 19 keys in BRIEF_FIELDS, so a sourcing job writing sourcingStatus or sourcingAdjacent, or a settings write to walkthrough, landing between the load and the save is overwritten.
Why it matters: A brief save landing mid-sourcing can revert sourcingStatus to 'running' permanently, or flip a live project's mode back to walkthrough, with no error surfaced anywhere. The same read-modify-write shape also affects updateProjectFields, which the nightly sweepSourcing uses (see M-40).
Recommended future fix: Route the PUT through updateProjectFields, which merges only supplied keys, or add the same updated_at optimistic-concurrency loop mutateExpert uses.
Existing test coverage: none.
```

**H-18**

```text
Finding: Nothing validates that an LLM-written anonymizedDescriptor is actually anonymous, and the redactor substitutes it verbatim.
Severity: High
File(s): lib/anonymizeExpert.ts parseFields (about :110-125); lib/redactExpert.ts anonymizeExpert (about :220); lib/projectValidation.ts:190 (validateProjectExpert); lib/generateExperts.ts step 5 (where the descriptor originates); contrast app/api/projects/[projectId]/interview-guide/route.ts redactGuideText
Relevant function/component: parseFields, anonymizeExpert, validateProjectExpert
What happens: parseFields keeps whatever string the model returned, trimmed and truncated to 140 or 200 characters, and anonymizeExpert then substitutes it for the blanked title and company. The only defence is the wording of ANONYMIZATION_RULES in the prompt. validateProjectExpert also accepts a client-supplied anonymizedDescriptor with nothing but a length cap. The interview-guide route implements exactly the post-hoc check that is missing here: redactGuideText masks the expert's name and company out of the model's answer before it is returned.
Why it matters: One model slip that names the employer puts the expert's identity on the client's card and in the exported PDF, which is the precise failure the whole redaction layer exists to prevent.
Recommended future fix: Reuse the interview guide's approach. Reject or mask a descriptor containing the expert's surname or company before persisting it, and re-check at render time inside redactExpert.
Existing test coverage: scripts/check-redaction.ts asserts the shape of the anonymized expert, not the content of the descriptor.
```

**H-19**

```text
Finding: The RLS proof suite has one stale assertion left over from the 20260908 policy drop, so scripts/rls-verify.sh now exits non-zero against a correct database.
Severity: High
File(s): scripts/rls/verify.sql:552-559 (section 7, actor B1); scripts/rls/verify.sql:690-702 (the raising summary block); supabase/migrations/20260908000000_identity_boundary_trial_events.sql
Relevant function/component: _rls_verify_eq, assertion "B1: sees only own project"
What happens: Every other project-family assertion was rewritten to expect 0 rows once `projects` lost its policies, but B1 still asserts count(*) = 1 for an authenticated session. With RLS enabled and zero policies the count is 0, so the suite reports expected '1', got '0', and the summary block raises, making psql and the shell script exit non-zero.
Why it matters: This suite is the project's evidence for cross-account isolation, and it is now the only evidence, because the WIP migration removed the policies that used to be defence in depth. A suite that fails on a correct database is a suite people stop running, and it currently blocks anyone from confirming the WIP migration's effect.
Recommended future fix: Change the expectation to 0::bigint and rename the assertion, and consider also asserting count(*) = 4 as service_role, which the file already does at :625-627.
Existing test coverage: this file is the test; it is not itself covered.
```

**H-20**

```text
Finding: The expert-side Google OAuth flow requests calendar.freebusy only, so calendarEmail is never captured and the expert's connected calendar is then silently ignored.
Severity: High
File(s): app/api/availability/[token]/google-auth/route.ts:52 (CALENDAR_SCOPE); app/api/availability/oauth/google/callback/route.ts:114-126, :233-241 (fetchCalendarEmail); lib/matchyScheduling.ts:308-322 (expertKnownWindows), :337-343 (expertHasConnectedCalendar); contrast app/api/onboarding/calendar/google/route.ts:43
Relevant function/component: fetchCalendarEmail / expertKnownWindows / expertHasConnectedCalendar
What happens: CALENDAR_SCOPE is freebusy alone with no openid or email scope, so the userinfo call fails and calendarEmail is stored as undefined. expertKnownWindows requires calendarAccessToken, calendarRefreshToken and calendarEmail all present before it will query freebusy, and expertHasConnectedCalendar has the same triple condition. The onboarding route's own header states the problem outright.
Why it matters: An expert who grants calendar access is redirected to ?connected=1 and shown a banner saying the proposed times are ones they are actually free for, while the scheduler silently ignores their calendar and proposes from the client's side alone. The most informative signal in the whole scheduling flow is collected and then discarded.
Recommended future fix: Add `openid email` to CALENDAR_SCOPE, matching the client-side onboarding flow, or fall back to pe.contactEmail as the calendar id when userinfo declines. Note this changes the consent screen the expert sees.
Existing test coverage: none.
```

**H-21**

```text
Finding: Google free/busy is inverted inside a fixed 08:00 to 19:00 UTC band, which silently shrinks or empties the offerable window for anyone far from UTC.
Severity: High
File(s): lib/fetchGoogleFreebusy.ts:104-154 (invertBusyToFree), :122-124; lib/matchyScheduling.ts:536-538 (pickProposals business hours)
Relevant function/component: invertBusyToFree
What happens: Each day's free gaps are computed between Date.UTC(...,8,0,0) and Date.UTC(...,19,0,0) and stamped timezone:'UTC'; the user's own zone is never consulted. pickProposals then keeps only starts whose whole call sits inside 09:00 to 17:00 in the owner's zone. For America/New_York the band is 03:00 to 14:00 local, so nothing after about 13:00 Eastern can ever be proposed. For America/Los_Angeles it is 00:00 to 11:00 local, leaving only 09:00 to 11:00 Pacific. For Asia/Singapore the two windows barely intersect.
Why it matters: West-coast and non-US clients get a fraction of their real availability, or a no_client_availability outcome, with no signal that anything was truncated. Calendly slots inherit the same UTC stamping but are provider-supplied, so they are unaffected, which makes the failure look provider-specific and random.
Recommended future fix: Invert over the full day, or over the connection's stored timezone, and let pickProposals be the only place business hours are applied.
Existing test coverage: none. scripts/test-scheduling.ts drives pickProposals from synthetic ranges and never goes through freebusy.
```

**H-22**

```text
Finding: Three operational scripts can mutate or destroy production data with no environment guard, no confirmation and no dry run.
Severity: High
File(s): scripts/wipe-projects.ts (whole file); scripts/seed-admin.ts:1-45; scripts/smoke-cutover.ts:1-20
Relevant function/component: main() in each
What happens: wipe-projects.ts unconditionally deletes every `project:*`, `projects:index`, `projects:lock`, `access-request:*`, `access-requests:list`, `signup-token:*` and `signup-rl:*` key in whichever Upstash instance the ambient environment variables point at, with no --force flag, no printed confirmation of the target, and no dry run. seed-admin.ts creates or updates a real Supabase auth user and organization row in whatever project NEXT_PUBLIC_SUPABASE_URL names. smoke-cutover.ts signs the real admin in and out, which revokes that admin's sessions everywhere.
Why it matters: A developer with production environment variables exported in a shell profile can wipe or corrupt production data, or sign the founder out of every live session, by running a script that looks like a diagnostic. wipe-projects.ts is Redis-era and probably dead now that Postgres is the source of truth, which makes it more dangerous, not less, because nobody thinks about it.
Recommended future fix: Have each script print the resolved Supabase and Upstash host and require a typed confirmation or ALLOW_PROD=1 when the host does not look like localhost or a known development project. Consider deleting wipe-projects.ts outright.
Existing test coverage: none; these are the operational scripts themselves and they have no guard rails to test.
```

**H-23**

```text
Finding: The seat-subscription create can plausibly produce a second live subscription for the same customer, because the Stripe idempotency key expires at the same 24-hour interval the reconcile cron runs on. Plausible, unverified.
Severity: High
File(s): lib/orgBilling.ts:573-586 (subscriptions.create with idempotency key `seat-sub:<organizationId>`), :589 (patchBillingRow); app/api/jobs/reconcile/route.ts:88-107 (sweepSeats, daily at 06:00 UTC)
Relevant function/component: syncOrgSeatQuantity / sweepSeats
What happens: When no subscription id is recorded on the billing row, syncOrgSeatQuantity creates one with idempotency key `seat-sub:${organizationId}`. Stripe retains an idempotency key for roughly 24 hours. If patchBillingRow fails after a successful subscriptions.create, the next night's sweep, exactly 24 hours later, sees no recorded subscription, reuses the same key, and the key is by then expired, so Stripe creates a second live per-seat subscription for the same customer. The 24-hour cron interval is what turns a one-off race into a reproducible one. This was reasoned from the code and the documented Stripe key lifetime; it was not reproduced against Stripe, so it is stated as plausible rather than confirmed.
Why it matters: Recurring double billing of a paying customer, self-perpetuating until someone notices two subscriptions in the Stripe dashboard.
Recommended future fix: List the customer's existing subscriptions for the seat price before creating one, or include a date component in the idempotency key so an expired key cannot silently permit a create, and record the subscription id in the same transaction as the create wherever possible.
Existing test coverage: none. scripts/test-org-billing.ts covers orgCancelIdempotencyKey and stripeFailureReason as pure helpers only.
```

## Medium

**M-1**

```text
Finding: The login rate-limit Redis key contains the raw client IP, breaking the no-PII-in-key-names rule every other limiter in the repository follows.
Severity: Medium
File(s): app/api/auth/login/route.ts:14-16 (loginRlKey); contrast lib/rateLimiter.ts:68, lib/passwordReset.ts:30, app/api/request-access/route.ts:77
Relevant function/component: loginRlKey
What happens: The key is `login-rl:${ip}` verbatim. Three other rlKey implementations first HMAC the value with LOG_HASH_SECRET and truncate it, precisely so an IP or address never lands in a key name. Upstash key names appear in the provider console and in any KEYS or SCAN output.
Why it matters: IP addresses are personal data under GDPR, and the codebase has an explicit stated policy against this plus three correct implementations of it, so this is an inconsistency rather than a considered exception.
Recommended future fix: Reuse the existing HMAC helper for this key. It is a one-line change and invalidates in-flight counters once, which is harmless.
Existing test coverage: none.
```

**M-2**

```text
Finding: routeAuthGuard and adminGuard admit accounts with status 'pending', while orgAdminGuard rejects them.
Severity: Medium
File(s): lib/auth.ts:127-136 (routeAuthGuard), :142-151 (adminGuard), :168-205 (orgAdminGuard)
Relevant function/component: routeAuthGuard, adminGuard
What happens: The first two guards reject only status === 'disabled'; orgAdminGuard rejects 'disabled' or 'pending'. In today's code a pending account cannot obtain a session, because it holds only the unguessable random password set by ensureSupabaseUser, so this is not currently exploitable. It is a latent gap: any future path that signs a user in before activation, such as a magic link, an SSO bridge, or a partially failed set-password that signs in before upsertUser, would immediately grant a pending account access to 18 routeAuthGuard-protected routes.
Why it matters: The three guards disagree about what "may use the product" means, and the safe one is the least used. The failure mode is authorization bypass and the fix is one token.
Recommended future fix: Treat 'pending' as not-yet-active in routeAuthGuard and adminGuard too, matching orgAdminGuard.
Existing test coverage: none.
```

**M-3**

```text
Finding: An org admin at a customer firm can disable or demote a platform admin who holds a seat in their organization, revoking that staff account across the whole platform.
Severity: Medium
File(s): app/api/org/members/route.ts:241-276 (PATCH)
Relevant function/component: PATCH /api/org/members
What happens: The only check on the target is member.orgId === orgId. The last-org-admin guard counts organization_members.role = 'org_admin', which is orthogonal to profiles.is_platform_admin. So an org_admin can PATCH {email: <staff address>, status: 'disabled'} for any ExpertMatch staff member who is a member of their organization, and disabling writes app_metadata.status, which middleware.ts enforces globally.
Why it matters: A customer can lock out platform staff. Whether staff ever hold customer-org seats is a deployment question that could not be verified from the code, which is why this is Medium rather than High.
Recommended future fix: Refuse any PATCH or DELETE whose target has role === 'admin' unless the caller is a platform admin.
Existing test coverage: none.
```

**M-4**

```text
Finding: firmStore and entitlements disagree about which organization a profile with multiple memberships belongs to.
Severity: Medium
File(s): lib/firmStore.ts:147-166 (getMembership, oldest membership regardless of status); lib/entitlements.ts:150-172 (getEntitlementsForUser, first ACTIVE membership falling back to the first)
Relevant function/component: getMembership / getEntitlementsForUser
What happens: getMembership takes order(created_at).limit(1) regardless of status, and its answer becomes the user's orgId, firmDomain and status in app_metadata and therefore in every guard. getEntitlementsForUser prefers an active membership. For a profile whose oldest membership is disabled and whose second is active, the guards place them in organization A while entitlements are computed from organization B.
Why it matters: Multi-organization membership is reachable today, because upsertUser inserts a membership per firmDomain it is given and never removes the previous one. The divergence means an account can be governed by one organization's status and another organization's paywall.
Recommended future fix: Extract one primary-membership resolver and have both call it, or add a uniqueness constraint if a profile is only ever meant to belong to one organization.
Existing test coverage: scripts/test-entitlements.ts covers entitlementsFromBilling, not the membership selection.
```

**M-5**

```text
Finding: scripts/rls/README.md documents the pre-20260908 access model and an obsolete assertion count.
Severity: Medium
File(s): scripts/rls/README.md (assertion table, "The statement this supports", Route audit section)
Relevant function/component: documentation
What happens: The README states 135 assertions (the file now contains 153) and its per-actor table claims A1 sees PA1 plus PA2 as a collaborator, A2 can share PA2 inside the organization and revoke it, and that isolation holds with three named migrations applied. After 20260908000000 the suite asserts denials or 0 rows for all of those, and eight migrations are in play. The Route audit section also still describes the cross-organization collaborator invite in app/api/projects/[projectId]/collaborators/route.ts as open, and documents app/api/email-sequence/trigger as live.
Why it matters: This page is the artefact quoted to answer "prove clients cannot see each other's data". A stale security claim is worse than no claim, and the numbers are checkable by anyone who runs the script.
Recommended future fix: Rewrite the actor table and the closing statement for the service-role-only model, list all eight migrations, and generate the assertion count from the script's own output rather than hard-coding it.
Existing test coverage: none (documentation).
```

**M-6**

```text
Finding: Three service-role-only tables are never asserted by the RLS suite.
Severity: Medium
File(s): scripts/rls/verify.sql (no occurrence of outreach_suppressions, engagement_events or system_events); section 2 structural assertions
Relevant function/component: section 2 structural assertions
What happens: The structural block checks RLS on nine tables and zero-policy status on access_requests, user_calendar_connections, organization_billing, the four project-family tables and product_events. outreach_suppressions, engagement_events and system_events appear nowhere in the file, so nothing would notice if a policy were added to them or if RLS were switched off.
Why it matters: outreach_suppressions is the list of people who told the platform not to contact them, and engagement_events is the behavioural data asset. Both are exactly the kind of table whose accidental exposure would be reportable, and both are one `alter table ... disable row level security` away from being readable by any session holding the publishable key.
Recommended future fix: Add the three tables to the RLS-enabled count, and add a zero-policies assertion plus an anon and authenticated invisibility probe for each, following the product_events pattern already in the file.
Existing test coverage: none.
```

**M-7**

```text
Finding: The 20260902 seat-limit backfill is an unconditional UPDATE that silently reverses deliberate admin seat caps every time the migration is re-applied.
Severity: Medium
File(s): supabase/migrations/20260902000000_org_billing_and_rls_hardening.sql, section 2 ("update public.organizations set seat_limit = 2147483647 where seat_limit < 2147483647")
Relevant function/component: section 2, seat limit to optional cap
What happens: The file's header advertises it as idempotent and safe to re-run, and scripts/rls-verify.sh applies every migration twice on purpose to prove it. The statement is idempotent in the narrow sense but not inert: any organization where a platform admin later set a real cap, which the column comment explicitly says they may, is silently reset to unlimited on the next re-run.
Why it matters: Migrations here are pasted by hand into Supabase Studio, and re-pasting an already applied file is a normal, documented recovery step. Seat caps are the mechanism that stops an organization adding billable seats.
Recommended future fix: Guard the backfill so it only touches rows still holding a legacy plan cap (where seat_limit in (3, 10)), or move it into a one-shot block keyed off a migrations-applied marker.
Existing test coverage: scripts/rls-verify.sh proves re-application does not error; nothing checks that it does not change data.
```

**M-8**

```text
Finding: scripts/verify-schema.ts's migration parser is additive-only and will report a correct database as MISSING the moment a SQL rpc exists.
Severity: Medium
File(s): scripts/verify-schema.ts parseMigration (create policy branch), SQL_RPC_CANDIDATES, catalogReader; supabase/migrations/20260908000000_identity_boundary_trial_events.sql
Relevant function/component: parseMigration / catalogReader
What happens: The parser records `create policy` statements and never `drop policy`. Migration 20260908000000 drops 13 project-family policies without recreating them. Today catalogReader finds no SQL rpc, so every policy is reported SKIPPED and the run passes. As soon as anyone adds an exec_sql-style function, which the file's comment says is the intent, the script would look for those 13 policies in pg_policies, not find them, count them MISSING and exit 1 against a perfectly correct production database.
Why it matters: The script's whole purpose is to be the trustworthy answer to "did the migration land?". A confident false FAIL trains people to ignore it, and it is a latent trap left for whoever wires up the rpc.
Recommended future fix: Track drop policy, drop table and drop column in the same statement loop and subtract them, last writer wins in filename order, before checking the catalog.
Existing test coverage: none; the script has no self-test.
```

**M-9**

```text
Finding: Four hot cron and admin queries scan projects and project_experts with no supporting index.
Severity: Medium
File(s): lib/attention.ts:144-148, :234-238; app/api/jobs/reconcile/route.ts:202-206; app/api/jobs/schedule-nudges/route.ts:137-141; supabase/migrations/20260907100000_availability_windows_and_indexes.sql section 3
Relevant function/component: listAttentionItems, sweepSourcing, schedule-nudges GET
What happens: brief->>'sourcingStatus' = 'running' is queried by the admin attention view and by the nightly reconcile sweep, data->nudges->>'scheduledFor' is not null by the stalled-nudge view, and project_experts.status in (WAITING_STATUSES) by the nudge scheduler on every run. Migration 20260907100000 added exactly this kind of partial expression index for zoomMeetingId and expertOnboardingStatus, but not for these predicates, so each is a sequential scan over the whole table. The only other project_experts index is on project_id.
Why it matters: The same reasoning the existing migration gives for the two indexes it does add. These run on a schedule rather than on demand, so the cost is continuous, and it feeds the reconcile starvation problem in H-10. Tables are small today, so this is a scaling item rather than a live outage.
Recommended future fix: Add partial indexes in a follow-up migration: projects((brief->>'sourcingStatus')) where that value is not null, project_experts((data->'nudges'->>'scheduledFor')) where that value is not null, and a plain project_experts(status).
Existing test coverage: none; there are no query-plan assertions anywhere in the repository.
```

**M-10**

```text
Finding: lib/supabase/database.types.ts has drifted from the migrations, and system_events is worked around with an ad-hoc inline type cast.
Severity: Medium
File(s): lib/supabase/database.types.ts:1-20 (header lists five of eight migrations); lib/engagementEvents.ts:203-224 (the cast)
Relevant function/component: Database type / recordSystemFailure
What happens: The hand-authored types file has no system_events table and no user_calendar_connections.weekly_windows column, both created by migration 20260907100000. lib/engagementEvents.ts compensates by declaring a one-off shape and casting the service-role client to it, with a comment saying the generated types do not describe it yet. The header's "keep in sync with" list omits 20260907100000, 20260907300000 and 20260908000000.
Why it matters: This file is the only compile-time check on column names in a codebase that otherwise talks to Postgres through strings. Each hand-written escape hatch removes a table from that check, and the next one is likelier because there is now precedent.
Recommended future fix: Add system_events and weekly_windows to database.types.ts, delete the cast in engagementEvents.ts, and update the header's migration list.
Existing test coverage: npx tsc --noEmit is the only check, and the cast is precisely what defeats it.
```

**M-11**

```text
Finding: Four independent token modules re-implement the same HMAC sign, verify and constant-time-compare logic.
Severity: Medium
File(s): lib/optOutToken.ts:26-69; lib/outreachToken.ts:25-70; lib/availabilityToken.ts:46-164; lib/onboardingOauthState.ts:45-105
Relevant function/component: the generate* / verify* pairs in each file
What happens: Each file duplicates base64url encode and decode helpers, a getSecret() reading AVAILABILITY_TOKEN_SECRET with a 32-character minimum, nonce generation, HMAC-SHA256 signing over a colon-joined payload, and a hand-rolled constant-time comparison. The four implementations are near identical but not shared, and they do not even agree on the comparison idiom: onboardingOauthState returns false on a length mismatch before calling timingSafeEqual, while the other three pad the actual buffer to the expected length first and then separately check equality of lengths. Both idioms are safe as written.
Why it matters: Duplicated cryptographic logic multiplies the surface area for one mistake to be introduced inconsistently, makes secret rotation or an algorithm change a four-file coordinated edit, and invites a future "simplification" of one copy that reintroduces a timing side channel.
Recommended future fix: Extract the shared sign, verify and constant-time-compare primitives into one internal helper, for example lib/hmacToken.ts, that all four call, keeping each module's payload shape and expiry policy distinct.
Existing test coverage: none of the four is imported by any script. scripts/e2e-matchy.ts exercises outreachToken indirectly through the outreach flow.
```

**M-12**

```text
Finding: publishQstashJob sets no deduplication id, so caller-side double invocation can queue the same job twice.
Severity: Medium
File(s): lib/qstashPublish.ts:63-114; lib/sourcingJob.ts:52; lib/contactDiscovery.ts:601; app/api/jobs/schedule-nudges/route.ts:214
Relevant function/component: publishQstashJob
What happens: The function sets Upstash-Retries to 0 by design, documented as avoiding a duplicate nudge from QStash's own retry mechanism, but it never sets an Upstash-Deduplication-Id. Retries=0 guards against provider-side redelivery only, not against the caller being invoked twice for the same engagement before the state that would prevent it is written.
Why it matters: Every duplicate-send hazard in this audit (H-2, H-11, M-41) has a caller-side double-invocation component that a deterministic deduplication id would close in one place.
Recommended future fix: Accept an optional deduplication id in publishQstashJob and have each caller pass a deterministic one derived from project, expert and the scheduled slot or run.
Existing test coverage: none.
```

**M-13**

```text
Finding: rateExpectation and availability reach a non-admin client, which the expertRate redaction rule otherwise forbids.
Severity: Medium
File(s): lib/redactExpert.ts INTERNAL_PROJECT_EXPERT_KEYS (about :91-140); app/api/projects/[projectId]/experts/[expertId]/route.ts:234; components/ClientReadyCard.tsx:136
Relevant function/component: redactExpertForViewer
What happens: expertRate, expertCounterRate and counterRateProposed are stripped precisely so the client never sees the expert-side number, but rateExpectation, free text a staffer records during screening and typically shaped like "wants $600/hr", is not on the list, and neither is the free-text availability field. Both are rendered by ClientReadyCard. The field list is certain; how much staff actually use these legacy screening fields today is not, so this may be dead in practice.
Why it matters: The expert-side rate leaking as prose defeats the numeric rule, and availability can carry the expert's own words verbatim.
Recommended future fix: Add rateExpectation and availability to INTERNAL_PROJECT_EXPERT_KEYS, or retire both fields with the rest of the pre-Matchy screening flow.
Existing test coverage: scripts/check-redaction.ts asserts specific stripped keys; neither of these two is asserted.
```

**M-14**

```text
Finding: /api/parse-brief and /api/projects/[projectId]/interview-guide spend paid LLM calls with no rate limiting, and interview-guide skips the shared mutation guard entirely.
Severity: Medium
File(s): app/api/parse-brief/route.ts:59-105; app/api/projects/[projectId]/interview-guide/route.ts:38-107; lib/projectsGuard.ts
Relevant function/component: POST handlers
What happens: parse-brief accepts up to 8 MB of base64 per call with maxDuration = 60 and forwards it to Anthropic. interview-guide calls OpenAI on every POST. Neither uses lib/rateLimiter.ts, and interview-guide does not use guardMutatingRequest, so it also skips the PROJECTS_ENABLED kill switch, the content-type CSRF surrogate and the 250 KB body cap.
Why it matters: One authenticated account can run up an unbounded model bill, and interview-guide is the only project route without the shared guard.
Recommended future fix: Put both behind the existing rate limiter, and move interview-guide onto guardMutatingRequest for consistency.
Existing test coverage: none.
```

**M-15**

```text
Finding: The interview-guide route parses the model's JSON without validating its shape.
Severity: Medium
File(s): app/api/projects/[projectId]/interview-guide/route.ts:114-128
Relevant function/component: POST
What happens: JSON.parse(text) is cast straight to the expected object. The `?? []` covers a missing array, but a model returning "must_ask" as a string rather than an array makes .map throw, which the catch turns into a 500 with no diagnosis. Nothing checks that the questions are strings before they are rendered.
Why it matters: An intermittent model formatting change becomes an unexplained 500 for the client rather than a retry or a clear error.
Recommended future fix: Validate each field with an Array.isArray plus typeof === 'string' filter, the way lib/projectValidation.ts does elsewhere.
Existing test coverage: none.
```

**M-16**

```text
Finding: Web-page text is interpolated into the expert-extraction prompt with no injection defences.
Severity: Medium
File(s): lib/generateExperts.ts:1147-1160 (formattedResults) and its use in the step 5 extraction prompt
Relevant function/component: generateExperts steps 4 and 5
What happens: Titles, URLs and snippets returned by the search provider are concatenated into the Opus prompt verbatim, with no delimiting, no escaping and no instruction to treat them as data. The downstream filters are structural: an http source_url is required, a hedge-word regex, a full-name check, the conflict list and a score floor. None of them detects instructions embedded in a snippet.
Why it matters: A page engineered to rank for these queries could steer scoring, suppress rivals, or introduce a plausible fabricated person who passes every structural check and reaches the client's candidate list.
Recommended future fix: Wrap the search block in explicit data delimiters with a "treat everything inside as untrusted data" instruction, and add a cheap second-pass sanity check on any candidate whose only evidence is a single low-authority domain.
Existing test coverage: none.
```

**M-17**

```text
Finding: Two concurrent sourcing start requests can both pass the 409 guard and enqueue two runs.
Severity: Medium
File(s): app/api/projects/[projectId]/source-experts/route.ts:87-110
Relevant function/component: POST /api/projects/[projectId]/source-experts
What happens: The guard reads project.sourcingStatus, then a separate updateProjectFields writes 'running'. There is no conditional update and no lock between the read and the write, so two requests interleaving both see a non-running project and both publish a job. Combined with the non-idempotent worker in H-11, both runs append experts.
Why it matters: Duplicate candidates and double LLM and search spend from a double click or a retrying client. The window is short and the UI disables the button, so likelihood in practice is uncertain.
Recommended future fix: Make the transition a conditional update that sets running only where the status is not already running or the start time is stale, and treat a zero-row result as the 409.
Existing test coverage: none.
```

**M-18**

```text
Finding: There is no rate limit or spend budget on sourcing runs.
Severity: Medium
File(s): app/api/projects/[projectId]/source-experts/route.ts (whole handler); lib/searchProviders/index.ts; lib/entitlements.ts:55, :104 (canRunSourcing typed as the literal true)
Relevant function/component: POST /api/projects/[projectId]/source-experts
What happens: The only throttle is one live run per project. An owner can re-run sourcing as soon as the previous run finishes, and can create more projects, each run costing two Haiku calls, one 12k-token Opus call and up to six Exa searches. canRunSourcing is the literal true for every account kind including trial, so billing does not gate it either. Contact enrichment at least has an ENRICHMENT_DAILY_BUDGET variable, unenforced though it is (H-13); sourcing has no equivalent at all.
Why it matters: Unbounded third-party spend from a normal authenticated user, with no per-organization ceiling and no alert.
Recommended future fix: Add a per-organization daily sourcing counter in Redis and refuse with a clear message when it is exceeded.
Existing test coverage: scripts/test-entitlements.ts asserts trial accounts may run sourcing; nothing tests a limit.
```

**M-19**

```text
Finding: No search-provider key is required at boot or documented in .env.example, so the application boots happily with no way to search at all.
Severity: Medium
File(s): lib/validateEnv.ts REQUIRED_VARS and OPTIONAL_VARS; .env.example; lib/searchProviders/index.ts:31-35
Relevant function/component: validateEnv / getSearchProvider
What happens: EXA_API_KEY, TAVILY_API_KEY, SCRAPINGBEE_KEY, SEARCH_PROVIDER and SEARCH_FALLBACK_ENABLED appear in no environment documentation and in neither validateEnv list. ANTRHOPICKEYREAL and OPENAI_API_KEY are required, so a deployment with a working LLM and no search key passes every boot check, and the first symptom is a user's sourcing run failing with no_search_provider.
Why it matters: A silent single-point misconfiguration that breaks the product's core feature and is invisible to the admin env-status console, which reads only those two lists.
Recommended future fix: Add EXA_API_KEY to REQUIRED_VARS, or add all three plus SEARCH_PROVIDER to OPTIONAL_VARS with a boot warning when none is set, and document them in .env.example.
Existing test coverage: none.
```

**M-20**

```text
Finding: The search cache key ignores the provider and the requested result count.
Severity: Medium
File(s): lib/searchCache.ts:22-27 (cacheKeyHash), :29-48; lib/generateExperts.ts runSearchQuery
Relevant function/component: cacheKeyHash / getCachedSearchPage
What happens: The Redis key is HMAC(normalized query) alone. The stored payload records which provider produced the results, but that field is never compared on read. Switching SEARCH_PROVIDER, rotating to the ScrapingBee fallback, or raising MAX_RESULTS_PER_QUERY all keep serving the previous provider's cached page for the remaining seven days.
Why it matters: A provider migration or a quality fix appears to have no effect for a week, and a fallback run's lower-quality results can be cached and then served as if they came from the primary provider.
Recommended future fix: Include the provider name and maxResults in the hashed input, or compare parsed.provider against the current provider on read and treat a mismatch as a miss.
Existing test coverage: none. scripts/test-upstash.ts exercises Upstash generally, not this module.
```

**M-21**

```text
Finding: The Exa provider has no request timeout, while both other providers do.
Severity: Medium
File(s): lib/searchProviders/exa.ts:31-70; contrast lib/searchProviders/tavily.ts and lib/searchProviders/scrapingbee.ts (AbortController, 12 s)
Relevant function/component: exaProvider.search
What happens: The Exa path calls exa.searchAndContents through the SDK with no signal and no timeout, and a 429 adds a one-second sleep plus a full second attempt. Nothing upstream imposes a deadline on generateExperts either, and the worker declares no maxDuration (H-11).
Why it matters: A slow or hanging Exa response stalls the whole sourcing job until the platform terminates the function, which then produces the stuck-'running' state and the redelivery behaviour described in H-11.
Recommended future fix: Pass an AbortSignal or wrap in Promise.race with a timeout matching the 12 seconds the other providers use, and treat a timeout as an empty result rather than a job failure.
Existing test coverage: none.
```

**M-22**

```text
Finding: lib/contactPathResolver.ts is dead code with a live Redis footprint, a search-provider dependency and an insecure-secret fallback.
Severity: Medium
File(s): lib/contactPathResolver.ts (whole file, about 330 lines); lib/domainSuggestions.ts:194 (suggestDomainsForExpert, its only consumer)
Relevant function/component: resolveContactPaths
What happens: A grep for contactPathResolver over .ts and .tsx outside the file itself returns only SECURITY_AUDIT.md references and the module's own log line. resolveContactPaths has zero callers, and the /api/resolve-contact-paths route that SECURITY_AUDIT.md names no longer exists. It is the only consumer of suggestDomainsForExpert and of the `cpath:` Redis namespace, it still pulls in lib/searchProviders, and it contains a `LOG_HASH_SECRET ?? 'dev-insecure-fallback'` path.
Why it matters: It reads as live infrastructure to anyone auditing the contact flow, it keeps suggestDomainsForExpert alive as apparent live code, and it shares the Exa query-logging leak in H-12.
Recommended future fix: Delete the module and suggestDomainsForExpert with it, or reinstate a route. A STATUS header was added in the meantime.
Existing test coverage: none.
```

**M-23**

```text
Finding: EMAIL_PROVIDER_ORDER has no effect; the waterfall builders are unused and the registry map is duplicated.
Severity: Medium
File(s): lib/contactProviders/index.ts:16, :39, :64, :73 (parseProviderOrder, buildProviderWaterfall, getContactProvider, PROVIDER_MAP, ACTIVE_PROVIDERS); lib/contactDiscovery.ts:461
Relevant function/component: parseProviderOrder / buildProviderWaterfall / getContactProvider
What happens: discoverContact hardcodes [snovProvider, hunterProvider].filter(p => p.isConfigured()). buildProviderWaterfall and getContactProvider have no callers, and PROVIDER_MAP and ACTIVE_PROVIDERS are byte-identical duplicates of each other. Setting EMAIL_PROVIDER_ORDER=hunter,snov in production changes nothing.
Why it matters: An operator reaching for the documented knob to shift spend away from an exhausted provider would silently get no change.
Recommended future fix: Either have discoverContact call buildProviderWaterfall (the cache key already carries the provider signature, so an order flip invalidates cleanly), or remove the builders and the environment variable.
Existing test coverage: none.
```

**M-24**

```text
Finding: A transient Snov poll timeout is indistinguishable from "this person has no address", and the false negative is cached for a week.
Severity: Medium
File(s): lib/contactProviders/snov.ts:175, :228 (pollResult); lib/contactDiscovery.ts:500-511 (negative caching)
Relevant function/component: pollResult / discoverContact
What happens: pollResult throws on any non-OK poll response, aborting the lookup after the credit is already spent, and that case is at least recorded as an error. But when polling simply runs out of its eight attempts it returns an empty array, which discoverContact records as not_found. providersAnswered is then true and writeCache stores a seven-day negative result for a person who may well be findable.
Why it matters: A slow provider day poisons the cache for a week, and the client sees "no address" for an expert who has one, with no retry path except waiting out the TTL or bumping CONTACT_CACHE_VERSION.
Recommended future fix: Have pollResult distinguish exhausted polling from an empty answer, for example by returning null rather than an empty array, and only cache a negative when the provider genuinely said no match.
Existing test coverage: none; the test script exercises only the pure functions and the kill switch.
```

**M-25**

```text
Finding: The Hunter API key is placed in the query string on the 401 retry path, contradicting the file's own comments.
Severity: Medium
File(s): lib/contactProviders/hunter.ts:79-95 (hunterGet)
Relevant function/component: hunterGet
What happens: The first request sends Authorization: Bearer <key>; if that returns 401, the same request is retried with api_key=<key> appended to the URL. Two comments in the file asserted the key never appears in the query string; both were corrected during this pass. This fires on every request whenever the Bearer scheme is not accepted, not once.
Why it matters: Secrets in URLs land in proxy logs, CDN logs and error traces. If Hunter ever stops accepting Bearer, every lookup takes this path.
Recommended future fix: Decide the auth scheme once, by probing at startup or via an environment flag, or cache the working scheme in module state after the first success, rather than retrying with the key in the URL.
Existing test coverage: none.
```

**M-26**

```text
Finding: Bounce handling is not implemented, so a bounced intro leaves contactStatus at 'intro_sent' forever.
Severity: Medium
File(s): lib/contactDiscovery.ts:634-643 (DiscoveryJobOutcome); app/api/jobs/contact-discovery/route.ts:14-17; ContactDiscoveryJob.attempt
Relevant function/component: runContactDiscoveryJob outcomes
What happens: The worker's header says a bounce retry is a separate job rather than a redelivery of this one, and ContactDiscoveryJob.attempt exists for exactly that, but no code path ever publishes a job with attempt greater than 1 and there is no bounce webhook feeding back into discovery. DiscoveryJobOutcome has no bounced state. A catch-all address that hard-bounces is never retried and never re-looked-up, because the cache holds it for 90 days.
Why it matters: Catch-all addresses are explicitly accepted as sendable, so bounces are expected. Today they are invisible and the expert silently drops out of the pipeline.
Recommended future fix: On a Resend bounce webhook, invalidate the cache entry, clear contactEmail, and re-publish the job with attempt + 1 under a small cap.
Existing test coverage: none.
```

**M-27**

```text
Finding: The bookmark route's inline send path does not check entitlements, while the contact-discovery job path does.
Severity: Medium
File(s): app/api/projects/[projectId]/experts/[expertId]/bookmark/route.ts:262; lib/contactDiscovery.ts:764-771
Relevant function/component: bookmark POST vs runContactDiscoveryJob
What happens: When the expert already has a contactEmail, the bookmark route computes draftOnly = project.reviewFirst === true || held and sends. It never calls getEntitlementsForProject. The job path computes draftOnly = reviewFirst || isWalkthrough || !entitlements.canOutreachExperts. So an organization with no card on file gets a real intro sent whenever the address happens to be on file already. The chokepoint (lib/emailSequence.sendSequenceEmail) does re-check entitlements and returns a hold, but the bookmark route does not read that outcome, which compounds with H-4.
Why it matters: The billing boundary is enforced on one of the two send paths only, and which one runs depends on incidental data state.
Recommended future fix: Move the gate computation into a single shared helper both callers use, for example draftOnlyFor(project, entitlements).
Existing test coverage: scripts/test-entitlements.ts covers the entitlement itself, not this branch.
```

**M-28**

```text
Finding: The inbound sender check compares an attacker-controllable header and ignores the SPF/DKIM results Resend supplies.
Severity: Medium (uncertain: depends on guarantees in Resend's inbound payload that could not be verified from the code)
File(s): app/api/inbound-email/route.ts:352-366 (sender check), :199-213 (extractFromAddress)
Relevant function/component: POST
What happens: The handler requires payload.from to equal pe.contactEmail. The Svix signature proves Resend sent the payload, not that the email was authentic. Resend relays whatever arrives at reply+TOKEN@expertmatch.fit, and the From header is trivially forgeable. Resend's inbound payload carries authentication results that this handler does not read.
Why it matters: Anyone who obtains a reply token, from a forwarded thread, a leaked email or a shared inbox, could mail as the expert and decline, counter-rate, accept a rate or pick a call time on their behalf, with money and the do-not-contact list downstream.
Recommended future fix: Reject an inbound message whose SPF, DKIM or DMARC result as reported by Resend is not a pass for the sending domain, in addition to the address match.
Existing test coverage: none.
```

**M-29**

```text
Finding: outreach/approve derives the intro topic with a shorter deny list than the bookmark route.
Severity: Medium
File(s): app/api/projects/[projectId]/experts/[expertId]/outreach/approve/route.ts:125-134; .../bookmark/route.ts:264-272; lib/outreachSteps.ts:119
Relevant function/component: POST / runSequenceStep
What happens: bookmark passes firmName: firm?.name, which lib/matchyTemplates.deriveTopic adds to the deny list so a brief naming the client's own firm cannot reach the expert. approve loads the same firm, for firmType, firmSize and the event orgId, but does not pass firmName, so the review-first intro is generalized with one fewer protection than the auto-sent one.
Why it matters: A blinding rule that holds on the default path and not on the deliberately more careful review-first path is the wrong way round. In practice deriveTopic's proper-noun stripper and the firmDomain label term usually catch the name anyway, so this is a missing layer rather than a demonstrated leak.
Recommended future fix: Add firmName: firm?.name ?? null to the runSequenceStep call in approve/route.ts.
Existing test coverage: scripts/test-matchy-templates.ts covers deriveTopic with deny terms; no test compares the two routes.
```

**M-30**

```text
Finding: The approve-and-send idempotency is read-then-write, not atomic.
Severity: Medium
File(s): app/api/projects/[projectId]/experts/[expertId]/messages/[messageId]/send/route.ts:103-108 (check), :153 (send), :156 (clear)
Relevant function/component: POST
What happens: The route reads screen_result.pending === true, sends, then clears the flag. Two concurrent POSTs, from a double click or a retried fetch, both pass the check before either clears it, and the expert is mailed twice. The header comment states the route is idempotent, which is true only for sequential calls.
Why it matters: A duplicate follow-up quoting the rate reads as disorganized to the expert and can confuse the negotiation state.
Recommended future fix: Clear the flag with a conditional update filtered on the pending flag and treat zero rows updated as "already sent", before calling Resend.
Existing test coverage: scripts/e2e-matchy.ts exercises the route sequentially only.
```

**M-31**

```text
Finding: The unsubscribe link is a plain GET and the recipient's address is recoverable from the URL.
Severity: Medium
File(s): app/api/outreach/unsubscribe/route.ts:43-76; lib/optOutToken.ts:26-32; lib/outreachFooter.ts:33-36
Relevant function/component: GET / generateOptOutToken / buildOptOutUrl
What happens: The token is base64url("optout:base64url(email):expiry:nonce") plus an HMAC. The HMAC stops third-party tampering, but base64url is encoding, not encryption, so anyone holding the link (a mail gateway, a proxy log, a forwarded email) can read the address. Separately, a plain GET records the opt-out on first fetch, and corporate link scanners and prefetchers routinely fetch every URL in a message. The route's own comment claimed the address never appears in the URL; it was corrected during this pass, and lib/outreachFooter.ts still carries the same inaccurate framing.
Why it matters: Expert addresses are the asset the platform is built on. A scanner-triggered opt-out silently removes a reachable expert from every future project, and the address leaks into logs it should not be in.
Recommended future fix: Implement RFC 8058 one-click (List-Unsubscribe plus List-Unsubscribe-Post) so only a POST commits, or show a confirm button, and key the token on an opaque contact id rather than embedding the address.
Existing test coverage: none.
```

**M-32**

```text
Finding: The Calendly provider appears to be non-functional: both API calls are unauthenticated and every failure degrades silently to no availability.
Severity: Medium (uncertain: not verified against a live Calendly account)
File(s): lib/fetchCalendlySlots.ts:55-89 (fetchEventTypes), :137-158 (fetchAvailableTimes); app/api/onboarding/calendar/route.ts; lib/calendarConnections.ts connectionIsUsable
Relevant function/component: fetchEventTypes / fetchAvailableTimes
What happens: fetchEventTypes calls https://api.calendly.com/event_types with an organization and user query built from a URL path segment, with no Authorization header, where Calendly's documented API expects a user URI containing an account UUID. There is no CALENDLY_* environment variable anywhere in the repository. A non-OK response returns an empty array, and the outer catch returns an empty array, so a 401 and a genuinely full calendar are indistinguishable.
Why it matters: A client who picks Calendly during onboarding passes the connected check, because connectionIsUsable needs only a URL, but may produce zero slots forever, surfacing as no_client_availability on every proposal.
Recommended future fix: Test one real public Calendly link end to end. If authentication is required, add a Calendly token or OAuth, or drop the option from onboarding rather than presenting a path that cannot schedule.
Existing test coverage: none.
```

**M-33**

```text
Finding: An expert who types free-text availability windows loses their linked Google calendar as a data source.
Severity: Medium
File(s): app/api/schedule/[token]/route.ts:390-398 (handleUnavailable); lib/matchyScheduling.ts:308-343
Relevant function/component: handleUnavailable
What happens: When the reply parser extracts windows, the write sets calendarProvider: 'manual' alongside availabilitySlots. expertHasConnectedCalendar and expertKnownWindows both branch on calendarProvider, so a previously connected Google account stops being queried. The ciphertext stays on the row but is unreachable, and the picker starts offering "Connect Google Calendar" again.
Why it matters: The most informative signal, real free/busy, is replaced by the least informative one, a sentence, at exactly the round where finding an overlap is hardest.
Recommended future fix: Only set calendarProvider:'manual' when the current provider is absent or already manual, or store typed windows in a separate field that supplements rather than replaces the provider.
Existing test coverage: none.
```

**M-34**

```text
Finding: A booking whose Zoom creation failed can never acquire a meeting, so it never completes and is never billed.
Severity: Medium
File(s): lib/bookCall.ts:217-218 (createZoomMeeting catch), :329-331 (rebookCall PATCH only); app/api/webhooks/zoom/route.ts:62, :78; lib/zoomLookup.ts
Relevant function/component: bookCall / rebookCall
What happens: createZoomMeeting(...).catch(() => null) is deliberately survivable: the booking is written with zoomMeetingId: null and the invite says the link will follow. But rebookCall only PATCHes an existing id and never creates one, and nothing else in the codebase retries creation. findProjectExpertByZoomMeetingId therefore never matches this engagement, so meeting.ended never fires and the completion and invoice path is never entered. updateZoomMeeting's boolean return is also discarded, so a failed PATCH leaves Zoom on the old time with no record.
Why it matters: A call that really happened stays 'scheduled' forever and is never charged, which is silent revenue loss, and the client keeps an invite with no join link.
Recommended future fix: Attempt creation in rebookCall when previous.zoomMeetingId is null, and surface a repaired or failed Zoom link through lib/attention.ts so a human sees it.
Existing test coverage: scripts/e2e-matchy.ts exercises bookCall, but HANDOFF notes the booked card and the move-the-call flow were never exercised against a real Zoom meeting.
```

**M-35**

```text
Finding: meeting.ended computes a NaN duration when Zoom omits start_time, and that NaN reaches the charge calculation.
Severity: Medium
File(s): app/api/webhooks/zoom/route.ts:71-76, :94-98
Relevant function/component: POST (meeting.ended branch)
What happens: startTs = new Date(String(obj?.start_time ?? '')).getTime() is NaN for a missing or unparseable stamp. Math.max(1, Math.ceil((resolvedEnd - NaN)/60000)) is NaN, which is written to actualDurationMin and passed to callChargeDollars. Nothing validates the arithmetic before the invoice is created.
Why it matters: A NaN feeding the charge calculation is a money bug whose outcome depends entirely on lib/pricing's tolerance, and at best the stored duration is unusable for reconciliation.
Recommended future fix: Guard with Number.isFinite(startTs) and fall back to booking.durationMin, or skip invoicing and record a system failure, when the payload is unusable.
Existing test coverage: none.
```

**M-36**

```text
Finding: Every bounded scan in both cron routes uses .limit() with no .order() and no cursor, so overflow silently drops an arbitrary subset.
Severity: Medium
File(s): app/api/jobs/schedule-nudges/route.ts:137-141 (MAX_ROWS 500); app/api/jobs/reconcile/route.ts:92-96 (MAX_ORGS 500), :169-173 (MAX_PENDING_PAYOUTS 500), :202-206 (MAX_STUCK_PROJECTS 200)
Relevant function/component: GET handlers, sweepSeats, sweepPayouts, sweepSourcing
What happens: Each query is .select(...).filter(...).limit(N) with no ORDER BY. Postgres is free to return any N matching rows, and the set is not stable between runs. Once the matching set exceeds N the excess is not processed, and nothing in the response distinguishes "exactly N matched" from "N of 5000 matched"; result.scanned reports the truncated count as if it were the whole set.
Why it matters: A waiting engagement can be starved for several consecutive days with no signal, breaking the four-business-day promise the nudge feature is built around, and the same is true of a stuck sourcing run that never gets reset.
Recommended future fix: Add a stable .order('updated_at') ascending so the least recently handled row wins, plus keyset pagination, and set an overflow flag on the result when a full page comes back.
Existing test coverage: none.
```

**M-37**

```text
Finding: sweepPayouts's row bound (500) is larger than the bound of the function that actually pays (200), and the design is one full table scan per Connect account.
Severity: Medium
File(s): app/api/jobs/reconcile/route.ts:51, :169-176; lib/expertPayout.ts:233 (MAX_PENDING_ROWS = 200), :276-280
Relevant function/component: sweepPayouts / retryPendingPayoutsForAccount
What happens: sweepPayouts reads up to 500 pending rows solely to collect distinct account ids. retryPendingPayoutsForAccount then re-runs essentially the same query capped at 200 rows, once per account, and filters client-side for the one account it cares about. The same pending set is scanned once plus once per distinct account, and a pending row that Postgres places past the 200th in that inner query is discovered by the outer scan but never paid.
Why it matters: An expert who is owed money can be permanently skipped once the pending backlog exceeds 200, and the N+1 multiplies the reconcile route's time cost, feeding the starvation problem in H-10.
Recommended future fix: Add a retryPendingPayouts() with no account filter to lib/expertPayout.ts that does one ordered, paginated pass, and have reconcile call that instead of enumerating accounts.
Existing test coverage: none.
```

**M-38**

```text
Finding: sweepPayouts records a system_events failure on every night where any pending payout is unpaid, which is the normal steady state.
Severity: Medium
File(s): app/api/jobs/reconcile/route.ts:198-203
Relevant function/component: sweepPayouts
What happens: After the retries, `if (attempted > paid)` records a system failure reading "N pending payout(s) still unpaid after the nightly retry". But attempted-but-not-paid is the expected outcome for every expert who has not finished Stripe onboarding, since the retry cannot pay them by design. The alert therefore fires every night for as long as one expert has an incomplete Connect account.
Why it matters: An alert that is always on is an alert nobody reads, and it devalues the system_events table, which is the operator's only view of failures the request path swallows.
Recommended future fix: Only record a failure when a payout was attempted against a Connect account that isOnboardingComplete says is usable and still did not transfer, or when a row has been pending beyond a threshold such as 14 days.
Existing test coverage: none.
```

**M-39**

```text
Finding: The nudge worker's QStash signature check can be bypassed entirely in a non-production build with no signing key set, and the same pattern exists in the contact-discovery worker.
Severity: Medium
File(s): app/api/jobs/send-nudge/route.ts:134; app/api/jobs/contact-discovery/route.ts (same gating); middleware.ts:59 (/api/jobs/ exempt from session auth)
Relevant function/component: POST handler
What happens: The whole verification block is gated on `process.env.NODE_ENV === 'production' || process.env.QSTASH_CURRENT_SIGNING_KEY`. If neither holds, an unauthenticated POST with a well-formed body reaches the full send path, and middleware exempts /api/jobs/ from session auth so nothing else stops it. In practice Next sets NODE_ENV=production for every Vercel build including previews, so this is a developer-machine and self-hosted concern rather than a live one, which is why it is Medium rather than Critical.
Why it matters: The bypass is on a route that sends real email to a real expert. An operator running a self-hosted or staging build with NODE_ENV unset has an open nudge-sending endpoint.
Recommended future fix: Require the signing keys unconditionally and return 503 when they are absent, matching the CRON_SECRET pattern the two cron routes already use. Let a local harness inject a stub receiver instead of disabling the check.
Existing test coverage: none.
```

**M-40**

```text
Finding: sweepSourcing writes into projects.brief via a read-modify-write and can mark a slow but live sourcing run as failed.
Severity: Medium
File(s): app/api/jobs/reconcile/route.ts:218-263 (sweepSourcing); lib/projectStore.ts:786-813 (updateProjectFields); lib/attention.ts:60 (STUCK_SOURCING_MINUTES = 15)
Relevant function/component: sweepSourcing
What happens: updateProjectFields reads the whole brief document, merges the patch and writes the whole document back with no optimistic concurrency. A sourcing worker still alive at 15 minutes but writing its results at the same moment can have those results clobbered, or can complete just after the sweep has told the client the run failed. Separately, the fallback when sourcingStartedAt is absent is Date.parse(row.updated_at), and any unrelated write to the project row refreshes updated_at, so a genuinely stuck run on a busy project can evade the cutoff indefinitely.
Why it matters: The client is shown "Sourcing stopped before it finished" for a run that may have succeeded, and re-running sourcing costs a fresh round of search and LLM spend. The sourcing worker's own maxDuration could not be compared against the 15-minute cutoff because it declares none (H-11).
Recommended future fix: Add a conditional update so the sweep only transitions a row still in 'running', and make sourcingStartedAt mandatory rather than falling back to updated_at.
Existing test coverage: none.
```

**M-41**

```text
Finding: Two nudge jobs published for the same morning both pass the worker's re-validation ladder; the only thing preventing a double email is read-then-write ordering.
Severity: Medium (uncertain: reachability in production not confirmed)
File(s): app/api/jobs/send-nudge/route.ts:185-186 (supersede check), :254-263 (the write); lib/qstashPublish.ts:80-90; lib/nudges.ts:510-515 (already_queued)
Relevant function/component: POST handler / publishQstashJob
What happens: The supersede guard compares state.scheduledDay against job.day, which is day granularity. NudgeState carries no job id and publishQstashJob sets no deduplication id, so two jobs published for the same civil day are indistinguishable to the worker and both pass every check. The only thing that stops the second is the successful send's write clearing scheduledFor, an unsynchronised read-then-write with no compare-and-set. The planner makes this hard to reach: a second planner run before delivery is refused with already_queued, and two independent 0 to 3600 second jitters rarely land in the same second.
Why it matters: The failure mode is two follow-up emails to the same expert on the same morning, which the founder's own rule excludes and which the entire planner/worker split exists to prevent.
Recommended future fix: Give each queued nudge a random jobId, store it in NudgeState, and require state.jobId === job.jobId in the worker; and pass an Upstash-Deduplication-Id of `${projectId}:${expertId}:${day}` on publish.
Existing test coverage: scripts/test-nudges.ts covers shouldSchedule's already_queued branch; nothing covers the worker's supersede logic.
```

**M-42**

```text
Finding: The Stripe webhook does not de-duplicate on event.id and has no ordering protection.
Severity: Medium
File(s): app/api/webhooks/stripe/route.ts:100-191
Relevant function/component: POST
What happens: Signature verification is correct and runs before any write, but event.id is never stored, and a grep finds no stripe_events or webhook_events table. Duplicate delivery re-runs every branch. The money branches happen to be idempotent today, because the paid and failed writes are the same values and runExpertPayout guards on stripeTransferId plus a deterministic transfer key, so this is a latent hazard rather than a live double-pay. On ordering, a late customer.subscription.updated can overwrite the past_due status mirrored from invoice.payment_failed.
Why it matters: Any future branch that is not naturally idempotent will double-apply, and the organization's mirrored subscription status can silently be wrong in the settings UI and on the admin attention list.
Recommended future fix: Insert event.id into a unique-keyed processed-events table and return 200 early on conflict, and carry a monotonic marker before overwriting subscription_status.
Existing test coverage: none.
```

**M-43**

```text
Finding: A failed client payment sets paymentStatus 'failed' and alerts nobody.
Severity: Medium
File(s): app/api/webhooks/stripe/route.ts:81-88, :143-151 (handlePaymentFailed); lib/expertPayout.ts:199-205 (catch); lib/createAndSendInvoice.ts:396-400 (catch); lib/engagementEvents.ts:176 (the 'invoice' and 'payout' areas)
Relevant function/component: handlePaymentFailed / runExpertPayout catch / createAndSendInvoice catch
What happens: handlePaymentFailed writes 'failed' and logs. recordSystemFailure supports the areas 'invoice' and 'payout', but the only writers of those areas are lib/orgBilling.cancelOrgSubscription and the nightly reconcile job; no branch here records one. createAndSendInvoice returning null, whether from a Stripe outage or an entitlement refusal, likewise only console.errors.
Why it matters: An uncharged completed call never appears on the admin attention list, so nobody chases it, and the expert is never paid because the payout only runs on payment success.
Recommended future fix: Call recordSystemFailure({area:'invoice'|'payout', projectId, expertId}) in these three failure paths so lib/attention surfaces them.
Existing test coverage: none.
```

**M-44**

```text
Finding: Any firm member, not just the champion, can be the one who saves the firm's card and starts its per-seat subscription.
Severity: Medium (uncertain: this may be the intended first-colleague-wins design, but it is the one billing decision with no org_admin gate)
File(s): app/api/onboarding/billing/route.ts:89, :120-147; app/api/onboarding/billing/confirm/route.ts:111; app/api/settings/payment-method/route.ts:118-124
Relevant function/component: POST /api/onboarding/billing
What happens: The org_admin gate applies only to the replace and activate actions. A plain onboarding POST from an ordinary member of an organization that is not yet billing_complete mints a SetupIntent, and /confirm then runs completeOrgBilling, which creates the seat subscription for the whole firm. Reading the card back afterwards is champion-only.
Why it matters: A junior user can commit their firm to a recurring per-seat charge, and only the champion can then see or alter it.
Recommended future fix: Either gate first-time card capture on org_admin too, or state explicitly in the route header that first-touch capture is deliberately open.
Existing test coverage: none.
```

**M-45**

```text
Finding: The isAdmin gating of the contactEmail badge and the raw status select in ProjectExpertCard is a UI convenience that reads like a security boundary.
Severity: Medium
File(s): components/ProjectExpertCard.tsx:401-440; components/ConversationThread.tsx:168 (StaffPanel, same pattern); lib/redactExpert.ts (the actual control)
Relevant function/component: ProjectExpertCard render, isAdmin prop
What happens: The contact-email mailto link and the raw-status select render only when isAdmin is true. isAdmin is a prop from app/projects/[projectId]/page.tsx's currentUserRole === 'admin', itself read from GET /api/auth/me. Nothing in the component re-verifies the role. This is not currently exploitable, because lib/redactExpert.ts strips contactEmail server-side for non-admins so the field is simply absent from the payload, but the pattern reads as a gate at the call site.
Why it matters: A future refactor that hardcodes isAdmin, or reads the wrong session field, would look correct at the call site while relying entirely on a redaction step in a different module. The risk is that someone treats the prop as sufficient.
Recommended future fix: No code change needed given the server-side redaction; a file header comment documenting the boundary was added during this pass so future edits do not mistake this for the actual control.
Existing test coverage: none in the component layer; the redaction itself is covered by scripts/check-redaction.ts.
```

**M-46**

```text
Finding: Deleting a user who owns any project fails with an opaque 500 rather than a clear message.
Severity: Medium
File(s): app/api/admin/users/route.ts:184-222 (DELETE); lib/firmStore.ts:524-531 (deleteUser); supabase/migrations/20260831000000_supabase_cutover_foundation.sql:70, :122
Relevant function/component: DELETE /api/admin/users, deleteUser
What happens: profiles.id cascades from auth.users, but projects.owner_id references profiles(id) ON DELETE RESTRICT. deleteUser calls deleteSupabaseUser with no project-ownership pre-check, so an admin deleting a user who owns at least one project gets a raw Postgres foreign-key violation caught by the route's generic catch, surfacing only "Failed to delete user" with no indication of why or what to do.
Why it matters: It fails safe, since no project is orphaned, but it wastes admin time and looks like a platform bug rather than an expected constraint. There is no UI hint that project ownership blocks deletion.
Recommended future fix: Check for owned projects before calling deleteSupabaseUser and return a specific 409 naming the blocking projects, or offer a reassign-owner flow.
Existing test coverage: none.
```

**M-47**

```text
Finding: Deleting an organization does not check for remaining members.
Severity: Medium
File(s): app/api/admin/firms/route.ts:185-230 (DELETE)
Relevant function/component: DELETE /api/admin/firms
What happens: The delete flow guards only against a live Stripe subscription, cancelling first and returning 409 on failure. It does not check whether organization_members or profiles still reference the organization before calling deleteFirm(domain). Whether that fails at the foreign-key layer or silently orphans members depends on constraints that were not re-verified in this pass.
Why it matters: If members are silently orphaned, with an org_id pointing nowhere, those users end up in an inconsistent state, active membership with no organization, with no admin-visible cause.
Recommended future fix: Explicitly check the active and pending member count before allowing an organization delete, and either block it or require a remove-all-members-first confirmation.
Existing test coverage: none.
```

**M-48**

```text
Finding: scripts/test-matchy-templates.ts fails 2 of 105 checks against the current lib/matchyTemplates.ts.
Severity: Medium
File(s): scripts/test-matchy-templates.ts:88-90, :216; lib/matchyTemplates.ts deriveTopic
Relevant function/component: deriveTopic
What happens: Running the script fails on "structured industry + function wins" (got "anything at all", wanted "operations in veterinary services") and "empty question falls back to industry" (got "this market", wanted "specialty pharma"). The test expects deriveTopic to prefer structured industry and function fields over, or as a fallback from, researchQuestion; the current implementation prefers or echoes researchQuestion instead.
Why it matters: Either the outreach-email topic clause is silently wrong for structured intake data, which is a real product bug because the expert receives a vaguer or incorrect description, or the test has drifted from an intentional behaviour change and is now a false alarm masking real regressions. Left failing, this script's non-zero exit gates nothing.
Recommended future fix: A human should decide which side is correct by checking deriveTopic against docs/MATCHY_SPEC.md, then either fix the implementation or update the two assertions, and keep the script green.
Existing test coverage: this is the failing script itself.
```

**M-49**

```text
Finding: Two parallel OAuth-state implementations exist for the same purpose, and only one cross-checks the session identity.
Severity: Medium
File(s): app/api/availability/[token]/google-auth/route.ts:58-66, :136-145 (inline buildState/verifyState); app/api/availability/oauth/google/callback/route.ts:70-74; lib/onboardingOauthState.ts (the client-side implementation); app/api/onboarding/calendar/google/callback/route.ts
Relevant function/component: buildState / verifyState vs buildOnboardingOAuthState / verifyOnboardingOAuthState
What happens: The expert-facing calendar flow uses an inline state builder and verifier defined in the route files; the client-facing onboarding flow uses lib/onboardingOauthState.ts. They share AVAILABILITY_TOKEN_SECRET but differ in payload shape, in nonce storage (project_experts.data.oauthState versus user_calendar_connections.oauth_state), and in whether the signed email is compared against the live session. Only the onboarding one does that comparison.
Why it matters: Two implementations of the same CSRF defence is a class of drift: a fix or a hardening applied to one will not reach the other, and the weaker of the two is the one used on the public, token-authenticated expert path.
Recommended future fix: Consolidate both onto lib/onboardingOauthState.ts with a discriminated payload, keeping the session cross-check where a session exists and the picker-token binding where it does not.
Existing test coverage: none for either implementation.
```

**M-50**

```text
Finding: Four environment variables are required by validateEnv or documented in .env.example but read by no code, and two of them will block a fresh deploy.
Severity: Medium
File(s): lib/validateEnv.ts:30 (GOOGLE_CALENDAR_REFRESH_TOKEN), :44 (STRIPE_CONNECT_CLIENT_ID); .env.example:33 (SESSION_SECRET), .env.example (CONTACT_ENRICHMENT_ADMIN_TOKEN, CONTACT_PROVIDER)
Relevant function/component: REQUIRED_VARS / validateEnv
What happens: A repository-wide grep for process.env.<NAME> across app/, lib/, components/ and scripts/ finds zero reads of GOOGLE_CALENDAR_REFRESH_TOKEN, STRIPE_CONNECT_CLIENT_ID, SESSION_SECRET, CONTACT_ENRICHMENT_ADMIN_TOKEN or CONTACT_PROVIDER. The first two are in REQUIRED_VARS, so validateEnv throws at boot in production if they are absent, crashing the deploy for variables nothing uses. SESSION_SECRET is a remnant of the removed HMAC-cookie session system, CONTACT_ENRICHMENT_ADMIN_TOKEN of the deleted /api/enrich-contact route, and CONTACT_PROVIDER of the superseded single-provider selection.
Why it matters: A fresh deployment, or a rotation that drops one of these, fails to boot for a reason that cannot be diagnosed from the code, because there is nothing to read. The admin env-status console reports them as required and MISSING, which sends the operator looking for a Google Calendar refresh token and a Stripe Connect client id the product does not use.
Recommended future fix: Remove GOOGLE_CALENDAR_REFRESH_TOKEN and STRIPE_CONNECT_CLIENT_ID from REQUIRED_VARS (confirm first that Stripe Connect Express really does not need a client id in this integration shape), and delete SESSION_SECRET, CONTACT_ENRICHMENT_ADMIN_TOKEN and CONTACT_PROVIDER from .env.example.
Existing test coverage: none. scripts/security-scan.sh checks for undocumented environment variables but not for documented ones that are never read.
```

**M-51**

```text
Finding: Fourteen environment variables that the running code actually reads appear in neither validateEnv list nor .env.example, so the admin env-status console cannot report them.
Severity: Medium
File(s): lib/validateEnv.ts REQUIRED_VARS/OPTIONAL_VARS; .env.example; app/api/admin/env-status/route.ts; read sites: lib/projectsGuard.ts (PROJECTS_ENABLED, PROJECTS_ADMIN_TOKEN), lib/auth.ts (APP_AUTH_ENABLED), lib/firmStore.ts (ADMIN_NOTIFICATION_EMAIL), lib/contactProviders/index.ts (EMAIL_PROVIDER_ORDER), lib/contactCache.ts (CONTACT_CACHE_VERSION), lib/searchProviders/index.ts (SEARCH_PROVIDER, SEARCH_FALLBACK_ENABLED, SEARCH_COMPARE_PROVIDERS), lib/searchProviders/{exa,tavily,scrapingbee}.ts (EXA_API_KEY, TAVILY_API_KEY, SCRAPINGBEE_KEY), seven files reading NEXT_PUBLIC_BASE_URL, seven reading DISABLE_EMAILS
Relevant function/component: validateEnv / GET /api/admin/env-status
What happens: Each of these was confirmed present with a process.env read in app/, lib/ or components/. None appears in REQUIRED_VARS, OPTIONAL_VARS or .env.example. Because the env-status route iterates only those two exported lists, none of them can be seen in the admin console, which is described in the code as the one place that answers "did I already add that key?" without opening the Vercel dashboard.
Why it matters: Two of them are kill switches (PROJECTS_ENABLED returns 503 from every projects route, DISABLE_EMAILS suppresses all outbound mail) and three are the search-provider keys the core feature depends on (see M-19). An operator cannot confirm the state of any of them from inside the product.
Recommended future fix: Add all fourteen to OPTIONAL_VARS and to .env.example with a one-line description each, keeping REQUIRED_VARS for what genuinely must be present at boot.
Existing test coverage: none.
```

## Low

**L-1**

```text
Finding: The required environment variable ANTRHOPICKEYREAL is a misspelling of "ANTHROPIC" that is now load-bearing.
Severity: Low
File(s): lib/validateEnv.ts:50 (REQUIRED_VARS); lib/generateExperts.ts; lib/anonymizeExpert.ts; app/api/parse-brief/route.ts
Relevant function/component: REQUIRED_VARS and every Anthropic client construction
What happens: The list of variables the application refuses to boot without in production contains the literal string 'ANTRHOPICKEYREAL'. This is the real deployed variable name and every read site matches it, so nothing is broken. It is a deliberate historical name rather than a bug.
Why it matters: It is a naming trap. Anyone adding a correctly spelled ANTHROPIC_API_KEY would find it silently ignored, and the boot check would still pass or fail on the misspelled one.
Recommended future fix: If it is ever renamed, do it as one coordinated change across REQUIRED_VARS, the Vercel dashboard, .env.example and every read site. There is no urgency.
Existing test coverage: none.
```

**L-2**

```text
Finding: Color and design tokens are hand-duplicated between tailwind.config.js and app/globals.css.
Severity: Low
File(s): tailwind.config.js:10-40 (theme.extend.colors); app/globals.css:5-11 (:root custom properties)
Relevant function/component: theme tokens
What happens: The navy, gold, cream, muted and border hex values are defined once in the Tailwind config and again as CSS custom properties, with no single source of truth and no build step keeping them in sync.
Why it matters: A palette change made in one file but not the other silently produces inconsistent colors between Tailwind utility classes and any code using the CSS variables directly.
Recommended future fix: Generate one file from the other, or reference the Tailwind theme value from CSS via a build step, if this becomes a maintenance pain point.
Existing test coverage: none; visual only.
```

**L-3**

```text
Finding: Admin notification recipients for access requests are hardcoded personal addresses in source.
Severity: Low
File(s): app/api/request-access/route.ts:68 (ADMIN_NOTIFY_EMAILS); contrast lib/firmStore.ts:758 (ADMIN_NOTIFICATION_EMAIL)
Relevant function/component: POST /api/request-access
What happens: Two addresses are string literals, one of them a personal Gmail account. Every other admin notification in the repository reads ADMIN_NOTIFICATION_EMAIL. Changing who is alerted to a new customer requires a code change and a deploy.
Why it matters: Two sources of truth for the same concept, and a single point of failure at the front of the funnel: if that inbox is unattended, access requests go unprocessed with no other signal.
Recommended future fix: Read from ADMIN_NOTIFICATION_EMAIL as a comma-separated list, with the current values documented as the default in .env.example.
Existing test coverage: none.
```

**L-4**

```text
Finding: trackProductEvent is fired as a floating promise on the login path, contradicting the repository's own documented Vercel behaviour.
Severity: Low
File(s): app/api/auth/login/route.ts:136 (`void trackProductEvent(...)`); contrast app/api/request-access/route.ts:190
Relevant function/component: POST /api/auth/login
What happens: The call is not awaited. The request-access route carries an explicit comment that on Vercel a floating promise can be cut off when the response returns, and awaits its send for that reason. Every other trackProductEvent call site awaits. signed_in events are therefore dropped non-deterministically.
Why it matters: signed_in is the first step of the trial funnel that lib/productEvents.ts exists to measure, so the metric is quietly lossy. No user-facing impact.
Recommended future fix: Await it, since trackProductEvent never throws, or move it behind waitUntil().
Existing test coverage: none.
```

**L-5**

```text
Finding: Dead code: the three rate-limiter tiers and their only consumer route are gone.
Severity: Low
File(s): lib/rateLimiter.ts:79-131 (checkRequestThrottle, checkCreditLimits, checkAndIncrementGlobalBudget, incrementProviderDailyCount)
Relevant function/component: as listed
What happens: Verified by grep: these four exports appear only in lib/rateLimiter.ts. app/api/enrich-contact, named in the module header as their purpose, does not exist, and checkContactLookupLimits, also advertised in the header, is not in the file. createRateLimiterStore() is still live, used by five token-gated public routes, so the module must stay.
Why it matters: The header describes a call-site topology that no longer exists, which misleads anyone reading it for the current rate-limiting design, and ENRICHMENT_DAILY_BUDGET is inert as a result (see H-13).
Recommended future fix: Delete the four functions and trim the header to describe createRateLimiterStore only.
Existing test coverage: none.
```

**L-6**

```text
Finding: Dead code: lib/supabase/client.ts has no importers, six UpstashRedis methods have none, and two signupToken Redis helpers are reachable only from a test.
Severity: Low
File(s): lib/supabase/client.ts (whole module); lib/upstashRedis.ts:95-124 (getAndDel, sadd, srem, smembers, sismember, scard); lib/signupToken.ts (tokenRedisKey, tokenTtlSeconds)
Relevant function/component: createClient (browser); UpstashRedis set operations
What happens: A grep across .ts and .tsx finds no import of supabase/client. The Redis set operations and getAndDel served the Redis-era single-use token flow that lib/authLinks.ts replaced with Supabase recovery tokens; keys() and delMany() survive only in scripts/wipe-projects.ts. The signupToken Redis helpers are reachable only from scripts/test-signup-token.ts. Both files' headers previously described the superseded HMAC-cookie architecture and were corrected during this pass.
Why it matters: Cleanup only.
Recommended future fix: Keep lib/supabase/client.ts as the sanctioned browser entry point, since it is harmless and the right shape if a client component ever needs it, but delete the unused Redis helpers and the two signupToken helpers with their tests.
Existing test coverage: scripts/test-upstash.ts and scripts/test-signup-token.ts exercise some of these.
```

**L-7**

```text
Finding: Re-issuing an invite does not invalidate the previous link, so multiple redeemable set-password links can be live for one account.
Severity: Low
File(s): lib/authLinks.ts:55-91 (mintSetPasswordLink); lib/accountProvisioning.ts:266, :347
Relevant function/component: mintSetPasswordLink
What happens: Each "resend invite" calls admin.auth.admin.generateLink({type:'recovery'}) again. Supabase issues a fresh hashed_token; whether it revokes previously issued recovery tokens for the same user could not be confirmed from the code, and the application does not track or revoke them itself. The HMAC half expires independently at 24 hours for an invite and 1 hour for a reset, and each link is individually single-use, so the blast radius is bounded by the invite's own expiry window.
Why it matters: It widens the window in which an old email forwarded or leaked from an inbox still works. Rated Low because Supabase's revocation semantics here are uncertain.
Recommended future fix: Confirm Supabase's behaviour. If old tokens survive, record the latest hashed_token per account and refuse any other at redemption time.
Existing test coverage: none.
```

**L-8**

```text
Finding: /api/auth/set-password has a per-link attempt cap but no per-IP cap.
Severity: Low
File(s): app/api/auth/set-password/route.ts:135-144 (overAttemptLimit), :176
Relevant function/component: overAttemptLimit
What happens: The counter key is derived from the submitted token, so an attacker enumerating tokens gets a fresh five-attempt budget per guess. There is no per-IP counter as there is on /api/auth/login and /api/request-access. The tokens are HMAC-SHA256 signed with a 16-byte nonce, so guessing one is not feasible and the cap is defence in depth rather than the primary control.
Why it matters: Low. The signature is what protects this endpoint; the cap only limits password-retry volume against a link an attacker already holds.
Recommended future fix: Add a per-IP counter alongside the per-link one.
Existing test coverage: none.
```

**L-9**

```text
Finding: The RLS helper functions for project access are now referenced by no policy but remain executable by any authenticated session.
Severity: Low
File(s): supabase/migrations/20260831000000_supabase_cutover_foundation.sql (is_project_owner, has_project_access); supabase/migrations/20260902000000_org_billing_and_rls_hardening.sql (is_active_member_of_project_org, is_platform_admin_profile)
Relevant function/component: SECURITY DEFINER RLS helpers
What happens: Migration 20260908000000 keeps the helpers deliberately, and may_be_project_member is still live via trg_project_members_same_org. But has_project_access, is_project_owner and is_active_member_of_project_org are now called by nothing, and Supabase grants EXECUTE on public functions to authenticated by default. is_platform_admin_profile(uuid) is the one with information content: an authenticated caller who knows a profile uuid can learn whether that profile is a platform admin.
Why it matters: Small. The others only answer questions about auth.uid()'s own access, and the platform-admin probe requires already knowing a uuid. It is a surface that exists for no current reason.
Recommended future fix: Revoke execute from anon and authenticated on all four and leave them for the trigger and any future policies. Dropping them would make reintroducing per-user policies harder, so revoking is the safer option.
Existing test coverage: verify.sql asserts is_active_member_of_project_org exists; nothing asserts who may execute it.
```

**L-10**

```text
Finding: handle_new_user swallows a profiles.email unique violation, which would leave an auth user with no profile row.
Severity: Low
File(s): supabase/migrations/20260831000000_supabase_cutover_foundation.sql (handle_new_user)
Relevant function/component: handle_new_user
What happens: The insert is wrapped in an exception block that catches unique_violation and does nothing, so the auth signup succeeds with no public.profiles row. The comment explains the choice, never fail the auth insert, and says the service role can repair it. Downstream, lib/projectStore.profileIdByEmail resolves by email, so the new user would silently map to whatever stale profile holds that address.
Why it matters: profiles.id is an ON DELETE CASCADE foreign key to auth.users, so a genuinely orphaned profile should not exist and this path is close to unreachable; no case could be constructed where it fires. It is stated because the consequence, if it did fire, is one user resolving to another user's profile id.
Recommended future fix: Record the collision as a system_events row instead of doing nothing, so a silent path becomes a visible one.
Existing test coverage: none; verify.sql relies on the trigger working but never exercises the collision branch.
```

**L-11**

```text
Finding: The A1 conversation_messages assertion in the RLS suite is vacuous, because no message fixtures exist.
Severity: Low
File(s): scripts/rls/verify.sql:409-413 (section 4, actor A1)
Relevant function/component: "A1: sees no conversation_messages"
What happens: The assertion counts rows for PA1 and PA2, but section 1 inserts no conversation_messages fixtures, so the count is 0 whether or not the SELECT policy was dropped. It passes identically against the old and the new schema.
Why it matters: It reads as behavioural proof for the newest privacy boundary and is not. The structural zero-policies assertion is what actually covers it.
Recommended future fix: Insert two fixture messages, one inbound and one outbound, for PA1 in section 1, which would also let the suite assert that a collaborator cannot read a thread.
Existing test coverage: not applicable.
```

**L-12**

```text
Finding: All four HMAC token families share one secret, AVAILABILITY_TOKEN_SECRET, despite protecting different trust boundaries.
Severity: Low
File(s): lib/optOutToken.ts:3; lib/outreachToken.ts:3; lib/availabilityToken.ts:10; lib/onboardingOauthState.ts:19
Relevant function/component: getSecret() / STATE_SECRET_ENV
What happens: The modules' own comments record this as deliberate: opt-out unsubscribe links, outreach reply attribution, availability and picker scheduling links, and the calendar OAuth CSRF state all derive from the same secret. A single leak or rotation affects all four at once.
Why it matters: A documented trade-off rather than a bug, but the four token families cannot be rotated independently, and a payload-parsing forgery bug in one could be probed with the same secret against the others.
Recommended future fix: Split into per-purpose secrets if rotation or blast-radius isolation ever becomes a requirement. Otherwise no action.
Existing test coverage: none.
```

**L-13**

```text
Finding: lib/extractDomain.ts has zero callers anywhere in the repository, including scripts/.
Severity: Low
File(s): lib/extractDomain.ts:12
Relevant function/component: extractDomain
What happens: A grep for extractDomain across the whole repository, excluding node_modules, matches only its own definition. Its header says it is used in Snov.io email lookups, but lib/contactDiscovery.ts implements its own deriveCompanyDomain inline instead.
Why it matters: Dead code that misleads a reader into thinking Snov domain resolution goes through this path, when the live logic was inlined and never reconciled.
Recommended future fix: Confirm with the contact-discovery owner that deriveCompanyDomain superseded it, then delete the module.
Existing test coverage: none.
```

**L-14**

```text
Finding: lib/attention.ts's listAttentionItems doc comment said "three sources" while four are implemented.
Severity: Low
File(s): lib/attention.ts:271-278
Relevant function/component: listAttentionItems
What happens: The function-level comment said three sources are read in parallel, while the file's own module header and the code implement four (systemFailureItems, stuckSourcingItems, billingItems, stalledNudgeItems). This was corrected in place during this pass; it is listed for completeness because it is the only comment in the batch that was replaced as wrong.
Why it matters: A stale count is a small but real trap for anyone skimming the doc comment to size the merge and sort logic below it.
Recommended future fix: Already applied.
Existing test coverage: none.
```

**L-15**

```text
Finding: DELETE /api/projects/[projectId] uses the read guard, contradicting the guard module's documented rule that a DELETE is a mutation.
Severity: Low
File(s): app/api/projects/[projectId]/route.ts DELETE (guardReadRequest); lib/projectsGuard.ts:13-15; contrast app/api/projects/[projectId]/experts/[expertId]/route.ts DELETE
Relevant function/component: DELETE
What happens: lib/projectsGuard.ts states that a DELETE goes through guardMutatingRequest, and the sibling expert DELETE does exactly that. The project DELETE calls guardReadRequest and so skips checkContentType. This is not exploitable in practice, because a cross-origin DELETE is never a simple request and is preflighted regardless, and the owner check still runs.
Why it matters: The two routes disagree and the comment is wrong about one of them, which invites someone to fix the wrong side. Destructive routes should be the most predictable in the codebase.
Recommended future fix: Switch it to guardMutatingRequest; the bodiless-DELETE exemption already covers a body-free request.
Existing test coverage: none.
```

**L-16**

```text
Finding: Two unused imports, one of which is an unscoped project read sitting in an access-controlled route.
Severity: Low
File(s): app/api/projects/[projectId]/route.ts:2 (getProject); app/api/projects/[projectId]/collaborators/route.ts:31 (isApprovedDomain)
Relevant function/component: module imports
What happens: Neither symbol is referenced anywhere in its file, verified by grep. getProject is the UNSCOPED store read, so its presence in a route file is actively misleading: a future edit could reach for it and skip the access check that getProjectForUser performs.
Why it matters: An unscoped project read in scope in an access-controlled route is a trap, especially now that application-level access checking is the only boundary.
Recommended future fix: Delete both imports.
Existing test coverage: not applicable; tsc does not flag unused imports under this configuration.
```

**L-17**

```text
Finding: lib/exportBrief revokes the blob URL in the same tick as the click.
Severity: Low
File(s): lib/exportBrief.tsx downloadProjectBriefPdf (end of file)
Relevant function/component: downloadProjectBriefPdf
What happens: a.click() is followed immediately by URL.revokeObjectURL(url), and the anchor is never attached to the document. Some browsers cancel a download whose object URL is revoked synchronously.
Why it matters: Intermittent "nothing happened" on the brief export, hard to reproduce and easy to blame on the user.
Recommended future fix: Revoke in a setTimeout(..., 0) or on the next animation frame.
Existing test coverage: none.
```

**L-18**

```text
Finding: mutateExpert exhausts its retries into a generic 500 with no backoff and no retry hint.
Severity: Low
File(s): lib/projectStore.ts mutateExpert (throws 'expert_update_conflict')
Relevant function/component: mutateExpert
What happens: After EXPERT_WRITE_RETRIES (3) lost compare-and-set rounds it throws expert_update_conflict. No route catches that message, so the client sees failed_to_update_expert or a 500 with no indication that a retry would succeed. There is no delay between attempts either, just three immediate re-reads.
Why it matters: Under exactly the concurrent writes this function exists to handle, such as a bookmark racing an inbound-email classification, the user gets an unexplained failure.
Recommended future fix: Map it to a 409 with a retry hint and add a small jittered delay between attempts.
Existing test coverage: none; no test forces a compare-and-set conflict.
```

**L-19**

```text
Finding: Dead input and output fields on the generateExperts contract, roughly 60 lines of unreachable behaviour that reads as live.
Severity: Low
File(s): lib/generateExperts.ts:851-861 (GenerateExpertsInput), :1046-1066 (supplementary block), :1508-1512 (excludeNames filter), :864-874 (result fields); lib/sourcingJob.ts:123-128
Relevant function/component: generateExperts / runSourcingJob
What happens: generateExperts has exactly one caller, which passes only query, geography, seniority and briefContext. supplementarySearch, excludeNames and additionalContext are therefore always undefined, making the supplementary-query block, the excludeNames filter and the "already-found experts" prompt section unreachable. Symmetrically, the caller ignores query_analysis, value_chain_summary and insufficient_categories from the result.
Why it matters: Untested, unreachable behaviour that will be trusted by the next person adding a "find more like these" feature.
Recommended future fix: Either wire the supplementary path to a real re-source action or delete the fields, and drop the unused result keys or start persisting them.
Existing test coverage: none.
```

**L-20**

```text
Finding: The hedge-language filter is a bare word regex and silently rejects valid candidates.
Severity: Low
File(s): lib/generateExperts.ts:290-303 (HEDGE_PATTERNS, hedgeReason), used at :1481
Relevant function/component: hedgeReason / step 7a
What happens: Any candidate whose justification matches \bmay\b, \bcould\b, \bmight\b or \badjacent\b is dropped outright. "May" as a month, as a surname, or an incidental "adjacent facility" all trigger it. The comment correctly calls it belt and braces over the prompt instruction.
Why it matters: Silent loss of genuinely strong candidates, recorded only in the development-only performance log's rejectedByReason map, so the rate is invisible in production.
Recommended future fix: Require the hedge word to appear in a relevance clause, or reduce the score rather than dropping the candidate, and surface rejectedByReason in the product-event payload so the rate is observable.
Existing test coverage: none.
```

**L-21**

```text
Finding: The value-chain diagnostic log echoes brief-derived model output in production.
Severity: Low
File(s): lib/generateExperts.ts:512-517 (the 'vci-llm-response' log)
Relevant function/component: inferValueChain
What happens: The log prints firstChars, the first 40 characters of the model's JSON, which begins with the endMarket value inferred from the client's brief. Unlike logPerf and the retry logs, it is not gated on NODE_ENV. The adjacent 'vci-parsed-structure' and 'tier-split-diagnostic' logs print shapes and scores only and are fine.
Why it matters: A small amount of client-derived content in production logs, in a file whose header promises none. Smaller in volume than H-12 but the same class of problem.
Recommended future fix: Drop firstChars, or gate this log on NODE_ENV === 'development' like the rest.
Existing test coverage: none.
```

**L-22**

```text
Finding: MAX_TOTAL_RESULTS is sized for a query volume the code no longer executes, and its comment misstates the search breadth.
Severity: Low
File(s): lib/generateExperts.ts:775-779 (the constant and its comment), :824-840 (runWithOptionalComparison)
Relevant function/component: runWithOptionalComparison
What happens: buildSearchQueriesFromBrief can produce up to about 11 query pairs and the constant's comment says "up to 16 queries by 10", but runWithOptionalComparison keeps only the first query per category, which is 3 searches and about 30 results, so the 160 cap can never bind. The extra generated queries are computed and discarded.
Why it matters: The comment misleads a reader about how broad the search actually is, and the effective pool feeding the Opus extraction is roughly a fifth of what the constants imply, which is directly relevant to result quality complaints.
Recommended future fix: Decide the intended query budget, then either raise the executed count or shrink the cap and the generator to match. A correcting note was added in place during this pass.
Existing test coverage: none.
```

**L-23**

```text
Finding: Discovered email addresses are stored in Redis in clear text for up to 90 days.
Severity: Low (deliberate, but worth stating)
File(s): lib/contactCache.ts:100-119 (UpstashCacheStore.set); lib/contactDiscovery.ts:513-556 (writeCache)
Relevant function/component: writeCache
What happens: Key names are HMAC'd with LOG_HASH_SECRET so a Redis keyspace scan reveals nothing, but the stored value is a ContactEnrichment JSON document containing best_email.email verbatim, retained for up to 90 days for a verified or catch-all result.
Why it matters: Anyone with the Upstash REST token holds a 90-day list of harvested professional email addresses, a GDPR-relevant dataset that sits outside Postgres and outside RLS and is not described on the privacy page's data-retention section.
Recommended future fix: Encrypt the value at rest with the existing application key, or shorten the found TTL, and at minimum document the store in the privacy page.
Existing test coverage: none.
```

**L-24**

```text
Finding: The engagement_events kind contact_not_found is overloaded with five different meanings.
Severity: Low
File(s): lib/contactDiscovery.ts:695-707, :749-756; app/api/projects/[projectId]/experts/[expertId]/bookmark/route.ts:191-199, :214-224; supabase/migrations/20260907000000_matchy_phase1.sql (the check constraint)
Relevant function/component: emitEngagementEvent call sites
What happens: Because the migration's check constraint allows only a fixed set of kinds, "queued", "queue_failed", "walkthrough_held", "suppressed", "discovery unavailable" and genuine "nobody found" are all written as contact_not_found with a distinguishing payload. Every call site comments on it, so it is deliberate.
Why it matters: Any funnel query counting contact_not_found overcounts by a large and variable factor unless it also filters on payload fields, which makes the learning-loop data asset harder to trust.
Recommended future fix: Extend the check constraint with the missing kinds in the next migration and backfill by payload.
Existing test coverage: none.
```

**L-25**

```text
Finding: contactCandidates is redacted and type-declared but never written.
Severity: Low
File(s): types.ts:367; lib/redactExpert.ts:94; scripts/check-redaction.ts:84, :183, :210, :321
Relevant function/component: ProjectExpert.contactCandidates
What happens: Nothing in the current discovery path writes contactCandidates; runContactDiscoveryJob writes a single contactEmail. The field survives only in the type, the redaction blocklist and the redaction tests, which synthesise it.
Why it matters: Harmless as a defensive redaction entry, but it makes readers look for a multi-candidate flow that no longer exists.
Recommended future fix: Keep the redaction entry as cheap insurance, and either drop the type field or mark it legacy in types.ts.
Existing test coverage: scripts/check-redaction.ts (synthetic).
```

**L-26**

```text
Finding: The retired pre-Matchy email cadence has left dead code across four modules, including the only remaining path that would put an LLM-written body and a dollar figure in a cold email.
Severity: Low
File(s): lib/emailSequence.ts:82 (scheduleNextEmail), :100-138 (generateEmail1), :42 (EmailStep); lib/outreachSteps.ts:173-203 (the 'email1' branch); app/api/email-sequence/trigger/route.ts (whole route); lib/replyDetection.ts (whole module)
Relevant function/component: scheduleNextEmail / generateEmail1 / POST trigger / parseReply
What happens: A grep across app/, lib/, components/ and scripts/ finds no caller for scheduleNextEmail, whose comment claimed inbound-email still called it (corrected during this pass), and none for parseReply. Nothing publishes an 'email1' QStash job any more, so the trigger route, generateEmail1 and the 'email1' branch are reachable only by a pre-Matchy job still sitting in the queue, which QStash retries for about 24 hours. The trigger route also passes `step` straight through without validating it against the OutreachStep union.
Why it matters: The dead email1 path is the only remaining code that would send an LLM-written body containing a dollar figure to a cold contact, which is precisely the behaviour Matchy replaced, and it is one queued job away from running.
Recommended future fix: After confirming the queue has drained, delete the trigger route, generateEmail1, the 'email1' branch, scheduleNextEmail and lib/replyDetection.ts, and narrow EmailStep at the same time. Update scripts/rls/README.md:133, which documents the trigger route as live.
Existing test coverage: none; nothing imports them.
```

**L-27**

```text
Finding: A follow-up held by the chokepoint cannot be re-sent, so the client presses an approve button that silently does nothing.
Severity: Low
File(s): app/api/inbound-email/route.ts:~866-878 (advanceInterested); app/api/projects/[projectId]/experts/[expertId]/messages/[messageId]/send/route.ts
Relevant function/component: advanceInterested
What happens: When the chokepoint holds the follow-up, the route stores it with pendingApproval: true and the summary "Follow-up drafted. Approve it and I will send it." The approve button then works, but only for a non-walkthrough hold; an entitlement hold is discarded again on the retry because that route ignores SendOutcome (H-4), leaving the client pressing a button that appears to work.
Why it matters: A silent no-op loop for a client whose organization has no card on file.
Recommended future fix: Fixing H-4 in messages/[messageId]/send resolves this too. Ideally the pending record should carry the hold reason so the UI can explain it.
Existing test coverage: scripts/test-entitlements.ts covers the entitlement itself, not this path.
```

**L-28**

```text
Finding: resend_message_id is never populated, so the message-level idempotency key the spec names does not exist in practice.
Severity: Low
File(s): lib/conversations.ts:222 (insert), :263 (update); app/api/inbound-email/route.ts (stores no message id); docs/MATCHY_SPEC.md
Relevant function/component: appendMessage / handleReply
What happens: The column exists and appendMessage and updateMessage both accept a value, but no caller supplies one. The only dedupe is the Redis svix-id claim in H-5.
Why it matters: If Redis is unavailable, and claimDelivery fails open, there is no second line of defence, so a retried delivery duplicates the thread message, the events and potentially the follow-up.
Recommended future fix: Store the inbound message id on the row and add a unique index, so the insert itself rejects a duplicate.
Existing test coverage: none.
```

**L-29**

```text
Finding: The reply-token Redis index TTL is 90 days while the token and the spec describe a longer thread lifetime.
Severity: Low
File(s): lib/outreachSteps.ts:27 (REPLY_TOKEN_TTL_S), :154, :189; app/api/inbound-email/route.ts:322 (the fallback); docs/MATCHY_SPEC.md ("per-thread reply-to token, 180 days")
Relevant function/component: runSequenceStep
What happens: The Redis index expires at 90 days while the HMAC outreach token itself is valid for 90 days by its own construction and 180 days per the spec. Inbound falls back to the token payload when the index misses, so nothing breaks, but the three numbers disagree.
Why it matters: Purely a consistency and documentation issue, worth noting only because a silent fallback path is what keeps it working.
Recommended future fix: Align the TTL with the token's own lifetime, or document that the index is a cache and the token is the source of truth.
Existing test coverage: none.
```

**L-30**

```text
Finding: computeOverlap(), scoreSlot(), formatInTimezone() and deleteZoomMeeting() are dead code, and the first three are a second, divergent implementation of overlap arithmetic.
Severity: Low
File(s): lib/computeOverlap.ts:136-179 (computeOverlap), :183-193 (scoreSlot), :205-257 (formatInTimezone); types.ts:338 (OverlapResult, OverlapSlot); lib/createZoomMeeting.ts:121 (deleteZoomMeeting)
Relevant function/component: computeOverlap
What happens: Grepping app/, lib/, components/ and scripts/ shows only resolveTimezone, slotToUtcRange, extractTimezone (used by matchyScheduling and bookCall) and localToUtc (used by scripts/test-scheduling.ts) are imported from this module. The headline computeOverlap() lost its last caller when lib/triggerOverlapCheck.ts was retired; the Phase 2 equivalent is intersectRanges over absolute UTC ranges. deleteZoomMeeting is likewise uncalled, and its own comment says so; the call-cancellation route is a known open task.
Why it matters: Two implementations of "when are these two both free", with different arithmetic and different business-hours rules, is a trap for the next person touching scheduling.
Recommended future fix: Delete computeOverlap, scoreSlot, formatInTimezone and the OverlapResult and OverlapSlot types, keeping the module as the timezone and slot-resolution primitives it has become. A header note was added in place during this pass.
Existing test coverage: none for computeOverlap itself.
```

**L-31**

```text
Finding: The expert OAuth state nonce has no expiry.
Severity: Low
File(s): app/api/availability/[token]/google-auth/route.ts:58-66, :136-145; app/api/availability/oauth/google/callback/route.ts:70-74
Relevant function/component: buildState / verifyState
What happens: The signed payload carries no timestamp, and ProjectExpert.oauthState is cleared only by a successful callback or overwritten by the next initiate. An abandoned consent leaves a valid nonce on the row indefinitely. The onboarding flow's state, lib/onboardingOauthState.ts, is a separate implementation (M-49); both are additionally bounded by the picker token's own seven-day expiry.
Why it matters: A longer than necessary window for a state to be completed by someone who obtained it. Impact is low because the callback also needs a Google authorization code for the same client.
Recommended future fix: Put an issued-at inside the signed payload and reject states older than about 15 minutes, in both OAuth flows.
Existing test coverage: none.
```

**L-32**

```text
Finding: Both expert-facing rate limits fail open on a store error, by design.
Severity: Low
File(s): app/api/schedule/[token]/route.ts:66-77 (withinRateLimit); app/api/availability/[token]/google-auth/route.ts:36-47 (checkTokenRateLimit)
Relevant function/component: withinRateLimit / checkTokenRateLimit
What happens: A missing store or a rejected increment() returns true. HANDOFF documents this as a deliberate fix after Upstash returned 500s and broke the picker in production, on the rule that anything on the expert-facing path must fail open.
Why it matters: With Upstash down, the picker's model-calling 'unavailable' action is unthrottled per token. The token itself is unguessable and short-lived, so exposure is bounded to a compromised link, but the OpenAI cost is real. Listed to distinguish it from H-14, where fail-open on the credential path is not defensible.
Recommended future fix: None required. If the cost matters, add an in-process counter as a second line of defence rather than closing the gate.
Existing test coverage: none.
```

**L-33**

```text
Finding: A Supabase read failure inside the nudge planner is indistinguishable from "the expert replied", and is counted as notWaiting.
Severity: Low
File(s): app/api/jobs/schedule-nudges/route.ts:201-207; lib/conversations.ts:300-322 (listThread)
Relevant function/component: listThread / GET handler
What happens: listThread swallows every error and returns an empty array. waitingSinceFor([]) returns null, so shouldSchedule reports not_waiting and the planner increments skipped.notWaiting. The same is true in the worker, where an empty thread produces skipped('replied'). Both directions fail safe, since no email is sent, but the counters and skip reasons then misreport the cause.
Why it matters: A Supabase incident during the 05:00 UTC run looks exactly like a quiet morning in the logs, so nobody investigates the day everybody's nudges stopped.
Recommended future fix: Have listThread return a discriminated result, or add listThreadOrThrow, so the planner can count skipped.threadUnreadable and record a system failure.
Existing test coverage: none.
```

**L-34**

```text
Finding: A calendar-connection read failure silently sends the nudge on Eastern time.
Severity: Low
File(s): app/api/jobs/schedule-nudges/route.ts:184-185; lib/nudges.ts:74 (DEFAULT_ZONE)
Relevant function/component: GET handler
What happens: getCalendarConnection(project.ownerEmail).catch(() => null) collapses "this owner has no calendar" and "the lookup failed" into the same DEFAULT_ZONE ('America/New_York') fallback. For a West Coast or European owner whose connection read transiently failed, the nudge lands at 08:00 Eastern, which is 05:00 Pacific.
Why it matters: A 5 a.m. follow-up reads as automation, which is precisely the impression the 0 to 3600 second jitter exists to avoid. Low because it needs a transient failure and costs one badly timed email.
Recommended future fix: Distinguish the two cases and skip the engagement, retrying tomorrow, when the lookup actually threw, rather than guessing a zone.
Existing test coverage: none.
```

**L-35**

```text
Finding: A completed call whose expert payout rounds under $0.50 leaves the row with no payout state at all.
Severity: Low
File(s): lib/expertPayout.ts:185, :207-215; lib/stripeConnect.ts:82-84
Relevant function/component: runExpertPayout
What happens: When onboardingDone is true but expertAmountCents is under 50, the transfer branch is skipped, the `if (!onboardingDone)` branch is false, and the function returns, leaving expertOnboardingStatus untouched and writing no log line. The row is then invisible to both retry sweeps.
Why it matters: Very unlikely at real rates, since a 15-minute minimum at any sane expertRate exceeds $0.50, but it is a silent no-op rather than an explicit decision.
Recommended future fix: Log and record an explicit terminal state, for example 'not_payable', for sub-minimum payouts.
Existing test coverage: none.
```

**L-36**

```text
Finding: The Connect account id created during expert onboarding is stored only in Redis, never written back to the project_experts row.
Severity: Low
File(s): app/api/expert-onboarding/[token]/route.ts:88-95 (setConnectAccountId); lib/expertPayout.ts:296-298; app/api/jobs/reconcile/route.ts:141-144
Relevant function/component: GET /api/expert-onboarding/[token]
What happens: setConnectAccountId writes only the `expert-connect:<hmac(email)>` Redis key, which has no TTL. The account.updated webhook sweep can still find the row by email, but the nightly reconcile sweep deliberately skips Redis-only rows, as its own comment says. If Redis is unavailable or the key is lost while the payout is 'pending', the payout has no path back to the expert.
Why it matters: A cache is load-bearing for a money path, while Redis is treated as best-effort everywhere else in this codebase.
Recommended future fix: Write stripeConnectAccountId onto the project_experts row at the moment the account is created, keeping Redis as a lookup cache.
Existing test coverage: none.
```

**L-37**

```text
Finding: Two mutations in ConversationThread.tsx bypass the shared matchyClient request wrapper and fail silently.
Severity: Low
File(s): components/ConversationThread.tsx:662 (saveNote), :683 (markReadyToBook); lib/matchyClient.ts request() and ERROR_LINES
Relevant function/component: saveNote(), markReadyToBook()
What happens: Both hand-roll their own fetch and try/catch against PUT /api/projects/:id/experts/:expertId instead of using lib/matchyClient.ts's request() helper, which normalizes error codes into ERROR_LINES. A failed saveNote keeps the typed text with no visible error, and markReadyToBook swallows failures with only a code comment saying the button stays available.
Why it matters: A client typing post-call notes can believe a save succeeded when it silently failed, because noteSaved being false looks identical to "not saved yet".
Recommended future fix: Route both through lib/matchyClient.ts so failures render a MatchyLine error consistent with every other action on the screen, or at minimum set a visible error string in both catch blocks.
Existing test coverage: none; no script imports any React component.
```

**L-38**

```text
Finding: The terms and privacy pages still carry unresolved placeholder tokens, one of them visible to site visitors.
Severity: Low
File(s): app/terms/page.tsx:11-12, :88 (a rendered "[CONFIRM: legal entity name and form ...]"); app/privacy/page.tsx:14, :21, :26 (three "[DECIDED 2026-09-06: ...]" code comments)
Relevant function/component: TermsPage, PrivacyPage (static content)
What happens: The terms page renders a literal [CONFIRM: ...] bracket in its visible text. The privacy page's tokens are code comments only, flagging that contact-discovery and web-search vendors are named generically rather than by name and that there is no standalone subprocessor page.
Why it matters: A live legal page showing a bracketed placeholder to a visitor looks unfinished, and the legal entity name is legally material. The privacy vendor-naming decision is lower urgency but should be settled before any enterprise data-processing review.
Recommended future fix: A founder decision on the entity name and form, then a content-only edit to remove the token.
Existing test coverage: none; static content.
```

**L-39**

```text
Finding: app/app/page.tsx's stageCounts and its "Calls Completed" tile are dead until a server-side change ships.
Severity: Low
File(s): app/app/page.tsx:9-18, :219-227
Relevant function/component: AppPage stats calculation
What happens: The file's own comment states that stageCounts does not exist on the server's ProjectSummary, since lib/projectStore only derives expertCount and shortlistedCount. The tile renders only when completedKnown is true, so it can never appear today.
Why it matters: Not a bug. Flagged only because a stat tile that can never render is easy to mistake for one during a future refactor if the explaining comment is ever deleted.
Recommended future fix: None now. When lib/projectStore adds stageCounts, remove the completedKnown guard.
Existing test coverage: none.
```

**L-40**

```text
Finding: Admin seat-sync failures are swallowed with no log and no warning to the admin.
Severity: Low
File(s): app/api/admin/users/route.ts:30-34 (syncSeats); app/api/admin/firms/route.ts:172-175 (post-upsert sync)
Relevant function/component: syncSeats(), POST /api/admin/firms
What happens: Both wrap syncOrgSeatQuantity in a try/catch commented "best effort" and swallow the error entirely, with no console.error and no surfaced warning. This is distinct from the explicit sync-seats action, which does report outcome and error to the caller.
Why it matters: The Stripe seat quantity can silently drift from the actual active-seat count after an enable, disable, delete or seat-cap edit, discoverable only by clicking Sync seats later.
Recommended future fix: At minimum console.error the failure, as most other catches in these files do, and consider a soft warning banner in the admin console.
Existing test coverage: none.
```

**L-41**

```text
Finding: The admin console shows every organization's member PII to any platform admin with no audit trail.
Severity: Low
File(s): app/admin/requests/page.tsx (whole page: MemberRow, FirmPanel, AccessRequestCard); app/api/admin/users/route.ts; app/api/admin/firms/route.ts
Relevant function/component: AdminConsolePage and children
What happens: Every platform admin sees every organization's members' full names, emails and billing status, and can create, disable or delete any account or organization. This is expected for a platform-admin console and is not a breach of the client and expert anonymization boundary, but there is no record of who performed which admin action.
Why it matters: If the admin role set ever grows beyond a tiny trusted group, there is no record of who disabled or deleted an account or changed a seat cap.
Recommended future fix: Log admin mutations (actor, action, target, timestamp) server-side, into system_events or a dedicated admin_actions table.
Existing test coverage: none; no script calls any /api/admin/* route.
```

**L-42**

```text
Finding: The check()/eq() assertion-helper boilerplate is duplicated across 18 scripts, with visible drift between copies.
Severity: Low
File(s): scripts/test-availability-windows.ts, test-brevity.ts, test-contact-discovery.ts, test-conversations-redaction.ts, test-email-clean.ts, test-email-domains.ts, test-entitlements.ts, test-matchy-classify.ts, test-matchy-client.ts, test-matchy-screen.ts, test-matchy-templates.ts, test-nudges.ts, test-org-billing.ts, test-pricing.ts, test-scheduling.ts, test-signup-token.ts, test-walkthrough.ts, check-redaction.ts
Relevant function/component: check() / eq() assertion counters
What happens: Every script hand-defines its own near-identical check(name, ok, detail) counter, and five also define eq(name, actual, expected), each with slightly different formatting and exit-code logic. Some count checks separately from failures and others do not.
Why it matters: No functional bug, but any future change to the reporting format, such as adding JSON output for CI or a shared summary, means editing 18 files identically, and drift is already visible.
Recommended future fix: Extract a small scripts/testHarness.ts exporting check, eq and a summary helper, imported by each script.
Existing test coverage: not applicable; this is a meta-finding about the test scripts.
```

**L-43**

```text
Finding: lib/expertPayout.ts's header states that nothing else retries pending payouts, which has been untrue since the reconcile cron shipped.
Severity: Low
File(s): lib/expertPayout.ts:19-21, :252-254; app/api/jobs/reconcile/route.ts:186
Relevant function/component: retryPendingPayoutsForAccount
What happens: Two comments state that pending payouts are retried by retryPendingPayoutsForAccount called from the account.updated branch of the Stripe webhook, and that this is "the only retry path in the system". The nightly reconcile sweep is a second caller and has been since it shipped.
Why it matters: Anyone reasoning about payout retry frequency from these comments will be wrong by a factor of one nightly sweep, which is exactly the mechanism behind the uncapped payout email in H-9.
Recommended future fix: Correct both comments to name reconcile's sweepPayouts as the second caller.
Existing test coverage: none.
```

**L-44**

```text
Finding: ProjectExpert.agreedRate is a dead field that is still rendered.
Severity: Low
File(s): types.ts:408 (agreedRate); components/ProjectExpertCard.tsx:261 (renders it)
Relevant function/component: ProjectExpert
What happens: agreedRate is declared in the type and read by the card, but nothing in the repository ever writes it. It appears to be a pre-Matchy leftover superseded by expertRate and clientRate.
Why it matters: A rendered field that is always undefined reads as a bug in the UI and as a live concept in the type.
Recommended future fix: Delete the field and its render site, after confirming no legacy row still carries a value.
Existing test coverage: none.
```

**L-45**

```text
Finding: lib/projectsGuard.ts documents an origin check in its execution order that does not exist in the file.
Severity: Low
File(s): lib/projectsGuard.ts (header execution-order list, "origin (NEXT_PUBLIC_APP_URL / APP_URL)")
Relevant function/component: guardMutatingRequest
What happens: The header lists an origin check as one of the guard's steps. No origin comparison exists anywhere in the file; the content-type check is the CSRF surrogate, and the header elsewhere says so.
Why it matters: A reader auditing CSRF protection will believe there is a defence in depth that is not there, and may skip adding one.
Recommended future fix: Remove the origin line from the header, or implement the check.
Existing test coverage: none.
```

**L-46**

```text
Finding: Four dependencies are installed and never imported.
Severity: Low
File(s): package.json (nodemailer ^8.0.7, @types/nodemailer ^8.0.0, ai ^6.0.175, @ai-sdk/anthropic ^3.0.75, bcryptjs ^3.0.3)
Relevant function/component: dependencies
What happens: A grep over app/, lib/, components/ and scripts/ finds no import of nodemailer, no import from 'ai' or '@ai-sdk/anthropic', and no reference to bcrypt at all. All outbound mail goes through Resend via lib/emailSequence.ts and lib/sendAvailabilityRequest.ts; all Anthropic calls go through @anthropic-ai/sdk directly; password hashing is Supabase Auth's responsibility. The 'ai' and '@ai-sdk/anthropic' packages in particular are large.
Why it matters: Install size, audit surface and dependency-upgrade noise for code nobody runs, plus a misleading signal that the Vercel AI SDK is in use.
Recommended future fix: Remove all five entries from package.json and reinstall. Confirm first that no build-time tooling pulls them in indirectly.
Existing test coverage: npm audit via scripts/security-scan.sh scans them but does not detect that they are unused.
```

**L-47**

```text
Finding: Two type-file comments make claims that no longer match the schema.
Severity: Low
File(s): types.ts (the new top-of-file map's "jsonb-embedded" paragraph); types.ts:448 (zoomStartUrl "stored in Redis only, never sent to frontend")
Relevant function/component: types.ts documentation
What happens: The top-of-file map, added during this annotation pass by one batch, says ProjectExpert is "one entry in projects.experts jsonb array". There is no projects.experts column; experts are one row per expert in the project_experts table, with status and contact_email promoted and the rest in project_experts.data. SchedulingState, BookingState and NudgeState do live in that data jsonb, so only the ProjectExpert claim is wrong. Separately, zoomStartUrl's comment says it lives in Redis only; since the Supabase cutover it lives in project_experts.data, and the 20260908 migration's own table comment names it. The "never sent to frontend" half of that comment is still correct and still important.
Why it matters: types.ts is the file most people read first to understand the data model, and both claims point a reader at the wrong storage location.
Recommended future fix: Correct both comments. This was found late in the pass and was not itself edited, to avoid two batches writing the same file.
Existing test coverage: not applicable.
```

**L-48**

```text
Finding: The privacy page names three search providers as data recipients when only one is in use.
Severity: Low
File(s): app/privacy/page.tsx:23-24; lib/searchProviders/index.ts
Relevant function/component: PrivacyPage
What happens: The page names Exa, Tavily and ScrapingBee as recipients of data. That matches the code, since all three providers exist, but overstates what is live: only Exa is configured and used in practice, with ScrapingBee reachable only when SEARCH_FALLBACK_ENABLED is set.
Why it matters: Overstating the recipient list is the safe direction for a privacy notice, but it makes the notice harder to keep accurate and may raise questions in a customer review that have no substance behind them.
Recommended future fix: Name the live provider and describe the others as conditional fallbacks, or leave as is deliberately and note that in a comment.
Existing test coverage: not applicable.
```

**L-49**

```text
Finding: app/api/inbound-email/route.ts defines a private pseudonymize identical to the exported one in lib/contactCache.ts.
Severity: Low
File(s): app/api/inbound-email/route.ts:102; lib/contactCache.ts (exported pseudonymize)
Relevant function/component: pseudonymize
What happens: The inbound-email route declares its own local copy of the HMAC-and-truncate helper used to keep identifiers out of log lines, rather than importing the existing exported one.
Why it matters: Two copies of a privacy helper can drift, and only one of them will be updated if the hashing policy changes.
Recommended future fix: Import lib/contactCache.pseudonymize and delete the local copy, or move the helper somewhere more neutral than the contact cache if the dependency direction is awkward.
Existing test coverage: none.
```

**L-50**

```text
Finding: isPublicEmailDomain allocates a roughly 110-element array on every call, on every provisioning and access-request path.
Severity: Low
File(s): lib/emailDomains.ts isPublicEmailDomain
Relevant function/component: isPublicEmailDomain
What happens: The function does Array.from(PUBLIC_EMAIL_DOMAINS).some(...) on every invocation, to test subdomain suffixes. The set itself is a module constant, so the array could be precomputed once.
Why it matters: Pure performance, no correctness issue. Listed because the function is on the provisioning and public access-request paths.
Recommended future fix: Precompute the array alongside the set at module scope.
Existing test coverage: scripts/test-email-domains.ts covers the predicate's behaviour.
```

**L-51**

```text
Finding: /api/auth/me and /api/org/membership each make two getUser round trips to the Supabase auth server per request.
Severity: Low
File(s): app/api/auth/me/route.ts; app/api/org/membership/route.ts; lib/auth.ts routeAuthGuard and getSessionUser; contrast lib/auth.ts:168-205 orgAdminGuard
Relevant function/component: routeAuthGuard + getSessionUser
What happens: Both routes call routeAuthGuard and then getSessionUser, each of which performs its own getUser(), on top of the one middleware already performed. orgAdminGuard already solves this by returning the resolved SessionUser; routeAuthGuard could take the same shape.
Why it matters: Pure latency, not correctness. Noted because /api/auth/me is polled by the onboarding stepper and read on every project page load.
Recommended future fix: Have routeAuthGuard return the resolved SessionUser, matching orgAdminGuard, and update the call sites.
Existing test coverage: none.
```

## Dead code and stale integrations

Consolidated across all fourteen batches. Each entry gives the path, why it is dead, and the evidence.

- `lib/contactPathResolver.ts` (whole module, about 330 lines): the `/api/resolve-contact-paths` route it served no longer exists. Grep for `contactPathResolver` over .ts and .tsx returns only SECURITY_AUDIT.md references and its own log line. It still owns the `cpath:` Redis namespace and a `lib/searchProviders` dependency. See M-22.
- `lib/domainSuggestions.suggestDomainsForExpert`: kept alive only by the dead resolver above; no other importer.
- `lib/extractDomain.ts`: zero callers anywhere including scripts/. `lib/contactDiscovery.deriveCompanyDomain` does the job inline. See L-13.
- `lib/replyDetection.ts` (whole module): superseded by `lib/matchyClassify.ts`. Grep finds no caller for `parseReply`. The file is deliberately labelled dead in its own header.
- `lib/emailSequence.scheduleNextEmail`: no callers. Its comment claimed inbound-email still called it; corrected during this pass.
- `lib/emailSequence.generateEmail1` and `lib/outreachSteps.ts`'s `'email1'` branch and `app/api/email-sequence/trigger/route.ts`: reachable only by a pre-Matchy QStash job still in the queue, which retries for about 24 hours. Nothing publishes such a job any more. This is the only remaining code that would put an LLM-written body and a dollar figure in a cold email. See L-26.
- `lib/rateLimiter.ts` `checkRequestThrottle`, `checkCreditLimits`, `checkAndIncrementGlobalBudget`, `incrementProviderDailyCount`: no callers; the `/api/enrich-contact` route named in the header does not exist. `checkContactLookupLimits`, also advertised in the header, was never written. `createRateLimiterStore` is still live. See L-5 and H-13.
- `lib/contactProviders/index.ts` `buildProviderWaterfall`, `getContactProvider`, `parseProviderOrder`: no callers; `discoverContact` hardcodes the provider list. `EMAIL_PROVIDER_ORDER` therefore has no effect. See M-23.
- `lib/contactProviders/types.ts` `estimateCreditsPerLookup`: no callers; its comment claimed it was used in audit logs (corrected during this pass).
- `lib/contactCache.ts` distributed lock (`lock:<hmac32>` keys): fully implemented, never called. It is the exact mechanism that would fix the duplicate-intro race in H-2.
- `lib/computeOverlap.ts` `computeOverlap()`, `scoreSlot()`, `formatInTimezone()`, and `types.ts` `OverlapResult` / `OverlapSlot`: orphaned when `lib/triggerOverlapCheck.ts` was retired. Only `resolveTimezone`, `slotToUtcRange`, `extractTimezone` and `localToUtc` are still imported. See L-30.
- `lib/createZoomMeeting.deleteZoomMeeting`: uncalled; the call-cancellation route is a known open task, and the function's own comment says so.
- `lib/supabase/client.ts` (whole module): no importers anywhere. Its header described the removed HMAC-cookie session architecture; replaced during this pass.
- `lib/upstashRedis.ts` `getAndDel`, `sadd`, `srem`, `smembers`, `sismember`, `scard`: served the Redis-era single-use token flow that `lib/authLinks.ts` replaced with Supabase recovery tokens. `keys()` and `delMany()` survive only in `scripts/wipe-projects.ts`.
- `lib/signupToken.ts` `tokenRedisKey`, `tokenTtlSeconds`: reachable only from `scripts/test-signup-token.ts` since the Redis token store was retired.
- `lib/generateExperts.ts`: the supplementary-search block, the `excludeNames` filter (step 7e) and the "already-found experts" prompt section are unreachable because the single caller never supplies those inputs; `query_analysis`, `value_chain_summary` and `insufficient_categories` are returned and discarded. See L-19.
- `ProjectExpert.contactCandidates`: redacted, type-declared and tested, but written by nothing since discovery moved to a single address. See L-25.
- `ProjectExpert.agreedRate`: declared in types.ts and rendered by `components/ProjectExpertCard.tsx:261`, written by nothing. See L-44.
- `ProjectExpert.rateExpectation` and `availability`: legacy pre-Matchy screening fields, still rendered by `components/ClientReadyCard.tsx` and, unlike the numeric rate fields, not redacted. See M-13.
- `conversation_messages.resend_message_id`: column exists, `appendMessage` accepts it, no caller supplies it. See L-28.
- `app/app/page.tsx` `stageCounts` and its "Calls Completed" tile: the server never populates the field, so the tile can never render. See L-39.
- `scripts/wipe-projects.ts`: targets the legacy Redis project store that Postgres replaced. Still runnable, still destructive, still ungated. See H-22.
- Environment variables read by nothing: `SESSION_SECRET` (removed HMAC-cookie sessions), `CONTACT_ENRICHMENT_ADMIN_TOKEN` (deleted enrich-contact route), `CONTACT_PROVIDER` (superseded provider selection), `GOOGLE_CALENDAR_REFRESH_TOKEN` and `STRIPE_CONNECT_CLIENT_ID` (both still in REQUIRED_VARS and therefore still able to block a boot). See M-50.
- Dependencies imported by nothing: `nodemailer`, `@types/nodemailer`, `ai`, `@ai-sdk/anthropic`, `bcryptjs`. See L-46.
- Stale documentation that describes live behaviour incorrectly: `scripts/rls/README.md` (pre-20260908 access model, 135 versus 153 assertions, the email-sequence trigger route described as live), `lib/expertPayout.ts:19-21` and `:252-254` ("nothing else retries"), `lib/projectsGuard.ts` (an origin check that does not exist), `lib/outreachFooter.ts` (opt-out token described as if the address were not recoverable), `types.ts` (projects.experts jsonb array; zoomStartUrl "Redis only"), `lib/supabase/database.types.ts` (five of eight migrations listed), `docs/MATCHY_SPEC.md` (flat $1,500 / $3,500 plans, already replaced by SEAT_TIERS in `lib/pricing.ts`), `SECURITY_AUDIT.md` (references the deleted resolve-contact-paths route).

## Duplicated logic

- **Four HMAC token modules.** `lib/optOutToken.ts`, `lib/outreachToken.ts`, `lib/availabilityToken.ts` and `lib/onboardingOauthState.ts` each re-implement base64url encoding, `getSecret()` over the same environment variable, nonce generation, HMAC-SHA256 signing over a colon-joined payload, and a constant-time comparison. Two different comparison idioms coexist. See M-11.
- **Two OAuth state implementations.** The inline `buildState`/`verifyState` pair in the expert calendar routes versus `lib/onboardingOauthState.ts` for the client flow. Same secret, different payload shapes, different nonce stores, and only one checks the session identity. See M-49.
- **Two `secretMatches` implementations.** `app/api/jobs/reconcile/route.ts:72` and `app/api/jobs/schedule-nudges/route.ts:93` are byte-identical constant-time comparisons of the CRON_SECRET bearer token.
- **Two `pseudonymize` implementations.** `app/api/inbound-email/route.ts:102` duplicates the exported `lib/contactCache.pseudonymize`. See L-49.
- **Two overlap engines.** `lib/computeOverlap.computeOverlap()` (civil-calendar, its own business-hours rules) versus `lib/matchyScheduling`'s `intersectRanges` over absolute UTC ranges. The first is dead but still reads as authoritative. See L-30.
- **Two provider registries in one file.** `PROVIDER_MAP` and `ACTIVE_PROVIDERS` in `lib/contactProviders/index.ts` are byte-identical, and neither is consulted by the live path. See M-23.
- **Assertion harness across 18 scripts.** Every `scripts/test-*.ts` hand-defines `check()`, and five also define `eq()`, with drift already visible between copies. See L-42.
- **Design tokens in two places.** The navy, gold and cream palette in `tailwind.config.js` and again as CSS custom properties in `app/globals.css`. See L-2.
- **Two membership resolvers.** `lib/firmStore.getMembership` (oldest membership, any status) versus `lib/entitlements.getEntitlementsForUser` (first active membership). They can disagree for the same profile. See M-4.
- **Two double-bill guards on the same money path.** The Stripe idempotency key in `lib/chargeSavedCard.ts` and the durable `paymentStatus`/`stripePaymentIntentId` check in `lib/createAndSendInvoice.ts`, both keyed on (projectId, expertId) and both wrong for a second genuine call. See H-8.
- **Two ICS builders.** `lib/bookCall.ts` `buildIcsEvent` (shared attendee list, sent to both parties) and `bookingIcsEvent` (client only, for the on-demand download). They disagree about what an attendee list should contain. See C-3.
- **Two draft-only gate computations.** The bookmark route's `reviewFirst || held` versus `runContactDiscoveryJob`'s `reviewFirst || isWalkthrough || !canOutreachExperts`. See M-27.
- **Two intro deny-list constructions.** The bookmark route passes `firmName`; `outreach/approve` does not. See M-29.
- **Two pending-payout selectors.** `lib/expertPayout.ts:279` and `app/api/jobs/reconcile/route.ts:151-153` both hardcode the `pending` filter and would both need changing together. See H-6.
- **Two seat-sync error policies.** The explicit `sync-seats` admin action reports outcome and error; the implicit post-mutation syncs swallow everything. See L-40.

## Testing gaps

There is no test runner in this repository. Every script under `scripts/` is a standalone program run with `npx tsx`, each hand-rolling its own assertion counter and exiting non-zero on failure. Ordered by risk, money and authorization first.

| System | What exists | What is missing |
| --- | --- | --- |
| Per-call charge (`chargeSavedCard`, `createAndSendInvoice`) | `scripts/test-pricing.ts` covers the arithmetic: 251 checks over seat tiers, `clientRateFor`, `callChargeDollars`, `expertPayoutDollars`, the `callCharge >= expertPayout` invariant, band clamping | No script imports either module. The double-bill guard, the idempotency-key scope (H-8), the entitlement gate, the payment-link fallback and the receipt email are all unverified. |
| Stripe webhook | Nothing | No test at all. Signature verification, duplicate delivery, `handlePaymentSucceeded`, the payout hand-off and the subscription mirror are uncovered. `scripts/verify-svix.ts` covers a different webhook (Resend inbound). |
| Zoom webhook and completion | Nothing | Signature verification, the replay window (C-4), the duration arithmetic including the NaN path (M-35), and the invoice hand-off are uncovered. `scripts/test-org-billing.ts` asserts only that `findProjectExpertByZoomMeetingId` exists. |
| Stripe Connect payouts | `scripts/test-org-billing.ts` asserts export shapes on `runExpertPayout` and `retryPendingPayoutsForAccount`, never calls them | No behavioural test. `lib/stripeConnect.ts` has no coverage at all. The `failed`-state trap (H-6), the Redis-only account id (L-36) and the sub-minimum no-op (L-35) are all untested. |
| Seat billing | `scripts/test-org-billing.ts` (23 checks: `orgCancelIdempotencyKey`, `stripeFailureReason`), `scripts/test-pricing.ts` (tiers) | The Stripe-calling `syncOrgSeatQuantity` and `cancelOrgSubscription` are asserted for shape only. The subscription-create idempotency window (H-23) is untested, as is the SetupIntent-ownership check in `confirm/route.ts:95`. |
| Route-level authorization on money and identity fields | Nothing | Nothing asserts that a role-`user` project owner is refused `expertRate`, `paymentStatus`, `stripePaymentIntentId` or `contactEmail` (C-1, H-1). This is the highest-value missing test in the repository. |
| Authentication (login, session, logout) | `scripts/smoke-cutover.ts` covers login success, wrong password, `/api/auth/me`, logout and session-dead-after-logout, live over HTTP | No unit test of the auth code. Rate limiting is untested in both directions: that caps fire, and that a Redis outage degrades as intended (H-14, H-15). |
| Invite, set-password, activation | `scripts/test-signup-token.ts` covers HMAC generate, verify, expiry and tamper for `lib/signupToken` | No script mints a link and redeems it. Single-use enforcement, the seat-cap-before-redeem ordering, the email-mismatch refusal in `redeemSetPasswordLink`, and the `kind: 'reset'` "touch nothing else" promise are all unverified. |
| Revocation | Nothing | Nothing asserts that disabling a member actually ends their access, which is exactly the behaviour H-16 says can silently fail. |
| Cross-organization scoping | `scripts/e2e-matchy.ts` logs in owner, collaborator and intruder personas and asserts the project-access split; `scripts/smoke-cutover.ts` covers a throwaway intruder | `orgAdminGuard` plus `resolveOrgId` cross-org scoping (that an org admin cannot act on another organization's members by passing `orgId`) is untested, as is the `provisionAccountInvite` refusal matrix. |
| RLS and direct database access | `scripts/rls-verify.sh` plus `scripts/rls/verify.sql`: 153 assertions across `anon`, five authenticated actors and `service_role`, plus a double-application idempotency proof | Currently exits non-zero on a correct database (H-19). Cannot run here (no psql) and has never run against production (no direct Postgres connection). `outreach_suppressions`, `engagement_events` and `system_events` are unasserted (M-6). Nothing ties the dropped policies to `lib/redactExpert.ts` as their replacement. |
| Blinding and redaction | Strong: `scripts/check-redaction.ts` (366 lines), `scripts/test-conversations-redaction.ts`, `scripts/test-matchy-screen.ts`, `scripts/test-matchy-templates.ts` | Content-level checks are missing: that a generated `anonymizedDescriptor` contains neither surname nor company (H-18), and that the booking ICS attendee list respects the same rules as the API responses (C-3). |
| Outbound send chokepoint | `scripts/test-walkthrough.ts` and `scripts/test-entitlements.ts` cover the two gates inside `sendSequenceEmail`; `scripts/e2e-matchy.ts` proves one live path (no contact, no send) | Nothing asserts that an opted-out address cannot receive a client reply, a rate line or an auto follow-up (H-3), and nothing asserts the three routes that discard `SendOutcome` behave correctly under a trial hold (H-4). |
| Duplicate-send protection | Nothing | The bookmark race (H-2), the post-send write failure, `messages/[messageId]/send` concurrency (M-30), and the nudge same-morning double (M-41) are all uncovered. |
| Inbound email pipeline | Good on the pure stages: `scripts/test-email-clean.ts`, `scripts/test-matchy-screen.ts`, `scripts/test-matchy-classify.ts` (stubbed model), `scripts/verify-svix.ts` | No test drives a signed payload through the route end to end. The sender check, the dedupe claim (H-5), `advanceDeclined`'s global suppression write and the auto follow-up are uncovered. |
| Background jobs | `scripts/test-nudges.ts` (219 checks on the pure decision layer, including DST and business days) | Nothing exercises `reconcile`, `schedule-nudges` or `send-nudge` as routes. The worker's re-validation ladder, `sweepSeats` against a Stripe stub, `sweepSourcing`'s cutoff arithmetic, and the 503/401 auth behaviour of all three are untested. |
| Sourcing | `scripts/verify-sourcing-prod.ts` (live, production-pointed, costs real money); `scripts/e2e-matchy.ts:241` asserts a collaborator gets 403 | No unit tests of sourcing logic. `classifySeniority` in particular is a pure, dependency-free function on the money path (it selects the tier that sets `expertRate`) and would be trivial to cover. QStash redelivery, `extractJSON`'s slow path, `normalizeExpert`'s rejection rules and the per-briefType score floors are all uncovered. |
| Contact discovery | `scripts/test-contact-discovery.ts` (81 checks on the pure helpers and the kill switch) | The provider chain itself has no fake-provider harness, so cache-then-Snov-then-Hunter ordering, abort handling and negative caching after a timeout (M-24) are unverified, as is QStash signature rejection on the worker. |
| Scheduling and booking | Good: `scripts/test-scheduling.ts` (171 checks), `scripts/test-availability-windows.ts` (109 checks), `scripts/test-matchy-client.ts` | `fetchGoogleFreebusy`'s busy-to-free inversion across zones (H-21), the Calendly path at all (M-32), both OAuth callbacks, `GET /api/schedule/[token]` as an HTTP route (which would have caught C-2), and `rebookCall` against a real Zoom meeting are uncovered. |
| Expert reply tokens | `scripts/e2e-matchy.ts` uses `lib/outreachToken.ts` to build fixtures | No dedicated unit test of any of the four HMAC token modules' verify paths: malformed, expired and invalid-signature branches are all unexercised. |
| Admin routes | Nothing | No script calls any `/api/admin/*` route or asserts admin-only authorization. The org-delete-with-Stripe-cancel-first path, the user-delete foreign-key interaction (M-46) and the personal-domain trial branch are all untested. |
| Password reset | Nothing | `lib/passwordReset.ts` has no coverage anywhere. `scripts/test-signup-token.ts` covers a related but distinct module. |
| Account and organization deletion | Nothing | No behavioural test of `deleteUser`, `deleteFirm`, or the cascade and RESTRICT interactions they depend on. |
| Frontend components | Nothing | No script imports any React component or `lib/matchyClient.ts`. Client-side error-state rendering (422 findings, 409 preconditions), the 5-second and 20-second polling loops' cleanup on unmount, and the silent-failure paths in L-37 are all uncovered. |
| Environment and configuration | `scripts/security-scan.sh` (npm audit, tsc, secret grep, XSS sinks, undocumented environment variables) | Nothing detects a documented-but-never-read variable (M-50) or a read-but-never-documented one (M-51), and nothing asserts that `validateEnv` fails a deploy for the right reasons. |

## Fragile areas

Places a newcomer should not touch without reading the surrounding documentation first. Most of these are single points of protection with no test behind them.

- **`lib/redactExpert.ts` is the blinding boundary, and since migration 20260908000000 it is the only one.** The RLS policies that used to sit beneath it are gone. Every field added to `ProjectExpert` must be considered for `INTERNAL_PROJECT_EXPERT_KEYS`, and `isIdentityRevealed` requires both a status at or past `scheduled` and real booking evidence for a reason (a client can write `status`, and cannot write `booking.bookedAt`).
- **`lib/projectStore.canAccess` and `getProjectForUser` are the only cross-customer boundary.** Every project route must go through `getProjectForUser`, never `getProject`. An unscoped `getProject` import already sits unused in one route file (L-16). A 404, not a 403, is the intended answer for an inaccessible project, so existence is not leaked.
- **`lib/createAndSendInvoice.ts:276`, the double-bill guard.** One conditional prevents the Zoom webhook and the manual complete route from charging the same call twice (C-4). It is keyed on the wrong identifier for a second genuine call (H-8) and has no test.
- **`lib/emailSequence.sendSequenceEmail` is the one outbound chokepoint.** It enforces `DISABLE_EMAILS`, walkthrough mode and entitlements, appends the CAN-SPAM footer and sets the reply-to token. It does not enforce suppression (H-3), and three callers ignore its return value (H-4). Anything added here affects every outbound email in the product.
- **`lib/expertPipeline.ts` `EXPERT_STATUSES` order is load-bearing.** The identity reveal is computed by index comparison against `REVEAL_AT`. Reordering the array silently moves the reveal. Its "ORDER IS LOAD-BEARING" comment is the single most important comment in the repository and should survive any refactor.
- **`lib/projectStore.mutateExpert`'s compare-and-set on `updated_at`.** It is the only optimistic-concurrency mechanism on the expert record, it retries three times with no backoff, and it throws a message nothing catches (L-18). `updateProject` has no equivalent at all (H-17).
- **The service-role client is used everywhere.** `lib/supabase/admin.getServiceRoleClient` bypasses RLS by definition, and after the WIP migration there is no policy layer to fall back on. Every module holding it (`projectStore`, `conversations`, `firmStore`, `entitlements`, `orgBilling`, `expertPayout`, `attention`, `engagementEvents`, `productEvents`, `outreachSuppressions`, `calendarConnections`, every cron route) is effectively a superuser.
- **Redis is fail-open almost everywhere, including on the credential path.** Rate limiters, the seat-claim lock, the search cache, the contact cache and the inbound dedupe claim all continue on a Redis error. The one exception, `createRateLimiterStore`, throws in production. Assume nothing about Redis being available, and assume the fail-open branch is a routinely taken path rather than an edge case (H-14).
- **`app/api/webhooks/zoom/route.ts` is where money starts.** `meeting.ended` writes `completed` and enters the invoice path with no replay window, no completion guard and no duration validation (C-4, M-35). It is also entirely untested.
- **`lib/pricing.ts` is the only rate converter.** `clientRateFor`, `expertRateFor`, `callChargeDollars`, `expertPayoutDollars`, the 15-minute minimum and the band clamp all live here, and it is well covered by `scripts/test-pricing.ts`. The danger is not the arithmetic but the callers: `rateFieldsFor` must write both numbers together, and no route should ever write one side alone.
- **`app/api/inbound-email/route.ts` claims its idempotency key before doing the work.** A partial failure loses the reply permanently and returns 200 so Resend never retries (H-5). The sender check is an address comparison, not authentication (M-28). This route is the entire read path for expert replies and has no end-to-end test.
- **`lib/matchyTemplates.deriveTopic` is what stops a client's own brief text reaching an expert.** Its deny-list is passed inconsistently by callers (M-29), one caller does not compile (C-2), and its structured-field behaviour currently disagrees with its own test (M-48).
- **Migrations are pasted by hand into Supabase Studio.** There is no CLI link, filename order is the only ordering guarantee, re-pasting an applied file is a documented recovery step, and one migration is not inert on re-application (M-7). `20260908000000` has not necessarily been applied at all; its own header says so.
- **`scripts/wipe-projects.ts`, `scripts/seed-admin.ts` and `scripts/smoke-cutover.ts` act on whatever environment variables happen to be exported.** No guard, no confirmation, no dry run (H-22).

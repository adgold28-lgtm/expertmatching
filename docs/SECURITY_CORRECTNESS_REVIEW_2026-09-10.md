# ExpertMatch security, correctness and efficiency review

Date: 2026-09-10. Branch: `fix/security-review-20260909`. Local worktree: `/Users/ashergoldstein/Projects/expertmatch-security-review`.

## Scope and coordination

Read `CLAUDE.md`, `HANDOFF.md`, `TASK_QUEUE.md`, `SECURITY_AUDIT.md`, `ARCHITECTURE.md`, `ARCHITECTURE-AUDIT.md`, `docs/REPAIR_PLAN.md`, and the state-of-the-union material before making changes. Traced authentication, project access/creation, sourcing, outbound sends, booking, billing, payouts and error recording. This is a targeted review, not a claim that every route or dependency is secure.

The initial main checkout was `b4518b8` (Matchy 2.0). Existing repair work was on `fix/waves@a3f0abf`, outside main. Started in an isolated worktree at that repair commit, leaving main's untracked call-policy draft and the repair worktree's auth test untouched. During this review the other worktree rebased its repairs onto main and advanced to `d263322`. Rebased only this review's commit onto that snapshot, without conflicts, and reran verification. The reviewed main snapshot `b4518b8` is an ancestor of this review branch. This preserves the current Matchy 2.0 work and all existing repairs. No changes were made in either other worktree. At the final coordination check main had advanced again to `b44a02c` (two intro trial arms and signature changes), and `fix/waves` was being rebased again. That later intro-only change is not included here; merge it through normal integration and rerun template tests before release. This branch intentionally retains its verified `d263322` base rather than racing the other writer.

The additions here are payment webhook recovery/settlement checks, payout eligibility checks, the pending-account middleware check, request-scoped auth reuse, and their tests. Earlier repairs are credited below, not presented as new work. Nothing was deployed, pushed, emailed, booked with a live provider, or charged. No production environment file was loaded or copied. The worktree uses the existing local dependency installation; the dependency advisory report is against the final tracked lockfile.

## Findings and evidence

“Confirmed” means established by current code or a local reproduction; it does not mean observed exploitation in production. “Risk” means a concrete failure window exists but its production conditions or occurrence were not validated. Line numbers refer to this review branch; function names remain useful as code evolves.

### R1 — Failed Stripe events are acknowledged and permanently skipped

**High; confirmed; fixed here.** A successful client payment followed by a failed database write was logged and swallowed by `handlePaymentSucceeded`. `claimStripeEvent` had already recorded a seven-day seen marker, and the route returned 200. A retry could never repair the state; payout was invoked even after the payment write failed. Refund writes and refund PaymentIntent lookups had similar swallowing paths.

Affected: `app/api/webhooks/stripe/handlers.ts` (`claimStripeEvent`, `handlePaymentSucceeded`, `handlePaymentFailed`, `handleRefundOrDispute`, `engagementForCharge`, `handleStripeEvent`); `app/api/webhooks/stripe/route.ts:68`.

Evidence: `scripts/test-stripe-recovery.ts` fails against the pre-change handler with “Missing expected rejection” and emits the synthetic secret-bearing provider error. The fixed suite passes **39 assertions**, covering write failure then retry, refund lookup failure then retry, duplicate/in-flight deliveries, unpaid checkout and the actual Redis claim implementation through a local REST double.

Fix: short owner-safe processing lease, completed marker only after successful work, release on failure, 500 for failure or in-flight delivery, and no payout before payment persistence. Versioned marker keys avoid trusting old markers that could represent lost work. Redis remains optional; durable payout guards and Stripe transfer idempotency remain necessary. Fixed reason codes, event type, and available project/expert IDs reach `system_events`; raw exception messages do not.

Limits: the lease is five minutes, not a durable financial transaction. Redis outages/expired leases still permit concurrent work. This does not replay previously lost Stripe events automatically. Subscription mirroring and payout helpers still swallow some internal failures; see R7/R11.

### R2 — Checkout completion is treated as settled payment

**High; confirmed code defect; fixed here.** `checkout.session.completed` could contain `payment_status: 'unpaid'` for delayed payment methods but unconditionally wrote `paid` and invoked payout. Exposure depends on which payment methods are enabled; those live settings were not inspected.

Affected: `app/api/webhooks/stripe/handlers.ts:394`, payment-link branch.

Fix: require `payment_status === 'paid'`; handle `checkout.session.async_payment_succeeded` as well. Tests cover unpaid, missing status, no-payment-required, ordinary paid checkout, and delayed settlement. Updated the existing Stripe fixture to explicitly represent a paid session. Enable the new async success event on the eventual deployment's Stripe endpoint. No live endpoint configuration was changed.

References: [Stripe fulfillment and delayed payment methods](https://docs.stripe.com/checkout/fulfillment), [Stripe webhook delivery/retries](https://docs.stripe.com/webhooks). A signed event authenticates its source; it does not establish that checkout funds have settled.

### R3 — Payout retries can pay a refunded call or a trial account

**High; confirmed; fixed here.** `runExpertPayout` checked prior transfers and contact details, but not `paymentStatus` or account entitlements. Example: payment succeeds, expert setup is pending, client is refunded, expert later finishes setup; `account.updated` retries the pending row and transfers money despite `refunded`. A stale paid row belonging to a restricted trial also had no final entitlement guard.

Affected: `lib/expertPayout.ts:364` (`runExpertPayout`); callers include the Stripe webhook and pending-payout sweep.

Fix: require a persisted `paid` state and current `canCharge` entitlement before looking up a Connect account, transferring, or sending onboarding email. No reversal of previously transferred money is attempted.

Evidence: expanded `scripts/test-stripe-flows.ts` gives **14 failing assertions before** this change and **229/229 passing after**. It explicitly tests unpaid/failed/refunded/invoice-sent/missing states, a trial with a stale paid row, and refund between initial pending setup and later onboarding. Paid, entitled calls and prior idempotency tests remain green.

Limit: this check is not atomic with a concurrent refund or entitlement change after the read; financial state serialization remains R7.

### R4 — Pending sessions bypass the outer project-route gate

**High; confirmed inconsistent authorization; fixed here.** The prior repair made `routeAuthGuard` reject pending accounts, but middleware rejected only disabled accounts. Project guards deliberately rely on middleware, and `getSessionUser` maps the verified user's metadata without checking status. A pending session with completed/absent onboarding metadata could therefore reach project routes despite the documented active-account requirement. Acquiring such a session depends on invitation/reset/account lifecycle state, not on editing a client-side role.

Affected: `middleware.ts:103`, `lib/projectsGuard.ts` (`checkAuth`), `lib/auth.ts` (`statusMayUseProduct`, `getSessionUser`).

Fix: middleware uses the same existing status policy as route guards. API calls return 403; protected pages redirect to login. Public token/auth paths retain their existing routing. No stricter legacy missing-status policy was introduced.

Evidence: `scripts/test-auth-request-cache.ts` invokes real middleware and guards with the Supabase HTTP boundary mocked; pending project requests return 403 and active requests pass. Existing authorization, entitlement and redaction suites pass.

### R5 — Duplicate verification requests on authenticated API reads

**Medium; confirmed; fixed and measured here.** A route that calls `routeAuthGuard(request)` then `getSessionUser(request)` performed two Supabase `getUser` round trips. Concurrent consumers duplicated the same work too.

Affected: `lib/auth.ts:97`; examples `/api/auth/me` and `/api/org/membership`.

Fix: cache the in-flight verified-user promise in a `WeakMap` keyed by the actual request object. A new request always calls Supabase again. No process-wide user/session cache, decoded-JWT shortcut, matching change, or permission relaxation.

Measurement: same fixture, same machine, fixed 15 ms auth-service delay, actual Supabase SSR client and actual guard/session calls. Before: **2 calls, 36.33 ms**. After: **1 call, 20.51 ms** (about 44% lower elapsed time in that run; exact timings vary). The deterministic improvement is **50% fewer auth calls within that handler**. Middleware runs in a separate request/runtime context and is not included in the saving. This is not a production latency or AI-cost estimate.

Evidence: `scripts/test-auth-request-cache.ts` verifies sequential and concurrent reuse, independent user requests, next-request revocation, pending middleware, and fail-closed auth errors. Matching quality is preserved because no prompts, candidate filters, search queries, ranks or result limits changed here.

### R6 — Vulnerable dependency versions remain

**Critical advisory severity; affected versions confirmed; reachability not established; open.** Final online `npm audit --package-lock-only --json`: **9 affected packages: 1 critical, 5 high, 2 moderate, 1 low**. See [machine-readable report](security-review-evidence/dependency-audit.json) for exact versions, advisory URLs, ranges and suggested upgrades. The earlier snapshot had 14; the other repair branch removed unused packages, accounting for the reduction, not this review.

Affected: `package.json`, `package-lock.json`, especially Next.js 14.2.35. Examples include AVIF image-optimization and Windows-hosted-server critical advisories. Windows-specific impact is not established for the documented Vercel deployment. No exploit was attempted. Other findings include axios and transitive packages.

Remediation: a supported patched Next.js release plus affected dependency updates and routing/build/browser validation. The audit proposes a major Next.js upgrade; it was not mixed into these targeted behavior fixes. **The branch is not a clean dependency-security gate.** An offline npm audit returned zero vulnerabilities on the first run; that is not evidence of safety, and the online result supersedes it.

### R7 — Cross-event ordering and per-call financial correlation remain incomplete

**High; code paths confirmed; production occurrence unvalidated; open.** `handlePaymentSucceeded`/`handlePaymentFailed` write the current engagement from project/expert metadata without an atomic terminal-state or call-identity condition. Different event IDs do not share the new event lock. A late failure can overwrite paid; a delayed success can overwrite refunded; an event from an earlier call can affect the current call. A transfer can race a refund after R3's eligibility read.

Affected: `app/api/webhooks/stripe/handlers.ts:252,267`, `lib/createAndSendInvoice.ts` payment-link metadata, `lib/chargeSavedCard.ts` metadata, `lib/expertPayout.ts` payout calculation/retries.

Remediation: correlate every intent/link/event with a durable call/payment record, serialize state transitions, and make terminal-state rules explicit. Do not call read-then-write checks an ordering guarantee. Also, subscription mirroring (`lib/orgBilling.ts:974`) swallows lookup/update failures and ignores `patchBillingRow`'s false result; R1 does not fix that helper. No transactional Postgres/Stripe race tests were run. Existing per-call charge/transfer keys reduce duplicates but do not constitute a ledger.

### R8 — Booking side effects can outlive failed persistence

**High reliability risk; confirmed sequence, no live reproduction; open.** `lib/bookCall.ts` creates or updates Zoom before persisting the new booking. On a store failure it returns `write_failed`; it does not compensate the external meeting. A retry can create another meeting, and concurrent bookings lack a demonstrated durable one-winner constraint. Zoom failure can also leave a scheduled booking without a meeting link.

Evidence: `bookCall` state construction and catch around `writeExpert` (approximately lines 275–310); `rebookCall` analogous write failure. Existing ICS tests prove recipient isolation and fallback wording, not external recovery. Remediation: durable booking attempt/lease and provider idempotency or explicit compensation/reconciliation. No meetings were created or canceled to test this.

### R9 — Sourcing and outreach idempotency are not fully atomic

**High reliability/cost risk; confirmed windows, concurrency not reproduced against Postgres; open.** `lib/sourcingJob.ts:154` itself documents a read-check/write window: two concurrent deliveries of one still-running job can both spend on AI/search, and the final ownership check is separate from append/status writes. A crash between append and terminal status can also leave partial results. `lib/outreachSteps.ts` persists a sent-looking claim before sending; a crash in that gap can strand an unsent intro. Redis failure removes the atomic intro lock and ambiguous email-provider outcomes can cause duplicates on retry.

Prior repairs improved these substantially: conditional start, run ID, queue deduplication ID, send claims and suppression checks are present and tested. They do not justify an unconditional “exactly once” claim. Remediation: durable attempt state/outbox, ownership-conditional commits and recovery that distinguishes unattempted, uncertain and acknowledged provider sends. No outreach was sent.

### R10 — Inbound-email provider contract is still unverified

**High suspected integration risk; open, inherited H-26.** `app/api/inbound-email/route.ts:390,466,483` reads top-level `to`, `from`, `text`. A nested event envelope or metadata-only received event can be ignored as having no recipient/body and acknowledged. The existing audit identifies this uncertainty; its sender-authentication gate also lacks validated provider verdicts in real deliveries.

Remediation: verify the configured event contract with a sanitized fixture and the provider's receiving API, then integration-test retrieval, missing body, signature, authenticated sender and retry behavior. This review did not inspect a production message, send a probe email or declare the current live integration broken. Local claim tests do not validate the email-body contract.

### R11 — Error capture is incomplete and redaction is not a general secret scrubber

**Medium; confirmed by source inspection; partly improved here.** `instrumentation.ts` validates configuration but does not install an error collector. There is no app/global error boundary or general browser `error`/`unhandledrejection` collector in `app/`, `components/` or `lib/`. Failed project creation/listing and several booking/provider operations use console-only error paths. Selected backend incidents enter `system_events` and the admin attention feed.

Affected: `instrumentation.ts`; `lib/engagementEvents.ts:204,245`; project API catches; booking catches; client mutation catches. `sanitizeFailureReason` removes emails and Stripe IDs but can retain bearer/API/OAuth tokens, URLs, personal names or confidential briefs in arbitrary exception text. `recordSystemFailure` also has raw database-error fallback logs. The annotation “PII-free” is stronger than this implementation supports.

R1 improves the changed webhook path using authored operation codes, event type and project/expert context, without payloads or arbitrary exception strings. It does not add global browser monitoring. Needed next: bounded allowlisted client-error reports, release/route/operation/correlation context, grouped incidents, retention/access controls and a safe server logging contract. Do not upload raw browser state, cookies, messages, briefs or payment payloads. A runtime failure of the error store still has only the console fallback; no release/stack/correlation coverage was validated.

### R12 — Search cache identity can serve the wrong search variant

**Medium; confirmed code defect; open.** `lib/searchCache.ts:38–72` hashes only normalized query; `lib/generateExperts.ts:825` requests a configured provider and max result count but looks up that query-only key. Switching provider or increasing breadth inside the seven-day TTL can return a different provider's or smaller result set. This can distort a sourcing-quality experiment.

Remediation: versioned key including provider and relevant options, with fallback provenance and validation. No search caching/ranking changes were made here because there is no frozen, human-rated relevance benchmark. No live AI/API calls or production search timing measurements were performed. R5 is the measured efficiency improvement in this change.

### R13 — Actual database isolation depends on unapplied/unverified migrations

**Critical if the legacy policies remain; deployment status unvalidated.** `supabase/migrations/20260908000000_identity_boundary_trial_events.sql` removes direct authenticated access to sensitive project-family tables. Older policies could expose raw expert rows and allow direct writes through PostgREST. Application-layer redaction cannot repair a permissive database policy. The newer cron-index migration is also present but not verified applied.

Evidence: migration SQL plus `HANDOFF.md`/`TASK_QUEUE.md` outstanding migration actions. No production Supabase query was made. Before release, apply/verify migrations on an isolated database and run cross-account/direct-RLS tests. Do not infer deployment state from a checked-in migration or a passing mocked test.

## Existing claims checked against code

- Older `SECURITY_AUDIT.md` is historical, not a current clean bill of health. Its package advice and remaining/fixed lists overlap. The updated architecture audit also contains original prose alongside newer status tables; use the code and dated status together.
- Owner money/contact-field restrictions and Matchy 2.0 client-rate behavior coexist after the other branch's rebase (`lib/expertFieldTiers.ts`, expert PUT route). Offline field authorization: **129/129**.
- Per-recipient ICS builders are present; booking ICS suite **38/38**. This does not prove a live calendar reschedule.
- Stripe raw-body signature verification and Zoom freshness/duration guards are present; signature suite **49/49**, Zoom **39/39**. No live webhook signatures were collected.
- Suppression and entitlement checks are at the email chokepoint; send-chokepoint **60/60**, walkthrough **64/64**. R9 limits the “send once” claim.
- Trial behavior is explicitly card-presence based, not trial expiry or subscription good standing. `entitlementsFromBilling` can allow external actions for a past-due account with billing complete; that is current policy, not silently changed here.
- Project access is owner/explicit collaborator (admin override), not automatic visibility to every person in the same firm. Application access checks and redaction were inspected; production RLS was not tested.
- Source search fan-out/scoring and Matchy 2.0 templates were preserved. Existing Matchy ask, draft, personalization and redaction suites pass.
- Pattern scan of tracked first-party code found no hardcoded values matching the checked Stripe/AWS/GitHub key patterns. Only `.env.example` is tracked. This is a limited scan, not a full history/credential validity review; production secrets and logs were not read.

## Verification and limitations

- `npm run build:local`: production Next build with mocked Google Fonts, no production env files. Repeated after rebase; final check recorded in the completion entry below.
- `tsc --noEmit`: passed. `git diff --check`: passed.
- **38 offline suites passed** on the combined branch, including Matchy 2.0. [Suite exit codes](security-review-evidence/offline-suites.json). Subsequently expanded Stripe flows: **229/229**, webhook recovery: **39 assertions**.
- Auth benchmark: actual guard/SSR client, mocked fetch, 15 ms delay; numbers above are a single controlled sample, not production percentiles.
- Failed-before evidence: old webhook swallowed the injected write failure; old payout implementation failed 14 new assertions; old auth reader issued two round trips. All pass with the fixes.
- Online advisory audit is intentionally nonzero: nine affected packages remain. [Full advisory report](security-review-evidence/dependency-audit.json).
- Did **not** run `e2e-matchy`, `e2e-trial`, `test-route-authz`, `test-auth-flows`, live Redis smoke, RLS SQL, or production schema/sourcing scripts. They need isolated configured services and can create accounts or perform external actions. No isolated Supabase/Zoom/Stripe environment was established during this review.
- No real-browser customer journey, delivery confirmation, live invoice/refund/transfer, production query plan or production latency was validated. Offline tests do not establish those properties.

Focused commands, using the repository's existing tsx convention:

```sh
npx tsx scripts/test-auth-request-cache.ts
npx tsx scripts/test-stripe-recovery.ts
npx tsx scripts/test-stripe-flows.ts
npx tsc --noEmit
npm run build:local
```

Tests were executed here using the locally cached tsx Node loader, without installing a dependency or loading any `.env` file.

### Final completion record

`npm run build:local` completed successfully after the payout guard change. `tsc --noEmit` and `git diff --check` passed. The full 38-suite pass includes the updated repair/Matchy 2.0 snapshot; the subsequently expanded payout regression passed 229/229. The new recovery suite passed 39 assertions. All changes remain local on the isolated branch, with no push or deployment.

## Follow-up review of this branch, 2026-09-10 (second reviewer)

The commits above were re-reviewed independently before integration, the branch
was rebased onto `main@b44a02c`, and four defects were fixed. Every claim in the
sections above was re-run rather than taken on trust: `tsc --noEmit` clean,
`git diff --check` clean, all 38 offline suites green, `test-stripe-flows`
229/229 and `test-stripe-recovery` 39 assertions reproduced exactly as stated
before any change. `npm run build:local` was run on a clean `npm ci` install.

### Confirmed as described

R1's lease protocol was traced through every interleaving: `busy` throws before
the `try`, so the `finally` cannot release another worker's lock;
`releaseLockIfOwner` is an owner-guarded EVAL; the second `doneKey` read closes
the claim/complete race; `completeEvent` before the release is the correct
order. R5's `WeakMap` is keyed on request identity, middleware and route
handlers get distinct objects, and caching a `null` from an auth outage is
fail-closed. The new `recordSystemFailure` call passes a fixed template with no
exception text. No secret-leak, stale-user or wrong-authorization path was
found in any of them.

### Defects found and fixed here

**F1 — a permanent handler failure became a three-day retry loop.** R1's
"stop swallowing, let Stripe redeliver" is right for a transient store failure
and wrong for a permanent one. `projectStore.mutateExpert` throws
`Expert not found` for an engagement deleted between billing and payment
(`DELETE /api/projects/[id]/experts/[id]` has no billed-row guard), and
`engagementForCharge` retrieves a PaymentIntent on the platform account that a
connected-account charge does not have. Both 500'd on every redelivery, wrote
one attention row per attempt, and risked Stripe disabling the endpoint — which
would have stopped every other money event too. `isUnprocessableWebhookError`
now separates the two; permanent failures are recorded once and acknowledged.

**F2 — a blocked payout became invisible rather than deferred.** R3's two new
checks were bare `return`s placed before the row is ever given an
`expertOnboardingStatus`, the only field both sweeps and the reconcile
stale-owed alarm select on. Since `getEntitlementsForProject` fails closed, a
Supabase outage, an unreadable organization row and a legacy project without an
organization all reach it looking like a restricted trial — and the expert
silently disappeared from every retry path. `createAndSendInvoice` resetting the
shared row to `unpaid` for a second call has the same shape. `holdPayout` now
parks such a row as `pending` without burning the attempt budget, and raises one
`payout_held` event on the transition only.

**F3 — R4 trapped a blocked session with no way out.** `PUBLIC_PATHS` is only
consulted in the no-session branch, so a signed-in `pending` user requesting
`/login` was redirected to `/login`, and `/api/auth/logout` answered 403: the
user could not clear the cookie blocking them. The gate now returns
`PUBLIC_PATHS` through, as the onboarding gate below it already does.

**F4 — rebase integration.** `main@b44a02c` removed the intro's LinkedIn line
and the only reader of `OUTREACH_LINKEDIN_URL`, which `check-env-drift` fails on
once the two are combined. The variable is retired.

Each fix carries failed-before evidence: reverting the changed file alone makes
its suite fail. `test-stripe-recovery` is now 61 assertions,
`test-stripe-flows` 241/241, and `test-auth-request-cache` additionally covers
the sign-out escape for both blocked statuses.

### Still open, unchanged by this pass

R6 (nine dependency advisories), R7 (cross-event ordering and per-call financial
correlation), R8–R13 and the "no live provider was exercised" limits above all
stand as written. F2 makes a blocked payout visible; it does not make the
entitlement read atomic with a concurrent refund. Nothing here was deployed, and
no live Stripe, Supabase, Zoom or email service was contacted.

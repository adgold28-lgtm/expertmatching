# Security Audit — ExpertMatch
**Date:** 2026-05-13  
**Scope:** Next.js 14 App Router — all public routes, webhooks, auth, env var handling, dependency chain  
**Status:** CRITICAL and HIGH fixes applied. MEDIUM and LOW documented below for future action.

---

## Applied Fixes (CRITICAL / HIGH)

### CRITICAL-1: No security headers [FIXED]
**File:** `next.config.js`  
**Issue:** No HTTP security headers were set — no X-Frame-Options, HSTS, X-Content-Type-Options, etc.  
**Fix:** Added `headers()` in `next.config.js` applying X-Frame-Options, X-Content-Type-Options, Strict-Transport-Security, Referrer-Policy, X-XSS-Protection, and Permissions-Policy to all routes.

### CRITICAL-2: Google OAuth refresh_token logged to stdout [FIXED]
**File:** `app/api/admin/google-calendar-auth/callback/route.ts`  
**Issue:** Lines 77–80 logged `data.refresh_token` in plaintext via `console.log`. Any log aggregation system (Datadog, CloudWatch, Vercel logs) would have captured this credential permanently.  
**Fix:** Removed all `console.log` calls for the token. Instead, the token is now returned directly in the HTML response body to the authenticated admin's browser — never written to stdout.

### CRITICAL-3: Missing startup env var validation [FIXED]
**Files:** `lib/validateEnv.ts` (new), `instrumentation.ts` (new), `next.config.js`  
**Issue:** No startup check for required production env vars. A misconfigured deployment could run silently with missing secrets (empty ENCRYPTION_KEY, STRIPE_WEBHOOK_SECRET, etc.), failing open or using insecure dev fallbacks in production.  
**Fix:** Created `lib/validateEnv.ts` that throws in production if any required variable is absent (warns in dev). Created `instrumentation.ts` to call it once at Node.js runtime startup. Enabled `experimental.instrumentationHook: true` in `next.config.js`.

### HIGH-1: Zoom URL validation challenge used `secret ?? ''` [FIXED]
**File:** `app/api/webhooks/zoom/route.ts`  
**Issue:** The `endpoint.url_validation` branch computed an HMAC using `secret ?? ''` — if `ZOOM_WEBHOOK_SECRET_TOKEN` was not set, it would silently compute with an empty string key and return a valid-looking response. This makes the challenge trivially bypassable without the real secret.  
**Fix:** Added an explicit `if (!secret) return 400` guard before computing the HMAC, so the challenge also fails closed when the secret is missing.

---

## Applied Fixes (MEDIUM)

### M-2: Admin OAuth error code logged verbatim [FIXED]
**File:** `app/api/admin/google-calendar-auth/callback/route.ts`
**Fix:** Allowlisted known error values; unknown values logged as `'unknown_error'`.

### M-3: No rate limiting on `/api/availability/[token]` POST [FIXED]
**File:** `app/api/availability/[token]/route.ts`
**Fix:** Per-token rate limit (10 requests / 10 min) using existing `createRateLimiterStore` infrastructure, keyed on `hashToken(rawToken).slice(0,16)`. Returns 429 with `Retry-After: 600` on breach.

### M-4: No rate limiting on `/api/availability/[token]/google-auth` GET [FIXED]
**File:** `app/api/availability/[token]/google-auth/route.ts`
**Fix:** Per-token rate limit (5 requests / 10 min). Redirects to `/availability/error?reason=rate_limited` on breach. Error page updated with user-facing message.

### M-5: `oauthState` cleared to `''` instead of `null` [FIXED]
**File:** `app/api/availability/oauth/google/callback/route.ts`
**Fix:** Changed `oauthState: ''` → `oauthState: null`.

### M-6: Internal error message returned to client in `/complete` route [FIXED]
**File:** `app/api/projects/[projectId]/experts/[expertId]/complete/route.ts`
**Fix:** Removed `message: msg` from 500 response body; raw Stripe/Resend errors now logged server-side only.

## Applied Fixes (LOW)

### L-1: `SESSION_SECRET` missing from validateEnv [FIXED]
**File:** `lib/validateEnv.ts`, `.env.example`
**Fix:** Added `SESSION_SECRET` to required vars list and documented it in `.env.example`.

### L-2: `OUTREACH_FROM_EMAIL` missing from validateEnv [FIXED]
**File:** `lib/validateEnv.ts`
**Fix:** Added `OUTREACH_FROM_EMAIL` to required vars list.

### L-3: `enrich-contact` audit log logs full event object
**Status:** FALSE POSITIVE — `AuditEvent` type contains only HMAC hashes and numeric counts by design. No PII present.

### L-4: `contactPathResolver.ts` logs full resolver result
**Status:** FALSE POSITIVE — logs only `domainSuggestionsCount`, `publicContactEmailCount`, `usedSearchProvider`, and cache hit/miss. No PII present.

### L-5: `sendAvailabilityRequest` success log has no correlation ID
**Status:** Deferred — low operational impact. Add pseudonymized recipient hash if log tracing becomes a need.

---

## Remaining Findings

### MEDIUM

#### M-1: `next@14.2.x` has multiple HIGH-severity CVEs
**File:** `package.json`  
**Detail:** `npm audit` reports 1 HIGH vulnerability in `next` covering versions `9.3.4-canary.0 – 16.3.0-canary.5`. CVEs include: DoS via Image Optimizer, HTTP request smuggling in rewrites, unbounded next/image disk cache growth, XSS in App Router with CSP nonces, cache poisoning, SSRF in WebSocket upgrades, and more.  
**Recommended fix:** `npm install next@latest` (resolves at ≥16.2.6 per npm audit). This is a major version bump — test thoroughly before upgrading. The current deployment uses none of the most exploitable surface areas (no CSP nonces, no WebSocket upgrades, `remotePatterns` is unconfigured), so immediate risk is reduced, but the upgrade should be tracked.

#### M-2: Admin refresh_token flow logs the OAuth error code to stdout
**File:** `app/api/admin/google-calendar-auth/callback/route.ts` line 29  
**Detail:** `console.error('[google-calendar-auth/callback] OAuth error:', error)` logs the raw `error` query param from Google. In normal operation this is benign (e.g. `"access_denied"`), but if Google ever includes sensitive context in the error string it would be captured in logs.  
**Recommended fix:** Allowlist known values: `const safeError = ['access_denied', 'invalid_request'].includes(error) ? error : 'unknown'; console.error(..., safeError);`

#### M-3: No rate limiting on `/api/availability/[token]` (POST)
**File:** `app/api/availability/[token]/route.ts`  
**Detail:** The public availability submission endpoint has no rate limiting. The signed token provides natural protection (brute-forcing a 256-bit HMAC is infeasible), but there is no guard against repeated submission attempts with a valid token, which could trigger many LLM calls (Claude Haiku) for `provider=manual` requests.  
**Recommended fix:** Add a per-token rate limiter (e.g. 10 requests / 10 min) using the existing `createRateLimiterStore()` infrastructure, keyed on `hashToken(rawToken)`.

#### M-4: No rate limiting on `/api/availability/[token]/google-auth` (GET)
**File:** `app/api/availability/[token]/google-auth/route.ts`  
**Detail:** Each request to this route writes a new nonce to `ProjectExpert.oauthState`, potentially causing write contention. No rate limit prevents repeated invocation with a valid token.  
**Recommended fix:** Same pattern as M-3 — per-token rate limit (5 requests / 10 min).

#### M-5: `oauthState` cleared to `''` instead of `null`
**File:** `app/api/availability/oauth/google/callback/route.ts` line 229  
**Detail:** After successful OAuth, `oauthState` is set to `''` (empty string). The guard at line 177 checks `if (!storedNonce)`, which treats `''` as falsy — so this works correctly. However, `''` is semantically ambiguous vs. `null`. A future developer might change the guard to `=== null` and introduce a bypass.  
**Recommended fix:** Set `oauthState: null` instead of `oauthState: ''` for clarity and forward safety.

#### M-6: `app/api/projects/[projectId]/experts/[expertId]/complete/route.ts` — error message leaks internal detail
**File:** line 95  
**Detail:** `console.error('[stripe] complete route error:', msg)` and then `NextResponse.json({ error: 'internal_error', message: msg }, { status: 500 })` returns the raw error message to the client. In production, internal error messages (e.g. from Stripe SDK or projectStore) should not be returned to callers.  
**Recommended fix:** Return a generic `{ error: 'internal_error' }` without the `message` field.

### LOW

#### L-1: `SESSION_SECRET` not in `validateEnv` required list
**File:** `lib/validateEnv.ts`  
**Detail:** `SESSION_SECRET` is required for the admin session cookie system (`lib/auth.ts`) but was not included in the `validateEnv` required list because it is not referenced in the provided `.env.example`. Confirm whether it belongs and add it if so.

#### L-2: `OUTREACH_FROM_EMAIL` not validated at startup
**File:** `lib/validateEnv.ts`  
**Detail:** `OUTREACH_FROM_EMAIL` is required for sending availability request emails via Resend, but missing from the `validateEnv` list. A missing value causes silent email failures at runtime.

#### L-3: `enrich-contact` audit log logs full event object
**File:** `app/api/enrich-contact/route.ts` line 75  
**Detail:** `console.log('[enrich-contact]', JSON.stringify(event))` logs the full audit event. Confirm this event object never contains email addresses or expert names before treating as safe.

#### L-4: `contactPathResolver.ts` logs full resolver result
**File:** `lib/contactPathResolver.ts` lines 191, 302  
**Detail:** `console.log(JSON.stringify({...}))` at resolution boundaries — confirm the logged objects don't include raw email addresses or personal names.

#### L-5: `sendAvailabilityRequest.ts` logs `status: 'ok'` without any identifier
**File:** `lib/sendAvailabilityRequest.ts` line 166  
**Detail:** Low risk, but the success log has no correlation ID, making it hard to trace. Consider adding a pseudonymized hash of the recipient for traceability without PII.

---

## Automated Security Scan (June 2026)

**Date:** 2026-06-01  
**Method:** Static grep analysis via `scripts/security-scan.sh` (`npm run security`)  
**Scope:** All TypeScript/TSX source in `app/`, `lib/`, `components/`

### Scan Setup

Added `scripts/security-scan.sh` — a reusable bash script that checks:
1. **npm audit** — HIGH/CRITICAL dependency CVEs
2. **tsc --noEmit** — TypeScript compilation errors
3. **Hardcoded secrets** — API key patterns (`sk_live_`, `whsec_`, AWS `AKIA*`, etc.)
4. **Insecure fallbacks** — `dev-insecure-fallback` and similar strings
5. **XSS sinks** — `dangerouslySetInnerHTML`, `eval()`, `.innerHTML =`
6. **console.log in API routes** — potential PII leakage
7. **TypeScript `any` usage** — weakens type-safety guarantees
8. **Undocumented env vars** — `process.env.*` references absent from `validateEnv.ts`

Run with: `npm run security`

### June 2026 Findings

#### NEW — Anthropic API key missing from startup validation [FIXED]

**Files:** `lib/validateEnv.ts`, `.env.example`  
**Finding:** `process.env.ANTRHOPICKEYREAL` is used in `app/api/generate-experts/route.ts:19` to initialize the Anthropic SDK client. This variable was absent from `validateEnv.ts`'s `REQUIRED_VARS` list and undocumented in `.env.example`. A misconfigured deployment would silently fail all expert-generation calls at runtime instead of refusing to start.  
**Fix:** Added `ANTRHOPICKEYREAL` to `REQUIRED_VARS` in `lib/validateEnv.ts` and documented it in `.env.example`.  
**Note:** The variable name `ANTRHOPICKEYREAL` is intentional (legacy naming in this codebase). Do not rename without updating `generate-experts/route.ts:19` and `demo-readiness/route.ts:48` simultaneously.

#### KNOWN — `dev-insecure-fallback` in multiple lib files [FALSE POSITIVE]

**Files:** `lib/rateLimiter.ts`, `lib/contactPathResolver.ts`, `lib/searchCache.ts`, `lib/stripeConnect.ts`, `app/api/resolve-contact-paths/route.ts`, `app/api/expert-onboarding/[token]/route.ts`  
**Detail:** These files use `process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback'` for HMAC pseudonymization in non-production mode. `lib/contactCache.ts` (the canonical implementation) throws in production when `LOG_HASH_SECRET` is absent. `LOG_HASH_SECRET` is validated at startup by `validateEnv.ts`, so production deployments cannot reach the fallback.  
**Status:** No action required — fallback is unreachable in production.

#### KNOWN — TypeScript `any` in generate-experts route [DEFERRED]

**File:** `app/api/generate-experts/route.ts` (lines 179, 471, 948, 1357, 1502, 1509, 1517, 1559)  
**Detail:** Multiple `any` usages when normalizing and scoring LLM-returned JSON. Typing dynamic AI output fully requires zod schemas or similar. Low security risk; the data is internal scoring only.  
**Recommended fix:** Introduce a `zod` schema for the expert candidate shape and parse with `z.safeParse()`. Deferred — medium complexity, no near-term attack surface.

#### KNOWN — `next@14.2.x` HIGH-severity CVEs [DEFERRED — unchanged from May 2026]

See M-1 in "Remaining Findings" section above. Status unchanged.

---

## Items Verified Clean

- **Stripe webhook:** `constructEvent(rawBody, sig, secret)` called before any DB writes. Returns 400 on bad signature. ✓
- **Zoom webhook:** Signature verified with `timingSafeEqual` before any DB writes (URL validation challenge now also guarded). ✓
- **Token expiry:** `verifyAvailabilityToken` checks expiry and returns `{ ok: false, reason: 'expired' }`. ✓
- **Token revocation:** SHA-256 hash compared against stored hash before processing. ✓
- **OAuth state nonce:** Cleared after use (set to `''`, effectively falsy — see M-5 above). ✓
- **Public route data exposure:** `/api/availability/[token]` and `/availability/[token]/page.tsx` return only safe fields — no `availabilityTokenHash`, `oauthState`, `calendarAccessToken`, `calendarRefreshToken`, `zoomStartUrl`, `stripePaymentLinkId`, or internal scores. ✓
- **Input validation on public routes:** Content-Type check, body size cap (4096 bytes), provider allowlist, URL prefix check, text length minimum — all present. ✓
- **Auth-gated routes all call `routeAuthGuard`:** `/complete`, `/request-availability`, `/request-client-availability`, admin routes. ✓
- **No PII in Redis key names:** `rlKey()` HMAC-pseudonymizes all identifiers. ✓
- **AES-256-GCM for OAuth tokens at rest:** Implemented correctly with random IV per encryption. ✓

---

## Stripe / Billing Review (September 2026)

**Date:** 2026-09-10
**Scope:** Every file that touches Stripe — `lib/stripe.ts`, `lib/stripeConnect.ts`,
`lib/chargeSavedCard.ts`, `lib/createAndSendInvoice.ts`, `lib/expertPayout.ts`,
`lib/orgBilling.ts`, `lib/pricing.ts`, `app/api/webhooks/stripe`,
`app/api/webhooks/zoom`, `app/api/onboarding/billing` (+ `/confirm`),
`app/api/settings/payment-method`, `app/api/expert-onboarding/[token]`,
`app/api/jobs/reconcile`, and the project-expert write route.
**Method:** Manual read of every money path end to end — who may write the numbers
that decide a charge, and what each webhook is trusted for.
**Tests:** `npx tsx scripts/test-billing-boundaries.ts` (48 checks) covers all
three findings below.

### S-1: The paying client could mark their own call paid [FIXED — HIGH]

**File:** `app/api/projects/[projectId]/experts/[expertId]/route.ts`
**Finding:** `PUT`/`PATCH` accepted `paymentStatus`, `paidAt`, `stripePaymentIntentId`,
`stripePaymentLinkId`, `stripePaymentLinkUrl`, `invoiceAmount` and `callDurationMin`
from the project owner — who is the person whose card the platform charges.
`lib/createAndSendInvoice.ts`'s durable double-bill guard skips billing when
`paymentStatus === 'paid'` **or** any `stripePaymentIntentId` is set, so a single
`PUT { "paymentStatus": "paid" }` before `POST …/complete` meant the call was
never charged and the engagement still read as paid to staff. The same fields let
`callDurationMin` be rewritten after a charge, inflating the expert payout that
`lib/expertPayout.ts` recomputes when Stripe's webhook lands — the difference
comes out of platform funds.
**Fix:** These seven fields are now `SERVER_OWNED_FIELDS` (`lib/expertWriteFields.ts`)
and the route answers `403 server_owned_field` to anyone who sends one, platform
admins included. They are written by exactly three server paths: `POST …/complete`
(which recomputes the amount from the stored rate), the Zoom `meeting.ended`
webhook, and the Stripe webhook. No client in this repo ever sent one of them, so
nothing in the product changes.

### S-2: An agreed rate could still be moved through `expertRate` [FIXED — MEDIUM]

**File:** `app/api/projects/[projectId]/experts/[expertId]/route.ts`
**Finding:** The rate lock (`rateAgreedAt`, or a status of `scheduling_sent` /
`scheduled` / `completed`) was enforced only on the `clientRate` branch. The
`expertRate` branch writes both rates through `rateFieldsFor()` and had no lock,
so `PUT { "expertRate": 1 }` on a settled engagement rewrote the client rate the
completion route then charges — after the expert had accepted a different number.
**Fix:** Both branches now go through the shared `isRateLocked()` predicate
(`lib/matchyIntent.ts`) and return the same `409 rate_locked`.

### S-3: The Zoom auto-invoice path had no duration ceiling [FIXED — MEDIUM]

**Files:** `app/api/webhooks/zoom/route.ts`, `lib/pricing.ts`
**Finding:** `meeting.ended` derives the call length from the event's
`start_time`/`end_time` and charges the saved card off-session. An unparseable
`start_time` produced `NaN` (a silent $0 invoice for a real call), and there was
no upper bound at all: a meeting left open, or an event carrying a stale
`start_time`, became an unbounded off-session charge — while the manual
`POST …/complete` route has always refused anything over 480 minutes.
**Fix:** `billableCallMinutesFromWindow()` in `lib/pricing.ts` bounds the derived
length to `[1, MAX_BILLABLE_MINUTES]` and never returns `NaN`. `MAX_BILLABLE_MINUTES`
(480) is now the single ceiling shared by the webhook and the completion route.

### Verified clean in this pass

- **SetupIntent confirmation** (`app/api/onboarding/billing/confirm`) retrieves the
  intent from Stripe, requires its `customer` to equal the caller's ORG customer
  before any state change, and requires `status === 'succeeded'`. The replay gap
  noted in PR #34 is closed. ✓
- **Card replacement** is gated on `org_admin` / platform admin at the point the
  SetupIntent is minted; `/confirm` can only ever promote a payment method that
  already belongs to the org's own customer. ✓
- **Charge amounts** are always recomputed server-side from the stored rate
  (`callChargeDollars`); the client-supplied `invoiceAmount` is only cross-checked,
  never used. ✓
- **Payout amounts** are recomputed from the stored `expertRate`
  (`expertPayoutDollars`) — a webhook payload is never trusted for money. ✓
- **Double-charge / double-payout** are guarded twice: durable state
  (`paymentStatus` / `stripePaymentIntentId` / `stripeTransferId`) plus deterministic
  Stripe idempotency keys (`charge:`, `expert-payout:`, `org-customer:`). ✓
- **Card data exposure:** `/api/settings/payment-method` returns brand, last4 and
  expiry only, and only to a champion or platform admin. Customer and payment
  method ids never leave the server. ✓
- **`/api/jobs/reconcile`** refuses to run (503) without `CRON_SECRET` and compares
  it without an early exit. ✓
- **Webhook signatures:** Stripe `constructEvent` and Zoom `timingSafeEqual` both
  run before any read or write. ✓

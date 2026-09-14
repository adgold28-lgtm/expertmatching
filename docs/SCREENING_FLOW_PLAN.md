# Structured Request & Screening Flow — build plan

*Written 2026-09-14. Lead: Fable (outline, schema, gates). Builders: Opus agents, one per step, disjoint file sets. Branch `claude/laughing-dirac-cs2b96`.*

## The thesis

Expert networks profit when a call under-delivers, because the client books another. We invert it: the client sees, before booking, exactly which of their questions an expert can speak to. Three surfaces: client intake, expert screening form, client review.

## Product alignment audit (CLAUDE.md)

1. **User problem.** A PE associate writes a brief, gets a list of experts, books a call, and only on the call learns the expert cannot speak to half the questions. Nobody asked the expert per question.
2. **Where it fits.** A parallel front door to Brief → Matches → Conversations. A *request* is a brief with learning objectives; *screening* replaces the guesswork of Matches for the objectives the client actually named; *selection* (Request call) hands off to the existing Matchy scheduling later. Nothing here touches scheduling, billing, or Stripe.
3. **What AlphaSights does by hand.** An associate emails a screening questionnaire, the expert answers in prose, the associate summarises. We automate the questionnaire (one yes/no per objective, one sentence of proof) and show the client the expert's own words, unsummarised.
4. **Edge cases.** Model fails or refuses (fallback templates, client edits inline); proof prompt that elicits substance (validator rejects, regenerates, then falls back); link expired / already submitted / revoked (one honest page, same body for every reason); expert marks 0 of 6 (still stored: negatives feed gap-matching); duplicate submission (single-use, conditional update); client edits the set after approval (refused, 409); collaborator or another org reads a request (404, never 403).
5. **Security / compliance.** No expert login: HMAC-signed link (lib/hmacToken, purpose `screening`), single-use, expires at the request deadline, revocable by hash. The expert learns the topic, an expert-side rate, a call length and "a mid-size PE firm" — never the client's name or firm. The client sees background lines and the expert's own words — never the expert's name or email (platform admins do). Stems and proof prompts pass the existing compliance screen (lib/matchyScreen) at approval so a client cannot ship their firm name or a URL to an expert. Rate-side rule from docs/MATCHY_SPEC.md holds: the expert sees `expertRateFor(clientRate)`, the client sees `clientRateFor(expertAsk)`, the two never share a message. All five tables are service-role only (RLS enabled, zero policies), the pattern every table since 20260908 uses.
6. **Polished SaaS version.** Intake finishable in 90 s with two fields; generation with a real loading state and an honest fallback; every stem editable inline; mobile-first one-handed screening form; coverage badges on a gradient; expand-row breakdown in the expert's verbatim words; empty, loading and error states on every surface.
7. **Files inspected first.** lib/hmacToken.ts, lib/availabilityToken.ts, lib/outreachToken.ts, lib/auth.ts, lib/projectsGuard.ts, lib/projectStore.ts (store shape + in-memory fallback), lib/supabase/{admin,database.types}.ts, middleware.ts, supabase/migrations/20260907000000 + 20260908000000 (table + RLS style), app/api/parse-brief/route.ts (Anthropic call pattern), app/schedule/[token] + app/api/schedule/[token] (public tokenized page), components/SchedulePicker.tsx (mobile-first expert UI), app/app/page.tsx (in-app chrome), lib/matchyTemplates.firmPhrase, lib/pricing.{clientRateFor,expertRateFor}, lib/productEvents.ts, lib/rateLimiter.ts, scripts/testHarness.ts.

## Decisions taken (change if you disagree)

- **Table names are the ones in the brief**: `requests`, `objectives`, `outreach_tokens`, `screening_responses`, `call_outcomes`. Two of them collide with existing vocabulary: `access_requests` / `/admin/requests` already mean "requests for access", and `lib/outreachToken.ts` already means the Matchy reply token. Renaming is a one-line change *before* the migration is pasted; after that it is a real migration. The HMAC purpose is `screening` and the module is `lib/screeningToken.ts` so the code never confuses the two tokens.
- **Who mints screening links: platform staff only.** A client cannot hold an expert's email address (the anonymity boundary), so a client-side "copy this link" is unusable by construction. Staff add a candidate (name, headline, background lines, optional email) and the platform either shows the link or emails it (Resend, suppression-checked, DISABLE_EMAILS honoured). The client sees respondents and acts on them.
- **The client never sees an expert's name or email**, only "Candidate N" plus background lines (companies, roles, dates) and the expert's own words. This keeps the existing product promise; the brief asks for companies and roles, which are shown. Admins see the name.
- **Rate and call length live on the request** (optional targeting fields; defaults $1,300/hr client-side = the senior tier, 60 min) because the screening header must show a rate and a length. The expert is shown the expert-side number and asked "does this work?" (one tap) or for their own number; the review row shows the client-side conversion.
- **Generation is its own route** (`POST …/generate`), not part of intake submit: a model failure never loses the intake, the UI shows a real loading state, and retry is one click. On failure the route writes deterministic fallback items so the client can still edit and approve.
- **Model: `claude-opus-5`**, one call per request, `effort: medium` via a typed cast (the pinned SDK 0.54.0 predates `output_config`; the server accepts it). No server-side refusal fallback (the SDK cannot type it; a refusal is handled as a generation failure).
- **Coverage is computed**, never stored: `yes / total`. Green ≥ 0.66, amber ≥ 0.34, red below.
- **Stage 5 is data model plus one route plus a disabled-looking control**, nothing more: `call_outcomes` rows, `POST …/tokens/[tokenId]/outcomes`, and the three-way control in the expanded row once a call has been requested. Gap re-match and reliability are queries over `expert_id`, documented in the migration, not built.
- **Access**: request owner or platform admin. No collaborators (a request is not a project). Any other caller gets 404.

## Schema (supabase/migrations/20260914000000_screening_requests.sql)

All ids uuid. `expert_id` is text (no expert table exists and none is in scope): `em:<sha256(email) first 24 hex>` when the candidate has an email, else `anon:<random 12 hex>`. That key is what stage 5 joins on across requests.

```
requests
  id               uuid pk default gen_random_uuid()
  organization_id  uuid not null → organizations(id) on delete cascade
  owner_id         uuid not null → profiles(id) on delete restrict
  status           text not null default 'draft' check in ('draft','approved','closed')
  topic_statement  text not null check (length ≤ 300)
  targeting        jsonb not null default '{}'   -- ScreeningTargeting (types.ts): targetCompanies[], seniority,
                                                 -- function, tenureWindow, geography, exclusions{companies[],experts[]}
  call_count       integer not null default 1 check (1..50)
  deadline         timestamptz not null           -- default now()+14d, set by the app; outreach-link expiry only
  client_rate      integer not null default 1300 check (>=100 and %50=0)  -- CLIENT-side $/hr
  call_length_min  integer not null default 60 check in (30,45,60)
  approved_at      timestamptz
  created_at / updated_at timestamptz (trg set_updated_at)
  idx (organization_id, created_at), idx (owner_id, created_at)

objectives
  id                 uuid pk
  request_id         uuid not null → requests(id) on delete cascade
  position           integer not null            -- 0-based, unique (request_id, position)
  objective_text     text not null               -- the client's learning objective, verbatim
  stem               text                        -- first-person yes/no question; null until generated
  proof_prompt       text                        -- asks ROLE and TIMEFRAME only; null until generated
  model_stem         text                        -- what the model wrote, kept for template learning
  model_proof_prompt text
  client_edited      boolean not null default false
  source             text check in ('model','fallback','client') null
  created_at / updated_at

outreach_tokens                                   -- one row = one screening link = one candidate on one request
  id                uuid pk
  request_id        uuid not null → requests(id) on delete cascade
  expert_id         text not null                 -- see above; cross-request key
  expert_email      text                          -- lowercased; staff-only; null when unknown
  expert_snapshot   jsonb not null default '{}'   -- { name, headline, background: [{company, role, dates}] }
  token_hash        text not null unique          -- sha256(raw token); raw token is never stored
  expires_at        timestamptz not null          -- = requests.deadline at mint
  submitted_at      timestamptz                   -- single use
  revoked_at        timestamptz
  call_requested_at timestamptz                   -- client action "Request call"
  rate_accepted     boolean                       -- submission-level answers (one per link, not per objective)
  rate_ask          integer                       -- EXPERT-side $/hr when not accepted; staff-only raw
  availability      text check in ('this_week','next_week','later') null
  created_by        uuid → profiles(id) on delete set null
  created_at
  idx (request_id, created_at), idx (expert_id)

screening_responses
  id           uuid pk
  token_id     uuid not null → outreach_tokens(id) on delete cascade
  objective_id uuid not null → objectives(id) on delete cascade
  request_id   uuid not null → requests(id) on delete cascade     -- denormalised for indexing
  expert_id    text not null                                        -- denormalised for cross-request queries
  answer       text not null check in ('yes','no','unsure')
  proof_text   text check (length ≤ 400)                            -- required by the app when answer = 'yes'
  created_at
  unique (token_id, objective_id); idx (request_id, objective_id, answer); idx (expert_id)

call_outcomes                                     -- stage 5
  id           uuid pk
  request_id   uuid not null → requests(id) on delete cascade
  token_id     uuid not null → outreach_tokens(id) on delete cascade
  objective_id uuid not null → objectives(id) on delete cascade
  expert_id    text not null
  outcome      text not null check in ('answered','partial','unanswered')
  marked_by    uuid → profiles(id) on delete set null
  created_at / updated_at
  unique (token_id, objective_id); idx (expert_id)
```

RLS: enabled on all five, **no policies** (service-role only). Comments on every table. Idempotent (`create table if not exists`, `do $$ … if not exists (pg_constraint)`, `drop policy if exists` not needed). Stage-5 queries documented in the migration header:

- gap re-match: `select distinct t.* from screening_responses r join outreach_tokens t on t.id = r.token_id where r.request_id = $1 and r.answer = 'yes' and r.objective_id in (select objective_id from call_outcomes where token_id = $2 and outcome = 'unanswered')`
- reliability per expert: claimed = count(answer='yes') from screening_responses by expert_id; delivered = count(outcome='answered') from call_outcomes by expert_id, joined on (token_id, objective_id).

## Types (types.ts, "Screening flow" section)

```ts
export type ScreeningRequestStatus = 'draft' | 'approved' | 'closed';
export interface ScreeningTargeting { targetCompanies?: string[]; seniority?: string; function?: string; tenureWindow?: string; geography?: string; exclusions?: { companies?: string[]; experts?: string[] } }
export type ScreeningItemSource = 'model' | 'fallback' | 'client';
export interface ScreeningObjective { id; requestId; position; objectiveText; stem: string|null; proofPrompt: string|null; clientEdited: boolean; source: ScreeningItemSource|null }
export interface ScreeningRequest { id; organizationId; ownerId; ownerEmail; status; topicStatement; targeting; callCount; deadline (ISO); clientRate; callLengthMin; approvedAt: ISO|null; createdAt; updatedAt; objectives: ScreeningObjective[] }
export interface ScreeningRequestSummary { id; status; topicStatement; objectiveCount; respondentCount; submittedCount; deadline; createdAt; updatedAt }
export type ScreeningAnswer = 'yes' | 'no' | 'unsure';
export type ScreeningAvailability = 'this_week' | 'next_week' | 'later';
export interface ExpertBackgroundLine { company: string; role: string; dates: string }
export interface ExpertSnapshot { name: string; headline: string; background: ExpertBackgroundLine[] }
export interface ScreeningResponse { objectiveId; answer; proofText: string|null }
export type CallOutcomeValue = 'answered' | 'partial' | 'unanswered';
export interface CallOutcome { objectiveId; outcome: CallOutcomeValue }
export interface ScreeningCandidate { id; requestId; expertId; expertEmail: string|null; snapshot: ExpertSnapshot; expiresAt; submittedAt: ISO|null; revokedAt; callRequestedAt; rateAccepted: boolean|null; rateAsk: number|null; availability: ScreeningAvailability|null; createdAt; responses: ScreeningResponse[]; outcomes: CallOutcome[] }
export interface Coverage { yes: number; total: number; ratio: number }
```

Wire views (what routes return; built field by field, never by spreading a row):

```ts
RespondentView   = { id, label: 'Candidate N', name?, email?, headline, background, expiresAt, submittedAt, revokedAt, callRequestedAt,
                     coverage: Coverage|null, rate: { accepted: boolean, clientRate: number, expertAsk?: number }|null,
                     availability, answers: ScreeningResponse[], outcomes: CallOutcome[] }
                     // name / email / expertAsk ONLY for role 'admin'
ScreeningRequestView = ScreeningRequest & { respondents: RespondentView[], canEdit: boolean, isAdmin: boolean }
```

## Modules

- `lib/hmacToken.ts` — add purpose `'screening'` (detached, base64url, minSecretLength 32). Existing formats untouched; scripts/test-hmac-tokens.ts must stay green.
- `lib/screeningToken.ts` — `generateScreeningToken(tokenId, requestId, expiresAtMs)` → `{ token, tokenHash, expiry }`; `verifyScreeningToken(raw)` → `{ ok, data: { tokenId, requestId, expiry } } | { ok: false, reason }`; `hashScreeningToken(raw)`. Payload `${tokenId}:${requestId}:${expiry}:${nonce}`.
- `lib/screeningCoverage.ts` — pure: `computeCoverage(responses)`, `coverageBand(ratio)` → `'green'|'amber'|'red'`, `sortRespondents`.
- `lib/screeningValidation.ts` — pure: `validateIntakeInput(body)` (topic 1..300 chars; objectives 3..6 each 1..500 chars, trimmed, blanks dropped; targeting arrays ≤ 30 entries ≤ 120 chars each; callCount 1..50; deadline ISO date 1..90 days out, default +14d; clientRate on the $50 grid ≥ 100 default 1300; callLengthMin ∈ {30,45,60}); `validateObjectiveEdits(body)`; `validateScreeningSubmission(body, objectiveIds)`; `validateCandidateInput(body)`.
- `lib/screeningItems.ts` — the LLM step. `SYSTEM_PROMPT` with the hard constraint; `generateScreeningItems({ topic, objectives })` (one Anthropic call, JSON out, fence-stripped, per-item validation); `proofPromptViolation(text): string|null` (pure, exported); `fallbackItem(objectiveText)` (deterministic, always passes the validator); one regeneration round for items that fail, then fallback. Never logs objective text. Model constant `SCREENING_MODEL = 'claude-opus-5'`; API key `ANTRHOPICKEYREAL` (existing env; 503 when absent).
- `lib/requestStore.ts` — Supabase store + in-memory dev fallback (same shape as lib/projectStore.ts): `createRequest`, `getRequest`, `getRequestForUser(id, email, role)` (owner or admin, else null), `listRequestsForUser`, `updateObjectiveItems(requestId, items, source)`, `approveRequest`, `addCandidate`, `getCandidateByTokenHash`, `submitScreening(tokenId, …)` (conditional on `submitted_at is null`), `requestCall`, `revokeCandidate`, `recordOutcomes`, `listCandidates`. Never logs topic, objectives, names, emails, proof text.
- `lib/screeningEmail.ts` — `sendScreeningLinkEmail({ to, link, topic, firmPhrase, expertRate, callLengthMin, deadline })` via Resend directly (pattern: lib/sendAvailabilityRequest.ts): DISABLE_EMAILS → held, `isSuppressed` → held, footer from buildOutreachFooter, From from getFromAddress. Never logs the address or the link.
- `lib/rateLimiter.ts` — add `checkScreeningGenerateLimit(store, userEmail)`: 10 per user per hour, keys HMAC'd like `checkDraftLimits`.
- `lib/productEvents.ts` — add types `request_created`, `screening_set_generated` (payload.source), `screening_set_approved`, `screening_link_minted`, `screening_submitted` (payload.yes, payload.total), `call_requested`.
- `lib/supabase/database.types.ts` — the five tables + row aliases.
- `middleware.ts` — `'/s/'` and `'/api/s/'` in PUBLIC_PREFIXES with a comment each.

## Routes

| Route | Guard | Notes |
| --- | --- | --- |
| `GET /api/requests` | routeAuthGuard + guardReadRequest | `{ requests: ScreeningRequestSummary[] }` for the caller (admins: all) |
| `POST /api/requests` | routeAuthGuard + guardMutatingRequest | intake; 201 `{ request }`; 400 `{ error:'invalid_input', field, message }` |
| `GET /api/requests/[id]` | same | 404 when not owner/admin; `{ request: ScreeningRequestView }` |
| `PATCH /api/requests/[id]` | same | `{ objectives: [{ id, stem, proofPrompt }] }`; draft only (409 `request_not_draft`); flips `client_edited` + `source:'client'` when text changed |
| `POST /api/requests/[id]/generate` | same + `checkScreeningGenerateLimit` | draft only; 503 `service_unavailable` (no key); 429 `rate_limited`; 200 `{ request, generation: { source: 'model'|'fallback', reason? } }` |
| `POST /api/requests/[id]/approve` | same | 409 not draft; 422 `incomplete_items` `{ objectiveIds }`; 422 `screen_blocked` `{ findings: [{ objectiveId, field, kind, match, hint }] }` (kinds: client_firm_name, email, url, scheduling_link, phone only); 200 `{ request }` |
| `POST /api/requests/[id]/tokens` | adminGuard | approved only (409 `request_not_approved`); body `{ name, headline, background[], email?, send? }`; 201 `{ respondent, link, sent, held? }`; deadline passed → 409 `deadline_passed` |
| `POST /api/requests/[id]/tokens/[tokenId]/revoke` | adminGuard | `{ respondent }` |
| `POST /api/requests/[id]/tokens/[tokenId]/request-call` | owner or admin | 409 `not_submitted`; idempotent; `{ respondent }` |
| `POST /api/requests/[id]/tokens/[tokenId]/outcomes` | owner or admin | 409 `call_not_requested`; body `{ outcomes: [{ objectiveId, outcome }] }`; upsert; `{ respondent }` |
| `GET /api/s/[token]` | public, rate limited 20/10 min per token hash (fail open) | 410 `{ error:'expired' }` for every dead reason; 200 `{ topic, expertRate, callLengthMin, firmPhrase, deadline, items:[{id, stem, proofPrompt}], state:'open'|'submitted' }` |
| `POST /api/s/[token]` | public, same limit | body `{ answers, rateAccepted, rateAsk?, availability }`; 400 invalid; 409 `already_submitted`; 410 expired; 200 `{ coverage }` |

Guard order in every `/api/requests/[id]*` handler: kill switch/auth/content-type → `getRequestForUser` (404) → status checks (409) → validation (400/422) → write. Admin-only routes run `adminGuard` first and still 404 on a missing request.

## Pages and components

- `app/requests/page.tsx` — list (client component fetching `/api/requests`): loading skeleton, error with retry, empty state, "New request" button, rows link to `/requests/[id]`. In-app header identical in shape to app/app/page.tsx (EXPERTMATCH mark, Requests, Projects, Settings, Sign out). Add a "Requests" link to the header in app/app/page.tsx.
- `app/requests/new/page.tsx` — intake. Required: topic (one line), 3–6 objective rows (add/remove, min 3 max 6, enter-to-add). Collapsed "Add targeting details (optional)" `<details>`: tag inputs (target companies, exclusions: companies, previously-used experts), text fields (seniority, function, tenure window, geography), call count, deadline (date input, default +14d), rate ($50 steps, default 1,300, shown as client-side, "includes ExpertMatch fee" is NOT written — founder feedback), call length (30/45/60). Submit → POST /api/requests → `router.push('/requests/[id]')`. Every error is a sentence; disabled+busy button while in flight.
- `app/requests/[id]/page.tsx` — one page, two states from `request.status`:
  - **draft** → `components/requests/ScreeningSetEditor.tsx`: on mount, if any objective lacks a stem, call `/generate` and show the generating state ("Turning your objectives into screening questions…", skeleton rows). Then each objective card: objective text (read-only), stem (editable inline), proof prompt (editable inline), "edited" tag when `clientEdited`; "Regenerate" (calls /generate again; confirms if there are client edits); "Approve screening set" (PATCH pending edits then POST /approve). Nothing sends until approved. 422 screen findings rendered next to the offending field.
  - **approved** → `components/requests/RespondentsTable.tsx`: table sorted by coverage desc (submitted first). Columns: coverage badge (`components/requests/CoverageBadge.tsx`, green/amber/red), background (company · role · dates lines), rate (client-side; "accepted"/"asked"), availability, action "Request call" (owner/admin; disabled until submitted; "Call requested" after). Expand row → per-objective breakdown: objective text, Yes/No/Unsure, verbatim proof for each Yes; when `callRequestedAt` is set, the stage-5 three-way control per objective ("After the call: answered / partial / unanswered") posting to `/outcomes`. Above the table a collapsed "Screening set" showing the approved stems. Below, admin-only `components/requests/InvitePanel.tsx`: add-candidate form → link shown once with a copy button, "Email it" when an address was given; list of pending links with expiry and "Revoke".
  - No model-generated scoring, ranking commentary or quality judgement anywhere. Coverage ratio and the expert's own words only. Never hide or filter a respondent based on a model output.
- `app/s/[token]/page.tsx` — thin server shell like app/schedule/[token]: verifies signature + expiry, renders `Expired` page for any dead link, else `components/ScreeningForm.tsx` (client) which fetches `GET /api/s/[token]`. Header: topic, expert-side rate, call length, "Asked by a mid-size PE firm". Body: every stem at once, each a Yes / No / Unsure segmented control (44 px targets, single column); Yes expands the proof prompt with a one-sentence textarea (required, ≤ 400 chars, counter); No/Unsure expand nothing. Then "Does $650/hr work for you?" (Yes / "I'd need $___"), then availability (This week / Next week / Later). Submit disabled until every item is answered and every Yes has a sentence. Success: "Thanks — N of M sent." Already submitted / expired: one honest page.

## Build order and gates

Each step ends with: `npx tsc --noEmit` clean, the step's offline script green, `npm run build:local` green (lead runs it), one commit.

1. **Schema + core** — migration, database.types, types.ts, hmacToken purpose, screeningToken, screeningCoverage, screeningValidation, requestStore (+ in-memory), productEvents types, `scripts/test-screening-core.ts`.
2. **Intake** — `/requests`, `/requests/new`, `GET|POST /api/requests`, header link.
3. **LLM + approval** — screeningItems, generate/patch/approve routes, `/requests/[id]` draft state, `scripts/test-screening-items.ts` (validator + parser + fallback, no network).
4. **Screening link** — screeningToken mint route + email, public GET/POST, `/s/[token]`, ScreeningForm, middleware prefixes, `scripts/test-screening-form.ts` (validation + single-use logic against the in-memory store).
5. **Review** — RespondentsTable, CoverageBadge, InvitePanel, request-call / outcomes / revoke routes, redaction test (`scripts/test-screening-redaction.ts`: a `user` view never carries name/email/rateAsk).

Final gate: all offline scripts green, build green, a local `next dev` run with `APP_AUTH_ENABLED` unset (in-memory store) driven end to end by `scripts/e2e-screening.ts`, docs updated (TASK_QUEUE, HANDOFF, ARCHITECTURE §4 table), push.

## Rules for builders

- Read CLAUDE.md first. Inspect the files this plan names before writing. Follow the existing style: comment headers that say what a module never logs, `Response.json` with `{ error: '<snake_case>' }` and a written `message` where a UI shows it, sentences not codes in the UI.
- No `any`. No `console.log`. No new dependencies. No placeholder UI.
- Every UI state: loading, error with retry, empty, success, disabled while busy, mobile.
- Do not run `next build` (the lead runs it once per step; concurrent builds clash). Run `npx tsc --noEmit 2>&1 | grep -v '^\.next/'` and your step's script.
- Do not commit. Report the files you touched and anything you deviated from.

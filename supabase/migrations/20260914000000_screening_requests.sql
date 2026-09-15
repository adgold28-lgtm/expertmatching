-- supabase/migrations/20260914000000_screening_requests.sql
--
-- ExpertMatch — Structured Request & Screening Flow. See
-- docs/SCREENING_FLOW_PLAN.md.
--
-- THE POINT. An expert network profits when a call under-delivers, because the
-- client books another one. This flow inverts that: before a call is booked,
-- the client sees which of their named learning objectives an expert says they
-- can speak to, in the expert's own words. Five tables hold it.
--
-- WHAT THIS CHANGES — five NEW tables, nothing existing is touched.
--
--   1. expert_requests    — a brief with learning objectives. Owned by one
--                           profile inside one organization. Carries the
--                           CLIENT-side hourly rate and the call length the
--                           screening header shows, and a deadline that is the
--                           expiry of every screening link minted for it.
--
--   2. objectives         — one row per learning objective, in the client's own
--                           words (`objective_text`), plus the generated
--                           first-person yes/no question (`stem`) and the
--                           sentence prompt that asks for ROLE and TIMEFRAME
--                           (`proof_prompt`). `model_stem` / `model_proof_prompt`
--                           keep what the model wrote even after a client edit,
--                           which is what makes template learning possible
--                           later. `source` says where the live text came from.
--
--   3. screening_tokens    — one row = one screening link = one candidate on one
--                           request. Named for what it is: the screening link
--                           (lib/screeningToken.ts, HMAC purpose 'screening'),
--                           not Matchy's reply token (lib/outreachToken.ts).
--                           The two never meet in code.
--
--                           The raw token is NEVER stored: `token_hash` is
--                           sha256(raw) and is the only handle the platform
--                           keeps. Revocation is `revoked_at`; single use is
--                           `submitted_at`; expiry is `expires_at`, stamped
--                           from requests.deadline at mint. The three
--                           submission-level answers (rate accepted, rate ask,
--                           availability) live here because they are answered
--                           once per link, not once per objective.
--
--   4. screening_responses — one row per (link, objective): yes / no / unsure,
--                           plus the expert's one sentence of proof when yes.
--                           `request_id` and `expert_id` are denormalised from
--                           the token row so the stage-5 queries below need no
--                           join back through screening_tokens.
--
--   5. call_outcomes      — stage 5. After a call, the client marks each
--                           objective answered / partial / unanswered. The data
--                           model ships now; the gap re-match and reliability
--                           products are queries over it, not code, and are
--                           written out below so nobody has to re-derive them.
--
-- EXPERT IDENTITY. There is no expert table and none is in scope, so
-- `expert_id` is text and is minted by lib/screeningValidation.normalizeExpertId:
--   'em:' + first 24 hex of sha256(lowercased email)   when an address is known
--   'anon:' + 12 random hex                            when it is not
-- That key is stable across requests for the same address, which is what makes
-- the cross-request queries below mean anything.
--
-- THE TWO STAGE-5 QUERIES (documented, not built)
--
--   Gap re-match — "who else already told us they can cover what this call
--   left unanswered", for request $1 after the call on token $2:
--
--     select distinct t.*
--       from screening_responses r
--       join screening_tokens t on t.id = r.token_id
--      where r.request_id = $1
--        and r.answer = 'yes'
--        and r.objective_id in (
--              select objective_id from call_outcomes
--               where token_id = $2 and outcome = 'unanswered');
--
--   Reliability per expert — claimed versus delivered, across every request the
--   expert has ever screened for:
--
--     select s.expert_id,
--            count(*) filter (where s.answer = 'yes')            as claimed,
--            count(*) filter (where c.outcome = 'answered')      as delivered
--       from screening_responses s
--       left join call_outcomes c
--              on c.token_id = s.token_id
--             and c.objective_id = s.objective_id
--      where s.answer = 'yes'
--      group by s.expert_id;
--
--   Both are served by idx_screening_responses_request_objective and the
--   expert_id indexes on both tables.
--
-- RLS. All five tables: RLS ENABLED, ZERO POLICIES — service-role only, the
-- pattern every table since 20260908000000 uses. The application reads and
-- writes through lib/requestStore.ts (service-role client, bypasses RLS), and
-- the route layer is what enforces owner-or-admin. Nothing here is reachable
-- from a browser session even with a valid JWT, which is what keeps the
-- expert's name, email address and expert-side ask out of a client's hands.
--
-- HOW TO APPLY
--   The Supabase CLI is not linked to this project. PASTE THIS WHOLE FILE INTO
--   THE SUPABASE STUDIO SQL EDITOR and run it, then verify with:
--       npx tsx scripts/verify-schema.ts
--   Idempotent (create table if not exists / create index if not exists /
--   create or replace trigger) and safe to re-run. The check constraints are
--   written INLINE rather than in `do $$ … pg_constraint` blocks because every
--   table here is new: `create table if not exists` skips the whole statement,
--   constraints included, on a re-run. The earlier migrations use do-blocks
--   because they constrain columns added to tables that already existed.
--
-- ORDERING NOTE: apply this BEFORE deploying the screening-flow code. The
-- application does not tolerate these tables being absent the way
-- product_events is tolerated — a request cannot be stored anywhere else.

begin;

-- ═════════════════════════════════════════════════════════════════════════
-- 1. expert_requests — a brief with learning objectives
-- ═════════════════════════════════════════════════════════════════════════

create table if not exists public.expert_requests (
  id               uuid primary key default gen_random_uuid(),
  -- The account the request belongs to. Cascade: an organization that is
  -- deleted takes its requests with it.
  organization_id  uuid not null references public.organizations(id) on delete cascade,
  -- The one person who can read and edit it (plus platform admins). RESTRICT,
  -- not cascade: a request must never be silently orphaned by a profile delete.
  owner_id         uuid not null references public.profiles(id) on delete restrict,
  status           text not null default 'draft'
                     check (status in ('draft','approved','closed')),
  -- One line, the client's own words. Shown to the expert verbatim, so the
  -- compliance screen (lib/matchyScreen.ts) runs over it at approval.
  topic_statement  text not null check (char_length(topic_statement) <= 300),
  -- ScreeningTargeting (types.ts): targetCompanies[], seniority, function,
  -- tenureWindow, geography, exclusions { companies[], experts[] }. Staff-
  -- facing sourcing hints — never shown to an expert.
  targeting        jsonb not null default '{}'::jsonb,
  call_count       integer not null default 1
                     check (call_count >= 1 and call_count <= 50),
  -- No SQL default on purpose: the application sets it (now + 14 days by
  -- default, 1..90 days from lib/screeningValidation.validateIntakeInput), and
  -- a row whose deadline was silently defaulted by the database would mint
  -- links with an expiry nobody chose. It is the outreach-link expiry and
  -- nothing else — it does not close the request.
  deadline         timestamptz not null,
  -- CLIENT-side whole dollars per hour, on the $50 grid (lib/pricing.
  -- isValidClientRateUsd). The expert is shown expertRateFor(client_rate) and
  -- the two numbers never share a message (docs/MATCHY_SPEC.md).
  client_rate      integer not null default 1300
                     check (client_rate >= 100 and client_rate % 50 = 0),
  call_length_min  integer not null default 60
                     check (call_length_min in (30,45,60)),
  -- Set once, when the client approves the screening set. After that the set
  -- is frozen and links may be minted.
  approved_at      timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.expert_requests is
  'A structured research request: one topic statement plus 3-6 learning '
  'objectives the client wants an expert to be able to speak to. Service-role '
  'only (RLS enabled, no policies) — access is owner-or-platform-admin, '
  'enforced in lib/requestStore.getRequestForUser. client_rate is the '
  'CLIENT-side hourly number; deadline is the expiry stamped onto every '
  'screening link minted for this request.';

-- The two list views: an organization's requests, and one owner's requests.
create index if not exists idx_expert_requests_org_created
  on public.expert_requests (organization_id, created_at);
create index if not exists idx_expert_requests_owner_created
  on public.expert_requests (owner_id, created_at);

-- ═════════════════════════════════════════════════════════════════════════
-- 2. objectives — one learning objective, and the question it became
-- ═════════════════════════════════════════════════════════════════════════

create table if not exists public.objectives (
  id                 uuid primary key default gen_random_uuid(),
  request_id         uuid not null references public.expert_requests(id) on delete cascade,
  -- 0-based display order. Unique per request, so a reorder is a real write
  -- and two rows can never claim the same slot.
  position           integer not null,
  -- The client's learning objective, verbatim. Never rewritten by the model.
  objective_text     text not null,
  -- The first-person yes/no question an expert answers. Null until generated.
  stem               text,
  -- The sentence prompt behind a Yes. Asks for ROLE and TIMEFRAME only — never
  -- for a number, a name or anything that would be confidential. Null until
  -- generated.
  proof_prompt       text,
  -- What the MODEL wrote, kept even after the client edits the live text. This
  -- pair is the training signal for better templates; it is never shown to an
  -- expert and never shown to the client.
  model_stem         text,
  model_proof_prompt text,
  client_edited      boolean not null default false,
  -- Where the live stem/proof_prompt came from. Null while ungenerated.
  source             text check (source is null or source in ('model','fallback','client')),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  unique (request_id, position)
);

comment on table public.objectives is
  'One learning objective on a request, in the client''s words, plus the '
  'first-person yes/no stem and the proof prompt generated from it. '
  'model_stem / model_proof_prompt preserve what the model wrote after a client '
  'edit. Service-role only (RLS enabled, no policies).';

-- No separate index: `unique (request_id, position)` above already builds the
-- btree on (request_id, position), which is also what a read of one request's
-- objectives uses.

-- ═════════════════════════════════════════════════════════════════════════
-- 3. screening_tokens — one screening link, one candidate, one request
-- ═════════════════════════════════════════════════════════════════════════
--
-- The screening link, not Matchy's reply token (see the header). The raw token
-- exists for exactly as long as it takes to put it in an email or on a staff
-- screen; only its sha256 is ever written here.

create table if not exists public.screening_tokens (
  id                uuid primary key default gen_random_uuid(),
  request_id        uuid not null references public.expert_requests(id) on delete cascade,
  -- 'em:<24 hex>' or 'anon:<12 hex>' — lib/screeningValidation.normalizeExpertId.
  -- The cross-request key every stage-5 query joins on. Not a FK: there is no
  -- expert table.
  expert_id         text not null,
  -- Lowercased. STAFF-ONLY: never leaves the server for a client role, because
  -- a client holding an expert's address is the anonymity boundary broken.
  -- Null when the link was handed over out of band.
  expert_email      text,
  -- { name, headline, background: [{ company, role, dates }] }. The client sees
  -- the background lines and the headline; `name` is admin-only.
  expert_snapshot   jsonb not null default '{}'::jsonb,
  -- sha256(raw token), hex. Unique so a mint collision is a database error
  -- rather than two candidates sharing a link.
  token_hash        text not null unique,
  -- Stamped from requests.deadline at mint. The signed token carries the same
  -- instant, so an expired link fails signature-side and storage-side alike.
  expires_at        timestamptz not null,
  -- Single use: the submit is conditional on this being null (lib/requestStore.
  -- submitScreening), which is what makes a double submit a no-op rather than a
  -- second set of answers.
  submitted_at      timestamptz,
  revoked_at        timestamptz,
  -- The client action. Idempotent: set once, never cleared.
  call_requested_at timestamptz,
  -- The three submission-level answers — one per link, not one per objective.
  rate_accepted     boolean,
  -- EXPERT-side whole dollars per hour when the expert did not accept. STAFF-
  -- ONLY raw; the client is shown clientRateFor(rate_ask).
  -- No range check: the 50..5000 bound is the SUBMISSION rule
  -- (lib/screeningValidation.validateScreeningSubmission), and staff must be
  -- able to correct a negotiated number without a migration.
  rate_ask          integer,
  availability      text check (availability is null or availability in ('this_week','next_week','later')),
  created_by        uuid references public.profiles(id) on delete set null,
  created_at        timestamptz not null default now()
);

comment on table public.screening_tokens is
  'One screening link: one candidate on one request. NOT the Matchy reply token '
  '(lib/outreachToken.ts) — this is lib/screeningToken.ts, HMAC purpose '
  '"screening". The raw token is never stored; token_hash is the only handle. '
  'Single use via submitted_at, revocable via revoked_at, expires at '
  'requests.deadline. expert_email and rate_ask are STAFF-ONLY. Service-role '
  'only (RLS enabled, no policies).';

create index if not exists idx_screening_tokens_request_created
  on public.screening_tokens (request_id, created_at);
create index if not exists idx_screening_tokens_expert
  on public.screening_tokens (expert_id);

-- ═════════════════════════════════════════════════════════════════════════
-- 4. screening_responses — one answer per (link, objective)
-- ═════════════════════════════════════════════════════════════════════════

create table if not exists public.screening_responses (
  id           uuid primary key default gen_random_uuid(),
  token_id     uuid not null references public.screening_tokens(id) on delete cascade,
  objective_id uuid not null references public.objectives(id) on delete cascade,
  -- Denormalised from the token row so the stage-5 queries index straight off
  -- this table. Written by lib/requestStore.submitScreening, never by a client.
  request_id   uuid not null references public.expert_requests(id) on delete cascade,
  expert_id    text not null,
  answer       text not null check (answer in ('yes','no','unsure')),
  -- The expert's own sentence, shown to the client UNSUMMARISED. Required by
  -- the application when answer = 'yes' and forced null otherwise
  -- (lib/screeningValidation.validateScreeningSubmission) — the database only
  -- bounds the length, because a 'no' with an explanation is data we would
  -- rather keep than reject.
  proof_text   text check (proof_text is null or char_length(proof_text) <= 400),
  created_at   timestamptz not null default now(),
  -- One answer per objective per link. The insert is all-or-nothing per
  -- submission, so this also catches a retry that raced the conditional update.
  unique (token_id, objective_id)
);

comment on table public.screening_responses is
  'One expert answer to one objective on one screening link: yes / no / unsure '
  'plus the expert''s own sentence of proof behind a yes. Negatives are kept '
  'deliberately — they are what makes gap re-matching work. request_id and '
  'expert_id are denormalised from screening_tokens for indexing. Service-role '
  'only (RLS enabled, no policies).';

-- Coverage for one request, and the gap re-match join.
create index if not exists idx_screening_responses_request_objective
  on public.screening_responses (request_id, objective_id, answer);
-- Everything this expert has ever claimed, across requests.
create index if not exists idx_screening_responses_expert
  on public.screening_responses (expert_id);

-- ═════════════════════════════════════════════════════════════════════════
-- 5. call_outcomes — stage 5: what the call actually delivered
-- ═════════════════════════════════════════════════════════════════════════

create table if not exists public.call_outcomes (
  id           uuid primary key default gen_random_uuid(),
  request_id   uuid not null references public.expert_requests(id) on delete cascade,
  token_id     uuid not null references public.screening_tokens(id) on delete cascade,
  objective_id uuid not null references public.objectives(id) on delete cascade,
  -- Denormalised, same reason as screening_responses: reliability is a query
  -- over expert_id across every request.
  expert_id    text not null,
  outcome      text not null check (outcome in ('answered','partial','unanswered')),
  -- The client or admin who marked it. SET NULL so a deleted account does not
  -- erase the reliability history.
  marked_by    uuid references public.profiles(id) on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  -- One verdict per objective per call; re-marking is an upsert on this key.
  unique (token_id, objective_id)
);

comment on table public.call_outcomes is
  'Stage 5: after a call, one verdict per objective — answered / partial / '
  'unanswered. Joined against screening_responses on (token_id, objective_id) '
  'it gives claimed-versus-delivered per expert, and against the yes answers of '
  'other candidates it gives the gap re-match (see the migration header). '
  'Service-role only (RLS enabled, no policies).';

create index if not exists idx_call_outcomes_expert
  on public.call_outcomes (expert_id);
create index if not exists idx_call_outcomes_request
  on public.call_outcomes (request_id, objective_id, outcome);

-- ═════════════════════════════════════════════════════════════════════════
-- 6. updated_at triggers
-- ═════════════════════════════════════════════════════════════════════════
--
-- public.set_updated_at already exists (20260831000000_supabase_cutover_
-- foundation.sql). screening_tokens and screening_responses have no updated_at:
-- a token's lifecycle is recorded as distinct stamps (submitted_at, revoked_at,
-- call_requested_at) and a response is written once and never edited.

create or replace trigger trg_expert_requests_updated
  before update on public.expert_requests
  for each row execute function public.set_updated_at();

create or replace trigger trg_objectives_updated
  before update on public.objectives
  for each row execute function public.set_updated_at();

create or replace trigger trg_call_outcomes_updated
  before update on public.call_outcomes
  for each row execute function public.set_updated_at();

-- ═════════════════════════════════════════════════════════════════════════
-- 7. Row level security — enabled everywhere, policies nowhere
-- ═════════════════════════════════════════════════════════════════════════
--
-- Deny-by-default for anon and authenticated. The service role bypasses RLS.
-- No policies are created for any of these tables on purpose — see the table
-- comments and the header. lib/requestStore.ts is the only path in.

alter table public.expert_requests            enable row level security;
alter table public.objectives          enable row level security;
alter table public.screening_tokens     enable row level security;
alter table public.screening_responses enable row level security;
alter table public.call_outcomes       enable row level security;

commit;

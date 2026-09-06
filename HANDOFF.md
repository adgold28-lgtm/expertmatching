# ExpertMatch — Session Handoff

**Written:** 2026-08-31 · **Branch:** `supabase-cutover` · **Status:** cutover complete and verified locally, not yet deployed

Read this together with `CLAUDE.md` (operating rules) and `TASK_QUEUE.md` (priorities).

---

## What happened this session

The stalled May–June Supabase migration was finished. Postgres is now the source
of truth for durable domain data, Supabase Auth is the only session mechanism,
and the dual-auth (HMAC cookie + scrypt) complexity is deleted.

Three things were fixed or built along the way that are **not** migration work:
expert-sourcing quality, a re-source bug, and brief document upload.

### The migration

The June draft migration (`20260608120000_gated_access_foundation.sql`) was
evaluated and **replaced**, not applied. It had eight defects — the significant
ones being nine tables modeling data the app does not have, no home for the data
it does have (the `Project` blob with its ~40-field `ProjectExpert` records), a
`search_results` integrity hole allowing cross-project inserts, a
`profiles_update_self` policy letting users rewrite their own email, and a
backfill that would have left every user unable to create anything (profiles but
no `organization_members` rows, while `projects_insert` requires org membership).

The replacement is `supabase/migrations/20260831000000_supabase_cutover_foundation.sql`
— 8 tables, all with writers, RLS from day one:

`organizations`, `profiles`, `organization_members`, `access_requests`,
`invites`, `projects`, `project_members`, `project_experts`

Decisions worth not re-litigating:

- **`projects.id` is `text`, 24-hex** (`encode(gen_random_bytes(12),'hex')`), not
  uuid — preserves the existing ID format so `ID_RE` and every route, outreach
  token, and availability token keep working unchanged.
- **`projects.brief` and `project_experts.data` are `jsonb`.** These are
  document-shaped aggregates read whole. Columns are promoted only for what gets
  filtered or sorted (`name`, `research_question`, `status`, timestamps,
  `owner_id`, `organization_id`). `types.ts` remains the source of truth for the
  blob shape. A 40-column table with 35 nullable columns would be worse.
- **Redis was narrowed, not deleted.** It keeps rate limits (`rl:*`,
  `login-rl:*`, `invite-rl:*`), caches (`cache:*`, `search:*`, `cpath:*`,
  `hedge:*`, `scrypt:*`), locks, and short-lived tokens (`invite-token:*`,
  `reply-token:*`). That is the correct end state, not a partial migration.
- **One acknowledged exception:** `expert-connect:{email}` (Stripe Connect
  account IDs, `lib/stripeConnect.ts`) is durable data still in Redis. Stripe
  Connect is backlog; it moves when that feature is built rather than adding a
  table with no writer.

The store swap used the existing seam — `lib/projectStore.ts` already had a
`ProjectStore` interface behind a factory, so a third implementation changed the
backend with **zero route changes**. `lib/firmStore.ts` got the same treatment
behind its existing exported function names.

**Deleted:** `lib/authPassword.ts`, `scripts/migrate-users-to-supabase.ts`,
`scripts/createUser.ts`, `scripts/hash-admin-password.ts`, and the
`ADMIN_EMAIL` + `ADMIN_PASSWORD_HASH` master-password login path (banned by
`CLAUDE.md`).

### Verification that was actually run

`scripts/smoke-cutover.ts` — **16/16 passing** against localhost. Covers admin
login, wrong-password rejection, session read, project create/re-read/list
durability, cross-user IDOR (API returns 404, list excludes it, and a direct
`anon`-key query with the intruder's JWT returns zero rows — proving RLS holds
independently of app-level checks), logout cookie sweep, and dead-session check.

Re-run any time with `npx tsx scripts/smoke-cutover.ts` (needs the dev server up).
It provisions and deletes its own throwaway user.

### The three non-migration fixes

1. **Sourcing quality.** `SEARCH_PROVIDER` was `scrapingbee` in `.env.local`
   while the better Exa integration sat unused with its key set — switched to
   `exa`. Separately, the value-chain-inference LLM call was capped at
   `max_tokens: 1800` while its required JSON needs more, so it truncated
   mid-object every time and sourcing silently ran in degraded mode
   (`vciAvailable:false`). Raised to 4000. Together these explain the "3 experts,
   none above 70, all from similar articles" complaint.
2. **Re-source bug.** `handleSourceExperts` saved the brief server-side but never
   synced the PUT response into parent React state, so `project.researchQuestion`
   stayed empty for the session and Re-source failed with "Query is required".
   Now calls `onSave`.
3. **Brief document upload (new feature).** `app/api/parse-brief/route.ts` +
   UI on the Brief step. Accepts PDF/TXT/MD (5 MB cap), extracts nine brief
   fields with Claude (native PDF reading — no new dependencies), fills the two
   visible fields, and persists the full set through the existing sanitizing PUT.
   Auth-gated, never logs document contents. Tested end-to-end with a synthetic
   PE brief; extraction was clean.

---

## Immediate next steps

### 1. Vercel environment variables — blocks everything else

In [Vercel → expertmatching → Settings → Environment Variables](https://vercel.com/adgold28-lgtms-projects/expertmatching/settings/environment-variables),
Production scope. Values match `.env.local`:

| Variable | Action |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | **Add** — almost certainly missing |
| `NEXT_PUBLIC_SUPABASE_URL` | Verify = `https://twiijjhulgpxaiavdgpo.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Verify = the `sb_publishable_...` value |
| `SEARCH_PROVIDER` | Set to `exa` so prod gets the sourcing fix |

The Vercel CLI token on this machine is expired, so this is a dashboard task for
the user, not something an agent can do.

### 2. Merge `supabase-cutover` → `main`

Do **step 1 first** — production will error on a missing service-role key.

The moment this deploys, production auth is Supabase-only. The login is
`ashergoldsteinbusiness@gmail.com` with the password in `SEED_ADMIN_PASSWORD`
(in `.env.local`). Any previously working credential stops working.

Note: local `main` is 15 commits behind `origin/main` (PR #35 was merged remotely
on 2026-08-31). Run `git checkout main && git pull` before merging locally, or
just open a PR and merge on GitHub.

### 3. Production smoke test

After deploy, run the equivalent of `scripts/smoke-cutover.ts` against
`expertmatch.fit`. Change `BASE` and use a throwaway account for the destructive
checks. Confirm login, project persistence, IDOR, and logout on the real domain.

### 4. Cleanup, once prod is confirmed healthy

- **Upstash is account-rate-limited.** Caching and login rate limiting are
  silently off (they fail open — the app works, just without them). Check the
  [Upstash console](https://console.upstash.com); likely a free-tier cap. Since
  Redis now only handles caches and rate limits, the free tier may be sufficient
  once legacy data is cleared.
- **Legacy Redis keys are dead weight.** `user:*`, `firm:*`, `firms:index`,
  `firm-users:*`, `project:*`, `projects:index`, `access-request:*`,
  `seat-request:*` are no longer read by anything. Safe to wipe after prod runs
  clean for a while. Nothing has been deleted yet.
- **Untracked files:** `.agents/` and `skills-lock.json` appeared from
  `npx skills add supabase/agent-skills`. Decide whether to commit
  `skills-lock.json` (pins skill versions) and gitignore `.agents/`.

---

## Gotchas — these cost time this session

- **Never run `npm run build` while the dev server is running.** Both write to
  `.next/` and the collision corrupts the dev server's chunks, producing an
  unstyled page and stale route errors. Symptom: `Cannot find module './8948.js'`.
  Fix: stop the server, `rm -rf .next`, restart. Use `npx tsc --noEmit` to
  type-check while the server runs.
- **Never log in and out as the user's own account in a test.** Supabase's
  `signOut()` revokes *all* sessions for that user, including their browser
  session. Provision a throwaway user via the service-role key instead — that is
  what `smoke-cutover.ts` does.
- **Verify `.env.local` after any manual edit.** Hand-editing mangled it twice
  this session (the Supabase URL was overwritten with the publishable key, and
  the publishable key line held an `sb_secret_` value — a real leak risk, since
  `NEXT_PUBLIC_*` is shipped to the browser). Check with
  `grep -oE '^[A-Z_]+' .env.local` and confirm no `NEXT_PUBLIC_*` var holds an
  `sb_secret_` value.
- **The Supabase CLI never got linked.** No `config.toml`, no DB connection
  string (the user does not have the DB password). The migration was applied by
  pasting the SQL into the Supabase Studio SQL editor. Future migrations either
  go the same route or need `supabase link` set up first. The service-role key in
  `.env.local` is enough for data operations via `@supabase/supabase-js`, just
  not for DDL.
- **`ANTRHOPICKEYREAL`** is the (misspelled) Anthropic API key env var. Not a
  typo to fix casually — it is referenced in several routes.

---

## Reference

- **Supabase project ref:** `twiijjhulgpxaiavdgpo` ·
  [dashboard](https://supabase.com/dashboard/project/twiijjhulgpxaiavdgpo)
- **Vercel project:** `expertmatching` (serves `expertmatch.fit`). **Never** touch
  the stale `expertmatch` Vercel project.
- **Platform admin:** `ashergoldsteinbusiness@gmail.com`, org "ExpertMatch"
- **Seed a new admin:** `npx tsx scripts/seed-admin.ts <email> --org-name <name>`
  (reads `SEED_ADMIN_PASSWORD` from `.env.local`)
- **Full plan and migration evaluation:**
  `~/.claude/plans/ok-can-u-evaluate-nifty-lagoon.md`

## After the deploy — where the product value is

`TASK_QUEUE.md` "NEXT" is untouched and is the real roadmap:

1. **Reply tracking** — per-expert status (Outreach Sent → Replied Yes →
   Scheduled → Completed → Billed). Highest value on the board.
2. Outreach generation with tone controls
3. Shareable shortlist link viewable without login
4. Expert sourcing pipeline improvements

Also open: the two onboarding stubs (calendar OAuth and Stripe billing are
placeholders — see TODOs in the route files), PR #34 (security/compliance/billing
integration, open since June), and ~26 open issues, mostly the numbered security
audit list. Issues #25, #30, and #31 (ownership checks, logout/session
expiration, IDOR) are substantively closed by this session's work and its smoke
test — worth closing them out with a link to `scripts/smoke-cutover.ts`.

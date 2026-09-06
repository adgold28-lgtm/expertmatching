# Matchy — the conversation layer

*Product spec / build framework. Draft 1, 2026-09-06. Supersedes the 3-email outreach autopilot (see `OUTREACH_BOT_AUDIT.md`).*

## The idea in one paragraph

A client bookmarks an expert from their matches. From that moment Matchy — ExpertMatch's agent — owns the expert relationship: it finds and verifies the expert's email, drafts the introduction for the client to approve, relays every message between the client's in-app inbox and the expert's ordinary email, screens each message so identities and contact details never cross the wall, summarizes every reply, keeps the pipeline stage current, and hands off to scheduling and billing when the two sides agree. The client never sees a raw email address; the expert never installs anything. The workflow collapses from **Brief → Source → Outreach → Screen → Deliver** to **Brief → Matches → Conversations**.

## Why this beats the current design

| Today | With Matchy |
|---|---|
| AI writes 3 cold emails on a timer; nobody reviews them | Human writes (with AI drafts); AI screens; nothing sends unapproved |
| Anonymity is cosmetic — parties can email directly by week two | Anonymity is structural — the relay is the only channel |
| "Find contact" is one click, one provider, take what you get | Matchy iterates providers, verifies, scores, retries on bounce |
| Replies are classified into 5 buckets and that's it | Replies are summarized in detail, stage updates itself |
| Counter-rates and conflicts dead-end in a panel | They are just messages in a thread, with Matchy suggesting a reply |
| Outreach + Screen are separate tabs with duplicated state | One thread per expert holds the whole relationship |

## Workflow

1. **Bookmark.** On a match card the client clicks *Save* (bookmark icon). Status → `bookmarked`. Matchy starts contact discovery in the background (server job, same QStash pattern as sourcing).
2. **Contact discovery (Matchy, autonomous).** Try in order: Hunter email-finder → Snov → domain-pattern inference from any verified colleague → Hunter/Snov verifier on each candidate. Score candidates; keep all with confidence. Result states: `found_verified`, `found_unverified`, `not_found`. **Never sends to more than one address.** Surfaces "Contact found · verified" or "Couldn't find a verified address — try LinkedIn InMail?" on the card.
3. **Introduction.** Client opens the thread. Matchy has pre-drafted the intro (facts only — no invented biography; research question generalized, no client name, rate stated as an opening position). Client edits or accepts → *Send*. Status → `contacted`.
4. **Relay.** Expert replies by email to `reply+<token>@expertmatch.fit`. Inbound webhook (Svix-verified) → strip quoted history + signature → Matchy screens → stored as a message → summary generated → classifier updates stage → client notified. Client replies in-app → Matchy screens → sent via Resend with the thread's reply-to token.
5. **Agreement.** Rate/availability/conflict questions are just conversation. When Matchy detects agreement (rate accepted + no conflict + intent to schedule), it offers *Schedule call* → existing availability/overlap/Zoom/ICS flow. Status → `scheduled`; identity reveals both ways per the anonymization rule.
6. **After the call.** Existing Zoom webhook → `completed` → auto-charge. The thread gets a final Matchy summary + the client's screening notes ("client-ready" decision lives here; the Screen tab is retired).

## Matchy's jobs (in priority order)

1. **Compliance screen** — both directions, before anything is stored or sent. Blocks or flags: phone numbers, personal/work email addresses, LinkedIn/Calendly/any scheduling URL, physical addresses, real names when the thread is pre-reveal, client firm name, "let's take this offline / connect directly." Response: hold the message, show the sender exactly what to remove. Deterministic regex first, LLM second; the LLM never gets to *approve* what regex blocked.
2. **Reply summary** — 2–4 sentences: intent, availability, rate position vs. ours, conflicts/NDAs, open questions, recommended next action. Stored on the message; shown in the thread and on the card.
3. **Stage tracking** — the existing classifier (`interested / declined / counter_rate / conflict / unclear`) maps to `ExpertStatus` and feeds the pipeline strip. Declined → global suppression list.
4. **Drafting** — intro draft, and suggested replies when the client opens the composer. Suggestions only.
5. **Contact discovery loop** — described above; runs without a human.

## Data model (additions)

- `conversation_messages`: `id uuid`, `project_id text`, `expert_id text`, `direction ('outbound'|'inbound')`, `author ('client'|'expert'|'matchy')`, `body_raw text` (inbound only, ciphertext), `body_clean text`, `summary text`, `intent text`, `screen_result jsonb` ({blocked: bool, findings: [...]}) , `resend_message_id text`, `created_at`. RLS: project-member read via `has_project_access(project_id)`, writes service-role only (the relay writes).
- `contact_candidates` (or a jsonb array on `ProjectExpert`): `{email, source, verificationStatus, confidence, checkedAt, bounced?}`. Start as jsonb on `ProjectExpert.contactCandidates` — no writer outside Matchy.
- `outreach_suppressions` (being added now): global do-not-contact.
- New `ExpertStatus` value: `bookmarked` (between `shortlisted` and `contact_found`). Pipeline stage helper (`lib/expertPipeline.ts`) gains it.
- Reply-to token: reuse `lib/outreachToken.ts` but per-thread, 180-day expiry, and the inbound route validates the sender against `contactEmail`.

## API surface

- `POST /api/projects/[id]/experts/[expertId]/bookmark` — sets `bookmarked`, enqueues discovery.
- `POST /api/jobs/contact-discovery` — QStash worker.
- `GET /api/projects/[id]/experts/[expertId]/messages` — thread (redacted per anonymization rules for non-admins).
- `POST /api/projects/[id]/experts/[expertId]/messages` — client sends; runs screen; 422 `message_blocked` with findings if held.
- `POST /api/inbound-email` — existing route, rewired: verify → match thread → clean → screen → store → summarize → classify → notify.
- `POST /api/projects/[id]/experts/[expertId]/messages/draft` — Matchy suggestion (intro or reply).
- Delete when live: `/api/email-sequence/trigger` email2/email3 paths, `scheduleNextEmail`, the auto-cadence.

## UI

- **Matches** (was Source): cards get a bookmark button; bookmarked cards show contact-discovery status and last-message summary.
- **Conversations** (replaces Outreach + Screen): left list of bookmarked experts with stage pill + unread dot; right pane = thread. Messages show author, time, body, and Matchy's summary card on inbound. Composer with "Ask Matchy for a draft," screen feedback inline, *Schedule call* CTA when Matchy detects agreement. Screening notes + "Mark client-ready" at the bottom of the thread after `completed`.
- **Dashboard sharing**: already covered by org membership + project collaborators; the Conversations pane respects the same access. Nothing new to build beyond an invite affordance.
- Pipeline strip stays and becomes the summary of Conversations.

## Phasing

**Phase 1 — Relay MVP (build after anonymization lands)**
Messages table, send/receive routes on the existing token plumbing, thread UI, regex compliance screen, Matchy summaries + stage updates, intro draft. Suppression + footer (in progress now). Retire Email 2/3 cadence.

**Phase 2 — Matchy discovery loop**
Bookmark action, discovery job across Hunter/Snov + verifier, bounce webhook from Resend to retry the next candidate, card status.

**Phase 3 — Polish**
LLM-assisted screen on top of regex, suggested replies, Schedule-call detection, retire the Screen tab into the thread, notifications (email digest to the client when an expert replies).

## Decisions taken (change if you disagree)

- Expert side stays email-only. No expert portal for messaging.
- Client side is in-app only. No "also email me the thread" in v1 (it reopens the leak).
- Identity reveal both ways at `scheduled`, not before.
- Rate in the intro is stated as an opening position, never as agreed.
- Matchy never sends anything on its own except the automated system messages (scheduling links, receipts), which contain no free text from an LLM.

## Risks

- Email cleaning (quoted history, signatures, HTML) is the messy engineering. Use a proven parser, test on real replies before launch.
- Deliverability: one sending domain, DKIM/SPF/DMARC must be right; suppression must be honored everywhere.
- Over-blocking: an aggressive screen that stops legitimate content ("my Calendly is…") will frustrate. Show findings, let the sender fix, never silently drop.
- Cost: one LLM call per inbound message (summary + classify in one prompt) — cheap; the discovery loop's provider API calls are the real spend, cap attempts per expert.

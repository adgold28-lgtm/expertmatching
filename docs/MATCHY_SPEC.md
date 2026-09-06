# Matchy — the conversation layer

*Product spec / build framework. **Draft 2**, 2026-09-06 — revised with founder feedback. Supersedes the 3-email outreach autopilot (see `OUTREACH_BOT_AUDIT.md`).*

## The idea in one paragraph

A client bookmarks an expert from their matches. From that moment Matchy — ExpertMatch's agent — owns the expert relationship: it finds the expert's email, sends a short intro asking whether they'd take a paid expert call with a firm of the client's type, follows up on a "yes" with the conflict/NDA questions and the rate, relays every message between the client's in-app inbox and the expert's ordinary email, screens each message so identities and contact details never cross the wall, summarizes every reply in plain language, keeps the pipeline stage current, proposes and books call times, and hands off to Zoom and billing. The client never sees a raw email address; the expert never installs anything. The workflow collapses from **Brief → Source → Outreach → Screen → Deliver** to **Brief → Matches → Conversations**.

## Principles (what keeps this from being a GPT wrapper)

1. **Verbs, not chat.** Every Matchy surface is a proposal that ends in a button (Send / Schedule / Accept / Use this). No open-ended text box in v1.
2. **Silent by default.** Matchy speaks when it has done something or needs a decision. Never a greeting, never filler.
3. **Plain status, no machinery.** "Address found for Scott. Not found for Priya." Never provider names, confidence scores, or how it got there. The *why* lives in an expandable activity log for staff, not in the client's face.
4. **Operator voice.** First person, short, specific. One dry line at most. A name and a small mark on its cards — no face, no bubble in the corner.
5. **Continuity is the companion.** It remembers every expert, every rate, every thing this client said no to. That's what makes it feel like someone.
6. **Transparent and reversible.** Every action is logged and undoable; every automated send has a per-project "review first" switch.
7. **Collect everything.** Every reply, rate, rejection reason, response time, and outcome is an event. The product gets sharper per client.

## Workflow

1. **Bookmark.** Client saves an expert from Matches. Status → `bookmarked`. Matchy starts contact discovery (server job).
2. **Contact discovery (Matchy, autonomous).** Tries the providers, verifies, picks one address. Never sends to more than one address; bounces trigger the next candidate. Client sees only: *"Address found for Scott."* or *"Couldn't find Priya — want me to keep trying / try LinkedIn?"*
3. **Intro (Matchy sends it — default auto, per-project review switch).** Short, anonymized, no rate, no client name:
   > *Subject: Paid expert call — {industry} question*
   > *Hi Scott — I'm reaching out on behalf of a {private equity firm / strategy consultancy / corporate strategy team} evaluating {generalized topic from the brief}. Given your background in {generalized descriptor fragment}, they'd value a 45–60 minute paid consultation. Would you be open to it? If so, I'll send the details.*
   Status → `contacted`. Matchy card in the thread: *"Sent Scott the intro. I'll let you know when he replies."*
4. **Follow-up on "yes" (Matchy drafts; sends automatically unless review switch is on).** Conflict/NDA questions + the rate ask — asked, never asserted:
   > *Glad to hear it. Three quick things before we schedule: (1) any NDAs or employer restrictions that would limit discussing {topic}? (2) any current involvement with companies in this space we should know about? (3) We compensate experts at ${expertRate}/hr, billed per minute — does that work for you? If so, I'll propose a couple of times.*
5. **Relay + summary.** Every expert email is verified, cleaned, screened, stored, summarized ("Interested. Free Tue/Thu afternoons ET. Wants $650 — you're offering $560. Possible NDA with a competitor."), and the pipeline stage updates. Client replies in-app; Matchy screens and sends.
6. **Rate negotiation.** Expert counters → Matchy summarizes and shows the client a decision card with the *client-side* numbers (see Pricing). Client picks; Matchy replies to the expert with the *expert-side* number. The two numbers never appear in the same message.
7. **Scheduling (Matchy's job).** Once conflicts are clear and the rate is agreed, Matchy proposes concrete times to the expert from the client's connected calendar ("Would Tue 2:00pm or Thu 4:00pm ET work?"), reads the expert's preference reply (free text — the existing parser), and books: Zoom meeting, ICS invites to both, status → `scheduled`, identity reveals both ways. The availability link is the fallback if the expert prefers to pick. The client can add preferences ("mornings only, not Fridays") to the thread and Matchy honors them.
8. **Call → billing.** Existing Zoom webhook → `completed` → auto-charge the **client rate**. Matchy wrap-up card: *"Call ran 47 min → $627 charged. Screening notes summarized — mark client-ready?"*

## Pricing rule (must be explicit everywhere)

ExpertMatch takes **30%**. Two numbers exist per engagement:
- `expertRate` — what the expert is offered and paid. Shown only to the expert and to staff. Tier defaults (founder, 2026-09-06) are **opening offers to the expert**: Mid $400 / Senior $650 / Executive $800. These replace the current `TIER_PRICING` expert numbers ($280 / $420 / $560).
- `clientRate = ceil(expertRate / 0.70 / 50) × 50` — what the client pays, rounded **up** to the next $50 (so $400 → $600, $650 → $950, $800 → $1,150). The rounding remainder is ExpertMatch margin; the effective take is 30–33%. Shown to the client everywhere (cards, decision cards, receipts) with "includes ExpertMatch fee." Opening client rates after rounding: $600 / $950 / $1,150.
- `clientRateMin` / `clientRateMax` — set by the client per project (in client-rate terms). Matchy negotiates only inside this band; tiers are rough estimates, the band is the rule.

Rules: the intro never mentions money; the follow-up asks the expert about `expertRate`; negotiation cards show the client `clientRate` (with the implied expert number visible only to staff); auto-billing charges `clientRate` (fixing the current code, which charges `expertRate`); payouts transfer `expertRate`. When an expert counters, Matchy converts: "Scott wants $650/hr → that's $950/hr for you; accept, or offer $600 ($850 to you)?"

## Matchy's jobs (priority order)

1. **Compliance screen** both directions — phone numbers, emails, LinkedIn/Calendly/any link, real names pre-reveal, client firm name, "let's connect directly." Hold + show what to remove. Regex first, LLM second; the LLM never overrides a regex block.
2. **Reply summary** — intent, availability, rate position (converted to the viewer's side), conflicts, next action. On the message and on the card.
3. **Stage tracking** — classifier → `ExpertStatus` → pipeline strip. Declined → global do-not-contact.
4. **Scheduling** — propose times from calendar overlap + stated preferences; book on confirmation.
5. **Drafting** — intro + follow-up templates filled from the brief; suggested replies on request.
6. **Contact discovery** — silent, bounded attempts, one send.
7. **Learning loop** — rejection reasons re-weight the next search; accepted/declined rates per tier and industry tune the opening position; descriptor phrasings that convert get reused. Surfaced to the client as one line: *"You've passed on 4 experts as too junior — I'm weighting VP+ operators next."*

## Data model (additions)

- `conversation_messages`: id, project_id, expert_id, direction, author (`client`|`expert`|`matchy`), body_raw (inbound, ciphertext), body_clean, summary, intent, screen_result jsonb, resend_message_id, created_at. RLS: project-member read via `has_project_access`; writes service-role only.
- `engagement_events` (the data asset): id, project_id, expert_id, org_id, type (`bookmarked`, `contact_found`, `contact_not_found`, `intro_sent`, `reply_received`, `intent_classified`, `rate_offered`, `rate_countered`, `rate_agreed`, `conflict_flagged`, `times_proposed`, `scheduled`, `completed`, `charged`, `rejected` (+reason), `client_ready`), payload jsonb (numbers, tiers, industries, timings — never free text with PII), created_at. Service-role write, admin read. Every Matchy action emits one.
- `contactCandidates` jsonb on `ProjectExpert`: [{email, source, verificationStatus, confidence, bounced}]. Staff-only.
- `ExpertStatus` gains `bookmarked` (after `shortlisted`); `lib/expertPipeline.ts` updated.
- `clientRate` becomes required on engagement start; `expertRate` derived. Tier defaults seeded from `TIER_PRICING` on bookmark.
- Per-thread reply-to token (180 days); inbound validates sender.

## API surface

- `POST /api/projects/[id]/experts/[expertId]/bookmark` → sets `bookmarked`, seeds rates from tier, enqueues discovery.
- `POST /api/jobs/contact-discovery` (QStash worker) → finds + verifies, then sends the intro unless the project's review switch is on (then it drafts and waits).
- `GET|POST /api/projects/[id]/experts/[expertId]/messages` — thread read (redacted per viewer) / client send (screened; 422 `message_blocked` with findings).
- `POST /api/inbound-email` — rewired: verify → thread → clean → screen → store → summarize + classify (one LLM call) → stage → emit events → maybe auto-follow-up / propose times.
- `POST /api/projects/[id]/experts/[expertId]/propose-times` → Matchy computes slots from calendar overlap + preferences and emails the expert.
- `POST .../messages/draft` → suggested reply.
- Retire: `/api/email-sequence/trigger` email2/email3, `scheduleNextEmail`, the cadence.

## UI

- **Matches** (was Source): bookmark button; bookmarked cards show a one-line Matchy status and the last summary.
- **Conversations** (replaces Outreach + Screen): left list of bookmarked experts with stage pill + unread dot; right pane = thread. Inbound messages carry Matchy's summary card; decision cards (rate, times) sit inline with buttons. Composer with "Ask Matchy for a draft"; screen feedback inline. After `completed`: notes + "Mark client-ready" at the bottom of the thread.
- **Matchy rail**: activity feed + proposals for the project, digest-style. Staff see the expandable "why" (provider, confidence, candidates); clients don't.
- **Digest email** to the client: replies overnight, decisions waiting, proposed times.
- Sharing: existing org membership + project collaborators; Conversations respects the same access.

## Phasing

**Phase 1 — Relay MVP.** Pricing rule (clientRate/expertRate everywhere, billing charges clientRate). `bookmarked` status + bookmark action. Messages + events tables. Intro + follow-up templates with auto-send and per-project review switch. Inbound rewired (verify → screen → summarize → stage → events). Thread UI + Conversations tab. Regex screen. Retire Email 2/3 cadence.

**Phase 2 — Matchy scheduling + discovery loop.** Propose-times from calendar overlap + preferences; book on confirmation; discovery job across providers with bounce retry; card statuses.

**Phase 3 — Learning + polish.** Rejection re-weighting into sourcing; rate tuning from events; LLM-assisted screen; suggested replies; digest; retire Screen tab into the thread.

## Decisions taken (change if you disagree)

- Intro and follow-up auto-send by default; "review first" is a per-project switch.
- Expert side is email-only; client side is in-app only.
- Identity reveals both ways at `scheduled`.
- Money is never in the intro; the follow-up asks, never asserts; the two rates never share a message.
- Matchy never free-writes to an expert without a human-approved draft or a template.

## Founder answers (2026-09-06)

1. **Firm type wording** — one word for type plus one for relative size, e.g. "a mid-size PE firm", "a boutique consulting firm", "a large law firm", "a family office". Needs `firmType` + `firmSize` on the organization (does not exist yet; capture at access request / org setup, admin-editable).
3. **Rates** — no fixed ranges per tier. Tier defaults are opening *expert* offers ($400 / $650 / $800); the client sets the min/max they are willing to pay per project and Matchy stays inside it. See Pricing rule.
4. **Minimum billable call** — 15 minutes. Calls shorter than 15 min bill as 15; per-minute above that.
6. **Digest cadence** — no digest in Phase 1. Matchy updates the thread and pipeline in real time when a reply arrives; a digest is a Phase 3 nicety.

2. **Review switch default** — auto-send. Bookmarking *is* the consent: the client knows a bookmark starts outreach, it costs them nothing, and the switch stays one click away. Bookmarking may also unlock slightly more expert detail than the sourcing card shows (decide the exact fields in Phase 1).
5. **Shared dashboard** — already built (`project_collaborators`, owner-only add, RLS-tested), so keep it. Phase 1 rule: only the project owner (or staff) can send to experts; collaborators are read-only. Not a build target.

## Risks

- Email cleaning (quoted history, signatures) is the messy engineering — test on real replies.
- Deliverability: single sending domain; DKIM/SPF/DMARC must be right; suppression honored everywhere.
- Over-blocking: the screen shows findings and lets the sender fix; never silently drops.
- Cost: one LLM call per inbound message; provider API calls in discovery are the real spend — cap attempts per expert.

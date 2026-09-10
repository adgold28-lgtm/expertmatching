# Matchy — the conversation layer

*Product spec / build framework. **Draft 3**, 2026-09-09 — Draft 2 plus the Matchy 2.0 amendments (the two-exit composer, summary-only threads, the per-expert rate, the rubric intro). Supersedes the 3-email outreach autopilot (see `OUTREACH_BOT_AUDIT.md`). The intro's contract is `OUTREACH_EMAIL_RUBRIC.md`.*

## The idea in one paragraph

A client bookmarks an expert from their matches. From that moment Matchy — ExpertMatch's agent — owns the expert relationship: it finds the expert's email, sends a short intro asking whether they'd take a paid expert call with a firm of the client's type, follows up on a "yes" with the conflict/NDA questions and the rate, relays every message between the client's in-app inbox and the expert's ordinary email, screens each message so identities and contact details never cross the wall, summarizes every reply in plain language, keeps the pipeline stage current, proposes and books call times, and hands off to Zoom and billing. The client never sees a raw email address; the expert never installs anything. The workflow collapses from **Brief → Source → Outreach → Screen → Deliver** to **Brief → Matches → Conversations**.

## Principles (what keeps this from being a GPT wrapper)

1. **Verbs, not chat.** Every Matchy surface is a proposal that ends in a button (Send / Schedule / Accept / Use this). The composer takes free text, but free text never acts: it goes to the expert only under a button that names them, or comes back from Matchy as one card (a line and a button) or one factual line. No transcript, no reply loop, no clarifying questions, no model-written answers. *(Amended 2026-09-09; Draft 2 read "No open-ended text box in v1.")*
2. **Silent by default.** Matchy speaks when it has done something or needs a decision. Never a greeting, never filler.
3. **Plain status, no machinery.** "Address found for Scott. Not found for Priya." Never provider names, confidence scores, or how it got there. The *why* lives in an expandable activity log for staff, not in the client's face. The same rule binds answers to the client: an "ask Matchy" answer names what happened and what is next, never how.
4. **Operator voice.** First person, short, specific. One dry line at most. A name and a small mark on its cards — no face, no bubble in the corner.
5. **Continuity is the companion.** It remembers every expert, every rate, every thing this client said no to. That's what makes it feel like someone. Its memory is the project record (threads, rates, passes, notes, nudges), never a chat log: nothing a client types to Matchy is stored.
6. **Transparent and reversible.** Every action is logged and undoable; every automated send has a per-project "review first" switch.
7. **Collect everything.** Every reply, rate, rejection reason, response time, and outcome is an event. The product gets sharper per client.

## Workflow

1. **Bookmark.** Client saves an expert from Matches. Status → `bookmarked`. Matchy starts contact discovery (server job).
2. **Contact discovery (Matchy, autonomous).** Tries the providers, verifies, picks one address. Never sends to more than one address; bounces trigger the next candidate. Client sees only: *"Address found for Scott."* or *"Couldn't find Priya — want me to keep trying / try LinkedIn?"*
3. **Intro (Matchy sends it — default auto, per-project review switch).** To the rubric in `OUTREACH_EMAIL_RUBRIC.md`: anonymized client, one real fact about the expert, the expert-side offer, one question:
   > *Subject: Expert in cold-chain distribution: compensated $800/hr for your time?*
   > *Dear Mark, / You ran distribution in the Southeast for Sysco for six years, so I think you'd be a great fit for my client. / They are a PE firm looking to understand cold-chain economics, and they want to compensate you $800/hr for 15 to 60 minutes of your time. This wouldn't be anything proprietary and should stay relatively broad. Does this sound interesting to you? / Asher*
   Four trial arms vary the subject (price or not) and the money framing (hourly or flat). When Matchy cannot write the personal line from the evidence, the intro is held for staff (`introNeedsWhyThem`). Status → `contacted`. Matchy card in the thread: *"Sent Mark the intro. I'll let you know when he replies."*
4. **Follow-up on "yes" (Matchy drafts; sends automatically unless review switch is on).** Conflict/NDA questions + the rate ask — asked, never asserted:
   > *Glad to hear it. Three quick things before we schedule: (1) any NDAs or employer restrictions that would limit discussing {topic}? (2) any current involvement with companies in this space we should know about? (3) We compensate experts at ${expertRate}/hr, billed per minute — does that work for you? If so, I'll propose a couple of times.*
5. **Relay + summary.** Every expert email is verified, cleaned, screened, stored, summarized ("Interested. Free Tue/Thu afternoons ET. Wants $650 — you're offering $560. Possible NDA with a competitor."), and the pipeline stage updates. Client replies in-app; Matchy screens and sends.
6. **Rate negotiation.** Expert counters → Matchy summarizes and shows the client a decision card with the *client-side* numbers (see Pricing). Client picks; Matchy replies to the expert with the *expert-side* number. The two numbers never appear in the same message.
7. **Scheduling (Matchy's job).** Once conflicts are clear and the rate is agreed, Matchy proposes concrete times to the expert from the client's connected calendar ("Would Tue 2:00pm or Thu 4:00pm ET work?"), reads the expert's preference reply (free text — the existing parser), and books: Zoom meeting, ICS invites to both, status → `scheduled`, identity reveals both ways. The availability link is the fallback if the expert prefers to pick. The client can add preferences ("mornings only, not Fridays") to the thread and Matchy honors them.
8. **Call → billing.** Existing Zoom webhook → `completed` → auto-charge the **client rate**. Matchy wrap-up card: *"Call ran 47 min → $627 charged. Screening notes summarized — mark client-ready?"*

## Pricing rule (must be explicit everywhere)

ExpertMatch takes **50%** of the call (founder, 2026-09-06; was 30%). Two numbers exist per engagement:
- `expertRate` — what the expert is offered and paid. Shown only to the expert and to staff. Tier defaults (founder, 2026-09-06) are **opening offers to the expert**: Mid $400 / Senior $650 / Executive $800. These replace the current `TIER_PRICING` expert numbers ($280 / $420 / $560).
- `clientRate = ceil(expertRate / 0.50 / 50) × 50` — what the client pays, rounded **up** to the next $50. Shown to the client everywhere (cards, decision cards, receipts) with "includes ExpertMatch fee." Opening client rates: $800 / $1,300 / $1,600 (rounding only fires on odd counter-offers, e.g. expert asks $675 → client $1,350).
- `clientRateMin` / `clientRateMax` — set by the client per project (in client-rate terms). Matchy negotiates only inside this band; tiers are rough estimates, the band is the rule. The band is the default and the limit: each engagement carries its own `clientRate` inside it, seeded from the tier at bookmark and changeable by the owner from the thread (`PUT …/experts/[id] { clientRate }`, $50 steps) until the rate is agreed (`rateAgreedAt`), after which it is locked. The expert-side figure is derived in the same write.

Rules: the intro names the expert-side opening offer and asks whether it works (`OUTREACH_EMAIL_RUBRIC.md`; Draft 2 kept money out of the intro); the follow-up confirms `expertRate` and asks the conflict questions; negotiation cards show the client `clientRate` (with the implied expert number visible only to staff); auto-billing charges `clientRate` (fixing the current code, which charges `expertRate`); payouts transfer `expertRate`. When an expert counters, Matchy converts: "Scott wants $650/hr → that's $1,300/hr for you; accept, or offer $600 ($1,200 to you)?"

## Seat pricing (founder, 2026-09-06)

Per-seat monthly subscription, every active seat billed at the tier the org's seat count falls in:

| Active seats | Per seat / month |
| --- | --- |
| 1–5 | $250 |
| 6–20 | $200 |
| 21+ | Talk to us |

Rationale: ~4,100 US PE firms average ~8 employees, so nearly every account is 1–10 seats; comparables (AlphaSense, Tegus) run $10k–$20k/seat/yr. The seat fee filters tire-kickers and covers sourcing; calls carry the margin. The implementation already exists on `origin/claude/multi-account-rls-billing-imi3la` (`lib/pricing.ts`, tiered Stripe Price, org-admin team page) with the old $100→$60 table — merge it and replace the table. The live `/pricing` page still shows the retired $1,500/$3,500 flat plans.

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
- `POST .../messages/draft { instruction }` → one suggested reply (≤3 sentences, ≤320 chars): the instruction is screened client→expert before any model call, the output is brevity-capped, screened and identity-checked (refused, never repaired), and it lands in the composer; the route never sends and never stores. Rate-limited per user and per project.
- `PUT .../experts/[expertId] { clientRate }` → the owner's rate for one engagement, on the $50 grid, inside the band, refused once agreed (409 `rate_locked`); both rate fields written together.
- Retire: `/api/email-sequence/trigger` email2/email3, `scheduleNextEmail`, the cadence.

## UI

- **Matches** (was Source): bookmark button; bookmarked cards show a one-line Matchy status and the last summary.
- **Conversations** (replaces Outreach + Screen): left list of bookmarked experts with stage pill + unread dot; right pane = thread. Inbound messages ARE Matchy's summary card (intent, availability, rate position in the client's numbers, conflicts, the ask); the email body never renders for a client, staff read it in the Staff panel. Decision cards (rate, times) sit inline with buttons. Under the header, the owner's rate for this expert, editable until agreed. One composer, two exits: "Send to {first}" relays as written (screened, verbatim, owner-only, held in walkthrough); "Ask Matchy" returns one card above the buttons: a factual line from the record, Matchy's summary of a reply, a proposal for an existing verb with its existing button, or a draft (`POST …/messages/draft`) that lands in the composer behind "Use this". Matchy's cards are not messages and are not stored. Screen feedback inline on either. Under the settings strip, one "waiting on you" line with the decisions open across the project. After `completed`: notes + "Mark client-ready" at the bottom of the thread.
- **Matchy rail**: replaced in 2.0 by the "waiting on you" line and the composer's cross-project answers ("who hasn't replied?"). A persistent feed and the digest remain Phase 3. Staff "why" (provider, confidence, candidates) stays in the thread's Staff panel; clients never see it anywhere.
- **Digest email** to the client: replies overnight, decisions waiting, proposed times.
- Sharing: existing org membership + project collaborators; Conversations respects the same access.

## Phasing

**Phase 1 — Relay MVP.** Pricing rule (clientRate/expertRate everywhere, billing charges clientRate). `bookmarked` status + bookmark action. Messages + events tables. Intro + follow-up templates with auto-send and per-project review switch. Inbound rewired (verify → screen → summarize → stage → events). Thread UI + Conversations tab. Regex screen. Retire Email 2/3 cadence.

**Phase 2 — Matchy scheduling + discovery loop.** Propose-times from calendar overlap + preferences; book on confirmation; discovery job across providers with bounce retry; card statuses.

**Phase 2.5 — Matchy 2.0 (built 2026-09-09).** The two-exit composer with deterministic answers and verb cards; `POST …/messages/draft`; summary-only expert messages; the per-expert rate; the rubric intro with four trial arms; the "waiting on you" line.

**Phase 3 — Learning + polish.** Rejection re-weighting into sourcing; rate tuning from events; LLM-assisted screen; suggested replies; digest; retire Screen tab into the thread.

## Decisions taken (change if you disagree)

- Intro and follow-up auto-send by default; "review first" is a per-project switch.
- Expert side is email-only; client side is in-app only.
- Identity reveals both ways at `scheduled`.
- The intro names the expert-side opening offer and asks; the follow-up confirms it; the two rates never share a message.
- The box never sends on inference. Only a button carrying the expert's name puts text on the wire; a typed number becomes a rate only through the set-rate card, inside the band; a machine-written suggestion lands in the composer, never on a Send button; an unrecognised ask returns one quiet line, never a question.
- No model writes a client-facing answer. Answers are templates over the redacted record; the one model call a client can trigger from the composer is the draft, and its output is a proposal the client sends.
- A client never reads the expert's email. Matchy's summary is the whole of what crosses; staff keep the body.
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

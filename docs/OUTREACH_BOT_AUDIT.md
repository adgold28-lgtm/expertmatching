# Background check: the outreach & negotiation email bot

*Read-only audit of the `main` branch (b18f3b8), 2026-09-06. Findings are read from code, not observed in production traffic.*

## How it works in 10 sentences

1. A teammate finds an expert's email, types an hourly rate into the expert's card, and clicks "Send Email 1."
2. That call hits `/api/email-sequence/trigger`, which asks GPT-4o-mini to write a short cold email and sends it through Resend.
3. Email 1 names the expert, their employer, the client's research question **word for word**, and the hourly rate — but not the client's name.
4. Every outgoing email carries a `Reply-To` of `reply+<90-day-signed-token>@expertmatch.fit`, so replies come back to us tagged with the project and expert.
5. When a reply arrives, Resend posts it to `/api/inbound-email`, which sends the reply text to GPT-4o-mini to be classified as interested / declined / counter-rate / conflict / unclear.
6. "Interested" is the only intent that triggers action: the system queues Email 2 five to twelve minutes later.
7. Email 2 asks three conflict/NDA questions and states the rate as an agreed fact.
8. "Declined" ends the sequence; "counter-rate" and "conflict" park the expert in an amber/red panel for a human to decide.
9. Email 3 (reveal the client, send the scheduling link) exists in code but **nothing ever triggers it** — scheduling is only reached by a human clicking "Resend Scheduling Link," which sends a different, branded ExpertMatch email naming the project.
10. The bot never writes a reply back to an expert on its own, and never accepts a counter-rate on its own.

**Three things in this chain are almost certainly broken in production today** — see Risk register #1–#3.

## What the bot does alone vs. what waits for a human

| Event | Bot acts alone | Human required |
|---|---|---|
| Send Email 1 | — | Yes: click, plus a rate must be set (`OutreachCard.tsx:276-322`) |
| Write the email text | Yes — LLM writes it, nobody sees it before send | No review step exists |
| Reply classification | Yes (`replyDetection.ts:26-88`) | No |
| Reply = interested → send Email 2 | **Yes, automatically** (`inbound-email/route.ts:189-202`) | No |
| Reply = declined → stop | Yes (status `rejected_after_outreach`) | No |
| Reply = counter-rate | Records the number only | Yes — "Approve"/"Pass" (`OutreachCard.tsx:721-761`) |
| Reply = conflict | Records the note only | Yes — "Reject"/"Override" (`OutreachCard.tsx:764-789`) |
| Reply back to the expert | **Never** | Human, out of band |
| Reveal client / send scheduling link | Never fires | Yes — "Resend Scheduling Link" button |
| Mark complete + invoice | — | Yes, manual duration entry |

**The "Review before sending / Auto-send" toggle does nothing.** `outreachMode` is saved (`projectStore.ts:234`, `types.ts:354`) and rendered (`page.tsx:1012-1030`), but **no code path ever reads it**. Nothing is queued for approval in either mode; nothing is auto-sent in either mode.

## The emails it sends

**Email 1** (`emailSequence.ts:89-126`, temp 0.6): greets by first name, asks if they'd be open to a paid consulting call at `$X/hr, billed per minute` about the client's research question, plus "one specific sentence connecting their background at *[Company]* to the topic," soft close. No client name, no links, ≤100 words.

**Email 2** (`emailSequence.ts:128-167`, temp 0.5): thanks them for replying, then three numbered questions — conflicts/NDA, employer restrictions, and "Confirm: you are available at $X/hr billed per minute." Prompt instruction: *"State the rate as confirmed fact, not a question."*

**Email 3** (`emailSequence.ts:169-208`, temp 0.5): reveals the client firm, includes only the scheduling link, ends "Please keep this engagement confidential."

Claims that could be wrong or over-promise:

- **Email 1's "specific sentence" is invented.** The model only receives name, title, company, and the research topic — nothing about the person's actual work. There is no "do not make up details" guard in this prompt (the older manual-draft prompt does have one, `generate-outreach/route.ts:106`). A fabricated career detail sent to a sitting CFO is the single most embarrassing failure mode here.
- **Email 2 opens "thank you for your reply" and asserts the rate as settled** to anyone the classifier tagged "interested." "Interested, but what does it pay?" classifies as interested — they then receive an email telling them they already agreed to a number.
- **The client's research question is copied verbatim into a cold email to a stranger** (`trigger/route.ts:91`). Whatever the client typed as the brief question is now outside the wall.
- **Email 3's "client firm" is the project's name**, not a firm field: `const firmName = project.name; // project name serves as firm name context` (`trigger/route.ts:137`). If a project is named "Falcon — battery diligence," the email tells the expert the client firm is "Falcon — battery diligence."
- No email contains a physical address or unsubscribe line. "Billed per minute" and "expires in 7 days" both check out against the code.

## Risk register

| # | Sev | What goes wrong | Where | Fix |
|---|---|---|---|---|
| 1 | **High** | "Send Email 1" cannot work in production: the browser posts to a route that demands a valid QStash signature whenever `NODE_ENV=production`, so it returns 400 and no outreach ever starts. | `trigger/route.ts:42-56` vs `OutreachCard.tsx:288` | Split a session-authed `/api/outreach/start` from the QStash-only endpoint. |
| 2 | **High** | Inbound replies are almost certainly all rejected: the code HMACs the raw body with the secret as plain text, but Svix (what Resend uses) signs `id.timestamp.body` with a base64-decoded `whsec_` secret. Genuine webhooks 400; no timestamp/replay check either. | `inbound-email/route.ts:42-66,112-117` | Use the `svix` library's `Webhook.verify`. |
| 3 | **High** | Email 3 is unreachable — nothing calls `scheduleNextEmail` with `email3`; and if it did, the link would be dead, because the scheduling token's hash is discarded and never saved, while the landing page requires a stored hash match. | `trigger/route.ts:133`; `availability/[token]/page.tsx:71-73` | Persist `tokenHash` and add the email2→email3 transition. |
| 4 | **High** | The auto/review toggle is decorative — a founder believing they're in "Review" mode still has LLM-written mail leave the building unread. | `page.tsx:1012-1030`; unread in `trigger/route.ts` | Gate sending on `project.outreachMode === 'auto'`; otherwise queue a draft. |
| 5 | **High** | No unsubscribe link, no postal address, no cross-project do-not-contact list; someone who declines in one project is cold-emailed again from the next. CAN-SPAM exposure and reputational damage with senior people. | `emailSequence.ts:229-258`; status is per-`ProjectExpert` only | Add a footer with address + opt-out, and a global suppression list keyed on email. |
| 6 | **Med** | Multiple replies on one thread each schedule another Email 2 — no check on current status or on whether email2 already went out. An expert who answers twice gets the same "confirm your rate" mail twice. | `inbound-email/route.ts:189-202` | Skip if `email2SentAt` is set or status isn't `contacted`. |
| 7 | **Med** | "Approve" on a counter-rate is a dead end: it saves the rate and sets status back to `replied`, but nothing sends Email 2, and the PUT route silently drops `replyIntent` and `conflictNote` (they aren't in its allow-list) — so "Override — Continue" also leaves the conflict note on screen forever. | `OutreachCard.tsx:325-339, 781`; `experts/[expertId]/route.ts:68-219` | Have Approve call the sequence endpoint; allow-list the reply fields. |
| 8 | **Med** | Anyone replying to the tagged address is treated as the expert — the sender is never compared to `contactEmail`. A forwarded thread, an EA, or a colleague can decline, counter-rate, or advance the sequence. Tokens live 90 days and are reusable despite the "single-use" comment. | `outreachToken.ts:1-7`; `inbound-email/route.ts:129-183` | Check the `from` address; shorten expiry. |
| 9 | **Med** | Expert-written text goes into the classifier prompt with no delimiting, so an instruction embedded in a reply can force "interested" (→ another email) or "declined." It does **not** reach any email-writing prompt, which limits the blast radius. | `replyDetection.ts:29-47` | Wrap the reply in explicit delimiters and instruct the model to ignore instructions inside them. |
| 10 | **Med** | The rate fallback `pe.expertRate ?? 500` means a queued Email 2 quotes $500/hr if the rate was cleared — the UI's rate check only guards Email 1. Tier pricing (`TIER_PRICING`, 70/30 split) is display-only and never sets the rate; `agreedRate` is never written. | `trigger/route.ts:90`; `seniorityClassifier.ts:5-9` | Fail closed with no rate; wire tier pricing into `expertRate`. |
| 11 | **Low** | Inbound rate limiting fails open — if Upstash is down the `catch {}` continues, so an unlimited flood of webhook posts reaches the LLM classifier (spend, not data exposure). | `inbound-email/route.ts:97-105` | Fail closed with 503 on store failure. |
| 12 | **Low** | `DISABLE_EMAILS=true` silently no-ops every send while statuses still advance to "contacted" — a stuck flag looks like a working pipeline. | `emailSequence.ts:236-239` | Refuse to start in production, or surface a banner. |
| 13 | **Low** | Zoom title and the .ics both read `Expert Call — {project.name}`, and the client's email is an attendee — so the expert learns the client's identity from the calendar invite regardless of what Email 3 said. | `triggerOverlapCheck.ts:158,184-227` | Use a neutral title; consider not cross-listing attendees. |

Good news worth stating: no client-side rate, margin, or firm billing number appears in any expert-facing email; reply bodies, expert names, and emails are kept out of logs; tokens are HMAC-signed with constant-time comparison; the LLM never composes a reply to an expert.

## Quick wins (each ≤1 day)

1. **Fix the two signature bugs** (#1, #2) — swap to the `svix` library, and give the UI its own authed start endpoint. Nothing else in the machine matters until these work.
2. **Make the review toggle real** (#4) — read `outreachMode` in the trigger and, in review mode, save the draft instead of sending.
3. **Add a compliant footer + global suppression list** (#5) — postal address, one-click opt-out, and a permanent do-not-contact keyed on email address.
4. **Idempotency + sender check on inbound** (#6, #8) — refuse to schedule Email 2 if one already went out, and only act on replies from the address we mailed.
5. **Stop the model inventing biography** — add "Use only the facts given. Do not invent details about this person." to the Email 1 prompt, and change Email 2 to ask about the rate rather than assert it.

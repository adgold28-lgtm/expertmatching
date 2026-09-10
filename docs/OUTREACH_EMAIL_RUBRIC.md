# Expert Outreach — Email Rubric

*Founder spec, 2026-09-08. Applies to email one of the expert outreach sequence (the Matchy intro), whether a human or the template writes it. Supersedes the "money is never in the intro" decision in `MATCHY_SPEC.md`; that decision becomes "the intro names the expert-side opening offer; it is asked, not asserted; the two rates never share a message."*

## Purpose of email one

Get a yes/no answer. Nothing else. No scheduling, no agreement, no payment details. Those go in email two, after they've said yes.

The email has to do two things at once: state the money, and prove a real person sent it. Money alone reads as a scam. Do not split these across variants.

## Structure

**Subject line.** Format: `Expert in [specific domain]: compensated $[X]/hr for your time?`

- Domain must be specific to their actual experience, not the industry at large
- The number appears in the subject
- Colon, not em dash

**Salutation.** `Dear [First name],` then a line break.

**Line 1 — why them.** One sentence. Their role, company, and duration, followed by why that makes them a fit.

> You ran distribution in the Southeast for Sysco for six years, so I think you'd be a great fit for my client.

**Line 2 — the offer.** Who the client is, what they want to understand, the rate, the time range, the scope limit, and the question.

> They are a PE firm looking to understand cold-chain economics, and they want to compensate you $800/hr for 15 to 60 minutes of your time. This wouldn't be anything proprietary and should stay relatively broad. Does this sound interesting to you?

**Sign-off.** First name only: `Asher`. Full signature block below with real name, real email, LinkedIn link. Always sign as Asher.

## Hard rules

Never use an em dash. Anywhere in the body.

Banned phrases (all read as AI or mass-send):

- "I hope this finds you well"
- "I came across your profile"
- "I was impressed by"
- "reach out" / "circle back" / "touch base"
- "real feel for" / "how things actually work"
- "leverage," "insights," "space" as in "the fintech space"
- "Would love to" / "excited to"
- Anything in a list of three
- "As someone who has..."

Style constraints:

- Use contractions
- Vary sentence length; do not write three same-length sentences in a row
- Plain words over elevated ones: "think" not "believe," "about" not "regarding"
- Under 90 words in the body
- No bullet points, no bold, no headers

**Personalization.** The "why them" line must contain a fact only someone who read their background would know. A filled-in template slot is not personalization. If the sentence would still work with a different person's name and company swapped in, it fails.

## Scope and compliance language

State the limit as one clause inside the offer sentence, not as its own paragraph.

- Good: "This wouldn't be anything proprietary and should stay relatively broad."
- Bad: "Please note we do not seek confidential information or trade secrets."

Do not use the words "secrets," "NDA," "confidential," or "compliance." Naming the risk plants it.

## Rate presentation

Two valid options. Pick deliberately.

- Hourly (`$800/hr for 15 to 60 minutes`): honest, makes the short-call floor feel low-commitment. Risk: reader computes $200 for 15 minutes and disengages.
- Flat (`$800 for up to an hour, even if we only need 20 minutes`): removes the arithmetic, number feels larger for the same spend.

Whichever is chosen, no ambiguity in the money sentence. Confusion there reads as evasion.

## Reference email

```
Subject: Expert in cold-chain distribution: compensated $800/hr for your time?

Dear Mark,

You ran distribution in the Southeast for Sysco for six years, so I think you'd be a great fit for my client.

They are a PE firm looking to understand cold-chain economics, and they want to compensate you $800/hr for 15 to 60 minutes of your time. This wouldn't be anything proprietary and should stay relatively broad. Does this sound interesting to you?

Asher
```

## Trial arms (founder, 2026-09-08)

Run trial emails with the price in the subject or not. Every arm keeps the "why them" line and states the hourly rate in the body (hard rule above); the only variable is the subject line. (The flat "$X for up to an hour" body framing was dropped by the founder on 2026-09-10.) Record the arm in the `intro_sent` event payload; reply rate and positive-reply rate within four business days come from `reply_received` / `intent_classified`.

## Pre-send checklist

- Subject names a specific domain and includes the number
- Zero em dashes
- No banned phrases
- The "why them" line would break if you swapped in another person
- Body under 90 words
- Scope limit is one clause, not a paragraph
- Money sentence has no ambiguity
- Ends on the yes/no question
- No scheduling link, agreement, or payment mechanics anywhere
- Real signature with LinkedIn
- Read it out loud. If it doesn't sound like something you'd say, rewrite it.

## What this means for `lib/matchyTemplates.ts` (not yet built)

- `buildIntroEmail` moves to this format. The "why them" fact comes from the expert's sourcing evidence (`evidenceItems`, high confidence, type `role` or `company`). No qualifying fact means Matchy holds the intro and asks the owner for the line instead of sending a generic one.
- The subject's domain comes from the expert's evidence, not the brief's industry.
- The rate is the expert-side opening offer already seeded at bookmark (Mid $400 / Senior $650 / Executive $800, clamped to the project band). The client number never appears.
- Sign-off `Asher` plus a signature block: name and From address from `OUTREACH_SIGNATURE` / `OUTREACH_FROM_EMAIL`. (Founder, 2026-09-10: no LinkedIn line.)
- `scripts/test-matchy-templates.ts` gains: zero em dashes, banned-phrase lint, body under 90 words, subject format.

### Rubric intro (built, 2026-09-09)

`buildIntroEmail` now produces the shape above, and the pre-send checklist is code, not hope:

- **Shape.** `Expert in {domain}: …` subject (colon, never an em dash), `Dear {First},`, the why-them line, the offer sentence with the scope clause and the question, then `Asher` over a signature block (full name, From address) and the CAN-SPAM footer. Two trial arms (`INTRO_ARMS`, `introArmFor(expertId)` is a stable hash; `INTRO_ARM=1|2` pins): arm 1 puts the rate in the subject, arm 2 says "a paid call for my client?"; the body always states the hourly rate. The flat "$X for up to an hour" framing was dropped by the founder on 2026-09-10. The arm rides on the `intro_sent` event payload as `introArm`.
- **Hard rules enforced.** An em dash anywhere, a banned phrase or word, or a body at or over 90 words makes `buildIntroEmail` throw `IntroRubricError`; the send path holds the intro instead of sending it. The topic clause is the one part that may be shortened to fit.
- **The why-them line is never a slot.** `lib/introPersonalization.ts` runs, in order: (1) a deterministic pass over `evidenceItems` (high confidence, or an untagged role/company claim) that turns a past-tense claim into second person plus the closing clause; (2) one `gpt-4o-mini` call whose JSON `{ whyThem, domain }` must pass the same checks plus "no digit you did not read" and "carries the company or a distinctive claim word"; (3) nothing. On nothing, `lib/outreachSteps.ts` leaves the expert at `outreach_drafted` with `introNeedsWhyThem: true` and sends nothing, whatever the review-first switch says. A platform admin supplies the line through `POST …/outreach/approve { whyThem }` (screened, linted, the clause appended if missing); an owner cannot, because the owner does not know who the expert is. The thread shows the client "Matchy is finishing the intro" meanwhile.
- **The domain** comes from the expert's value-chain label or descriptor, falls back to the brief's industry only when neither exists, and is refused if it names the employer or a client term.
- **Redaction.** `whyThem`, `introDomain` and `introArm` are staff-only on the wire (`lib/redactExpert.ts`, checked by `scripts/check-redaction.ts`); `introNeedsWhyThem` is client-visible.
- **Tests.** `scripts/test-matchy-templates.ts` (all four arms against every rule above) and `scripts/test-intro-personalization.ts` (the evidence pass and the model validator, no network).

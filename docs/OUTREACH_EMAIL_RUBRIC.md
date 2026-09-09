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

Run trial emails with various bodies and subjects, with the price in them or not. Every arm keeps the "why them" line and states the money in the body (hard rule above); what varies is whether the number is in the subject and whether the body frames it hourly or flat. Record the arm in the `intro_sent` event payload; reply rate and positive-reply rate within four business days come from `reply_received` / `intent_classified`.

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
- Sign-off `Asher` plus a signature block: name and From address from `OUTREACH_SIGNATURE` / `OUTREACH_FROM_EMAIL`; LinkedIn needs a new env var (e.g. `OUTREACH_LINKEDIN_URL`).
- `scripts/test-matchy-templates.ts` gains: zero em dashes, banned-phrase lint, body under 90 words, subject format.

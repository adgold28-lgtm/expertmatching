# Expert Outreach Email Sequence — Copy Draft

*Draft copy only. Nothing here is wired into `lib/emailSequence.ts` yet.*

Sequence: Email 1 on approval → Email 2 at +3 days → Email 3 at +5 days after Email 2
(≈8 days total). Any reply, decline, or opt-out cancels the remaining sends.

**Merge fields used:** `{{first_name}}`, `{{company}}`, `{{topic}}` (neutral 6–12 word
topic label — *not* the client's verbatim brief), `{{rate}}`, `{{details_link}}`,
`{{sender_name}}`, `{{sender_title}}`.

**Global rule for whoever writes `{{topic}}`:** it must read as an industry subject
("how mid-market payers evaluate utilization-management vendors"), never as a request for
a specific company's numbers. Half the compliance framing below fails if the topic line
itself sounds like an ask for internal data.

---

## Email 1 — Initial outreach

**Subject:** Paid expert call on {{topic}} — {{rate}}/hr

**Preheader:** Industry perspective only. You choose what you discuss.

**Body:**

> Hi {{first_name}},
>
> I'm {{sender_name}} at ExpertMatch. We connect investors and research teams with
> practitioners for short, paid consultations — and one of our clients is looking for
> someone with your background to talk through {{topic}}.
>
> To be direct about what this is and isn't: the client wants your general read on the
> industry — how the market works, how buyers evaluate options, where things are heading.
> They are not asking for {{company}}'s internal figures, customer data, or anything
> covered by an NDA or confidentiality agreement. You set the boundaries, and "I can't
> answer that" is a complete answer to any question on the call.
>
> How it works:
>
> - 30–60 minutes, by phone or video, at a time you pick
> - {{rate}}/hr, billed per minute with a 15-minute minimum, paid out after the call
> - A short compliance check before we schedule — conflicts, employer restrictions,
>   anything that would make this a bad fit
> - No material non-public information, and nothing that would breach an agreement you've
>   signed. If your employer requires pre-approval for outside consulting, get it first —
>   we'd rather you decline than put yourself in a difficult spot.
>
> If it's a fit: {{details_link}}
>
> And if it isn't, just reply "no thanks" and I won't follow up.
>
> {{sender_name}}
> {{sender_title}}, ExpertMatch

**Why this compliance framing:** the disclaimer is placed *before* the logistics rather
than in a footer, because the "are you asking me to leak something?" question is the one
that decides whether they keep reading — and stating the limits as our own rules (a
compliance check we run, MNPI we won't touch) reads as a real operating standard, while
the same points buried at the bottom read as legal cover.

---

## Email 2 — Follow-up (+3 days)

**Subject:** Re: Paid expert call on {{topic}}

**Preheader:** A bit more on who we are, in case that's the hesitation.

**Body:**

> Hi {{first_name}},
>
> Following up once on the consultation I mentioned — {{topic}}, {{rate}}/hr, 30–60
> minutes whenever suits you.
>
> If you passed on it because a cold email like this is hard to place, that's fair. Here's
> the short version: ExpertMatch is an expert network. Firms hire us to find practitioners
> who can explain how an industry actually works, and we run the same guardrails the
> established networks do — a compliance screen before every call, no material non-public
> information, no discussion that would breach an employment, confidentiality, or client
> agreement. Consultants, bankers, and corporate teams take these calls routinely; a lot of
> people's employers have a formal process for approving them.
>
> Practically, that means the call stays at the level of market structure, competitive
> dynamics, and how decisions get made in your field — not {{company}}'s internals. You see
> the topic before you agree to anything, and you can end the call at any point.
>
> Details and times here: {{details_link}}
>
> Happy to answer questions by email first if that's easier.
>
> {{sender_name}}

**Why this compliance framing:** silence at this stage most often means "I'm not sure this
is legitimate," so this email names that objection out loud and answers it with category
evidence — this is a normal, widely used service with standard controls — instead of
adding new restrictions, which would only make a suspicious reader more suspicious.

---

## Email 3 — Final nudge (+5 days)

**Subject:** Closing this one out

**Body:**

> Hi {{first_name}},
>
> Last note from me on this — we're wrapping up the {{topic}} conversations this week.
>
> Still {{rate}}/hr for 30–60 minutes, still industry perspective only, still entirely your
> call what you discuss.
>
> If you want it: {{details_link}}
>
> If not, no reply needed — I'll close this out and you won't hear from me about it again.
> If the timing is the only issue, say the word and I'll keep you in mind for future work in
> your area.
>
> Thanks either way,
> {{sender_name}}

**Why this compliance framing:** the guardrails are compressed to a single clause because
they've already been made twice — repeating them at full length here would reframe a
low-stakes close as a legal warning, and the trust to be won at this point comes from
visibly walking away rather than from more reassurance.

---

## Notes for implementation (for later, not now)

- All three emails need the CAN-SPAM footer (postal address + one-click opt-out) from
  `lib/outreachFooter.ts`, and must respect `lib/outreachSuppressions.ts` — including a
  decline recorded on a different project.
- Email 3's "you won't hear from me about it again" is a promise: it should add the address
  to the per-project suppression list when the sequence ends unanswered.
- Nothing here should be LLM-rewritten at send time beyond the merge fields. The compliance
  sentences are the point of the email; a model paraphrasing them is a liability.
- `{{topic}}` must be a sanitized label, never the client's raw brief text.

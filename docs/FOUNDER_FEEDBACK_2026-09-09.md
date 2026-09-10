# Founder feedback — 2026-09-09 browser pass

**Status: LOGGED ONLY. Nothing below has been changed yet.** Asher walked the
project workspace, sourcing, the thread, and billing and flagged the items
below. Each entry records what he said, where it lives in the code, and a note
on the likely fix so the next session can pick it up without re-deriving it.

Verbatim ask: "do only an outline/recording of these problems. make sure they
are logged."

---

## 1. "Related Perspectives" block — remove, or push to the bottom

**Feedback:** "Doesn't make sense, also looks very vibe coded so needs to change."

**Where:**
- `app/projects/[projectId]/page.tsx` ~L841 (limited-pool amber notice mentions "related perspectives are below")
- `app/projects/[projectId]/page.tsx` ~L851 (count line: "Related perspectives are listed below — add the ones worth pursuing")
- `app/projects/[projectId]/page.tsx` ~L878–L900 (the amber "Related Perspectives" section header + explainer + adjacent list with per-row scores and "Add All")

**Notes:** Three separate strings reference it; if the section is removed all
three go together. The amber background, uppercase tracked header, and the
"suppliers, buyers, regulators, adjacent operators" explainer are what read as
vibe-coded. Decision needed: drop adjacent results from the client view
entirely, or keep them as a plain, unstyled list after the direct matches with
no header copy.

## 2. "Includes the ExpertMatch fee" — remove everywhere

**Feedback:** "That makes me question, well what's the fee?"

**Where (client-facing):**
- `components/ProjectExpertCard.tsx:244` — `{rate}/hr · includes ExpertMatch fee`
- `components/ConversationThread.tsx:1029` — "Agreed {rate}/hr · includes ExpertMatch fee"
- `components/ConversationThread.tsx:1032` — "Your rate for {name} {rate}/hr · includes ExpertMatch fee"
- `components/MatchySettingsStrip.tsx:344` — rate rule footnote "Includes the ExpertMatch fee."
- `app/pricing/page.tsx:46` — FAQ answer "The rate you see includes the ExpertMatch fee."
- `app/pricing/page.tsx:145` — "Rates are opening positions and include the ExpertMatch fee."
- `app/terms/page.tsx:139` — "That rate is all in: it includes both the expert's fee and the ExpertMatch fee."

**Notes:** The intent was "no surprise markup", but naming a fee invites the
question. Replace with nothing, or with a single "all-in" / "one rate, nothing
added" phrasing. Terms may need to keep a legal statement that the rate is
inclusive; that is a wording decision, not a deletion. Cross-reference
`docs/COPY_AUDIT.md` (money strings were the biggest cluster there too).

## 3. Sourced experts still show full name and employer

**Feedback:** "When you source experts, it says their full name and where they work still."

**Where:**
- `app/projects/[projectId]/page.tsx:898` renders `expert.name`; L906–908 render `expert.title · expert.company` in the sourcing results list.
- Redaction chokepoint is `lib/redactExpert.ts` (identity revealed only at `scheduled` with a real booking; admins always see everything).

**Notes / things to verify before fixing:**
- Asher was almost certainly logged in as **admin**, and redaction is
  admin-exempt by design. Confirm with a throwaway `user`-role account whether
  the sourcing results (not the pool cards) are actually redacted for clients.
- If the sourcing-results list is fed from the sourcing API response rather
  than a `redactProjectForViewer`-wrapped project, it may bypass the chokepoint.
  Check the route that returns sourcing results and the `adjacentResults` /
  core results state on the page.
- Decision needed: should admins also see the anonymized view in the workspace
  (with a reveal toggle), so the founder sees what clients see? The
  `ConversationThread` staff panel already has a Reveal/Hide pattern for the
  address that could be reused.

## 4. After "Bookmark", drop everything that follows

**Feedback:** "Get rid of the whole thing after bookmarking. Just click bookmark and that should be it."

**Where:**
- `components/ProjectExpertCard.tsx:282–310` — bookmarked state shows a "Bookmarked" pill plus **Retry** and **Undo** buttons.
- `components/ProjectExpertCard.tsx:91–114` — after the bookmark call resolves, `setMatchyNote(bookmarkLine(...))` writes a Matchy status line onto the card.
- `lib/...` `bookmarkLine` (imported at L13) produces the outcome copy.

**Notes:** Target state is: click Bookmark, button becomes "Bookmarked", nothing
else appears on the card. Retry/Undo and the outcome line move out of the card
(or go away). Open question: Retry exists because a bookmark with no address is
a dead end (TASK_QUEUE audit blocker 5); if the button goes, the retry has to
live somewhere else or happen automatically.

## 5. Interview guide questions — keep as is

**Feedback:** "I like the interview guide questions, those are amazing."

No action. Do not touch the interview guide generation or its copy when doing
the other items.

## 6. Expert rate / Client rate / Expert payout rows in the thread

**Feedback:** "Why does it tell me expert rate, and then client rate? Why does it say expert payout?"

**Where:**
- `components/ConversationThread.tsx:230–238` — `StaffRow` "Expert rate" and "Client rate"
- `components/ConversationThread.tsx:275–278` — `StaffRow` "Expert payout"
- Gated by `{isAdmin && <StaffPanel pe={pe} />}` at `components/ConversationThread.tsx:1093`.

**Notes:** These rows are the **admin staff panel** and never render for a
client. Asher saw them because he was logged in as admin. Two possible reads of
the feedback:
1. He did not realise it was the staff panel, in which case the panel needs a
   clear "Staff only — clients never see this" label and visual separation.
2. He does not want the staff panel to show both numbers side by side at all.
Clarify before changing. Either way, "Expert payout" is Stripe Connect
onboarding status (`expertOnboardingStatus`), not a dollar figure; the label is
misleading and should read like "Payout account: not started / complete".

## 7. Card entry should be a Stripe popup; Link only shows "new card number"

**Feedback:** "Can we make the card entering section a Stripe popup? I love how Link comes up but it only says new card number."

**Where:**
- `components/onboarding/BillingStep.tsx:13–28, 94–200` — mounts a legacy `card` Element imperatively via `@stripe/stripe-js` (`stripe.elements().create('card')`). `@stripe/react-stripe-js` is deliberately not a dependency.
- `components/settings/PaymentPanel.tsx` — same pattern for the settings page.
- `package.json:16` — `@stripe/stripe-js ^9.5.0`.

**Notes:** The single `card` Element is why Link only offers "new card": the
legacy Card Element has limited Link support. Options, in order of effort:
1. **Payment Element** in place of Card Element (same imperative mount, a
   SetupIntent already exists). Gives full Link (saved cards, one-tap), wallets,
   and Stripe's own styling. Closest to what he described.
2. **Stripe Checkout in setup mode** (hosted page / popup redirect). A true
   "popup" but leaves the app and returns via redirect; changes the onboarding
   flow.
3. Embedded Checkout (iframe modal). Middle ground; needs client secret from a
   Checkout Session, not a SetupIntent.
Recommend option 1. Must keep the trial path (BillingStep skips the card for
trials) and the champion-only gating from Session 6 intact.

---

## Suggested order

1. Item 2 (fee copy) — pure string edits, lowest risk.
2. Item 4 (bookmark) — one component.
3. Item 1 (related perspectives) — one page section.
4. Item 3 (identity leak) — verify with a `user`-role account first; may be a real redaction gap, which would be P0.
5. Item 6 (staff panel) — needs a product answer.
6. Item 7 (Payment Element) — largest change; browser-verify with test cards + Link.

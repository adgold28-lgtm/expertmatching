# ExpertMatch — State of the Union

**Date:** 2026-09-06 · **Author:** written by Claude (coding session) for the founder, Asher Goldstein · **Purpose:** a plain-English, honest snapshot of the company for an outside reader (an advisor, a co-founder candidate, or a Claude conversation assessing Y Combinator readiness). Everything here is verifiable in the repo at `/Users/ashergoldstein/Projects/expertmatch` and on the live site at expertmatch.fit.

Items in `[brackets]` are things only the founder can fill in.

---

## 1. What ExpertMatch is, in one paragraph

ExpertMatch is a self-serve expert network for private equity firms, family offices, consulting firms, law firms and corporate strategy teams. A client writes a short research brief; the platform sources and scores anonymized expert candidates from public records in minutes; the client bookmarks the ones worth a call; an AI relay called **Matchy** then owns the expert relationship end to end — finds an address, sends an anonymized intro, asks about conflicts and rate, relays every message through a compliance screen, and schedules the call — and the client's saved card is charged automatically when the call completes. It replaces the human research associates that GLG, AlphaSights and Guidepoint sell, and the annual contract that comes with them.

## 2. The thesis (why this could work)

- **Incumbents are labor businesses.** GLG ($600M+ revenue) and AlphaSights ($600M+) employ thousands of associates to do what is now largely automatable: find a person, write an intro, chase a reply, schedule a call. Their pricing ($1,000–$2,500 per call plus $60k+ annual minimums) is priced for that labor.
- **The buyer is a 3–10 person deal team, not a procurement department.** ~4,100 US PE firms average ~8 employees. They want a tool an associate can expense, not a contract a partner signs.
- **Anonymized, relay-based outreach is a structural moat, not a feature.** Because the client never sees the expert's email and the expert never sees the client's name until the call is booked, every interaction has to run through the platform — which is also what makes it compliant (MNPI, conflicts, do-not-contact) and what generates the data asset (every rate, reply, rejection reason and outcome is an event).
- **Why now:** LLMs make sourcing, summarizing and screening cheap enough to run per-call at near-zero marginal cost, and the incumbents' cost structure cannot follow the price down.

## 3. Business model and pricing (decided 2026-09-06)

| Line | Price |
|---|---|
| Seat subscription | $250 / seat / month for 1–5 seats; $200 for 6–20; custom above 20. Month-to-month, prorated, no contract |
| Expert calls | Client pays the displayed hourly rate, billed per minute with a 15-minute minimum. The rate includes ExpertMatch's fee |
| Opening rates by expert seniority | Expert offered $400 / $650 / $800 per hour (mid / senior / executive); client pays $800 / $1,300 / $1,600 |
| Take rate on calls | 50% (expert receives the rate they accepted; ExpertMatch keeps the rest) |

**Unit economics per senior call (one hour):** client pays $1,300 → expert paid $650 → gross margin $650 before payment fees (~$40) and LLM/provider costs (single-digit dollars). A 5-seat team doing 10 senior calls a month generates ≈ $1,250 seats + $13,000 calls = **$14,250/month**, of which ≈ $7,750 is gross margin. That client would pay AlphaSights roughly $15,000/month for the same volume, with an annual commitment.

**Market:** the expert network market is $3–5B and growing 12–15% a year; ~11,200 firms buy from it. Seats are a small line (≈ $60–170M TAM); calls are where the money is.

## 4. What is actually built and live (verified in production today)

The product is real software, not a deck. Repo facts: first commit 2026-04-10; 110 commits; ~46,000 lines of TypeScript; 59 API routes; 28 pages; 5 database migrations; 11 automated test/verification scripts. 27 commits shipped today alone.

**Live and verified in production on 2026-09-06:**
- Auth and data on Supabase (Postgres with row-level security; cross-organization isolation proven by a test harness and a production smoke test that provisions and deletes its own users).
- Onboarding: calendar connection (Google OAuth / Calendly / manual) and a saved card (Stripe) are required before the app unlocks.
- Sourcing: a background job sources and scores candidates from public records; results are anonymized server-side ("Scott S.", role and org-type descriptor, no name, employer, LinkedIn or contact details until a call is booked).
- **Matchy Phase 1 (shipped today):** bookmark → rate seeding → anonymized intro email → inbound replies verified, cleaned, compliance-screened, stored encrypted, classified and summarized by one LLM call → pipeline stage updated → follow-up with conflict/NDA questions and the rate ask → client replies in-app through the same screen (phone numbers, emails, links, firm names and "let's talk directly" are blocked with an explanation). A per-project "review before sending" switch and a client-set rate band that Matchy negotiates inside.
- Billing: off-session auto-charge of the client's saved card on call completion at the client rate with the 15-minute minimum; expert payouts via Stripe Connect. Per-seat subscription with Stripe volume tiers.
- Compliance plumbing: signed inbound-email verification, global do-not-contact list with public opt-out, CAN-SPAM footer, every automated action logged as an event.
- Marketing site with honest pricing, Terms of Service, Privacy Policy and Contact pages (two placeholders remain: legal entity name and governing law).

**Verification that exists and passes:** production smoke test (16 checks), Matchy end-to-end against production with throwaway users (≈40 checks, no email sent), 7 unit suites (513 checks) covering pricing math, templates, the compliance screen, email cleaning, reply classification and redaction, and a 135-check RLS isolation harness.

## 5. What is NOT done (be honest with yourself and with YC)

- **Zero paying customers and zero revenue.** Stripe is still in test mode. No real client has run a real project.
- **No legal entity.** The founder operates as an individual; Terms name no entity. A Delaware C corp (Stripe Atlas, ~$500) is the obvious next step if YC is the plan.
- **Matchy Phase 2 is not built:** autonomous contact discovery on bookmark (today a bookmark only sends if an address is already on record), proposing call times from calendar overlap, and booking on confirmation. Scheduling currently uses an availability-link flow.
- **Deliverability is unproven at volume:** one sending domain; DKIM/SPF/DMARC must be verified; no data yet on expert reply rates.
- **Expert supply is sourced per-project from public records, not a standing panel.** Reply rates from cold, anonymized outreach are the single biggest unknown in the model.
- **No SOC 2**, no security audit beyond the internal RLS harness; PE and law-firm IT will ask.
- **Solo founder, no co-founder** [confirm], building with AI coding agents. YC will probe this.
- **The website still needs a second copy audit** now that the workflow changed (queued as a release gate).

## 6. Traction and evidence to date

- Product: as above — a working, deployed system, not a prototype.
- Customers: `[none yet — list any design partners, LOIs, waitlist entries, or firms that have said yes to a pilot]`
- Distribution: `[how you plan to get the first 5 clients — warm PE/consulting contacts, Colby/alumni network, cold outbound?]`
- Founder background: `[your relevant experience — finance/PE exposure, why you know this buyer, anything that makes you the right person to build this]`
- Time: `[full-time? student? graduation date?]`

## 7. Competition

| Player | What they are | Where ExpertMatch differs |
|---|---|---|
| GLG, AlphaSights, Guidepoint, Third Bridge | Human-staffed networks, $1,000–$2,500/call, annual minimums | Self-serve, no minimum, ~half the price, AI relay instead of associates |
| Tegus / AlphaSense | Transcript libraries + calls, $10–20k/seat/yr | ExpertMatch sells live conversations at low seat cost; no content library |
| Inex One, Dialectica, newer AI-first networks | Marketplace/aggregator or partly automated networks | Fully anonymized relay + compliance screen + event data loop as the core, not a bolt-on |
| Doing it yourself (LinkedIn + cold email) | Free, slow, non-compliant | Compliance, anonymity, billing and scheduling handled |

## 8. Risks, in order

1. Expert reply rate to anonymized cold intros (model breaks below roughly 15–20%).
2. Getting the first paying client without a brand — PE buyers are conservative.
3. Compliance incident (MNPI, contacting someone on a do-not-contact list) before there is a lawyer and a policy.
4. Solo-founder execution and support load once real clients are live.
5. Incumbents cutting price or shipping their own AI relay.

## 9. What the next 90 days look like

1. Form the entity; fill the last two legal placeholders; move Stripe to live keys.
2. Run the second website/copy audit; get 3–5 design-partner firms onto real projects at a discount in exchange for feedback and reply-rate data.
3. Ship Matchy Phase 2 (contact discovery on bookmark, calendar-based scheduling) so the loop is fully autonomous.
4. Measure: expert reply rate, intro-to-call conversion, time-to-first-call, client rate acceptance, calls per seat per month.

## 10. Questions a YC partner will ask, and the current honest answers

- *Do you have users?* No paying users yet. The product is live and demonstrable end to end.
- *Why you?* `[founder answer]`
- *Why isn't this a feature GLG adds?* Their revenue is the associate labor this removes; their contracts are annual minimums this removes. Cannibalizing both is hard from inside.
- *What's the moat?* The anonymized relay forces every interaction through the platform, which compounds into rate/reply/outcome data that tunes sourcing and pricing per client. Plus compliance workflow that DIY can't match.
- *How big can this be?* $3–5B market today; if ExpertMatch takes calls at half the incumbents' price with 50% take, 1% share is ~$40M revenue.
- *What do you need money for?* Founder salary to go full-time, a lawyer for compliance/contracts, sending-domain and provider costs, and a first hire for client success. `[refine]`

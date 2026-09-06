# ExpertMatch — Full Copy Audit

> **Status (2026-09-06, after the audit ran):** Top-10 items 1, 2, 3, 4, 5 and 9 were fixed by the per-seat billing merge + pricing commit (`0146290`, `e4817b1`); item 8, item 10's opt-out bug, the `projectsGuard` leak, the admin gating of `/demo-readiness` `/rank-experts` `/screen-expert`, and the model-vendor line were fixed in the commit that added this file. **Still open:** item 6 (Email 1/2/3 on the client card) and item 7 (raw email on the admin card is by design — redaction strips it for clients) fold into Matchy Phase 1; item 10's Terms / Privacy / Contact pages; the 102 REWRITE rows below, most of which are the workspace vocabulary Matchy Phase 1 replaces.

**Audited:** 2026-09-06 · **Repo:** `/Users/ashergoldstein/Projects/expertmatch` (Next 14.2, app router) · **Read-only — no files were modified.**
**Measured against:** `docs/MATCHY_SPEC.md` (draft 2), `HANDOFF.md`, `TASK_QUEUE.md`, and the pricing decided 2026-09-06.
**Scope:** 372 strings / string-clusters across 11 surfaces — marketing, auth, onboarding, the project workspace, email templates, expert-facing pages, admin tools, and legal.

## The one-line verdict

**The website sells the product you had in April, not the one you decided on last week.** The workflow copy still describes five manual staff steps (`Brief → Source → Outreach → Screen → Deliver`) instead of the relay (`Brief → Matches → Conversations`); the pricing pages still sell $1,500/$3,500 flat plans with per-month call caps; every per-call rate shown to a client is **roughly half** what the client will actually be charged; and the words **"Matchy"** and **"bookmark"** do not appear anywhere in `app/`, `components/`, or `lib/`. Separately, three strings make claims that are now false or unsupportable — *"Per-call markup: None"*, *"SOC 2 and compliance package"*, and *"SLA with uptime guarantee"*.

The tone, where it's current, is good. **Onboarding and the expert-facing pages are genuinely well-written** and need almost nothing. The problems cluster tightly in three places: **anything about money, anything about the workflow, and anything the old outreach bot touches.**

## Summary — verdicts by surface

| # | Surface | KEEP | REWRITE | CUT | UNSURE | Total |
|---|---|---:|---:|---:|---:|---:|
| 1 | Landing — `app/page.tsx`, `layout.tsx`, `NavBar` | 14 | 14 | 4 | 4 | **36** |
| 2 | Pricing — `app/pricing/page.tsx` | 6 | 8 | 9 | 0 | **23** |
| 3 | Request access | 13 | 4 | 0 | 0 | **17** |
| 4 | Sign in / invite / set password | 16 | 4 | 0 | 0 | **20** |
| 5 | Onboarding stepper | 27 | 7 | 1 | 0 | **35** |
| 6 | App home + project list | 11 | 6 | 2 | 0 | **19** |
| 7 | **Project workspace** (the core screen) | 48 | 40 | 47 | 2 | **137** |
| 8 | **Email templates** | 17 | 5 | 9 | 4 | **35** |
| 9 | Expert-facing pages | 16 | 2 | 0 | 4 | **22** |
| 10 | Admin + internal tools | 10 | 5 | 4 | 0 | **19** |
| 11 | Legal / footer / site-wide gaps | 1 | 7 | 0 | 1 | **9** |
| | **Total** | **179** | **102** | **76** | **15** | **372** |

Roughly **half the product's copy is fine** (179 KEEP). Of the rest, the CUT column is concentrated almost entirely in two places — the project workspace (47) and the email cadence (9) — both of which Matchy Phase 1 replaces anyway. **The copy work and the Matchy build are the same project.**

## Top 10 highest-impact fixes

Ordered by damage-if-left-alone, not by effort.

**1. `lib/seniorityClassifier.ts:6-8` — every rate in the product is wrong.**
`TIER_PRICING` still encodes the retired 30% take: `callRate` 800/600/400, `expertRate` 560/420/280. Per spec the expert is offered **$400/$650/$800** and the client pays **$800/$1,300/$1,600**. This one constant feeds `ExpertCard.tsx:99`, `ProjectExpertCard.tsx:161`, the `/pricing` table, and the exported PDF — so **every rate a prospect or client sees today is about half what they will be billed.** Fix this first; roughly a dozen other findings resolve with it.

**2. `app/page.tsx:206` — "Per-call markup: None".**
ExpertMatch takes **50%** of every call. This is a comparison-table row on the homepage asserting the opposite of the business model, aimed at buyers who negotiate for a living. Delete or reframe the row today.

**3. `app/pricing/page.tsx:75-76` — "SOC 2 and compliance package" / "SLA with uptime guarantee".**
Neither exists anywhere in the codebase. A PE firm's IT diligence asks for the SOC 2 report in the first week. Also on the same card: `Custom data integrations` (no code) and `Dedicated account manager` (contradicts the landing page's own "No account managers").

**4. `app/pricing/page.tsx:83-85` — the per-call rate table under-quotes clients by ~2×.**
`$400 / $600 / $800` is presented as `Call Rate` (what the client pays). Those are now the **opening offers to the expert**. Replace with $800/$1,300/$1,600 and relabel the column `You pay (all in)`.

**5. The retired plans and call caps, everywhere.**
`app/page.tsx:242-260`, `app/pricing/page.tsx:33-78`, `app/admin/requests/page.tsx:50-52`, and `lib/firmStore.ts:29-45` all still encode `$1,500` / `$3,500` / `3 seats` / `10 seats` / `10 expert calls per month` / `25 expert calls per month`. The decided model — **$250/seat (1–5), $200/seat (6–20), talk to us (21+)** — and the **15-minute billable minimum** appear on **no page of the site**. This is the biggest content gap, and `TASK_QUEUE.md` already has it as the blocking item.

**6. `components/OutreachCard.tsx:643-685` + `lib/expertPipeline.ts:134-136` — Email 1/2/3 is on the client's screen.**
`Email Sequence Status`, `Email 1 — Interest check`, `Email 2 — Conflict check + rate confirmation`, `Email 3 — Scheduling link`, `Send Email 1 →`, plus the status pills `Email 1 Sent` / `Email 2 Sent`. The cadence is being retired; until then the client is watching a drip campaign run, which is the opposite of the "silent operator" the spec describes.

**7. `components/OutreachCard.tsx:492, 124-125` — the anonymization promise is broken on the same card that makes it.**
`IdentityProtectedLabel` says *"Identity protected until a call is scheduled"* while the card directly beneath prints the expert's **raw email address** and the **vendor that found it** (`Hunter.io` / `Snov.io`). Spec: *"The client never sees a raw email address"* and *"Never provider names."* This also removes the client's reason to keep transacting through ExpertMatch.

**8. `app/projects/[projectId]/page.tsx:580-587` — "Scanning 1B+ professional profiles…".**
A fabricated capability claim in the sourcing loader, alongside seven more lines of AI narration ("Cross-referencing…", "Ranking by relevance…", "Filtering out the LinkedIn influencers…", "Building your shortlist…"). The sourcing job is an LLM call plus web search. Replace all eight with one honest line.

**9. Two money bugs behind the copy — `lib/expertPayout.ts:146-152` and `lib/createAndSendInvoice.ts`.**
(a) `expertRate` is already 70% of `clientRate` (`types.ts:291`) and is quoted to the expert in outreach — then the payout email multiplies by 0.70 **again**, so the expert is promised one number and paid ~49% of the client rate. (b) Auto-billing charges `expertRate` instead of `clientRate` (already known in `HANDOFF.md`), so every client receipt is for about half the intended amount. These are wrong *numbers*, not wrong words — fix before the copy.

**10. No Terms, no Privacy Policy, no contact address — and a client-facing email carrying a cold-outreach opt-out.**
The site captures cards, stores deal-adjacent research questions, and shares data with nine third parties with **no privacy policy and no terms anywhere in the repo**. Separately, `app/api/projects/[projectId]/request-client-availability/route.ts:117-122` sends a **paying client** the expert outreach template *plus* the CAN-SPAM footer — if they click "Opt out", their address is added to the global do-not-contact list. `sendConfirmationEmail` in the same file already guards against exactly this.

**Runner-up, worth naming:** `app/demo-readiness/page.tsx` is an internal pre-launch checklist whose own code comments say *"must never be indexed"* and *"TODO: Gate behind admin auth before public launch"* — **neither has been done**. `/rank-experts` and `/screen-expert` are likewise only session-gated, not admin-gated, and `/rank-experts:1106` prints *"AI rationale by Claude Opus"* to whoever loads it.

## How to read the tables

Each row is one string or one tight cluster of strings on a single screen. **KEEP** = accurate and on-product. **REWRITE** = on-product but stale, wrong, machinery talk, or off-tone (proposed copy included). **CUT** = describes a retired or never-built feature, or is aimed at the wrong reader. **UNSURE** = needs a founder call, with the reason given.

Sections run in the order a new client meets them.

---

## 1. Landing page — `app/page.tsx`, `app/layout.tsx`, `components/NavBar.tsx`

The first thing a client sees. This page currently sells a **different product** from the one that was decided on 2026-09-06: flat plans, call caps, no seats-based pricing, no relay/Matchy story, "shortlist" as the deliverable.

| # | file:line | text | verdict |
|---|---|---|---|
| 1.1 | `app/layout.tsx:21` | `title: 'ExpertMatch — Expert Intelligence Platform'` | **REWRITE** — "Expert Intelligence Platform" is category mush and contradicts the landing `<title>`. The default tab title should match the product. → `ExpertMatch — Talk to the operators who've done it` |
| 1.2 | `app/layout.tsx:22` | `description: "Surface the practitioners, advisors, and outliers who've been there."` | **REWRITE** — "surface" is a sourcing verb; the product's value is the *call*, not the list. → `Find the right industry expert and be on a call with them this week. We handle outreach, scheduling, and billing.` |
| 1.3 | `app/page.tsx:7` | `title: 'ExpertMatch — Expert Calls, Sourced and Billed in Hours.'` | **KEEP** — accurate, verb-forward, on-brand. Consider dropping the trailing period. |
| 1.4 | `app/page.tsx:8` | `description: '…replaces traditional expert networks for PE firms, hedge funds, and strategy consultants. AI-sourced practitioners, direct outreach, per-minute billing. No account managers, no markups.'` | **REWRITE** — three problems: (a) **"hedge funds"** is not a stated target segment (PE, family offices, consulting, law); (b) **"per-minute billing"** with no 15-minute minimum is now inaccurate; (c) **"no markups"** is now flatly false — ExpertMatch takes 50% of every call. → `ExpertMatch replaces traditional expert networks for PE firms, family offices, consulting firms, and law firms. We source the expert, run the outreach, book the call, and bill it — no account managers, no research fees.` |
| 1.5 | `app/page.tsx:56` | eyebrow `Expert Network Operations` | **REWRITE** — reads as an internal category label, not a promise. → `For PE, family offices, consulting and law` |
| 1.6 | `app/page.tsx:62-65` | H1 `Expert calls, sourced` / *`and billed in hours.`* | **KEEP** — strongest line on the page. |
| 1.7 | `app/page.tsx:71-72` | `…We identify the right practitioners, handle outreach, and bill by the minute.` | **REWRITE** — same "hedge funds" and bare "by the minute" problems. → `We find the right practitioners, run the outreach, book the call from your calendar, and bill it to your card — 15-minute minimum, per-minute after that.` |
| 1.8 | `app/page.tsx:81` | CTA `Go to Your Projects` (signed in) | **KEEP** |
| 1.9 | `app/page.tsx:89`, `:97` | CTAs `Request Access` / `See Pricing` | **KEEP** |
| 1.10 | `app/page.tsx:107` | stat `< 2 hours` — *"Brief to expert shortlist"* | **REWRITE** — "shortlist" is retired language and describes a list, not an outcome; also the claim is unverified against the real sourcing job (a run is minutes, but nothing enforces "< 2 hours"). → `< 2 hours` / *"Brief to expert candidates"*. **UNSURE** whether "< 2 hours" is defensible — founder call. |
| 1.11 | `app/page.tsx:108` | stat `Per minute` — *"Pay for time used, not a flat hourly rate"* | **REWRITE** — omits the 15-minute minimum, which is now a decided term. → `15 min minimum` / *"Then per minute. Pay for the time actually used."* |
| 1.12 | `app/page.tsx:109` | stat `No contracts` — *"No minimums. No account managers."* | **REWRITE** — "No minimums" directly contradicts the 15-minute billable minimum *and* the per-seat subscription. → `Month to month` / *"No annual contract. No account managers."* |
| 1.13 | `app/page.tsx:139-141` | step 01 `Describe your research question` / *"Tell us the sector, geography, and what you need to understand."* | **KEEP** |
| 1.14 | `app/page.tsx:144-146` | step 02 `We find and contact the right experts` / *"Operators, advisors, and domain experts are identified from public records and contacted on your behalf."* | **REWRITE** — "identified from public records" is machinery talk and invites a sourcing-legitimacy question the client didn't ask. → `We find them and reach out` / *"We identify the operators and advisors who fit, contact them anonymously on your behalf, and handle the conflict and rate conversation."* |
| 1.15 | `app/page.tsx:149-150` | step 03 `Get on a call. Billed by the minute.` / *"Once an expert confirms, the call is set up. You pay for the time actually used."* | **REWRITE** — missing the calendar/Zoom story and the 15-min minimum. → `Get on the call` / *"We book the Zoom from your calendar. 15-minute minimum, per minute after that, charged to your card when the call ends."* |
| 1.16 | `app/page.tsx:182` | `ExpertMatch vs. Traditional Networks` | **KEEP** |
| 1.17 | `app/page.tsx:201` | row `Expert sourcing` → `AI, from public records` | **REWRITE** — machinery talk; leading with "AI" invites doubt rather than confidence. → `Automated, in minutes` |
| 1.18 | `app/page.tsx:202` | `Sourcing turnaround` → `< 2 hours` vs `2–5 business days` | **UNSURE** — is "< 2 hours" a measured number or an aspiration? Needs a founder call before it stays on a public page. |
| 1.19 | `app/page.tsx:203` | `Outreach` → `Handled for you` / `Not offered` | **UNSURE** — "Not offered" for traditional networks is arguably false (AlphaSights/Tegus do run outreach; that *is* their job). This is the one comparison line a knowledgeable PE buyer will call out. Recommend rewriting to `Manual, via an account manager`. |
| 1.20 | `app/page.tsx:205` | `Billing` → `Per-minute, instant` | **REWRITE** — add the minimum. → `Per-minute after 15 min, charged instantly` |
| 1.21 | `app/page.tsx:206` | `Per-call markup` → **`None`** | **CUT / REWRITE — HIGHEST PRIORITY.** ExpertMatch takes **50%** of every call. Claiming "no markup" on the homepage while charging a 2× spread is the single most legally and reputationally dangerous string on the site. Either delete the row or reframe honestly: `Pricing` → `One rate, all in — no research fee` vs `Rate + retainer + research fees`. |
| 1.22 | `app/page.tsx:207` | `Sourcing evidence` → `Full evidence trail` / `Opaque` | **UNSURE** — the evidence trail exists in the product (`evidenceItems`, source links) but is **redacted away for non-admin users** (`lib/redactExpert.ts` strips sources/evidence for `role==='user'`). So the promise is false for exactly the people reading the page. Either unredact evidence for clients or cut the row. |
| 1.23 | `app/page.tsx:237` | `Flat monthly fee. Per-minute billing on calls. No contracts.` | **REWRITE** — "flat monthly fee" is the retired model. → `Per-seat monthly subscription. Per-call billing on top. Month to month.` |
| 1.24 | `app/page.tsx:242-246` | **Starter — `$1,500`/month — `3 seats`, `10 expert calls/mo`, `AI sourcing`, `Outreach automation`, `Call coordination and billing`** | **CUT — RETIRED.** Flat plan, call cap, seat count all wrong. Replace the whole three-card block with the decided seat table (§2). |
| 1.25 | `app/page.tsx:249-253` | **Growth — `$3,500`/month — `10 seats`, `25 expert calls/mo`, `Priority sourcing queue`, `Dedicated onboarding`** | **CUT — RETIRED.** Same. "Priority sourcing queue" and "Dedicated onboarding" are also features that do not exist in code. |
| 1.26 | `app/page.tsx:256-260` | **Enterprise — `Custom` — `Unlimited seats`, `Unlimited calls`, `Custom integrations`, `SLA and compliance`** | **CUT — RETIRED + UNSUPPORTED CLAIMS.** "Custom integrations" and "SLA and compliance" do not exist anywhere in the codebase. Replace with `21+ seats — talk to us`. |
| 1.27 | `app/page.tsx:313` | `{name === 'Enterprise' ? 'Contact Us' : 'Request Access'}` | **KEEP** (once the plan data is replaced) |
| 1.28 | `app/page.tsx:337` | `See it with a question you're working on.` | **KEEP** — best CTA copy on the site. |
| 1.29 | `app/page.tsx:340` | `Request access. We'll run a live sourcing brief on a real question from your pipeline.` | **KEEP** |
| 1.30 | `app/page.tsx:23-31` (Footer) | `EXPERTMATCH` · `Pricing` · `Request Access` · `© {year} ExpertMatch` | **REWRITE — GAP.** There is **no Terms, no Privacy Policy, no contact address** anywhere on the site, while the product takes card details, stores personal data on third parties, and sends cold commercial email (which needs a postal address under CAN-SPAM — one exists in `OUTREACH_POSTAL_ADDRESS` for emails but is nowhere on the web site). Add: `Terms` · `Privacy` · `Contact`. |
| 1.31 | `components/NavBar.tsx:42` | wordmark `EXPERTMATCH` | **KEEP** |
| 1.32 | `components/NavBar.tsx:54` | nav `Pricing` | **KEEP** |
| 1.33 | `components/NavBar.tsx:63` | `Open ExpertMatch` | **KEEP** |
| 1.34 | `components/NavBar.tsx:69` | `Welcome, {firstName}` | **KEEP** — though it duplicates the greeting in `/app`. Minor. |
| 1.35 | `components/NavBar.tsx:79` | `Sign In` | **KEEP** |
| 1.36 | `components/NavBar.tsx:9` | `activePath?: 'pricing'` — nav has exactly two links | **UNSURE** — there is no `/about`, `/faq`, `/security`, `/how-it-works`, or `/contact` page in the repo. For a product asking a PE firm for a card on file, the absence of an About and a Security page is a conversion problem worth a founder decision. |

**Landing verdict:** the hero and "how it works" are close to right. Everything about **money** (stats strip, comparison table, pricing teaser) is describing a retired product and contains at least one claim ("Per-call markup: None") that is now untrue.

---

## 2. Pricing — `app/pricing/page.tsx`

**This entire page is stale.** It sells the retired flat-plan model and makes four compliance/capability claims that do not exist in the codebase.

| # | file:line | text | verdict |
|---|---|---|---|
| 2.1 | `app/pricing/page.tsx:6` | `title: 'Pricing — ExpertMatch'` | **KEEP** |
| 2.2 | `app/pricing/page.tsx:7` | `description: 'Flat monthly fee. Per-minute billing on calls. No minimums, no contracts.'` | **REWRITE** — every clause is now wrong ("flat", "no minimums"). → `Per-seat subscription from $250/seat. Calls billed per engagement, 15-minute minimum.` |
| 2.3 | `app/pricing/page.tsx:128` | H1 `Flat fee. No markups.` | **CUT — FALSE.** ExpertMatch takes 50% of each call. → `Simple seats. Honest call rates.` |
| 2.4 | `app/pricing/page.tsx:131-132` | `One monthly subscription covers sourcing, outreach, and billing. Experts are compensated competitively for their time.` | **REWRITE** — "compensated competitively" is the weasel phrasing that hides the 50% take. Say the real thing. → `Your seat subscription covers sourcing, outreach, scheduling, and billing. Call rates are quoted all-in — the expert's fee and ours are in the one number you see.` |
| 2.5 | `app/pricing/page.tsx:33-46` | **Starter `$1,500`/month — `3 analyst seats`, `10 expert calls per month`, `Email support`** | **CUT — RETIRED.** Replace with `1–5 seats — $250 / seat / month`. |
| 2.6 | `app/pricing/page.tsx:49-62` | **Growth `$3,500`/month — `10 analyst seats`, `25 expert calls per month`, `Priority sourcing queue`, `Dedicated onboarding session`, `Custom conflict exclusion rules`, `Phone and email support`** | **CUT — RETIRED + THREE UNBUILT FEATURES.** "Priority sourcing queue" (no queue priority in `lib/sourcingJob.ts`), "Custom conflict exclusion rules" (not implemented), **"Phone and email support"** (no phone number exists anywhere in the repo). Replace with `6–20 seats — $200 / seat / month`. |
| 2.7 | `app/pricing/page.tsx:65-78` | **Enterprise `Custom` — `Unlimited analyst seats`, `Unlimited expert calls`, `Custom data integrations`, `SOC 2 and compliance package`, `SLA with uptime guarantee`, `Dedicated account manager`** | **CUT — RETIRED + FOUR UNSUPPORTABLE CLAIMS.** **`SOC 2 and compliance package`** and **`SLA with uptime guarantee`** are the two most dangerous strings on the site after 1.21 — a PE firm's IT diligence will ask for the SOC 2 report on day one and there isn't one. `Custom data integrations` has no code. `Dedicated account manager` contradicts the landing page's own "No account managers" promise (1.12). Replace with `21+ seats — talk to us`. |
| 2.8 | `app/pricing/page.tsx:151-155` | `Most Popular` badge on Growth | **CUT** — unearned social proof on a pre-revenue product; also attached to a plan being deleted. |
| 2.9 | `app/pricing/page.tsx:36`, `:52`, `:68` | taglines `For small teams with occasional expert projects.` / `For funds with multiple active research workstreams.` / `For large teams with compliance requirements.` | **REWRITE** — rewrite to describe seat bands, and drop "compliance requirements" (see 2.7). |
| 2.10 | `app/pricing/page.tsx:83-85` | **`Mid-Level $400/hr` · `Senior $600/hr` · `Executive / C-Suite $800/hr`, column header `Call Rate`** | **REWRITE — CRITICAL, WRONG NUMBERS.** These are presented as *what the client pays*, but $400/$650/$800 are now the **opening offers to the expert**. The client pays **$800 / $1,300 / $1,600**. As shipped, this page under-quotes the client by ~2×. Replace the table with the client rates and label the column `You pay (all in)`. |
| 2.11 | `app/pricing/page.tsx:83-85` | tier descriptors `Directors, VPs, Senior Managers` / `C-1 level: SVPs, Partners, MDs` / `CEOs, CFOs, Board members` | **KEEP** — these match `classifySeniority()` in `lib/seniorityClassifier.ts`. |
| 2.12 | `app/pricing/page.tsx:223` | `Call allowances are included in your plan. These rates apply to additional calls.` | **CUT — RETIRED.** There are no allowances and no caps. → `Every call is billed at the rate agreed for that engagement.` |
| 2.13 | `app/pricing/page.tsx:246` | `Billed per minute. Experts are compensated competitively for their time.` | **REWRITE** — missing the 15-min minimum, and the weasel clause again. → `15-minute minimum, then billed per minute. The rate you see is all in.` |
| 2.14 | `app/pricing/page.tsx:249` | `These rates are our opening position — the final rate is agreed per engagement.` | **KEEP** — good, honest line. Keep it verbatim once the numbers in 2.10 are fixed. |
| 2.15 | `app/pricing/page.tsx:90-91` | FAQ `Are there per-call fees on top of the subscription?` → *"No. The rates below are what clients pay per call. Calls within your monthly allowance are included in the subscription…"* | **CUT — RETIRED AND SELF-CONTRADICTORY.** Answers "no per-call fees" and then describes per-call fees. Replace: *"Yes — the subscription covers seats and sourcing; each call is billed separately at the rate agreed for that engagement, 15-minute minimum."* |
| 2.16 | `app/pricing/page.tsx:94-95` | FAQ `What happens if I exceed my monthly call limit?` → *"…We'll notify you before you hit the limit."* | **CUT — RETIRED.** No limits exist, and the notification it promises is not built. |
| 2.17 | `app/pricing/page.tsx:98-99` | FAQ `How do experts get paid?` → *"Experts are compensated competitively and paid directly through the platform within 5 business days…"* | **REWRITE** — the "within 5 business days" SLA is not enforced anywhere (`lib/expertPayout.ts` transfers on `payment_intent.succeeded`, which is same-day, or never if Connect onboarding is incomplete). Say what actually happens: *"Experts are paid through Stripe as soon as the call is billed, usually the same day. No invoicing on their end."* |
| 2.18 | `app/pricing/page.tsx:102-103` | FAQ `Can I switch plans at any time?` → *"Plan changes take effect at the start of your next billing cycle. Upgrades can be activated immediately."* | **REWRITE** — reframe around seats: *"Add or remove seats any time. Seat changes are prorated on your next invoice."* **UNSURE** whether proration is what the founder wants. |
| 2.19 | `app/pricing/page.tsx:106-107` | FAQ `Is there a setup fee or long-term contract?` → *"No setup fees. Plans are month-to-month. Enterprise contracts are available…"* | **KEEP** (drop the word "Enterprise"). |
| 2.20 | `app/pricing/page.tsx:277` | `Questions? Let's talk.` | **KEEP** |
| 2.21 | `app/pricing/page.tsx:280` | `Request access and we'll walk you through the platform with a real brief.` | **KEEP** |
| 2.22 | — | **MISSING** | The decided seat table (**$250 for 1–5, $200 for 6–20, talk to us for 21+**) and the **15-minute minimum** appear **nowhere** on the site. This is the biggest content gap. |
| 2.23 | `lib/firmStore.ts:29,42-45` | `FirmPlan = 'starter' \| 'growth' \| 'enterprise'`, `SEAT_LIMITS = { starter: 3, growth: 10, enterprise: Infinity }` | **CUT — DATA MODEL, NOT COPY, BUT IT DRIVES COPY.** The retired plan names and seat caps are baked into the firm record and surface in the admin UI and in the seat-limit error a real user hits (`"Your firm's account is full…"`). Must change with the pricing merge noted in `TASK_QUEUE.md`. |

---

## 3. Request access — `app/request-access/page.tsx`, `app/request-access/RequestAccessForm.tsx`

The cleanest page on the site. Two structural gaps rather than bad strings.

| # | file:line | text | verdict |
|---|---|---|---|
| 3.1 | `app/request-access/page.tsx` | *(no `metadata` export)* | **REWRITE — GAP.** No `<title>`/`<description>`; the tab reads the generic root title. Add `Request Access — ExpertMatch`. |
| 3.2 | `RequestAccessForm.tsx:81` | eyebrow `Early Access` | **KEEP** |
| 3.3 | `RequestAccessForm.tsx:87` | H1 `Request Access` | **KEEP** |
| 3.4 | `RequestAccessForm.tsx:90` | `Tell us a bit about your team and we'll follow up within one business day.` | **KEEP** — matches the actual flow (`app/api/request-access/route.ts` emails the founders). |
| 3.5 | `RequestAccessForm.tsx:102,110` | `Your Name *` / placeholder `Jane Smith` | **KEEP** |
| 3.6 | `RequestAccessForm.tsx:122,131` | `Firm Name *` / `Acme Capital` | **KEEP** |
| 3.7 | `RequestAccessForm.tsx:142,150` | `Work Email *` / `jane@acmecapital.com` | **KEEP** |
| 3.8 | `RequestAccessForm.tsx:162,169` | `What are you researching? *` / placeholder about cold chain + portfolio company | **KEEP** — the placeholder is genuinely good; it teaches the brief format. |
| 3.9 | — | **MISSING FIELDS** | `docs/MATCHY_SPEC.md` (founder answer 1) requires **`firmType` + `firmSize`** on the organization, captured *"at access request / org setup"*, so Matchy can write *"a mid-size PE firm"* in the anonymized intro. Neither field is on this form. Add `Firm type` (PE / family office / consulting / law / corporate) and `Roughly how many people?`. |
| 3.10 | `RequestAccessForm.tsx:188` | `{loading ? 'Submitting…' : 'Submit Request'}` | **KEEP** |
| 3.11 | `RequestAccessForm.tsx:61` | success `Thanks, {firstName}.` | **KEEP** — nice touch. |
| 3.12 | `RequestAccessForm.tsx:64` | `We received your request and will be in touch within one business day.` | **KEEP** |
| 3.13 | `RequestAccessForm.tsx:71` | `← Back to home` | **KEEP** |
| 3.14 | `RequestAccessForm.tsx:33,37` | error fallback `Something went wrong. Please try again.` | **KEEP** |
| 3.15 | `app/api/request-access/route.ts:44-63` | `Invalid JSON` / `Invalid request body` / `Name is required` / `Firm name is required` / `Valid email is required` / `Use case is required` | **REWRITE** — these are raw strings under `error:`, and the form renders `data.error` straight to the user (`RequestAccessForm.tsx:33`), so a user can see literally **"Invalid JSON"**. Give them the `{ error, message }` shape the rest of the API uses and human copy: *"Add your name."*, *"Add your firm name."*, etc. |
| 3.16 | `RequestAccessForm.tsx:194-197` | `Already have an account? Log in` | **KEEP** |
| 3.17 | — | **MISSING** | No consent line. The form collects a name, work email and a description of live deal work, then emails it to two Gmail/Colby addresses. There is no privacy notice or link. Add one line: *"We'll only use this to contact you about access. See our Privacy Policy."* — which requires that page to exist. |

---

## 4. Sign in / invite — `app/login/page.tsx`, `app/auth/set-password/*`, `app/signup/[token]/page.tsx`

| # | file:line | text | verdict |
|---|---|---|---|
| 4.1 | `app/login/page.tsx` | *(no `metadata`)* | **REWRITE — GAP.** Add `Sign in — ExpertMatch`. |
| 4.2 | `app/login/page.tsx:57` | wordmark `ExpertMatch` | **KEEP** |
| 4.3 | `app/login/page.tsx:67` | `Private Access` | **KEEP** — good tone for invite-only. |
| 4.4 | `app/login/page.tsx:77,89` | `Email` / `you@firm.com` | **KEEP** |
| 4.5 | `app/login/page.tsx:100,110` | `Password` / `Enter your password` | **KEEP** |
| 4.6 | `app/login/page.tsx:36` | `Incorrect credentials. Please try again.` | **KEEP** — correctly non-enumerating. |
| 4.7 | `app/login/page.tsx:42` | `Connection error. Please try again.` | **KEEP** |
| 4.8 | `app/login/page.tsx:127` | `{loading ? 'Signing in…' : 'Sign In'}` | **KEEP** |
| 4.9 | — | **MISSING** | **No "Forgot password" link anywhere.** A user who forgets their password has no self-serve path and no instruction — the page doesn't even say to contact an admin. High-impact gap. |
| 4.10 | `app/api/auth/login/route.ts:77` | `Too many login attempts. Please try again later.` | **KEEP** — but the login page never renders it (it shows the generic 4.6 for any non-OK response), so a rate-limited user is told their password is wrong. **REWRITE the page** to surface this message. |
| 4.11 | `app/api/auth/login/route.ts:123` | `This account has been disabled. Contact your administrator.` | **KEEP** (same non-surfacing problem as 4.10) |
| 4.12 | `app/auth/set-password/page.tsx:36-37` | `Invitation expired` / `This invitation link has expired. Please contact your administrator for a new one.` | **KEEP** |
| 4.13 | `app/auth/set-password/page.tsx:43-44` | `Invalid invitation` / `This invitation is invalid or has already been used.` | **KEEP** |
| 4.14 | `app/auth/set-password/page.tsx:65-66` | `Invitation already used` / `This invitation link has already been used to create an account.` | **KEEP** |
| 4.15 | `SetPasswordForm.tsx:85` | `Create Your Account` | **KEEP** |
| 4.16 | `SetPasswordForm.tsx:117` | placeholder `Min. 8 chars, at least one number` | **REWRITE** — a rule stated only as a placeholder disappears the moment the user types. Move it to helper text under the field. |
| 4.17 | `SetPasswordForm.tsx:26` | `Passwords do not match.` | **KEEP** |
| 4.18 | `SetPasswordForm.tsx:49` | `Your firm's account is full. Reach out to your account admin to add more seats.` | **REWRITE** — tied to the retired 3/10/unlimited seat caps (2.23). Under per-seat billing the right behaviour is "adding a seat costs $250/mo — ask your admin to add one", not a hard wall. Revisit with the pricing merge. |
| 4.19 | `SetPasswordForm.tsx:155` | `{loading ? 'Creating account…' : 'Create Account'}` | **KEEP** |
| 4.20 | `app/signup/[token]/page.tsx` | *(pure redirect, no copy)* | **KEEP** |

---

## 5. Onboarding — `app/onboarding/page.tsx`, `components/onboarding/*`

The strongest-written surface in the product. The copy here is specific, non-machinery, and tells the user what happens next. Two real problems: an internal env-var error shown to end users, and a claim about automatic scheduling that the product does not yet do.

| # | file:line | text | verdict |
|---|---|---|---|
| 5.1 | `app/onboarding/page.tsx:244` | header `Account Setup` | **KEEP** |
| 5.2 | `app/onboarding/page.tsx:30-32` | step labels `Connect Calendar` / `Add Billing` / `Your Profile` | **KEEP** |
| 5.3 | `app/onboarding/page.tsx:258` | `Step {n} of 3` | **KEEP** |
| 5.4 | `app/onboarding/page.tsx:378` | `Calendar and billing are both required before you can start a brief.` | **KEEP** — sets expectation up front; matches the server 409. |
| 5.5 | `app/onboarding/page.tsx:61` | `Google Calendar is not enabled on this deployment yet. Use Calendly or enter your availability manually to continue, and let your ExpertMatch contact know.` | **REWRITE** — "this deployment" is engineer-speak. → `Google Calendar isn't available right now. Use Calendly or enter your availability manually — we'll let you know when Google is back.` |
| 5.6 | `app/onboarding/page.tsx:63` | `You cancelled the Google permission screen, so nothing was connected…` | **KEEP** — exemplary error copy. |
| 5.7 | `app/onboarding/page.tsx:65` | `Google did not grant the long-lived permission we need to check your availability later. Remove ExpertMatch from your Google account's connected apps, then connect again.` | **KEEP** — actionable and honest. |
| 5.8 | `app/onboarding/page.tsx:67,69,72,74,76,78` | remaining Google error strings (`session expired`, `session_mismatch`, `invalid_state`, `token_exchange_failed`, `server_error`, default) | **KEEP** — all six are well-written and end in an action. |
| 5.9 | `app/onboarding/page.tsx:332` | `We could not load your setup` + *"Your progress is safe. This is usually a connection problem — try again in a moment."* | **KEEP** |
| 5.10 | `app/onboarding/page.tsx:225` | `Setup could not be completed because a required step is still outstanding.` | **REWRITE** — passive and vague. → `One of the earlier steps still needs finishing — we've taken you back to it.` |
| 5.11 | `app/onboarding/page.tsx:353,362` | toasts `Calendar connected.` / `Payment method saved.` | **KEEP** |
| 5.12 | `CalendarStep.tsx:300` | H2 `Connect Your Calendar` | **KEEP** |
| 5.13 | `CalendarStep.tsx:302-303` | `So ExpertMatch can find your availability and schedule expert calls automatically. This step is required.` | **UNSURE → REWRITE.** "schedule expert calls automatically" is a promise the shipped product does not keep — scheduling today is a manual availability request + overlap check (`ClientSchedulingSection`, `lib/computeOverlap.ts`), and autonomous proposing/booking is Matchy **Phase 2**. Safer now: *"So we can propose call times that actually work for you. Required."* |
| 5.14 | `CalendarStep.tsx:43` | `Recommended. We read free/busy times only — never event titles or guests.` | **KEEP** — precise, trust-building, and true (`lib/fetchGoogleFreebusy.ts`). |
| 5.15 | `CalendarStep.tsx:48` | `Paste your booking link. We check it for openings when a call is being scheduled.` | **KEEP** |
| 5.16 | `CalendarStep.tsx:53` | `Add the windows that work for you. You can update these any time.` | **KEEP** |
| 5.17 | `CalendarStep.tsx:334,347` | `Your time zone` / `Detected automatically. Change it if you work from somewhere else.` | **KEEP** |
| 5.18 | `CalendarStep.tsx:125,127,129,132,134,136,137` | Calendly/timezone/slot validation errors | **KEEP** — all specific and fixable by the user. |
| 5.19 | `CalendarStep.tsx:219` | `We could not reach ExpertMatch. Check your connection and try again.` | **KEEP** |
| 5.20 | `CalendarStep.tsx:391,419,534,550` | buttons `Continue with Google` / `Save Calendly link` / `Save availability` / `Continue` | **KEEP** |
| 5.21 | `BillingStep.tsx:197` | H2 `Add a Payment Method` | **KEEP** |
| 5.22 | `BillingStep.tsx:200-201` | `Expert calls are billed by the minute. We only charge after each completed consultation. No call, no charge. This step is required.` | **REWRITE** — (a) omits the **15-minute minimum**; (b) **"No call, no charge" will become false** the moment per-seat subscriptions go live, and this is the screen where the card is captured. → `Calls are billed after they happen — 15-minute minimum, then per minute. Your seat subscription is billed monthly. This step is required.` |
| 5.23 | `BillingStep.tsx:244` | `Handled entirely by Stripe. ExpertMatch never sees your card number.` | **KEEP** — true and exactly the reassurance needed here. |
| 5.24 | `BillingStep.tsx:293` | `Your card is stored by Stripe and charged only after a completed call.` | **REWRITE** — same subscription problem as 5.22. |
| 5.25 | `BillingStep.tsx:220-223` | `Billing is not configured` → *"This deployment has no Stripe publishable key… An administrator needs to set `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` and redeploy."* | **CUT — INTERNAL LEAK.** A paying client is shown an env-var name and a deploy instruction. → `Card setup is temporarily unavailable. We've been notified — please try again shortly, or contact us and we'll set this up for you.` (and alert internally instead). |
| 5.26 | `BillingStep.tsx:79,91,113,145,149,168,172,178` | Stripe failure strings, incl. *"Your card was saved with Stripe, but we could not finish activating it. Retry below — you will not be charged twice."* | **KEEP** — the double-charge reassurance is exactly right. |
| 5.27 | `BillingStep.tsx:210,258,268,277,287` | `Payment method saved` / `Continue` / `Retry activation` / `Try again` / `Save payment method` | **KEEP** |
| 5.28 | `ProfileStep.tsx:79` | H2 `Your Profile` | **KEEP** |
| 5.29 | `ProfileStep.tsx:82` | `So we can personalize your experience and communicate with experts on your behalf.` | **REWRITE** — "personalize your experience" is filler. → `So we can address you properly and speak to experts on your behalf.` |
| 5.30 | `ProfileStep.tsx:89,106,125,140` | `First name *` / `Last name *` / `Role / Title (optional)` / `Firm` | **KEEP** |
| 5.31 | `ProfileStep.tsx:134` | placeholder `Associate, VP Strategy, Partner…` | **KEEP** |
| 5.32 | `ProfileStep.tsx:63` | `Your calendar or payment method still needs finishing. Taking you back to that step.` | **KEEP** |
| 5.33 | `ProfileStep.tsx:68,70` | `We could not save your profile. Please try again.` / `We could not reach ExpertMatch…` | **KEEP** |
| 5.34 | `ProfileStep.tsx:157` | `{saving ? 'Saving…' : 'Finish Setup'}` | **KEEP** |
| 5.35 | — | **MISSING** | Nothing in onboarding tells the new user **what a call will cost them** ($800/$1,300/$1,600) or that a bookmark starts outreach. The card is captured before any number is shown. Founder call, but this is where the 15-min minimum and the call rates belong. |
---

## 6. App home / project list — `app/app/page.tsx`, `app/projects/page.tsx`

| # | file:line | text | verdict |
|---|---|---|---|
| 6.1 | `app/app/page.tsx` | *(no `metadata`)* | **REWRITE — GAP.** Add `Projects — ExpertMatch`. |
| 6.2 | `app/app/page.tsx:130` **and `:147`** | `You're all set. Create your first project to get started.` | **REWRITE + BUG.** The identical welcome banner is rendered **twice** (two copies of the same `{showWelcome && …}` block at :125-139 and :141-156), so a new user sees the same gold bar stacked twice on their first screen. Delete one. Copy itself is fine. |
| 6.3 | `app/app/page.tsx:174`, `:354` | `New Project` | **KEEP** |
| 6.4 | `app/app/page.tsx:181` | `Sign Out` | **KEEP** |
| 6.5 | `app/app/page.tsx:193-195` | stats `Total Projects` / `Experts Sourced` / **`Calls Completed`** | **REWRITE — HARDCODED ZERO.** `Calls Completed` is literally `value: 0` (line 195); it never counts anything. Either wire it to completed experts or cut the tile — a permanently-zero KPI on the client's home screen reads as a dead product. |
| 6.6 | `app/app/page.tsx:13-15` | project stage labels `Brief` / `Sourcing` / `Outreach` | **REWRITE** — these are the internal 5-step workflow names, not client-legible states, and `Complete` (defined at :22) is unreachable because `getProjectStage` can only return the first three. Post-Matchy this should read `Brief` / `Matches` / `Conversations`. |
| 6.7 | `app/app/page.tsx:25` | `const STEPS = ['Brief', 'Source', 'Outreach', 'Screen', 'Deliver']` | **CUT — RETIRED.** The 5-step model is being replaced by **Brief → Matches → Conversations** (`docs/MATCHY_SPEC.md`), and `Screen` folds into the thread. This array drives the progress bar on every project card. |
| 6.8 | `app/app/page.tsx:226` | section label `Projects` | **KEEP** |
| 6.9 | `app/app/page.tsx:279` | `{n} expert{s}` | **KEEP** |
| 6.10 | `app/app/page.tsx:319` | `Open →` | **KEEP** |
| 6.11 | `app/app/page.tsx:341` | empty state `Start your first project` | **KEEP** |
| 6.12 | `app/app/page.tsx:347` | `Describe the business problem and we'll find the right experts.` | **KEEP** — best product sentence in the app. |
| 6.13 | `app/app/page.tsx:398`, `:405` | `Project name` / placeholder `e.g. Cold Chain Logistics — Southeast Entry` | **KEEP** |
| 6.14 | `app/app/page.tsx:105`, `:110` | `Failed to create project. Please try again.` / `Network error. Please try again.` | **KEEP** |
| 6.15 | `app/app/page.tsx:433` | `{creating ? 'Creating…' : 'Create Project'}` | **KEEP** |
| 6.16 | `app/projects/page.tsx:127,130` | `Project Workspaces` / `Saved expert searches with pipeline tracking and export.` | **REWRITE** — "saved expert searches" describes the old search-tool product, not the relay. Also `/projects` and `/app` are two near-duplicate project lists; **UNSURE** whether `/projects` should exist at all. |
| 6.17 | `app/projects/page.tsx:138`, `:171` | `+ New Search` / `Start a Search` | **REWRITE** — inconsistent with `New Project` used everywhere else. → `New Project` / `Start a project`. |
| 6.18 | `app/projects/page.tsx:163` | `Run a search and click "Save as Project" to create a workspace with pipeline tracking.` | **CUT** — instructs the user to click a **"Save as Project" button that no longer exists** anywhere in the app. Dead empty-state copy. |
| 6.19 | `app/projects/page.tsx:42,46` | `Delete this project? This cannot be undone.` / `Confirm` | **KEEP** |

---

## 7. Project workspace — `app/projects/[projectId]/page.tsx` (2,188 lines, the core screen)

This is where the retired workflow lives. The whole **Brief → Source → Outreach → Screen → Deliver** stepper is the model `docs/MATCHY_SPEC.md` replaces with **Brief → Matches → Conversations**, and much of the copy explains internal staff mechanics to a client.

### 7a. Stepper and step summaries

| # | file:line | text | verdict |
|---|---|---|---|
| 7.1 | `:33-39` | steps `Brief` · `Source` · `Outreach` · `Screen` · `Deliver` | **CUT — RETIRED MODEL.** → `Brief` · `Matches` · `Conversations`. `Screen` folds into the thread; `Deliver` is a staff concept a self-serve client has no use for. |
| 7.2 | `:64` | `Research question defined` | **KEEP** |
| 7.3 | `:67` | `{n} discovered` | **REWRITE** — "discovered" is pipeline-status jargon. → `{n} candidates` |
| 7.4 | `:71` | `{n} in outreach` | **REWRITE** → `{n} conversations` |
| 7.5 | `:79` | `{n} calls recorded` | **CUT** — belongs to the Screen tab. |
| 7.6 | `:83` | `{n} client-ready` | **CUT** — "client-ready" is an internal staff verdict. The person reading this screen **is** the client. |
| 7.7 | `:95` | next action `Describe the business problem and the type of expert you need.` / `Complete brief` | **KEEP** |
| 7.8 | `:99` | `No experts discovered yet. Source candidates to fill the pipeline.` / `Go to Source` | **REWRITE** — "fill the pipeline" is CRM-speak. → `No candidates yet. Run sourcing to see who fits.` |
| 7.9 | `:103` | `Shortlist candidates from the discovery pool — they appear in Outreach immediately.` | **REWRITE — RETIRED VOCABULARY** ("shortlist", "discovery pool", "Outreach"). → `Bookmark the candidates worth talking to — we'll reach out for you.` |
| 7.10 | `:113` | `{n} expert(s) ready for vetting call review.` / `Record outcomes` | **CUT** — the vetting-call/Screen step is retired and is pure staff work. |
| 7.11 | `:121` | `{n} expert(s) are client-ready. Export the brief to deliver.` / `Export brief` | **CUT** — again addresses staff, not the client who is reading it. |

### 7b. Brief step

| # | file:line | text | verdict |
|---|---|---|---|
| 7.12 | `:448-450` | `Have a brief document?` / `Upload a PDF or text file and we'll fill in the fields below. Word docs: export to PDF first.` | **KEEP** — honest about the limitation. |
| 7.13 | `:460` | `{parsing ? 'Reading document…' : 'Upload Brief'}` | **KEEP** |
| 7.14 | `:368` | `Brief imported — {n} additional fields saved to the full brief. Review and edit before sourcing.` | **REWRITE** — "the full brief" refers to fields the UI never shows, so the user is told about invisible data. Either show them or drop the clause. |
| 7.15 | `:332` | `Document is too large — 5 MB max.` | **KEEP** |
| 7.16 | `:478`, `:483` | `What's the business problem?` / placeholder `e.g. We're evaluating entry into cold chain logistics in the Southeast` | **KEEP** — excellent. |
| 7.17 | `:489`, `:494` | `What type of person do you want to talk to?` / placeholder `e.g. Someone with 20+ years in the poultry industry, former VP or Director level at a major integrator like Tyson, Pilgrim's, or Koch Foods` | **KEEP** — the best placeholder in the product. |
| 7.18 | — | **MISSING** | `docs/MATCHY_SPEC.md` requires **`clientRateMin` / `clientRateMax` per project** ("the band is the rule") so Matchy knows how far it can negotiate. There is no rate-band field on the brief. |
| 7.19 | `:510`, `:524` | `Complete Brief →` / `Source Experts →` | **REWRITE** — two primary buttons doing near-identical things is a decision the user shouldn't have to make. Collapse to one `Find experts →`. |
| 7.20 | `:521`, `:644`, `:1652` | `Sourcing experts…` / `Sourcing timed out — try again.` | **KEEP** |
| 7.21 | `:529-530` | `Complete Brief saves and moves to Source. Source Experts saves and runs AI discovery in the background — you can keep working, or close the tab and come back.` | **REWRITE — MACHINERY TALK.** Explains the app's own button semantics and names "AI discovery". → `We'll keep looking in the background — close the tab and come back whenever.` |
| 7.22 | `:540`, `:547` | `Danger Zone` / `Delete Project` | **REWRITE** — "Danger Zone" is GitHub-developer idiom, off-register for a PE workspace. → `Delete this project`. |
| 7.23 | `:1212` | `Delete this project? All experts, notes, and screening data will be permanently removed. This cannot be undone.` | **KEEP** (drop "screening"). |

### 7c. Source step — the biggest machinery-talk cluster

| # | file:line | text | verdict |
|---|---|---|---|
| 7.24 | `:1753-1755` | `Who might have the knowledge we need?` — *"Run brief-informed sourcing to populate the discovery pool. Shortlist the strongest candidates — they appear in the Outreach tab immediately."* | **REWRITE — RETIRED + JARGON.** Four internal terms in one sentence ("brief-informed sourcing", "discovery pool", "shortlist", "Outreach tab"). → `Who's actually done this? Bookmark anyone worth a call — we'll take it from there.` |
| 7.25 | `:721` | `Source Experts for This Project` | **KEEP** (rename to `Find experts`). |
| 7.26 | `:724` | `Experts are sourced against the full brief — key questions, hypotheses, required expertise, and exclusions.` | **CUT — DESCRIBES FIELDS THAT DON'T EXIST.** The brief UI has exactly **two** fields (business problem, expert type). "Key questions, hypotheses, required expertise, exclusions" are not collectible anywhere. This tells the client we use inputs they were never asked for. |
| 7.27 | `:726` | `({n} brief context field{s} active)` | **CUT — MACHINERY TALK.** Exposes an internal counter (`briefContextDepth`) that means nothing to a client. |
| 7.28 | `:756`, `:759` | chips `Business problem` / `Expert type` | **KEEP** |
| 7.29 | **`:580-587`** | **rotating loader: `Scanning 1B+ professional profiles...` · `Cross-referencing industry experience...` · `Surfacing the people who've actually done this...` · `Filtering out the LinkedIn influencers...` · `Ranking by relevance, not just keywords...` · `Almost there — quality over speed...` · `Checking seniority and recency...` · `Building your shortlist...`** | **CUT — HIGH PRIORITY.** (a) **"Scanning 1B+ professional profiles" is a fabricated capability claim** — the sourcing job is an LLM call plus web search, it does not query a billion-profile database. Shipping a made-up number to PE buyers is the kind of thing that ends a diligence conversation. (b) The whole set is machinery narration of AI internals — exactly what the founder ruled out. (c) "Filtering out the LinkedIn influencers" is a joke that reads as unserious in a $250/seat product. (d) "Building your shortlist" uses retired vocabulary. Replace with one honest line: `Finding people who've actually done this — usually a few minutes.` |
| 7.30 | `:770` | `This runs on our servers and takes a few minutes. You can switch tabs, close this page, and come back.` | **REWRITE** — "runs on our servers" is infrastructure detail. → `This takes a few minutes. Close the tab if you like — we'll keep going.` |
| 7.31 | `:790` | `Limited direct expert pool. Showing direct matches first — adjacent material and domain perspectives appear below.` | **REWRITE** — "Limited direct expert pool" reads as a failure report on the client's own question. → `Few exact matches for this one. The closest fits are first; related perspectives are below.` |
| 7.32 | `:798-800` | `{n} core expert(s) in the discovery pool below.` / `No core experts from the last run.` / `Adjacent perspectives are listed below — add the ones worth pursuing.` | **REWRITE** — "core expert", "discovery pool", "last run" are all internal. |
| 7.33 | `:824`, `:827` | `Adjacent Perspectives` / *"These candidates may not directly own the primary domain, but can help evaluate material, technical, or commercialization pathways."* | **REWRITE** — "own the primary domain" and "commercialization pathways" are consultant word-salad. → `Not a direct match, but close enough to be useful — suppliers, buyers, regulators, adjacent operators.` |
| 7.34 | `:807`, `:815`, `:869` | `{n} adjacent candidate(s) not yet added` / `Add All ({n})` / `✓ Added` | **KEEP** |
| 7.35 | `:1785` | `Discovery Pool` | **REWRITE** → `Candidates` |
| 7.36 | `:918-922` | filter labels `All` / `Discovered` / `Shortlisted` | **REWRITE** — status jargon. → `All` / `New` / `Bookmarked` |
| 7.37 | `:1053`, `:1058`; `lib/seniorityClassifier.ts:43-44` | sort labels `Seniority` / `Relevance score`; `Seniority (Executive first)` / `Relevance score (High first)` | **KEEP** |
| 7.38 | `:1072`, `:1079` | `Sorted by: {label}` / `{visible} of {total} experts` | **KEEP** |
| 7.39 | `:1088`, `:1141`, `:1807`, `:1811` | `Clear filters ✕` / `Clear filter ✕` / `No experts match these filters.` / `Clear filters` | **KEEP** |
| 7.40 | `lib/seniorityClassifier.ts:84-85` (rendered `:1095`) | `Tier rates shown are opening positions — final rates are negotiated per engagement.` | **KEEP the sentence, FIX the numbers it disclaims** — see 7.41. |
| 7.41 | **`lib/seniorityClassifier.ts:6-8`** | **`TIER_PRICING`: `executive { callRate: 800, expertRate: 560 }`, `senior { callRate: 600, expertRate: 420 }`, `mid { callRate: 400, expertRate: 280 }`** | **REWRITE — CRITICAL, WRONG NUMBERS EVERYWHERE.** This one constant is the source of every rate string in the product (`ExpertCard.tsx:99`, `ProjectExpertCard.tsx:161`, the `/pricing` table, the PDF). It encodes the **retired 30% take** and the **retired $400/$600/$800 client rates**. Per spec it must become: expert $400/$650/$800, client $800/$1,300/$1,600 (50% take, rounded up to the next $50). **Until this changes, every rate a client sees on every card is roughly half what they will actually be charged.** |

### 7d. Outreach step

| # | file:line | text | verdict |
|---|---|---|---|
| 7.42 | `:1838-1841` | `Find, contact, and schedule.` — *"Shortlisted experts enter here. Find their professional email, generate interview prep questions, draft and send outreach, track replies, send an availability request, and confirm the vetting call slot. Record call outcomes in Screen."* | **CUT — WRITTEN FOR STAFF, SHOWN TO CLIENTS.** This is an operator runbook: it hands the client seven manual jobs that Matchy is supposed to do silently. → `We've reached out. Replies land here — we'll tell you when there's something to decide.` |
| 7.43 | `:1140`, `:1152`, `:1163` | `Outreach mode` — `Review before sending` / `Auto-send drafts` | **REWRITE** — right idea, wrong words. Spec calls this the per-project **"review first" switch** with **auto-send as the default** (the code defaults to `'review'` at `:1845`). → `Send automatically` (default) / `Show me first`. |
| 7.44 | `:1849`, `:1852` | `No experts in outreach yet.` / `Shortlist candidates in Source first` | **REWRITE** → `Nobody contacted yet.` / `Bookmark a candidate to start.` |
| 7.45 | `lib/expertPipeline.ts:118-125` (rendered in `PipelineBar`) | stage labels `Pre-Outreach` · `Outreach Sent` · `Replied Yes` · `Needs Attention` · `Scheduled` · `Completed` · `Billed` · `Declined` | **REWRITE** — a CRM funnel shown to the buyer. Client-legible set: `Reached out` · `Interested` · `Needs you` · `Booked` · `Done` · `Passed`. |
| 7.46 | **`lib/expertPipeline.ts:134-136`** | **status labels `Email 1 Sent` · `Email 2 Sent` · `Scheduling Sent`** | **CUT — RETIRED CADENCE, CLIENT-VISIBLE.** These render as pills on the client's own cards. The 3-email cadence is explicitly being retired. → `Reached out` / *(remove)* / `Sent times`. |
| 7.47 | `lib/expertPipeline.ts:129-142` | remaining status labels `Discovered` · `Shortlisted` · `Rejected` · `Contact Found` · `Draft Ready` · `Rate Negotiation` · `Conflict Flagged` | **REWRITE** — `Contact Found` and `Draft Ready` are pure machinery (spec: *"Never provider names, confidence scores, or how it got there"*); `Rejected` is harsh for a person who simply said no (`Declined` already exists for the same thing at :142 — inconsistent). |
| 7.48 | `PipelineBar.tsx:98`, `:133`, `:141` | `Filter outreach by pipeline stage` / `Filtered — {stage}` / `Clear filter ✕` | **KEEP** (relabel with 7.45). |
| 7.49 | `:1868`, `:1874` | `No experts at the {stage} stage right now.` / `Clear filter — show all {n} experts` | **KEEP** |

### 7e. Outreach card — `components/OutreachCard.tsx`

| # | file:line | text | verdict |
|---|---|---|---|
| 7.50 | `:455`, `:463` | `Step 1 — Find Email` / `Find professional email` | **CUT — SHOULD BE SILENT.** Contact discovery is Matchy's autonomous job; the spec's client-visible version is at most *"Address found for Scott."* A client should never be asked to hunt for an email. |
| 7.51 | `:492` | `Contact` + the raw email address (`EmailRow`, `:99-104`) | **CUT — ANONYMIZATION LEAK.** The product promise (`IdentityProtectedLabel`) is *"Identity protected until a call is scheduled"* and the spec says *"The client never sees a raw email address."* This card prints `scott.smith@tyson.com` — which defeats the entire anonymization model and lets the client go around ExpertMatch. **Highest-severity contradiction in the app.** |
| 7.52 | `:124-125`, `:91-92` | `Hunter.io` / `Snov.io` / `Checked {date}` | **CUT — VENDOR NAMES TO CLIENTS.** Directly violates *"Never provider names."* |
| 7.53 | `EmailStatusBadge.tsx:9-27` | `Verified professional email` · `Catch-all domain` · `Unverified / risky` · `Do not use` · `No email found` | **CUT (client) / KEEP (staff).** Email-deliverability verdicts are ops data. "Do not use" and "risky" tell a client nothing they can act on. |
| 7.54 | `:516`, `:976` | `Expert Rate` | **REWRITE — WRONG SIDE OF THE WALL.** The spec is explicit: `expertRate` is *"Shown only to the expert and to staff"*; the client sees `clientRate`. This card shows the client what the expert is paid, exposing the 50% spread. → show `Your rate` / `clientRate`. |
| 7.55 | `:528`, `:623` | placeholder `e.g. 500` | **KEEP** (staff field). |
| 7.56 | `:258`, `:328` | `Rate must be between $1 and $9,999/hr` / `Enter a valid rate between $1 and $9,999/hr` | **KEEP** |
| 7.57 | `:560` | `Manual Draft` / `View / Regenerate ↻` | **CUT — LEGACY.** Self-described legacy path (comment at `:556`). |
| 7.58 | **`:577`, `:587`** | **`Email Sequence` / `Send Email 1 →`** | **CUT — RETIRED CADENCE.** |
| 7.59 | **`:643`, `:651`, `:675`, `:685`** | **`Email Sequence Status` / `Email 1 — Interest check` / `Email 2 — Conflict check + rate confirmation` / `Email 3 — Scheduling link`** | **CUT — RETIRED CADENCE, THE CLEAREST CASE IN THE CODEBASE.** This is the literal Email 1/2/3 timeline rendered on the client's card. Replace with the Matchy thread. |
| 7.60 | `:665`, `:697` | `Awaiting reply…` / `Awaiting scheduling…` | **KEEP** — these two survive into the Matchy thread. |
| 7.61 | `:661-664` | `Reply detected — Interested / Declined / Counter rate / Conflict flagged / Unclear` | **REWRITE** — "Reply detected" is sensor language; and per spec the client should get a **plain-language summary**, not a one-word classifier output. → `Scott replied — interested. Free Tue/Thu afternoons.` |
| 7.62 | `:714` | `Declined — no further action` | **REWRITE** → `Scott passed.` |
| 7.63 | `:724`, `:728` | `Rate Negotiation` / `Expert proposed: ${n}/hr` | **REWRITE — WRONG NUMBER SHOWN.** Spec: when an expert counters, the client must see the **converted client-side** number (*"Scott wants $650/hr → that's $1,300/hr for you"*). Showing the raw expert counter exposes the spread and understates the client's cost by half. |
| 7.64 | `:748`, `:756` | `Approve` / `Pass` | **KEEP** — verbs, not chat. Good. |
| 7.65 | `:767`, `:778`, `:785` | `Conflict Flagged` / `Reject` / `Override — Continue` | **REWRITE** — "Override" is admin-console language and, for a compliance control, dangerously casual. → `Proceed anyway`. |
| 7.66 | `:800`, `:806`, `:810`, `:820` | `Resend Scheduling Link ↻` / `Scheduling link resent ✓` / `Or confirm slot manually if expert replies with a time:` / `Confirmed Slot` | **CUT — MANUAL WORK, RETIRED.** Matchy proposes times from the client's calendar and books; the client should never paste a time string. |
| 7.67 | `:814` | placeholder `e.g. Tue Jun 10, 2:00 pm` | **CUT** (with 7.66) |
| 7.68 | `:866`, `:875` | `Complete Engagement` / `✓ Completed` | **REWRITE** — "Complete Engagement" is a manual staff action; the Zoom webhook already does this. Also this is a *button on the client's card* that triggers billing. |
| 7.69 | **`:960`, `:983`, `:1022`** | **`Call Duration (minutes)` / `Invoice Amount` / helper `rate × duration / 60`** | **CUT — NO 15-MINUTE MINIMUM, AND IT SHOWS THE FORMULA.** `submitComplete` (`:375`) computes `rate * dur / 60` with **no floor at 15 minutes**, so a 6-minute call bills 6 minutes. Both the copy and the arithmetic contradict the decided pricing. Also `:369` allows a `1`-minute call. |
| 7.70 | `:854`, `:591`, `:284`, `:288` | `Set expert rate before marking complete.` / `Set the expert rate to enable sending` / `No email address on file — find the email first.` / `Set expert rate before sending.` | **CUT (client-facing)** — every one of these is an instruction to the client to do staff work. |
| 7.71 | `:307`, `:308`, `:309` | `Outreach has already started for this expert.` / `This address has opted out of outreach.` / `Could not verify the do-not-contact list. Try again shortly.` | **KEEP** (staff) — accurate and specific. |
| 7.72 | `:352` | `Too many requests. Please wait an hour and try again.` | **KEEP** |
| 7.73 | `:894`, `:897` | `Payout processed {date}` / `Awaiting expert payout setup` | **CUT (client)** — the expert's Stripe Connect state is none of the client's business. |
| 7.74 | `components/IdentityProtectedLabel.tsx:36` | `Identity protected until a call is scheduled` | **KEEP — the single best sentence in the product.** It states the anonymization promise plainly and names what unlocks it. (Contradicted by 7.51/7.52 — fix those, not this.) |

### 7f. Screen step — `components/ScreeningCard.tsx`

Whole surface is **CUT — RETIRED**: the Screen tab folds into the conversation thread, and this is staff-only vetting work presented on the client's screen.

| # | file:line | text | verdict |
|---|---|---|---|
| 7.75 | `:1904-1907` | `Vetting call done — what did you learn?` — *"Record pass / fail / no-show, capture key insights, and flag conflicts. Passed experts move to Deliver for client call scheduling. No-shows return to Outreach for follow-up."* | **CUT** — describes a staff pre-screening call the self-serve client never runs. |
| 7.76 | `:1916` | `Evaluating against` | **CUT** |
| 7.77 | `:1929`, `:1932` | `No experts at the vetting call stage yet.` / `Move experts through Outreach first` | **CUT** |
| 7.78 | `ScreeningCard.tsx:188` | `Vetting Call Outcome` + buttons `Pass` / `Fail` / `No Show` | **CUT** — "Fail" as a verdict on a named human, rendered next to their name, is a tone problem even internally. |
| 7.79 | `ScreeningCard.tsx` (verdict notes) | `Passed — moving to Deliver.` / `Failed — removed from pipeline.` / `No show — returned to Outreach for follow-up.` | **CUT** |
| 7.80 | `ScreeningCard.tsx:254` | placeholder `What did you learn on this call? Key themes, surprises, hesitations…` | **KEEP the wording, move it** — this is a good prompt; it belongs on the post-call notes in the thread. |
| 7.81 | `ScreeningCard.tsx:312-314` | placeholders `Core expertise confirmed…` / `Key nuance or caveat…` / `Relevant risk or flag…` | **KEEP the wording, move it** (same as 7.80). |
| 7.82 | `ScreeningCard.tsx:334`, `:367` | `Conflict:` (unknown/low/medium/high) / `Recommend to client` | **CUT** — "Recommend to client" is unanswerable when the reader *is* the client. |
| 7.83 | `ScreeningCard.tsx` | `⚠ High conflict risk — confirm before passing.` | **KEEP** (staff) — a real safeguard, worth preserving wherever conflicts land. |

### 7g. Deliver step

| # | file:line | text | verdict |
|---|---|---|---|
| 7.84 | `:1957-1958` | `What does the client receive?` — *"Experts cleared on knowledge fit, conflicts, communication quality, and availability — ready to deliver to the client."* | **CUT — ADDRESSES THE WRONG PERSON.** Literally asks the client what the client receives. |
| 7.85 | `:1980-1981` | `No client-ready experts yet.` / `Record vetting call outcomes in the Screen step — passed experts appear here.` | **CUT** |
| 7.86 | `:1986` | `Client-Ready Experts` | **CUT** → `Booked` / `Your calls` |
| 7.87 | `:1995`, `:2000`, `:2005` | `Scheduled` / `Overlap found — invite pending` / `Availability received` | **REWRITE** — "Overlap found" is the internal name of `lib/computeOverlap.ts`. → `Found a time — sending the invite`. |
| 7.88 | `:2013`, `:2029`, `:2036` | `📹 Zoom Created` / `🟢 Call in Progress` / `✓ Call completed · {n} min` | **REWRITE** — "Zoom Created" is a system event. → `Zoom ready`. The rest is fine. |
| 7.89 | `:2043`, `:2046` | `Rate Not Set` / `Set the expert rate to send the invoice automatically.` | **CUT (client)** — staff task on the client's screen; and again names `expertRate` (7.54). |
| 7.90 | `:2054`, `:2061`, `:2079`, `:2091`, `:2121` | `Invoice Pending` / `Invoice Sent` / `Paid ✓` / `Payment Failed` / `Resend Invoice` | **REWRITE** — the decided model is an **auto-charge on the saved card**, not invoicing. → `Charging…` / `Charged $X` / `Card declined — update your card`. Per spec the wrap-up line is *"Call ran 47 min → $627 charged."* |
| 7.91 | `:1972`, `ClientSchedulingSection.tsx:100-107` | `Client Scheduling` / *"Collect the client's availability, then match it against expert slots to find a call time."* + fields `Client Name` / `Client Email` / `Request Client Availability` | **CUT — THE PRODUCT MODEL IS INVERTED HERE.** This asks the logged-in user to type in *"the client's"* name and email — i.e. it assumes ExpertMatch staff are operating the tool on behalf of an outside client. In the self-serve product the logged-in user **is** the client and their calendar was already connected during onboarding. Whole section should go. |
| 7.92 | `ClientSchedulingSection.tsx:116`, `:126` | placeholders `e.g. Sarah Johnson` / `client@company.com` | **CUT** (with 7.91) |
| 7.93 | `ClientSchedulingSection.tsx:168`, `:191` | `Request Client Availability` / `Resend Request` | **CUT** (with 7.91) |
| 7.94 | `ClientSchedulingSection.tsx` | `Requested — awaiting response` / *"Availability request sent to {name}. This page will update once they submit."* / `✓ Received — availability on file` | **CUT** (with 7.91) |
| 7.95 | `ClientReadyCard.tsx:82` | badge `Client Ready` | **REWRITE** → `Ready to book` |
| 7.96 | `ClientReadyCard.tsx` | `Value chain:` / `Knowledge:` / `Comm.:` / `Conflict risk:` / `Availability:` | **REWRITE** — `Comm.` is an unexplained abbreviation; `Knowledge`/`Comm.` are dot-ratings with no legend. |
| 7.97 | `ClientReadyCard.tsx:9-16` | value-chain labels `Supplier / Input` · `Equipment Vendor` · `Producer / Operator` · `Processor / Manufacturer` · `Distributor` · `Retail / Customer` · `Regulator / Academic` · `Investor / Advisor` | **KEEP** — legitimate domain taxonomy, genuinely useful to a PE reader. |

### 7h. Shared modals and controls

| # | file:line | text | verdict |
|---|---|---|---|
| 7.98 | `:166` | `Expert Profile` | **KEEP** |
| 7.99 | `:232`, `:245`, `:213` | `Interview Guide` / `Generating interview guide…` / `Failed to generate guide.` | **KEEP** — genuinely valuable client feature. Consider renaming `Call prep`. |
| 7.100 | `:252`, `:256`, `:266`, `:276` | `Opening Script` / `Must-Ask Questions` / `Tailored Questions` / `Diligence Risks` | **KEEP** — strong, on-audience. |
| 7.101 | `:1311`, `:1328`, `:1334`, `:1345`, `:1354`, `:1370` | `Share Project` / `Add by email` / `colleague@firm.com` / `Invite` / `Collaborators` / `No collaborators yet.` | **REWRITE (one gap)** — per spec, *"only the project owner (or staff) can send to experts; collaborators are read-only."* Nothing here says that, so a shared-in colleague will not know what they can't do. Add: *"Collaborators can see everything and add notes. Only you can start outreach."* |
| 7.102 | `:1271`, `:1291` | `Failed to add collaborator` / `Failed to remove collaborator` | **KEEP** |
| 7.103 | `app/api/projects/[projectId]/collaborators/route.ts:62` | `That email does not belong to an existing user or approved firm.` | **KEEP** |
| 7.104 | `:1594`, `:1609`, `:1617`, `:1625` | `← Projects` / `Client View ↗` / `Share` / `Export Brief` | **REWRITE (`Client View`)** — a *client* looking at a button labelled "Client View" learns there is a version of this screen being hidden from them. → `Shareable summary`. Its tooltip `Open client-safe view (no internal notes)` (`:1607`) is worse — it announces the existence of internal notes about them. |
| 7.105 | `:1539`, `:1548`, `:1549`, `:2180` | `Loading project…` / `Project not found.` / `Back to Projects` / `Loading…` | **KEEP** |
| 7.106 | `:1701` | `Experts have already been sourced for this brief. Review the brief, then continue to Source.` | **KEEP** |
| 7.107 | `ProjectExpertCard.tsx:161`, `:163` | `${pricing.callRate}/call` / `Agreed: ${n}/call` | **REWRITE — WRONG NUMBER (see 7.41).** Shows the retired client rate; and `/call` is misleading for an hourly rate with a 15-min minimum. → `$1,300/hr · 15 min minimum`. |
| 7.108 | `ProjectExpertCard.tsx:176`, `:184`, `:191`, `:213` | `★ Shortlist` / `✗ Reject` / `★ Shortlisted` / `✗ Rejected` | **REWRITE — RETIRED VERB.** Spec replaces this with **Bookmark**, and bookmarking is what starts outreach. → `Bookmark` / `Pass`. "Reject" on a person is needlessly cold. |
| 7.109 | `ProjectExpertCard.tsx:204` | `→ Added to Outreach` | **REWRITE** → `We'll reach out to Scott and let you know.` |
| 7.110 | `ProjectExpertCard.tsx:10-20` | rejection reasons `Too Generic` · `Wrong Industry` · `Wrong Geography` · `Weak Evidence` · `No Contact Path` · `Conflict Risk` · `Not Senior Enough` · `Too Academic` · `Vendor Biased` · `Better Option Available` · `Other` | **KEEP** — these feed the learning loop; well-chosen. (`No Contact Path` is machinery — rename `Couldn't reach them`.) |
| 7.111 | `ProjectExpertCard.tsx:246-249` | placeholders `Note the conflict (not shared externally)…` / `Who is the better option?` / `Add a note on this rejection…` | **KEEP** |
| 7.112 | `ProjectExpertCard.tsx:134` | `window.confirm('Remove this expert from the project?')` | **REWRITE** — a raw browser `confirm()` in a product that has a custom modal three files away. Inconsistent and unstyled. |
| 7.113 | `ProjectExpertCard.tsx:290`, `:312`, `:318` | `Email:` + address / `+ Add note` / `Interview guide →` | **CUT (`Email:`)** — same anonymization leak as 7.51. |
| 7.114 | `ExpertCard.tsx:90`, `:96` | `Score` / tier badges `Executive` · `Senior` · `Mid-Level` | **KEEP** |
| 7.115 | `ExpertCard.tsx:99` | `${pricing.callRate}/call` | **REWRITE** (see 7.41 / 7.107) |
| 7.116 | `ExpertCard.tsx:129`, `:175` | `Evidence` / `Sources` | **KEEP** — but note `lib/redactExpert.ts` strips both for `role==='user'`, so **clients never see these sections**, which makes the landing page's "Full evidence trail" claim (1.22) false. |
| 7.117 | `ExpertCard.tsx:206` | `Draft Outreach` | **CUT — RETIRED.** Manual drafting is replaced by Matchy's templates. |
| 7.118 | `OutreachModal.tsx:93` | `Outreach Draft` | **CUT** (with 7.117) |
| 7.119 | `OutreachModal.tsx:181-182` | `Composing message...` / `Calibrating to {name}'s profile` | **CUT — MACHINERY TALK + FAKE PROGRESS.** "Calibrating to the profile" describes nothing real. |
| 7.120 | `OutreachModal.tsx:172`, `:206`, `:212` | `Subject Line` / `Message` / `Copy to Clipboard` / `Dismiss` | **CUT** (with 7.117) |
| 7.121 | `OutreachModal.tsx:117` | badge `Company inbox` | **CUT** (with 7.117) |
| 7.122 | `ContactSection.tsx:406`, `:420`, `:453`, `:568`, `:592`, `:830`, `:879` | `Contact` / `Company domain` / `Find contact paths` / `Professional Email` / `Find professional email` / `Generate outreach` | **CUT (client) / KEEP (staff, admin-only).** These routes are admin-gated per `HANDOFF.md`, but the component still renders inside `ExpertCard`. |
| 7.123 | `ContactSection.tsx:305` | `Insufficient email-provider credits to perform this lookup.` | **CUT (client)** — exposes ExpertMatch's own vendor billing state. Staff-only. |
| 7.124 | `ContactSection.tsx:358` | `Re-checking may spend one or more contact lookup credits. Continue?` | **CUT (client)** — same; also a raw `window.confirm`. |
| 7.125 | `ContactSection.tsx:860` | `This company uses catch-all email routing — delivery not guaranteed.` | **KEEP** (staff) |
| 7.126 | `ContactSection.tsx:66-68` | `Enter a valid domain (e.g. acmecorp.com)` / `Enter a company domain, not a personal email provider` / `Internal/reserved domain not allowed` | **KEEP** |
| 7.127 | `lib/sourcingJob.ts:144` | `No experts found. Try broadening the brief or adjusting the research question.` | **KEEP** |
| 7.128 | `lib/sourcingJob.ts:180`, `:183` | `Expert generation failed while formatting results. Please try again or simplify the brief.` / `Expert sourcing failed. Please try again.` | **REWRITE (first one)** — "Expert generation failed while formatting results" is a stack trace in prose. → `Something went wrong finding experts. Try again, or simplify the brief.` |
| 7.129 | `app/api/projects/[projectId]/source-experts/route.ts:76` | `Add a business problem to the brief before sourcing.` | **KEEP** |
| 7.130 | `app/api/parse-brief/route.ts:76-154` | `No document was uploaded.` · `Document is too large — 5 MB max.` · `Upload a PDF or plain-text file. For Word documents, export to PDF first.` · `Could not read the document. Try again.` · `This document does not look like a project brief — no research question found.` | **KEEP** — all six are specific and actionable. Best error set in the codebase. |
| 7.131 | **`lib/projectsGuard.ts:36`** | **`Projects are disabled. Set PROJECTS_ENABLED=false to disable.`** | **CUT — INTERNAL LEAK + LOGICALLY BACKWARDS.** Shows a user an env-var name and then instructs them to do the thing that already happened. → `Projects are temporarily unavailable. We're on it.` |

### 7i. Exported brief PDF — `lib/exportBrief.tsx`

| # | file:line | text | verdict |
|---|---|---|---|
| 7.132 | `:329`, `:342` | `EXPERTMATCH` / `RESEARCH QUESTION` | **KEEP** |
| 7.133 | `:349` | `RECOMMENDED EXPERTS` | **KEEP** |
| 7.134 | `:380`, `:384-392` | `SCREENING SUMMARY` / `PASSED` · `FAILED` · `PENDING` | **CUT — RETIRED + WRONG AUDIENCE.** A PDF the client keeps, labelling named people `FAILED`. |
| 7.135 | `:423`, `:265-271` | `OUTREACH STATUS` + `Contact Found` · `Outreach Drafted` · `Contacted` · `Replied` · `Scheduled` · `Completed` | **REWRITE** — internal pipeline states in a client deliverable (`Outreach Drafted` and `Contact Found` are pure machinery). |
| 7.136 | `:441` | footer `Generated by ExpertMatch · {date}` | **KEEP** |
| 7.137 | — | **MISSING** | The exported PDF carries **no confidentiality notice and no rate information** — the two things a PE reader most expects on a deliverable. (`client-view` does say "Confidential"; the PDF doesn't.) |
---

## 8. Emails — `lib/emailSequence.ts`, `lib/outreachSteps.ts`, `lib/sendAvailabilityRequest.ts`, `lib/createAndSendInvoice.ts`, `lib/expertPayout.ts`, `lib/outreachFooter.ts`, `lib/triggerOverlapCheck.ts`

The single largest block of retired copy. The **entire 3-email cadence is live in production code** and is the thing `docs/MATCHY_SPEC.md` exists to replace.

### 8a. The retired cadence — CUT in full

| # | file:line | text | verdict |
|---|---|---|---|
| 8.1 | `lib/emailSequence.ts:1-8` | file header: *"Automated 3-email outreach sequence… Email 1 — interest check… Email 2 — conflict check + rate confirmation… Email 3 — scheduling link and firm name revealed"* | **CUT — RETIRED.** Delete the file when the Matchy relay lands. |
| 8.2 | `lib/emailSequence.ts:83-92` | system prompt `You write cold outreach emails for a research firm… Sound like a sharp 30-year-old analyst, not a recruiter` | **CUT (with the file), SALVAGE THE TONE RULES.** The anti-corporate-filler instructions are good and should be carried into Matchy's templates. |
| 8.3 | **`lib/emailSequence.ts:101-114`** | **Email 1 prompt: `Ask if they would be open to a paid consulting call ($${rate}/hr, billed per minute) about ${query}`** | **CUT — AND IT'S THE 15-MINUTE-MINIMUM VIOLATION.** As written, an expert can reasonably infer a 3-minute call pays 3 minutes' worth. Any surviving version must say *"billed per minute after a 15-minute minimum."* Also: per spec the **intro must never mention money at all**. |
| 8.4 | **`lib/emailSequence.ts:141-152`** | **Email 2 prompt: `The proposed rate is $${rate}/hr, billed per minute — it is not yet agreed… Would $${rate}/hr, billed per minute, work for you?`** | **CUT — same 15-min gap.** But note the framing (*"it is not yet agreed"*, *"Would … work for you?"*) is **exactly right** — asked, never asserted, per spec §4. Preserve that phrasing verbatim in Matchy's follow-up. |
| 8.5 | `lib/emailSequence.ts:182-196` | Email 3 prompt: `Reveal the client firm is ${firmName}… End with: 'Please keep this engagement confidential.'` | **CUT.** Salvage the confidentiality line. **Also verify:** this reveals the client's firm name *before* the call is booked; spec says identity reveals both ways **at `scheduled`**. |
| 8.6 | `lib/emailSequence.ts:249-266` | `sendSequenceEmail` — plain-text Resend send + footer | **CUT.** Keep the footer plumbing (`buildOutreachFooter`) and repoint it at Matchy's sends. |
| 8.7 | `lib/outreachSteps.ts:24, 73-130` | `EmailStep = 'email1' \| 'email2' \| 'email3'` and the branch logic setting `contacted` / `email2_sent` / `scheduling_sent` | **CUT — RETIRED STATE MACHINE.** The status names themselves encode the cadence and leak into the client UI (7.46). |
| 8.8 | `app/api/email-sequence/trigger/route.ts` (whole file) | QStash consumer that fires the Email 2/3 delays (random 5–12 min, `lib/emailSequence.ts:61`) | **CUT — RETIRED.** Named for retirement in `docs/MATCHY_SPEC.md` § API surface. |
| 8.9 | `app/api/projects/[projectId]/experts/[expertId]/outreach/start/route.ts:1-5` | *"this is what the 'Send Email 1' button calls"* | **CUT — RETIRED,** but **preserve the safety logic**: no-rate → 422, suppressed address → 403, suppression-check failure → **fail closed** 503. That fail-closed behaviour must survive into whatever replaces it. |

### 8b. Expert-facing transactional email — mostly good

| # | file:line | text | verdict |
|---|---|---|---|
| 8.10 | `lib/sendAvailabilityRequest.ts:248` | subject `Scheduling Request — {projectName}` | **KEEP** |
| 8.11 | `lib/sendAvailabilityRequest.ts:80-88, 132-138` | *"Thank you for your willingness to speak with our team regarding **{projectName}**. Please use the link below to share a few times that work for you."* | **KEEP for the expert.** (Misapplied to clients — see 8.14.) |
| 8.12 | `lib/sendAvailabilityRequest.ts:272-401` | `sendConfirmationEmail` — subject `Your expert call is confirmed — {date}`; *"Your call is confirmed… Join Zoom: … A calendar invitation is attached."* | **KEEP** — clean transactional copy. |
| 8.13 | `lib/sendAvailabilityRequest.ts:371-377` | comment + guard: the opt-out footer is attached to the **expert's** copy only, *"offering them an outreach opt-out would suppress the wrong address"* | **KEEP — this is the correct pattern**, and the fix template for 8.14. |
| 8.14 | **`app/api/projects/[projectId]/request-client-availability/route.ts:117-122`** | reuses `sendAvailabilityRequest` for the **client**, so a paying signed-in customer receives *"Thank you for your willingness to speak with our team"* **plus the CAN-SPAM cold-outreach opt-out footer** | **REWRITE — HIGH SEVERITY, TWO BUGS IN ONE.** (a) Wrong voice — the client isn't the one being interviewed. (b) If the client clicks "Opt out", their address lands in the global `outreach_suppressions` do-not-contact table. `sendConfirmationEmail` two functions away already guards against exactly this. Fix: add `recipientType: 'expert' \| 'client'`, use a client subject/body (`Share your availability — {projectName}` / *"Pick a few times that work and we'll lock in the call."*), and **omit the footer entirely** on the client path. |

### 8c. Billing email — client-facing

| # | file:line | text | verdict |
|---|---|---|---|
| 8.15 | `lib/createAndSendInvoice.ts:96-121` | *"Your expert call with **{expertName}** has been completed… Please find your invoice below."* + `Pay Now — ${amount}` | **KEEP** — and note it correctly shows only the client-side number; the expert rate never appears in the same message (spec rule honoured). |
| 8.16 | `lib/createAndSendInvoice.ts:145-168` | receipt: *"We charged the card on file — no action is needed… Total charged: ${amount}"* | **KEEP** — this is the model the in-app Deliver copy should follow (7.90). |
| 8.17 | `lib/createAndSendInvoice.ts:295, 367` | subjects `Receipt for your expert call` / `Invoice for your expert call` | **KEEP** |
| 8.18 | `lib/createAndSendInvoice.ts:335` | Stripe product name `Expert Call — {project.name}` | **UNSURE** — the code deliberately excludes the expert's name from the card statement (good). But the **project name** goes on the statement, and project names in this product look like *"Cold Chain Logistics — Southeast Entry"* — i.e. the client's live deal thesis, printed on a shared corporate card statement. Founder call. |
| 8.19 | **`lib/createAndSendInvoice.ts:343-345`** | fallback success URL `https://expertmatch.ai/payment/success` | **REWRITE — WRONG DOMAIN.** Every other file uses `expertmatch.fit`. A client who has just paid can be redirected to a domain that may not be owned. |
| 8.20 | `lib/createAndSendInvoice.ts` (amounts) | invoice/receipt amount | **REWRITE — CHARGES THE WRONG SIDE.** `HANDOFF.md` and spec both record it: auto-billing currently charges **`expertRate`**, not `clientRate`. Every receipt the client receives is for roughly half the intended amount. |

### 8d. Expert payout email — a real money bug behind the copy

| # | file:line | text | verdict |
|---|---|---|---|
| 8.21 | **`lib/expertPayout.ts:66-84`** | *"Your call is complete and payment has been received… To receive your **${expertAmount}**, please set up your payout account. It takes about 5 minutes"* | **REWRITE — THE NUMBER IS WRONG.** `types.ts:291` defines `expertRate` as *already* 70% of `clientRate`, and the outreach cadence quotes that same `expertRate` to the expert as their pay — then `expertPayout.ts:146-152` multiplies by **0.70 a second time**. The expert is promised $X/hr in outreach and paid ~49% of the client rate. Two irreconcilable numbers in two emails about the same call. Fix the split before touching the copy — and the whole 70/30 model is superseded by the decided **50%**. |
| 8.22 | `lib/expertPayout.ts:115` | subject `Set up your payout account — ${expertAmount} waiting` | **KEEP once 8.21 is fixed** — good subject line. |
| 8.23 | `lib/triggerOverlapCheck.ts:159` | Zoom meeting title `Expert Call — {project.name}` | **KEEP** |
| 8.24 | `lib/triggerOverlapCheck.ts:193-202` | ICS description: `Expert: {name}, {title} at {company}` | **KEEP** — this is the deliberate identity-reveal boundary at `scheduled`, matching spec. |
| 8.25 | `lib/triggerOverlapCheck.ts:189-191` | organizer fallback hardcoded to `asher@expertmatch.fit` | **UNSURE** — a founder-personal-looking address baked into calendar invites sent to clients and experts whenever `OUTREACH_FROM_EMAIL` is unset. Should be a durable alias. |

### 8e. Compliance footer

| # | file:line | text | verdict |
|---|---|---|---|
| 8.26 | `lib/outreachFooter.ts:53, 58` | `Prefer not to hear from us? Opt out: {url}` / *"…Opt out of future emails."* | **KEEP** — clear, and the per-recipient HMAC token correctly prevents third-party unsubscribes. |
| 8.27 | **`lib/outreachFooter.ts:46`** | `const identity = address ? 'ExpertMatch · {address}' : 'ExpertMatch'` | **UNSURE — COMPLIANCE RISK.** If `OUTREACH_POSTAL_ADDRESS` is unset in prod, the postal address is **silently dropped** and cold commercial email ships without it. CAN-SPAM requires a valid physical address in every such message. `.env.example:75` still holds the placeholder *"100 Example St, Suite 200, Boston, MA 02110"*. Verify the real value is set in the `expertmatching` Vercel project — and consider failing the send rather than dropping the line. |

### 8f. Invite / access-request email

| # | file:line | text | verdict |
|---|---|---|---|
| 8.28 | `lib/sendAvailabilityRequest.ts:159-226` | subject `You're invited to ExpertMatch`; *"Your access to ExpertMatch has been approved for **{firmName}**. Set up your account here — the link expires in 7 days"* | **KEEP** — clean, accurate, no machinery talk. |
| 8.29 | `app/api/request-access/route.ts:136-142` | admin notification `New access request: {name} — {firm}` + Name / Firm / Email / Research focus | **KEEP** (internal) |
| 8.30 | `app/api/request-access/route.ts:28` | `ADMIN_NOTIFY_EMAILS = ['adgold28@colby.edu', 'ashergoldsteinbusiness@gmail.com']` | **UNSURE** — every access request for a premium B2B platform routes to a `.edu` address and a personal Gmail. Not copy, but it is the reply-to a prospect may eventually see. A `team@expertmatch.fit` alias would read very differently in diligence. |
| 8.31 | `lib/firmStore.ts:502-517` | internal alert `[ExpertMatch] Seat limit reached — {domain}` + `Active seats:` / `Seat limit:` | **KEEP (internal)** — but the numbers come from the retired `SEAT_LIMITS` (2.23). |
| 8.32 | `app/api/generate-outreach/route.ts:77-98` | system prompt: *"Never say 'expert network' or 'AlphaSights' or 'expert call'… Sound like a smart 28-year-old analyst, not a recruiter… 'Happy to work around your schedule if you have 20 minutes.'"* | **KEEP — MODEL COPY.** This is the founder's "no machinery talk, not a wrapper" instinct executed correctly. Use it as the tone brief for Matchy's templates. |
| 8.33 | `app/api/generate-outreach/route.ts:100-106` | *"Do not make up details not provided above."* | **KEEP** — the guardrail against inventing biography. Directly addresses the concern flagged in `docs/OUTREACH_BOT_AUDIT.md`. |
| 8.34 | — | **INCONSISTENCY** | The two outreach paths disagree: the automated cadence quotes a rate in the very first email, while the manual `generate-outreach` tool never mentions money. Spec sides with the manual tool (*"the intro never mentions money"*). |
| 8.35 | `lib/anonymizeExpert.ts:73` | *"NEVER include the person's name, their employer's name, a product name, a fund name, or any other detail that identifies one specific company or person."* + the "every number must be derivable from evidence" rule | **KEEP — MODEL PROMPT.** The strongest anti-hallucination instruction in the codebase; reuse its phrasing for Matchy's summarizer. |

---

## 9. Expert-facing web pages — `app/availability/*`, `app/expert-onboarding/*`, `app/outreach/unsubscribed`, `components/AvailabilityForm.tsx`

**The cleanest surface in the product.** No internal jargon ("shortlist", "screen", pipeline states, pricing) leaks to experts anywhere here. Three items need attention.

| # | file:line | text | verdict |
|---|---|---|---|
| 9.1 | `app/availability/[token]/page.tsx:46, 91` | `Hi {firstName} — let's find a time.` | **KEEP** — verbs, warm, no filler. Exactly the target voice. |
| 9.2 | `app/availability/[token]/page.tsx:49, 94` | *"Please share a few windows that work for you. This takes less than a minute."* | **KEEP** |
| 9.3 | `app/availability/[token]/page.tsx:61, 109` | `Questions? Reply to the email you received.` | **KEEP** |
| 9.4 | `app/availability/[token]/page.tsx:124-129` | `This link has expired` / *"Availability links expire after 7 days. Please ask your contact to resend the request."* | **KEEP** |
| 9.5 | `app/availability/[token]/page.tsx:129` | `Invalid link` / *"…contact your ExpertMatch representative."* | **KEEP** |
| 9.6 | `app/availability/[token]/page.tsx:143-147` | `Thanks, {firstName}!` / *"We already have your availability. Our team will be in touch to confirm the call."* | **KEEP** |
| 9.7 | `app/availability/success/page.tsx:27-36` | `All set — thank you!` / *"Your calendar has been connected. Our team will review your availability and reach out to confirm the call."* / `Questions? Reply to the email you received.` | **KEEP** |
| 9.8 | `app/availability/error/page.tsx:12, 16, 20, 28, 32, 36` | the six error messages (`access_denied`, `token_invalid`, `token_revoked`, `token_exchange_failed`, `server_error`, `rate_limited`) | **KEEP** — every one names the cause and offers a route out. |
| 9.9 | `app/availability/error/page.tsx:24` | `oauth_not_configured`: *"Google Calendar integration is not available right now. Please use Calendly or describe your availability manually."* | **UNSURE** — fires only on a missing env var. If it can fire in production that's a config bug, not a copy problem; verify Google OAuth is live in the `expertmatching` project. |
| 9.10 | `components/AvailabilityForm.tsx:185-335` | `How would you like to share your availability?` · `Google Calendar` / `Connect and share free/busy` · `Calendly` / `Paste your scheduling link` · `Describe your availability` / `Type a few times that work` · `Use This Link` · `Submit Availability` | **KEEP** — all of it. |
| 9.11 | `components/AvailabilityForm.tsx:257-259` | *"We'll use Google Calendar to check your free/busy times. No events or details will be shared — only whether you're available."* | **KEEP** — precise and true. Best privacy sentence in the product. |
| 9.12 | `components/AvailabilityForm.tsx:320` | placeholder `Monday–Wednesday, 9–11 AM ET` | **KEEP** |
| 9.13 | `components/AvailabilityForm.tsx:73-76, 164-167` | `Google Calendar connected` / `Got it — thank you!` / *"Our team will review your availability and send a calendar invite shortly."* | **KEEP** |
| 9.14 | `components/AvailabilityForm.tsx:341-343` | *"Your availability is shared only with the research team coordinating this call. It will not be stored beyond scheduling purposes."* | **UNSURE — UNVERIFIED DATA-RETENTION PROMISE.** Availability is persisted on the project record; nothing in the codebase purges it after scheduling. This is a commitment made to an outsider that the system does not keep. Either implement the deletion or soften to *"…used only to schedule this call."* |
| 9.15 | `app/expert-onboarding/[token]/page.tsx` | *(no copy — redirects straight to Stripe, `notFound()` on failure)* | **UNSURE** — an expert who has just agreed to a paid call is bounced into a bare Stripe onboarding flow with no ExpertMatch-branded "here's what this is" screen, and gets a default Next.js 404 if the token is bad. Worth one page of copy. |
| 9.16 | `app/expert-onboarding/refresh/page.tsx:10-21` | `Link Expired` / *"Please contact us at **asher@expertmatch.fit** for a new link."* | **REWRITE** — a founder-personal-looking address on the highest-stakes trust moment for an outsider (getting paid). → `support@expertmatch.fit`. |
| 9.17 | `app/expert-onboarding/return/page.tsx:10-14` | `Setup Complete` / *"Your payout account is set up."* | **KEEP** |
| 9.18 | `app/expert-onboarding/return/page.tsx:17` | *"You will receive payment within **2 business days** of your call."* | **UNSURE — UNBACKED SLA.** Nothing enforces two business days; `lib/expertPayout.ts` transfers on `payment_intent.succeeded`, and not at all if Connect onboarding is incomplete. Also contradicts `/pricing`'s *"within 5 business days"* (2.17) — **two different payment promises on the same site.** |
| 9.19 | `app/expert-onboarding/return/page.tsx:19-24` | *"If you have any questions, contact us at asher@expertmatch.fit."* | **REWRITE** — same as 9.16; one alias fixes both. |
| 9.20 | `app/outreach/unsubscribed/page.tsx:6` | `title: 'Unsubscribed — ExpertMatch'` + `robots: { index: false, follow: false }` | **KEEP** — the only page in the repo that sets `noindex`. Model for the internal tools (§10). |
| 9.21 | `app/outreach/unsubscribed/page.tsx:12-21` | `You're unsubscribed.` / *"You won't receive further outreach from ExpertMatch."* / *"Reply to any email you've received from us and we'll remove you **by hand**."* | **KEEP** — "by hand" is the most human line on the site. |
| 9.22 | `app/payment/success/page.tsx:29-33` | `Payment received.` / *"Thank you — we'll be in touch shortly."* | **KEEP** |

---

## 10. Admin and internal tools — `app/admin/*`, `app/rank-experts`, `app/screen-expert`, `app/demo-readiness`, `app/projects/[projectId]/client-view`

Weighted lower per brief — except for three routes that are **reachable by any logged-in client user**, which turns internal copy into client-facing copy.

| # | file:line | text | verdict |
|---|---|---|---|
| 10.1 | **`app/admin/requests/page.tsx:50-52`** | `PLAN_LABELS`: `Starter — 3 seats` · `Growth — 10 seats` · `Enterprise — unlimited` | **CUT — RETIRED PRICING MODEL.** Same root as 2.23 / `lib/firmStore.ts:29-45`. Also at `:363` (`{firm.plan} plan · {n} seats`), `:494-497`, `:737`. One constant fixes all. |
| 10.2 | `app/admin/requests/page.tsx:131-140, 168-177, 242` | access-request cards, `Approve + Send Invite`, `Approve + Invite`, `Reject` | **KEEP** (internal) |
| 10.3 | `app/admin/users/page.tsx` (all) | `All Users (N)` · `No users yet. Create one below.` · field labels · `Create User` / `Creating…` · `User created successfully.` | **KEEP** (internal) — nothing to flag. |
| 10.4 | `app/api/admin/invite/route.ts:45, 60, 79` | `This email domain is not approved for access. Contact your administrator.` / `A user with this email already exists.` / `Seat limit reached for this firm. Admin has been notified.` | **KEEP** — though the seat-limit message inherits the retired caps. |
| 10.5 | `app/api/admin/seat-requests/route.ts:79` | `Seat limit is still reached. Upgrade the firm plan first.` | **REWRITE** — "Upgrade the firm plan" is retired-model language; under per-seat billing you add a seat, you don't upgrade a plan. |
| 10.6 | `app/api/admin/users/route.ts:69, 157` | `Password must be at least 8 characters.` / `You cannot delete your own account.` | **KEEP** |
| 10.7 | **`app/rank-experts/page.tsx:1106`** | **`Deterministic scoring by category · AI rationale by Claude Opus · Click any row to expand`** | **CUT — NAMES THE MODEL VENDOR ON A ROUTE ANY LOGGED-IN CLIENT CAN REACH.** `/rank-experts` is not in `middleware.ts` `PUBLIC_PREFIXES` but is only **session**-gated, not admin-gated (`app/api/rank-experts/route.ts` checks `getSessionUser` for redaction only). Textbook machinery talk plus a vendor disclosure. → `Scored automatically · click any row to expand`. |
| 10.8 | `app/rank-experts/page.tsx:768` | *"…run the ranking engine — deterministic scoring combined with AI-generated rationale and vetting questions."* | **REWRITE** — same category. → *"…then compare them side by side."* |
| 10.9 | `app/rank-experts/page.tsx:765, 1052, 325` | `Review Candidates` · `Ranking — this may take 20–40 seconds` · placeholder `Private notes — not sent to AI` | **KEEP** (internal) — the last one is fine *because* it's an internal field. |
| 10.10 | `app/screen-expert/page.tsx:175-178, 338-342, 49, 367-368` | `Expert Vetting` / *"Vet an individual expert for direct knowledge, conflicts, communication quality, and client readiness…"* / `Screen Candidate` / the six score dimensions / `Evaluation will appear here.` | **KEEP** (internal) — no model names, clean rubric. **But the route is session-gated only**, same as 10.7. |
| 10.11 | **`app/demo-readiness/page.tsx:3, 7-8`** | code comments: *"This page must never be indexed; add to robots.txt before public launch."* / *"TODO: Gate behind admin auth before public launch."* | **CUT THE ROUTE — NEITHER TODO IS DONE.** No `noindex` metadata, no admin gate. An internal pre-launch checklist is currently reachable and indexable. |
| 10.12 | `app/demo-readiness/page.tsx:181-192` | manual QA checklist referencing `Source tab`, `Shortlist 2+ experts`, `ScreeningCard`, `client_ready`, `Generate outreach draft` | **CUT — STALE.** Walks a tester through the exact flow being retired. |
| 10.13 | `app/demo-readiness/page.tsx:204-205` | *"Values are never displayed — only presence is checked. This page is for admin use only."* | **KEEP the caution, CUT the page.** |
| 10.14 | `app/projects/[projectId]/client-view/page.tsx:346, 358, 369, 384, 421-422` | `ExpertMatch · Expert Brief` · `Research Question` · `Scope` · `Key Questions` · `Prepared by ExpertMatch · {date} · Confidential` | **KEEP** — this is the best-composed client deliverable in the product. |
| 10.15 | `app/projects/[projectId]/client-view/page.tsx:399-402` | *"No shortlisted experts yet — check back soon."* / *"{n} experts selected for your review, each with direct domain relevance to your research question."* | **REWRITE (first)** — "shortlisted" is retired vocabulary even where the reader is a client. The second sentence is good. |
| 10.16 | `app/projects/[projectId]/client-view/page.tsx:253-255` | `Screening Ratings` / `Knowledge Fit` / `Communication` | **REWRITE — RETIRED SURFACE.** Names the Screen workflow on a permanent client deliverable. Revisit when Screen folds into the thread. |
| 10.17 | `app/projects/[projectId]/client-view/page.tsx:139-144` | `Score` + `title="Relevance score: {n}/100"` | **KEEP** — a bare number without attributing it to a model; does not break the machinery rule. |
| 10.18 | `app/projects/[projectId]/client-view/page.tsx:502-504` | value-chain taxonomy labels | **KEEP** |
| 10.19 | `app/screen-expert`, `app/rank-experts`, `app/demo-readiness` | *(no `metadata` export on any of the three)* | **REWRITE — GAP.** No `noindex` on any internal tool. `app/outreach/unsubscribed/page.tsx:6` shows the one-line fix. |

---

## 11. Legal, footer, and site-wide gaps

| # | file:line | text | verdict |
|---|---|---|---|
| 11.1 | `app/page.tsx:26-27`, `app/pricing/page.tsx:22-23` | footer links: `Pricing` · `Request Access` (landing) / `Home` · `Request Access` (pricing) | **REWRITE — INCOMPLETE.** Two hand-duplicated footer components with different link sets. Extract one component and add the missing pages. |
| 11.2 | `app/page.tsx:30`, `app/pricing/page.tsx:25` | `© {year} ExpertMatch` | **KEEP** |
| 11.3 | — | **MISSING — Terms of Service** | The product takes a card on file, auto-charges it, and brokers paid engagements between two parties. There is **no Terms page anywhere in the repo.** |
| 11.4 | — | **MISSING — Privacy Policy** | The product stores names, work emails, calendar free/busy, deal-adjacent research questions, and expert PII, and shares data with Anthropic, Hunter.io, Snov.io, Resend, Stripe, Zoom, Google, Upstash and Supabase. **No privacy policy exists.** This is the single biggest legal gap on the site, and it blocks the consent line the access form needs (3.17). |
| 11.5 | — | **MISSING — postal address / contact page** | `OUTREACH_POSTAL_ADDRESS` exists for email compliance but appears nowhere on the web site, and there is no `/contact`. The only contact route a stranger has is a founder's personal-looking address on an error page (9.16). |
| 11.6 | — | **MISSING — expert-facing terms** | Experts are asked for conflicts, rate, calendar access and bank details via Stripe Connect with no expert terms, no confidentiality terms, and no statement of what happens to their data. |
| 11.7 | — | **MISSING — cookie/consent notice** | Session cookies are set at login. No notice. (Likely acceptable for strictly-necessary cookies, but worth a founder call given UK/EU prospects.) |
| 11.8 | `app/layout.tsx` | no favicon, no `openGraph`, no `twitter` metadata, no `metadataBase` | **REWRITE — GAP.** A link to `expertmatch.fit` pasted into a Slack or an email renders with no image, no title card, and no description. For an invite-only product spread by link, this matters more than usual. |
| 11.9 | — | **MISSING — the product itself** | **"Matchy" appears nowhere in `app/`, `components/`, or `lib/`** (verified by grep — the only hit for "bookmark" is an unrelated variable in `app/api/enrich-contact/route.ts`). The relay that the whole spec, pricing model and value proposition are built on is not named, described, or hinted at on any page a client can reach. Every surface still describes the manual staff workflow it replaces. |

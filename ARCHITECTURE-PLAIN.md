# ExpertMatch: How the System Works, in Plain English

*Written 2026-09-08 from the code itself. For founders, operators, investors, interns and anyone who is not a software engineer. The technical version is `ARCHITECTURE.md`; the list of known problems is `ARCHITECTURE-AUDIT.md`.*

## The one-minute version

ExpertMatch is a website where a client (an analyst at a private equity firm, a consultant, a lawyer) writes a short description of what they need to learn, and the system finds real people who know about it, contacts them, negotiates a rate, books a video call, charges the client's card when the call is over, and pays the expert. Most of that work is done by an automated assistant the product calls **Matchy**.

Behind the website there are four main parts:

1. **The application itself** (the pages you click on and the logic behind them), which runs on a hosting service called Vercel.
2. **The database and login system**, provided by a service called Supabase. Every project, expert, message and payment record lives here.
3. **A set of outside services** the application talks to: Stripe for money, Resend for email, Zoom for calls, Google for calendars, two "find this person's email" services (Snov and Hunter), a web search engine (Exa), and two AI providers (Anthropic and OpenAI).
4. **A background queue** (Upstash QStash) and a **scratchpad memory** (Upstash Redis) used for slow jobs and temporary values.

The rest of this document walks through each thing a person does, in order, and says which parts are involved and what could go wrong.

## 1. How someone gets an account

Nobody can sign up on their own. The public website has a "request access" form. Filling it in stores a request and emails the founder. A platform administrator (today, the founder) opens the admin console and approves it. Approving creates the person's organization (their firm, identified by their email domain) if it does not exist, creates the account, and emails them a link to set a password. The link is signed, expires after 24 hours, and can only be used once.

Freemail addresses (gmail.com and similar) cannot become an organization on their own. The admin can instead create a **trial** account with no card on file; a trial can do everything in "walkthrough" mode (explained below) but cannot email a real expert until the firm adds a card.

Each firm has one **champion**, the person who sees the firm's billing. Ordinary members do not see seat prices or the card. The champion can invite and remove colleagues from the Team page.

After setting a password, a new user must complete three onboarding steps before the app opens: connect a calendar (Google, a Calendly link, or typed weekly hours), save a payment card (unless the firm is on a trial), and fill in their name and title. The application refuses to show the dashboard until all three are done.

**What could break it:** if Supabase (the login service) is down, nobody can sign in. If the email service is down, invite links are created but never delivered; the admin console shows a warning and can resend them.

## 2. How a client creates a project and a brief

A client presses "New project" on the dashboard. Every project starts in **walkthrough mode**: the client can go through the whole flow and see exactly what Matchy would say and do, but no email reaches an expert and no paid service is called. Going live is a deliberate two-step confirmation, and a live project lands on "review before sending" so the client sees each message before it goes.

The client then writes the brief: the research question, who they want to talk to, geography, seniority, companies to avoid, and confidential notes. The notes marked confidential never leave the platform. A client can also upload a document and have an AI extract the brief fields from it.

Ownership is simple: the person who created the project owns it. The owner can share it read-only with colleagues in the same firm; sharing across firms is impossible (the database itself refuses it).

## 3. How experts are found

When the client presses "Find experts", the application hands the job to the background queue so the page does not have to wait. A worker then runs a pipeline that takes about three minutes:

1. An AI model reads the brief and works out the industry's supply chain and what kinds of people would know the answer.
2. It writes a few web-search queries. A search engine (Exa) runs them and returns pages about real people.
3. A larger AI model reads those search results and extracts named individuals it can point to evidence for, scores how relevant each one is, sorts them into Operator / Advisor / Outsider, estimates their seniority, and writes a short anonymous description ("VP-level operator at a mid-size logistics company").
4. The application filters out hedged or duplicate results and saves the candidates to the project.

So every expert comes from the public web, and the platform holds no standing roster. Expert records are stored inside the project that found them.

**Anonymity.** Before a call is booked, the client sees only "Scott S.", the anonymous description and a relevance rationale. They do not see the surname, employer, LinkedIn page, sources or email. The full record exists in the database; the application strips those fields out of every response to a client. Only platform administrators see the unredacted record.

**What could break it:** the search engine key is not checked at start-up, so a missing key only shows up as a failed sourcing run. A run that dies part way stays marked "running" for up to a day until a nightly clean-up marks it failed; the page shows it as stale after 15 minutes and lets the client retry.

## 4. How experts are contacted

The client **bookmarks** an expert. That is the moment of consent: from here Matchy owns the relationship.

1. If the platform does not already have the expert's work email, a background job tries to find one: it works out the company's domain, checks a cache, then asks Snov and then Hunter (each call costs a credit). It keeps only professional addresses that the providers say are deliverable.
2. Matchy sends a short introduction. The email says it is reaching out on behalf of "a mid-size private equity firm" (the firm's type and size, never its name), gives a generalised version of the topic (proper nouns and the client's own firm name are stripped out), and asks whether the expert would take a paid call. It never mentions money. Every expert email carries a physical address and a one-click opt-out link, as US anti-spam law requires, and comes from a verified expertmatch.fit address.
3. If the expert replies "yes", Matchy sends the follow-up: three questions about conflicts and NDAs, and the rate offered to the expert.
4. If the expert has not replied, Matchy sends one short follow-up line at 8am the expert's business morning, at most four business days in a row, never the same line twice.

**How the client's identity is protected.** The expert never sees the client's name, firm, project name, the research question word for word, or what the client is paying. When the client types a reply in the app, a compliance screen checks it before sending and refuses anything containing a name, firm, phone number, email address, link, money amount or "let's talk directly", explaining what to remove.

**The one place every email passes through.** All expert-facing email goes through a single function that re-checks, on every send, that the project is live (not walkthrough), that the firm is allowed to contact experts (has a card), and that emails are not globally disabled. This is the safety net that stops a bug elsewhere from emailing a real person by accident. Note from the audit: the global do-not-contact list is checked in most places but not inside this one function, so some message types can still reach someone who opted out.

**What could break it:** if the email-finding services are down or out of credits, the expert is marked "no address found" and the client can try again later. If the email service rejects a send, the expert is marked "intro failed". There is no handling yet for emails that bounce.

## 5. How experts respond

Experts never log in or install anything. They just reply to the email. The reply-to address contains a signed code that tells the platform which project and expert it belongs to.

When a reply arrives, the email service forwards it to the platform, which:

1. Checks the forwarding service's signature so nobody can inject fake replies.
2. Checks the sender address matches the address Matchy wrote to.
3. Strips out quoted history and signatures.
4. Runs the compliance screen the other way (so an expert's phone number or LinkedIn link is masked before the client sees it).
5. Stores the message (the raw email is encrypted).
6. Asks an AI model, in one call, what the reply means (interested / declined / counter-offer / conflict / unclear) and writes a one-line summary for the client.
7. Moves the engagement to the right stage: a decline puts the expert on a global do-not-contact list; a counter-offer shows the client a decision card; a "yes" triggers the follow-up.

The client reads the conversation in the app. Until the call is booked, names and companies in the expert's messages are masked and dollar amounts in Matchy's own messages are hidden.

## 6. How money is discussed

Every engagement has two numbers that never appear in the same message:

- the **expert rate**: what the expert is offered and paid (opening offers are $400, $650 or $800 an hour by seniority);
- the **client rate**: what the client pays, which is the expert rate doubled and rounded up to the next $50 ($800, $1,300, $1,600).

The client can set a per-project band for what they are willing to pay, and Matchy will not accept a rate above it. When an expert counters, the client sees the counter converted to their side ("$650 to the expert is $1,300 to you") and chooses accept or counter; Matchy then emails the expert only the expert-side number.

## 7. How calls are scheduled

Once the rate is agreed, Matchy proposes up to three 60-minute slots taken from the client's connected calendar (business hours in the client's time zone, weekdays, at least 24 hours out), intersected with the expert's calendar if they connected one. The expert gets an email with the slots and a link to a simple picker page. The page shows the times in the expert's own time zone, offers "none of these work" with a text box, and offers to connect Google Calendar. Matchy tries up to three rounds and never re-offers a slot the expert has already turned down.

When the expert picks a time, the platform creates a Zoom meeting, marks the engagement as scheduled, sends calendar invitations to both sides, and **reveals identities both ways** (the client now sees the expert's full name and employer). The client can move the call from the app, which re-runs the proposal and updates the same Zoom meeting and invitation.

**What could break it:** if Zoom is down when a call is booked, the booking is saved without a meeting link and the invitation says the link will follow. Because completion and billing are triggered by Zoom telling us the meeting ended, that call can never complete or bill on its own; a person has to fix it. The audit also found that the shared calendar invitation currently lists both people's email addresses, which leaks the expert's address to the client and the client's address to the expert.

## 8. How money flows

**From the client, part one: seats.** Each firm pays a monthly subscription per active user ($250 per seat for 1 to 5 seats, $200 for 6 to 20, custom above). When the champion saves a card during onboarding, the platform creates a Stripe customer for the firm and a subscription; every time a member is added, disabled or removed, the seat count is pushed to Stripe. A nightly job re-checks every firm's seat count.

**From the client, part two: calls.** When Zoom reports that the meeting ended (or the owner presses "mark complete"), the platform computes the charge: the client rate times the minutes, with a 15-minute minimum. It then charges the firm's saved card without the client having to do anything. If the card fails, it emails a payment link instead. Stripe later confirms the payment, and only then does the platform mark the call as paid.

**To the expert.** Once Stripe confirms the client paid, the platform pays the expert their accepted rate for the same minutes through Stripe Connect, which lets a platform send money to people who are not its customers. The expert must once set up a payout account through a Stripe-hosted page (the platform emails them a link). If they have not done so yet, the payment waits, and the platform retries when Stripe says the account is ready, and again every night.

**Important caveat.** Stripe is still in **test mode**. No real money has moved. Before going live: switch to live keys, register the live webhook, and add the "account.updated" event for connected accounts.

**What the audit found here.** There is no refund or dispute handling at all. A second call with the same expert on the same project inside 24 hours would not be charged. A project owner can, through an ordinary edit request, change the expert's rate or mark an engagement as already paid, which would suppress the charge. These are listed as critical items in the audit.

## 9. Who can see what

| | Client (ordinary member) | Champion | Platform admin | Expert |
| --- | --- | --- | --- | --- |
| Own firm's projects | Yes | Yes | All firms | No |
| Expert's real name and employer | Only after a call is booked | Same | Always | (their own) |
| Expert's email | Never | Never | Yes | (their own) |
| Expert-side rate | Never | Never | Yes | Yes |
| Client-side rate | Yes | Yes | Yes | Never |
| Client's name and firm | Yes | Yes | Yes | Only after a call is booked, and only the name on the calendar invite |
| Firm's card and seat price | No | Yes | Yes | No |

The important thing to understand about how this is enforced: the database no longer has per-user access rules on the project tables. The application reads everything with a master key and then decides, in code, what each viewer may see. Two pieces of code are therefore doing all the protecting: the one that decides whether you may open a project at all, and the one that strips the sensitive fields out before sending an expert record to a client. Those two files are the most important code in the company.

## 10. The outside services ExpertMatch depends on

| Service | What it is used for | If it stops working |
| --- | --- | --- |
| Vercel | Runs the website and the scheduled nightly jobs | The site is down |
| Supabase | Login and the database | Nobody can sign in; nothing can be read or saved |
| Stripe | Cards, subscriptions, charges, expert payouts | No billing; calls happen but are not charged; experts are not paid |
| Resend | Sends every email and receives expert replies | Experts are not contacted; replies are lost until it recovers |
| Upstash QStash | Runs slow jobs (sourcing, finding emails, follow-ups) in the background | Sourcing and follow-ups stop; bookmarks report "no address" |
| Upstash Redis | Temporary memory: rate limits, caches, a few lookups | The product keeps working but with no throttling and higher outside costs; some expert payouts can stall |
| Zoom | Creates meetings and tells us when they end | Bookings have no link; calls do not auto-complete or bill |
| Google Calendar | Reads free/busy for clients and experts | Matchy cannot propose times from the calendar |
| Calendly | Alternative calendar source | Same as above (the audit doubts this path works at all today) |
| Exa | Web search behind sourcing | Sourcing fails |
| Snov, Hunter | Find an expert's work email | More "address not found" results |
| Anthropic | The AI that reads briefs and extracts experts | Sourcing fails |
| OpenAI | The AI that reads expert replies and proposed times | Replies are stored but labelled "unclear"; scheduling falls back to simple pattern matching |

## 11. What could break the product

In rough order of seriousness, from the audit:

1. **A build-breaking mistake in unfinished work.** The uncommitted work in the repository today references a variable that does not exist in two places. Until that one-line fix lands, the code does not compile, and if it were deployed as-is the expert's time-picker page would crash.
2. **Money fields a client can edit.** A project owner can change the expert's rate or mark a call as paid through an ordinary edit, which changes what is charged and what the expert is paid.
3. **The calendar invitation leaks email addresses** in both directions at the moment of booking, which undermines the anonymity the product is built on.
4. **A Zoom "meeting ended" message can be replayed**, and the only thing standing between a replay and a second charge is one check in the invoicing code.
5. **Single points of protection.** Access to projects and the anonymisation of experts are each enforced in exactly one piece of code, with no database backstop.
6. **Duplicate cold emails.** Two quick bookmarks, or a send that succeeds but whose bookkeeping fails, can email the same stranger twice.
7. **Quiet failures.** Several places record a message as sent when it was actually held, retry an expert's payout-setup email every night with no cap, or never retry a payout that failed once. Failed payments do not appear on the admin's attention list.
8. **No safety limits on spend.** There is no per-firm cap on how many sourcing runs or email lookups a user can trigger, and the documented daily budget for lookups is not actually enforced.
9. **Scripts that can damage production.** A few maintenance scripts will wipe or alter whatever database their environment points at, with no confirmation prompt.
10. **Thin automated testing on the parts that move money.** The pricing arithmetic is well tested; the code that actually charges cards, handles Stripe's notifications and pays experts has no automated tests.

None of these needs a rewrite. Each is a bounded fix, and the audit document lists them with the exact file to change.

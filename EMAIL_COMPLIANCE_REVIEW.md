# ExpertMatch Email Compliance Review

**Prepared:** June 2026  
**Scope:** All outbound emails sent via Resend from the ExpertMatch platform  
**Priority:** High — automated cold outreach sequence carries the greatest legal exposure

---

## 1. Email Inventory

| Email Type | File | Trigger | Recipient | Volume |
|---|---|---|---|---|
| Outreach Email 1 (interest check) | `lib/emailSequence.ts` | Client submits brief | Expert (cold) | High |
| Outreach Email 2 (conflict/rate) | `lib/emailSequence.ts` | Expert replies to E1 | Expert | Medium |
| Outreach Email 3 (scheduling link) | `lib/emailSequence.ts` | Expert confirms E2 | Expert | Medium |
| Availability Request | `lib/sendAvailabilityRequest.ts` | Scheduling step | Expert | Low |
| Call Confirmation + ICS | `lib/sendAvailabilityRequest.ts` | Scheduling confirmed | Expert + Client | Low |
| Invoice | `lib/createAndSendInvoice.ts` | Call completed | Client | Low |
| Invite (account setup) | `app/api/request-access/route.ts` | Admin approval | Prospective client | Low |
| Expert Payout Onboarding | `app/api/webhooks/stripe/route.ts` | Stripe event | Expert | Low |
| Admin notification | `lib/firmStore.ts` | New access request | Admin (internal) | Low |

---

## 2. Compliance Framework Overview

ExpertMatch operates in the B2B sector and contacts professionals at their business email addresses. The relevant legal frameworks are:

### CAN-SPAM Act (United States)
Applies to any commercial email with a primary purpose of advertising or promoting a product or service. Key requirements:
- Accurate "From," "To," "Reply-To," and routing information
- Non-deceptive subject lines
- **Physical mailing address of the sender** (street address, PO box, or registered agent)
- **Clear and conspicuous unsubscribe mechanism**
- Honor opt-outs within 10 business days
- No fee, no login, no complex process to unsubscribe

### GDPR (European Union / EEA)
Applies when contacting individuals in the EU/EEA — including B2B contacts. Key requirements:
- Lawful basis for processing personal data (legitimate interest is commonly relied on for B2B cold outreach, but requires a documented balancing test)
- Privacy notice or link to privacy policy at point of collection
- Right to erasure and right to object to processing
- Data minimization — only hold data needed for the stated purpose
- Cross-border transfer safeguards if data leaves the EU

### CASL (Canada)
Applies to commercial electronic messages sent to or from Canada. Stricter than CAN-SPAM:
- Express or implied consent is required before sending
- Identification of the sender and contact information
- Unsubscribe mechanism
- Implied consent (e.g., business card, published address) expires after 2 years

---

## 3. Current Compliance Gap Analysis

### 3.1 Outreach Email Sequence (CRITICAL)

The 3-email automated sequence (`lib/emailSequence.ts`) is cold outreach to experts who have not opted in. This is the highest-risk area.

**Gaps identified:**

| Requirement | Status | Detail |
|---|---|---|
| Physical mailing address | **MISSING** | None of the 3 outreach email bodies or footers include a postal address |
| Unsubscribe link | **MISSING** | No opt-out mechanism in any outreach email |
| Opt-out database | **MISSING** | No suppression list or do-not-contact store |
| Sender identity | Partial | `OUTREACH_FROM_EMAIL` is configurable but may be generic; identity of the firm is intentionally hidden until Email 3 |
| Non-deceptive subject lines | Likely OK | GPT-4o-mini generates subjects; prompt rules ban misleading content |
| Legitimate interest documentation | **MISSING** | No GDPR balancing test documented for cold expert outreach |

**Risk assessment:**
- Sending automated multi-step cold email sequences without a postal address and unsubscribe link violates CAN-SPAM.
- If any recipients are in the EU/EEA, GDPR legitimate interest processing without documentation creates liability.
- Deliberately concealing the client firm name until Email 3 could be read as deceptive routing under CAN-SPAM (though firm names in the "From" field are typically sufficient).

### 3.2 Availability Request & Confirmation Emails (LOW RISK)

These are transactional — sent to experts who have already agreed to participate. Transactional emails have lighter CAN-SPAM requirements (no opt-out required if purely transactional), but the physical address is still best practice.

**Gaps identified:**
- No postal address in HTML footer (`lib/sendAvailabilityRequest.ts`)

### 3.3 Invoice Email (LOW RISK)

Purely transactional. Sent to clients who are active platform users. Low compliance risk.

**Gaps identified:**
- No postal address in footer (minor)

### 3.4 Invite Email (LOW RISK)

Triggered by admin approval. Recipients have explicitly requested access. Low compliance risk.

**Gaps identified:**
- No postal address in footer (minor)

### 3.5 Expert Payout Onboarding Email (LOW RISK)

Transactional — sent after Stripe onboarding event. Low risk.

---

## 4. Priority Recommendations

### Priority 1 — URGENT: Add unsubscribe mechanism to outreach sequence

**Why:** Without an unsubscribe link, every outreach email is potentially non-compliant with CAN-SPAM. If recipients mark emails as spam rather than finding a way to opt out, Resend domain reputation will suffer, blocking legitimate transactional emails.

**What to do:**
1. Add a suppression list store (Redis key `suppress:<email_hash>` or a dedicated DB table).
2. Create an API route `/api/unsubscribe?token=<hmac_token>` that records the opt-out.
3. Add a signed unsubscribe token to each outreach email footer: `"To opt out of further emails, reply STOP or visit: https://expertmatch.fit/api/unsubscribe?token=<token>"`
4. Before sending any sequence email, check the suppression list and skip if opted out.
5. When a reply is classified as `declined` by the AI reply parser (`lib/replyDetection.ts`), also record the opt-out in the suppression list.

**Affected files:** `lib/emailSequence.ts`, `lib/replyDetection.ts`, new `app/api/unsubscribe/route.ts`

### Priority 2 — URGENT: Add physical mailing address to all outbound emails

**Why:** Required by CAN-SPAM for commercial emails. Absence is a clear violation.

**What to do:**
- Add a text footer to all outbound emails (both HTML and plain text versions):
  ```
  ExpertMatch | [Physical Address] | expertmatch.fit
  To opt out: [unsubscribe link]
  ```
- Centralize this footer in a shared utility (e.g., `lib/emailFooter.ts`) to avoid drift.
- Use an environment variable `COMPANY_MAILING_ADDRESS` so the address can be updated without a code deploy.

**Affected files:** `lib/emailSequence.ts`, `lib/sendAvailabilityRequest.ts`, `lib/createAndSendInvoice.ts`, new `lib/emailFooter.ts`

### Priority 3 — HIGH: Document GDPR legitimate interest basis for cold outreach

**Why:** Processing EU/EEA personal data without a documented lawful basis is a GDPR violation even for B2B. Legitimate interest is defensible for expert cold outreach, but only if documented.

**What to do:**
- Create a Legitimate Interest Assessment (LIA) document covering:
  - Purpose: facilitating paid consulting engagements
  - Necessity: direct professional contact is required
  - Balancing test: experts are professionals contacted about professional opportunities; limited privacy intrusion given business context
  - Safeguard: easy opt-out via unsubscribe link (see Priority 1)
- Add a privacy policy to the ExpertMatch website that covers data processing for expert contact.
- Consider adding a brief privacy statement to the Email 1 footer: `"Your contact information was sourced via professional data services. To opt out, reply STOP."`

**Affected files:** New `PRIVACY_POLICY.md` or public privacy policy page; `lib/emailSequence.ts`

### Priority 4 — MEDIUM: Honor CASL for Canadian contacts

**Why:** CASL requires implied or express consent. For B2B outreach in Canada, published business email addresses provide implied consent, but only for 2 years. No tracking of when an email address was sourced currently exists.

**What to do:**
- Add a `sourced_at` timestamp to the expert contact data model.
- Enforce a 2-year age limit on implied CASL consent before suppressing outreach.
- Alternatively, restrict the outreach sequence to US contacts only until consent infrastructure is in place.

**Affected files:** Expert data model, `lib/emailSequence.ts`

### Priority 5 — LOW: Centralize email footer and remove Nodemailer dependency

**Why:** Nodemailer is installed (`package.json`) but not used. Dead dependencies increase attack surface and bloat.

**What to do:**
- Remove `nodemailer` and `@types/nodemailer` from `package.json`.
- Create `lib/emailFooter.ts` as a single source of truth for compliance footers.

**Affected files:** `package.json`, new `lib/emailFooter.ts`

---

## 5. What Is Already Working Well

- **PII protection in logs:** Explicit guards prevent expert names, emails, and project names from appearing in audit logs. This is a GDPR best practice.
- **HMAC-signed tokens:** Reply tokens and unsubscribe tokens (once added) are cryptographically signed, preventing spoofing.
- **Rate limiting on inbound webhook:** Prevents abuse of the reply-tracking endpoint.
- **`DISABLE_EMAILS` flag:** Allows email suppression in dev/staging — reduces accidental cold outreach from test environments.
- **Resend webhook signature verification:** Prevents spoofed inbound email webhooks from manipulating expert status.

---

## 6. Scope Boundary (Out of Scope for This Review)

- End-to-end encryption of email content
- HIPAA / CCPA compliance (not applicable given current user base)
- Email deliverability optimization (SPF, DKIM, DMARC — assumed configured in Resend)
- Client-to-platform communication (separate channel, not email-based)

---

## 7. Recommended Next Stage

**Engineering — implement Priority 1 and Priority 2** (unsubscribe mechanism + postal address footer) in a single focused PR. These are the minimum viable compliance fixes before the platform goes live with production expert outreach. Estimated effort: 4-6 hours.

Priority 3 (GDPR LIA + privacy policy) is a legal/product task that should run in parallel and does not require an engineer.

---

## 8. Open Questions for Legal / Product Review

1. Does ExpertMatch operate as the sender of record, or is the client firm the effective sender? This affects whose physical address appears in the footer.
2. Is expert contact data sourced from providers (Hunter.io, Snov.io) that have their own GDPR/CASL compliance programs? If so, document the data provenance.
3. Should the unsubscribe scope be per-project or global? (i.e., if an expert opts out of one client's project, are they opted out of all future ExpertMatch outreach?)
4. What is the retention period for expert contact data after a project closes?

import type { Metadata } from 'next';
import Link from 'next/link';
import NavBar from '../../components/NavBar';
import MarketingFooter from '../../components/MarketingFooter';
import { SEAT_TIERS, formatUsdFromCents, MIN_BILLABLE_MINUTES } from '../../lib/pricing';

// Terms of Service.
//
// Every commercial term below is drawn from lib/pricing.ts so this page can
// never quote a number the billing code does not charge. Anything the founder
// still has to decide is marked with a literal [CONFIRM: …] token so it can be
// found with `grep -rn "\[CONFIRM" app/`.

export const metadata: Metadata = {
  title: 'Terms of Service — ExpertMatch',
  description:
    'The terms that govern your ExpertMatch account: per-seat subscription, per-call billing, expert engagement rules, and platform conduct.',
};

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';

const EFFECTIVE_DATE = 'September 6, 2026';

const seatLine = (i: number): string => {
  const tier = SEAT_TIERS[i];
  if (!tier) return '';
  const range = tier.maxSeats === null ? `${tier.minSeats} or more seats` : `${tier.minSeats}–${tier.maxSeats} seats`;
  return tier.contactSales
    ? `${range}: custom pricing, agreed with us in writing before the seats are added.`
    : `${range}: ${formatUsdFromCents(tier.unitPriceCents)} per seat per month.`;
};

interface SectionProps {
  n: string;
  title: string;
  children: React.ReactNode;
}

function Section({ n, title, children }: SectionProps) {
  return (
    <section className="border-t border-frame pt-8 mt-8 first:border-t-0 first:pt-0 first:mt-0">
      <h2 className="font-display text-navy mb-3" style={{ fontSize: '1.15rem', fontWeight: 500 }}>
        <span className="text-[11px] font-body font-medium align-middle mr-3" style={{ color: GOLD, letterSpacing: '0.14em' }}>
          {n}
        </span>
        {title}
      </h2>
      <div className="space-y-3 text-[13px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>
        {children}
      </div>
    </section>
  );
}

export default function TermsPage() {
  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>
      <NavBar />

      {/* ── Hero ── */}
      <section style={{ background: NAVY }} className="py-16 px-6 text-center">
        <p className="text-[10px] uppercase font-medium mb-4" style={{ color: GOLD, letterSpacing: '0.22em' }}>
          Legal
        </p>
        <h1 className="font-display text-cream mb-4" style={{ fontSize: 'clamp(1.8rem, 4vw, 2.6rem)', fontWeight: 500 }}>
          Terms of Service
        </h1>
        <p className="text-cream/50 text-sm mx-auto" style={{ maxWidth: '460px', fontWeight: 300 }}>
          Effective {EFFECTIVE_DATE}. These terms cover your ExpertMatch account, what we
          charge, and the rules for talking to the experts we introduce.
        </p>
      </section>

      {/* ── Body ── */}
      <main className="flex-1 py-16 px-6">
        <div className="max-w-2xl mx-auto bg-surface border border-frame px-6 sm:px-10 py-10">

          <Section n="01" title="Who these terms are between">
            <p>
              These terms are an agreement between ExpertMatch
              (&ldquo;ExpertMatch&rdquo;, &ldquo;we&rdquo;, &ldquo;us&rdquo;) and the organization whose
              employees hold ExpertMatch accounts (&ldquo;you&rdquo;, &ldquo;the client&rdquo;).
              Anyone who signs in under your organization is bound by them, and your organization
              is responsible for what those people do with the account.
            </p>
            <p>
              [CONFIRM: legal entity name and form — e.g. &ldquo;ExpertMatch, Inc., a Delaware
              corporation&rdquo;. Every reference to &ldquo;ExpertMatch&rdquo; below should name that entity.]
            </p>
            <p>
              Accounts are issued by invitation. We may decline a request for access, and we may
              suspend or close an account — see section 10.
            </p>
          </Section>

          <Section n="02" title="What ExpertMatch does">
            <p>
              You describe a research question. We identify people whose background fits it, contact
              them on your behalf, handle the conflict and rate conversation, schedule a call from
              your connected calendar, and bill the call to the card you have on file.
            </p>
            <p>
              We are an intermediary. We do not employ the experts, we do not warrant what they say
              on a call, and we do not give investment, legal, tax, or accounting advice. What you
              do with an expert&rsquo;s answers is your decision and your responsibility.
            </p>
          </Section>

          <Section n="03" title="Seats and subscription">
            <p>
              ExpertMatch is sold as a monthly per-seat subscription. A seat is one person who can
              sign in. Your total active seat count picks a price band, and every seat is billed at
              that band&rsquo;s rate — not just the seats above the threshold.
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              {SEAT_TIERS.map((tier, i) => (
                <li key={tier.minSeats}>{seatLine(i)}</li>
              ))}
            </ul>
            <p>
              Billing is month to month. There is no annual contract, no setup fee, and no seat
              minimum. You can add or remove seats at any time from your team settings; changes are
              prorated, so you are charged for the remainder of the month when a seat is added and
              credited when one is removed. Adding seats can move your whole organization into a
              different band, in either direction.
            </p>
            <p>
              You can cancel at any time. Cancellation stops future subscription charges; it does
              not refund the current month, and it does not cancel a call that has already happened
              but has not yet been billed.
            </p>
          </Section>

          <Section n="04" title="Expert calls and how they are billed">
            <p>
              Calls are billed separately from your seats. Each engagement has a rate, shown to you
              before the call is scheduled and quoted per hour. <strong className="font-medium text-ink">
              That rate is all in: it includes both the expert&rsquo;s fee and the ExpertMatch fee.</strong>{' '}
              There is no separate research fee, retainer, or per-call markup added afterwards.
            </p>
            <p>
              Every call carries a {MIN_BILLABLE_MINUTES}-minute minimum. A call shorter than{' '}
              {MIN_BILLABLE_MINUTES} minutes is billed as {MIN_BILLABLE_MINUTES} minutes; beyond that,
              you are billed per minute of actual call time.
            </p>
            <p>
              The rates shown on our pricing page are our opening position for each seniority band.
              The final rate for an engagement is agreed before the call is scheduled, and that
              agreed rate is what you are charged.
            </p>
            <p>
              <strong className="font-medium text-ink">When a call completes, we charge the card you
              have on file automatically.</strong> You do not receive an invoice to approve first.
              You must keep a valid payment method on your account; if a charge fails we may pause
              your account until it is settled. If you think a charge is wrong, tell us within{' '}
              30 days and we will review the call
              record with you.
            </p>
            <p>
              Amounts are in US dollars and exclusive of any taxes that apply to you. Where we are
              required to collect sales tax or VAT we will add it to the charge; otherwise you are
              responsible for any tax due on your side.
            </p>
          </Section>

          <Section n="05" title="Experts are independent contractors">
            <p>
              Experts are independent contractors engaged by ExpertMatch. They are not your
              employees, agents, or contractors, and they are not ours either in any employment
              sense. <strong className="font-medium text-ink">ExpertMatch pays the expert. You never
              pay an expert directly</strong>, and you should not agree to.
            </p>
            <p>
              We screen and brief experts, but we do not control what they say. An expert&rsquo;s
              statements are their own opinions and recollections, not ExpertMatch&rsquo;s.
            </p>
          </Section>

          <Section n="06" title="Talking to experts only through ExpertMatch">
            <p>
              Until a call is scheduled, an expert&rsquo;s identity is anonymized: you see their
              background and seniority, not their name, employer history in identifying detail, or
              contact information. Identity is revealed to both sides once a call is on the calendar.
            </p>
            <p>
              While your account is open, and for 12 months
              afterwards, you agree not to:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>contact an expert we introduced outside the platform, or arrange to;</li>
              <li>
                ask an expert for their email address, phone number, LinkedIn profile, calendar
                link, or any other direct contact detail;
              </li>
              <li>
                engage or pay an expert we introduced for consulting work outside ExpertMatch,
                unless we have agreed to it in writing;
              </li>
              <li>
                give an expert your firm&rsquo;s name or your own contact details before identities
                are revealed.
              </li>
            </ul>
            <p>
              We screen messages in both directions for exactly these things and will hold a message
              that contains them. Repeated attempts are grounds for suspension.
            </p>
            <p>
              This is not a formality. Anonymized introductions are the reason experts take these
              calls, and the reason we can pay them properly.
            </p>
          </Section>

          <Section n="07" title="Compliance is yours to run">
            <p>
              You are responsible for complying with your own firm&rsquo;s policies and with the law
              that applies to you. That includes, at minimum:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <strong className="font-medium text-ink">Material non-public information.</strong> Do
                not ask an expert for MNPI, and stop a call that is heading toward it. If your firm
                requires calls to be chaperoned, recorded, or pre-cleared, that is your process to
                run — we do not run it for you.
              </li>
              <li>
                <strong className="font-medium text-ink">Confidential information.</strong> Do not ask
                an expert to disclose anything covered by an employment agreement, NDA, or duty of
                confidentiality they owe someone else, and do not ask for a current or former
                employer&rsquo;s trade secrets or customer data.
              </li>
              <li>
                <strong className="font-medium text-ink">Conflicts.</strong> You are responsible for
                your own conflict checks and restricted lists. We ask experts about conflicts and
                pass on what they tell us; we do not verify it independently.
              </li>
              <li>
                <strong className="font-medium text-ink">Your use of the output.</strong> Notes,
                summaries, and call content are for your internal research. Do not republish or
                resell them.
              </li>
            </ul>
            <p>
              ExpertMatch does not record calls and does not offer recording. Do not record a call
              yourself without the express consent of everyone on it.
            </p>
          </Section>

          <Section n="08" title="Your account">
            <p>
              Keep your credentials to yourself — seats are per person, not shared logins. Tell us
              promptly if you think an account has been compromised. Do not attempt to access another
              organization&rsquo;s data, scrape the platform, or reverse-engineer it.
            </p>
            <p>
              You keep ownership of the briefs and questions you submit. You give us permission to
              use them to run the service — to source experts, to write the outreach we send on your
              behalf, and to schedule and bill your calls.
            </p>
          </Section>

          <Section n="09" title="Availability">
            <p>
              We work to keep ExpertMatch available and will tell you about planned maintenance where
              we can, but the service is provided as is and we do not offer an uptime guarantee or a
              service level agreement. We also depend on third parties — payment processing,
              calendars, video conferencing, email — and an outage at one of them can interrupt the
              service.
            </p>
          </Section>

          <Section n="10" title="Declining, suspending, and closing accounts">
            <p>
              Access is by invitation and at our discretion. We may decline a request for access
              without giving a reason.
            </p>
            <p>
              We may suspend or close an account — with notice where we reasonably can, and without
              it where the risk is immediate — if payment fails, if these terms are breached
              (particularly section 06 or 07), if we believe the account is being used to obtain
              confidential information or MNPI, or if we are required to by law.
            </p>
            <p>
              You may close your account at any time by telling us. Section 05, 06, 07, 11, 12 and 13
              survive closure.
            </p>
          </Section>

          <Section n="11" title="Limitation of liability">
            <p>
              To the fullest extent the law allows, ExpertMatch is not liable for indirect,
              incidental, special, consequential, or punitive damages, or for lost profits, lost
              revenue, lost data, or lost business opportunity — including any investment,
              transaction, or business decision you make after a call.
            </p>
            <p>
              Our total liability for any claim relating to the service is capped at the amount you
              paid ExpertMatch in the 12 months before the event giving rise to it.
            </p>
            <p>
              Nothing here limits liability that cannot be limited by law, including for fraud.
            </p>
          </Section>

          <Section n="12" title="Indemnity">
            <p>
              You will defend and indemnify ExpertMatch against claims arising from your use of the
              service in breach of these terms, in particular claims arising from seeking or using
              confidential information or MNPI, or from contacting an expert outside the platform.
            </p>
          </Section>

          <Section n="13" title="Governing law and disputes">
            <p>
              These terms are governed by the laws of{' '}
              <strong className="font-medium text-ink">[Governing law: State]</strong>, without regard
              to its conflict-of-laws rules. Any dispute will be brought in the courts of{' '}
              <strong className="font-medium text-ink">[Governing law: State]</strong>, and both
              parties consent to that jurisdiction.
            </p>
          </Section>

          <Section n="14" title="Changes to these terms">
            <p>
              We may update these terms. If a change materially affects you, we will tell you by
              email to your account address before it takes effect. Continuing to use ExpertMatch
              after that date means you accept the updated terms. The effective date at the top of
              this page always reflects the current version.
            </p>
          </Section>

          <Section n="15" title="Contact">
            <p>
              Questions about these terms go to{' '}
              <strong className="font-medium text-ink">ashergoldsteinbusiness@gmail.com</strong>, or by post
              to <strong className="font-medium text-ink">4502 Mayflower Hill, Waterville, ME 04901</strong>.
            </p>
            <p>
              How we handle personal data is described in our{' '}
              <Link href="/privacy" className="text-navy underline hover:no-underline" style={{ fontWeight: 400 }}>
                Privacy Policy
              </Link>
              .
            </p>
          </Section>

        </div>

        <p className="max-w-2xl mx-auto mt-6 text-center text-[11px] text-muted" style={{ fontWeight: 300 }}>
          Effective {EFFECTIVE_DATE} ·{' '}
          <Link href="/privacy" className="hover:text-navy transition-colors">Privacy Policy</Link>
          {' · '}
          <Link href="/contact" className="hover:text-navy transition-colors">Contact</Link>
        </p>
      </main>

      <MarketingFooter activePath="/terms" />
    </div>
  );
}

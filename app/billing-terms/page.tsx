import type { Metadata } from 'next';
import Link from 'next/link';
import NavBar from '../../components/NavBar';

export const metadata: Metadata = {
  title: 'Billing Terms — ExpertMatch',
  description: 'Understand how ExpertMatch billing works: subscription fees, per-minute call billing, payment process, and refund policy.',
};

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';

function Footer() {
  return (
    <footer style={{ background: NAVY, borderTop: `1px solid rgba(198,167,94,0.2)` }}>
      <div className="max-w-6xl mx-auto px-6 sm:px-10 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <span className="font-display text-cream/40 font-semibold" style={{ letterSpacing: '0.15em', fontSize: '11px' }}>
          EXPERTMATCH
        </span>
        <div className="flex items-center gap-6">
          <Link href="/" className="text-[11px] text-cream/40 hover:text-cream/60 transition-colors" style={{ letterSpacing: '0.1em' }}>Home</Link>
          <Link href="/pricing" className="text-[11px] text-cream/40 hover:text-cream/60 transition-colors" style={{ letterSpacing: '0.1em' }}>Pricing</Link>
          <Link href="/request-access" className="text-[11px] text-cream/40 hover:text-cream/60 transition-colors" style={{ letterSpacing: '0.1em' }}>Request Access</Link>
        </div>
        <p className="text-[10px] text-cream/25" style={{ letterSpacing: '0.06em' }}>© {new Date().getFullYear()} ExpertMatch</p>
      </div>
    </footer>
  );
}

const SECTIONS = [
  {
    id: 'overview',
    heading: '1. Overview',
    body: `ExpertMatch charges clients in two ways: a flat monthly subscription fee based on your plan, and per-minute billing for completed expert calls. There are no setup fees, hidden markups, or minimum commitments beyond the current billing cycle. By adding a payment method and using the platform, you agree to these terms.`,
  },
  {
    id: 'subscription',
    heading: '2. Monthly Subscription',
    body: `Subscription fees are charged at the start of each billing cycle. Your plan determines the number of analyst seats and included expert calls per month. Unused calls do not roll over. Plan changes (upgrades or downgrades) take effect at the start of the next billing cycle; upgrades can be activated immediately upon request. ExpertMatch reserves the right to adjust plan pricing with 30 days' notice.`,
  },
  {
    id: 'per-call',
    heading: '3. Per-Call Billing',
    body: `Expert calls that fall within your plan's monthly allowance are covered by your subscription. Calls that exceed your monthly allowance are billed at the following rates based on the expert's seniority tier:\n\n• Mid-Level (Directors, VPs, Senior Managers): $400 / hour\n• Senior (SVPs, Partners, Managing Directors): $600 / hour\n• Executive / C-Suite (CEOs, CFOs, Board Members): $800 / hour\n\nBilling is calculated to the minute using the formula: (call duration in minutes ÷ 60) × hourly rate. The minimum billable duration is 1 minute. Call duration is measured from the time the Zoom session begins until it ends, as recorded by the platform.`,
  },
  {
    id: 'invoicing',
    heading: '4. Invoicing and Payment',
    body: `After each completed expert call, ExpertMatch automatically generates an invoice and sends it to the email address on your account. Each invoice includes a secure Stripe payment link. Payment is due within 14 days of the invoice date. ExpertMatch does not store full card numbers; all payment processing is handled by Stripe in accordance with PCI-DSS standards. Failure to pay within the due period may result in suspension of your account until the outstanding balance is settled.`,
  },
  {
    id: 'overages',
    heading: '5. Overages and Notifications',
    body: `ExpertMatch will notify you by email when your account is approaching its monthly call limit. Calls scheduled beyond your plan limit will be charged at the standard per-call rates listed above. You are responsible for monitoring your usage. ExpertMatch does not automatically block calls when a plan limit is reached; overages are billed retroactively on the invoice following the call.`,
  },
  {
    id: 'refunds',
    heading: '6. Refunds and Disputes',
    body: `ExpertMatch does not offer refunds on subscription fees for unused portions of a billing cycle. If a call is cancelled before it begins, no per-call charge is incurred. If a technical failure attributable to ExpertMatch results in a call not completing, no charge is applied for that session. Billing disputes must be submitted within 30 days of the invoice date by contacting support. ExpertMatch will investigate and, where appropriate, issue a credit against a future invoice.`,
  },
  {
    id: 'expert-compensation',
    heading: '7. Expert Compensation Disclosure',
    body: `ExpertMatch compensates experts directly for their time. Experts receive approximately 70% of the client-facing call rate; the remaining portion covers platform operations, compliance, and sourcing services. Experts are paid via Stripe within five business days of a completed and invoiced call. ExpertMatch does not mark up expert compensation rates beyond the published per-call tiers.`,
  },
  {
    id: 'changes',
    heading: '8. Changes to These Terms',
    body: `ExpertMatch may update these billing terms from time to time. Material changes will be communicated via email to the account holder at least 14 days before they take effect. Continued use of the platform after the effective date constitutes acceptance of the updated terms. The most current version of these terms is always available at this URL.`,
  },
  {
    id: 'contact',
    heading: '9. Questions',
    body: `For billing questions, disputes, or to request a plan change, contact your account manager or reach out through the platform. ExpertMatch support typically responds within one business day.`,
  },
];

export default function BillingTermsPage() {
  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>
      <NavBar />

      {/* Hero */}
      <section style={{ background: NAVY }} className="py-16 px-6 text-center">
        <p
          className="text-[10px] uppercase font-medium mb-4"
          style={{ color: GOLD, letterSpacing: '0.22em' }}
        >
          Legal
        </p>
        <h1
          className="font-display text-cream mb-4"
          style={{ fontSize: 'clamp(1.8rem, 3.5vw, 2.6rem)', fontWeight: 500 }}
        >
          Billing Terms
        </h1>
        <p className="text-cream/50 text-sm leading-relaxed mx-auto" style={{ maxWidth: '480px', fontWeight: 300 }}>
          How ExpertMatch charges for subscriptions, expert calls, and overages. Effective June 1, 2026.
        </p>
      </section>

      {/* Body */}
      <section className="py-14 px-6">
        <div className="max-w-2xl mx-auto">

          {/* Quick-nav */}
          <nav
            className="mb-12 p-5 border border-frame bg-white"
            aria-label="Billing terms sections"
          >
            <p className="text-[9px] uppercase font-semibold mb-3" style={{ color: NAVY, letterSpacing: '0.2em' }}>On this page</p>
            <ol className="space-y-1.5 list-none">
              {SECTIONS.map(({ id, heading }) => (
                <li key={id}>
                  <a
                    href={`#${id}`}
                    className="text-[12px] transition-colors"
                    style={{ color: '#5A6B7A', fontWeight: 300 }}
                  >
                    {heading}
                  </a>
                </li>
              ))}
            </ol>
          </nav>

          {/* Sections */}
          <div className="space-y-10">
            {SECTIONS.map(({ id, heading, body }) => (
              <section key={id} id={id} className="scroll-mt-8">
                <h2
                  className="font-display mb-3"
                  style={{ color: NAVY, fontSize: '1.05rem', fontWeight: 500 }}
                >
                  {heading}
                </h2>
                <div className="border-l-2 pl-5" style={{ borderColor: `${GOLD}50` }}>
                  {body.split('\n').map((line, i) =>
                    line === '' ? null : (
                      <p
                        key={i}
                        className="text-[13px] leading-relaxed mb-2 last:mb-0"
                        style={{ color: '#5A6B7A', fontWeight: 300 }}
                      >
                        {line}
                      </p>
                    )
                  )}
                </div>
              </section>
            ))}
          </div>

          {/* Bottom link to pricing */}
          <div className="mt-14 pt-8 border-t border-frame flex flex-col sm:flex-row items-center justify-between gap-4">
            <p className="text-[12px] text-muted" style={{ fontWeight: 300 }}>
              See the full breakdown of plans and call rates on our{' '}
              <Link href="/pricing" className="underline underline-offset-2 hover:text-navy transition-colors">
                Pricing page
              </Link>
              .
            </p>
            <Link
              href="/request-access"
              className="text-[10px] uppercase font-medium px-6 py-2.5 transition-colors whitespace-nowrap"
              style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
            >
              Request Access
            </Link>
          </div>
        </div>
      </section>

      <Footer />
    </div>
  );
}

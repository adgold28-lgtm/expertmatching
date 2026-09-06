import type { Metadata } from 'next';
import Link from 'next/link';
import NavBar from '../../components/NavBar';
import MarketingFooter from '../../components/MarketingFooter';
import { SEAT_TIERS, formatUsdFromCents, MIN_BILLABLE_MINUTES } from '../../lib/pricing';
import { TIER_PRICING } from '../../lib/seniorityClassifier';

export const metadata: Metadata = {
  title: 'Pricing — ExpertMatch',
  description: 'Per-seat monthly pricing with volume tiers. Calls billed by the minute after a 15-minute minimum. No contracts.',
};

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';


// Rendered from lib/pricing.ts so the marketing page can never drift from what
// Stripe actually charges.
const SEAT_ROWS = SEAT_TIERS.map(tier => ({
  range: tier.maxSeats === null ? `${tier.minSeats}+ seats` : `${tier.minSeats}–${tier.maxSeats} seats`,
  price: tier.contactSales ? 'Talk to us' : `${formatUsdFromCents(tier.unitPriceCents)}/seat/mo`,
  note:
    tier.contactSales
      ? 'Larger teams — custom terms and onboarding'
      : `Every seat billed at ${formatUsdFromCents(tier.unitPriceCents)} once your team reaches this range`,
}));

// Rates come from lib/seniorityClassifier.ts so the page matches what is charged.
const CALL_TIERS = [
  { tier: 'Mid-Level',           rate: `$${TIER_PRICING.mid.callRate.toLocaleString('en-US')}/hr`,       desc: 'Directors, VPs, Senior Managers' },
  { tier: 'Senior',              rate: `$${TIER_PRICING.senior.callRate.toLocaleString('en-US')}/hr`,    desc: 'C-1 level: SVPs, Partners, MDs' },
  { tier: 'Executive / C-Suite', rate: `$${TIER_PRICING.executive.callRate.toLocaleString('en-US')}/hr`, desc: 'CEOs, CFOs, Board members' },
];

const FAQS = [
  {
    q: 'How does per-seat pricing work?',
    a: 'You pay monthly for each active seat. Your total team size selects a tier, and every seat is billed at that tier — reaching 6 seats moves all 6 to the lower rate, not just the sixth.',
  },
  {
    q: 'What happens when I add or remove someone?',
    a: 'Any organization admin can add or remove seats from the Team page. Changes are prorated: you are charged for the remainder of the month when a seat is added, and credited when one is removed.',
  },
  {
    q: 'Are expert calls included in the seat price?',
    a: `No. Seats cover the platform — sourcing, outreach, scheduling and billing. Calls are billed by the minute at the rates above, with a ${MIN_BILLABLE_MINUTES}-minute minimum per call. The rate you see includes the ExpertMatch fee.`,
  },
  {
    q: 'How do experts get paid?',
    a: 'Experts are paid through Stripe as soon as the call is billed, usually the same day. No invoicing on their end.',
  },
  {
    q: 'Is there a setup fee, minimum, or long-term contract?',
    a: 'No setup fee, no seat minimum and no contract. Billing is month-to-month and you can add or remove seats at any time.',
  },
];

export default function PricingPage() {
  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>
      <NavBar activePath="pricing" />

      {/* ── Hero ── */}
      <section style={{ background: NAVY }} className="py-20 px-6 text-center">
        <p
          className="text-[10px] uppercase font-medium mb-4"
          style={{ color: GOLD, letterSpacing: '0.22em' }}
        >
          Pricing
        </p>
        <h1
          className="font-display text-cream mb-4"
          style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', fontWeight: 500 }}
        >
          Per seat. One rate, shown up front.
        </h1>
        <p className="text-cream/50 text-sm leading-relaxed mx-auto" style={{ maxWidth: '480px', fontWeight: 300 }}>
          Billed monthly per active seat — every seat at your team&apos;s volume tier.
          Your subscription covers sourcing, outreach, scheduling and billing. Call rates are
          quoted all in: the expert&apos;s fee and ours are inside the one number you see.
        </p>
      </section>

      {/* ── Seat tiers ── */}
      <section className="py-16 px-6 border-b border-frame bg-cream">
        <div className="max-w-3xl mx-auto">
          <p
            className="text-[10px] uppercase font-medium mb-2 text-center tracking-widest"
            style={{ color: NAVY, letterSpacing: '0.22em' }}
          >
            Seat Pricing
          </p>
          <p className="text-center text-muted text-sm mb-8 mx-auto" style={{ fontWeight: 300, maxWidth: '520px' }}>
            Billed monthly per active seat. Every seat is billed at the tier your team size
            falls into — add or remove seats any time, prorated.
          </p>

          <div className="border border-frame overflow-x-auto">
            <table className="w-full text-sm border-collapse min-w-[420px]">
              <thead>
                <tr style={{ background: NAVY }}>
                  <th className="text-left px-5 py-3.5 text-[10px] uppercase font-medium text-cream/50" style={{ letterSpacing: '0.14em' }}>Team Size</th>
                  <th className="text-left px-5 py-3.5 text-[10px] uppercase font-medium text-cream/50" style={{ letterSpacing: '0.14em' }}>What It Means</th>
                  <th className="text-center px-5 py-3.5 text-[10px] uppercase font-medium" style={{ letterSpacing: '0.14em', color: GOLD }}>Price</th>
                </tr>
              </thead>
              <tbody>
                {SEAT_ROWS.map(({ range, price, note }, i) => (
                  <tr key={range} style={{ background: i % 2 === 0 ? '#FFFFFF' : '#F7F9FC' }} className="border-b border-frame last:border-b-0">
                    <td className="px-5 py-4 text-[12px] font-semibold text-ink whitespace-nowrap">{range}</td>
                    <td className="px-5 py-4 text-[12px] text-muted" style={{ fontWeight: 300 }}>{note}</td>
                    <td className="px-5 py-4 text-center text-[13px] font-semibold whitespace-nowrap" style={{ color: GOLD }}>{price}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-muted mt-3 text-center" style={{ fontWeight: 300 }}>
            Seats include sourcing, outreach on your behalf, scheduling, and call billing.
          </p>

          <div className="text-center mt-8">
            <Link
              href="/request-access"
              className="inline-block px-10 py-3.5 text-[11px] font-medium uppercase"
              style={{ background: NAVY, color: GOLD, letterSpacing: '0.14em' }}
            >
              Request Access
            </Link>
          </div>
        </div>
      </section>

      {/* ── Per-call rates ── */}
      <section className="py-16 px-6 border-b border-frame" style={{ background: '#F7F9FC' }}>
        <div className="max-w-3xl mx-auto">
          <p
            className="text-[10px] uppercase font-medium mb-2 text-center tracking-widest"
            style={{ color: NAVY, letterSpacing: '0.22em' }}
          >
            Per-Call Rates
          </p>
          <p className="text-center text-muted text-sm mb-8" style={{ fontWeight: 300 }}>
            Calls are billed by the minute at these rates, on top of your seats, with a {MIN_BILLABLE_MINUTES}-minute minimum. Rates are opening positions and include the ExpertMatch fee.
          </p>
          <div className="border border-frame overflow-hidden">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr style={{ background: NAVY }}>
                  <th className="text-left px-5 py-3.5 text-[10px] uppercase font-medium text-cream/50" style={{ letterSpacing: '0.14em' }}>Seniority Tier</th>
                  <th className="text-left px-5 py-3.5 text-[10px] uppercase font-medium text-cream/50" style={{ letterSpacing: '0.14em' }}>Typical Profiles</th>
                  <th className="text-center px-5 py-3.5 text-[10px] uppercase font-medium" style={{ letterSpacing: '0.14em', color: GOLD }}>Call Rate</th>
                </tr>
              </thead>
              <tbody>
                {CALL_TIERS.map(({ tier, rate, desc }, i) => (
                  <tr key={tier} style={{ background: i % 2 === 0 ? '#FFFFFF' : '#F7F9FC' }} className="border-b border-frame last:border-b-0">
                    <td className="px-5 py-4 text-[12px] font-semibold text-ink">{tier}</td>
                    <td className="px-5 py-4 text-[12px] text-muted" style={{ fontWeight: 300 }}>{desc}</td>
                    <td className="px-5 py-4 text-center text-[13px] font-semibold" style={{ color: GOLD }}>{rate}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted mt-3 text-center" style={{ fontWeight: 300 }}>
            {MIN_BILLABLE_MINUTES}-minute minimum, then billed per minute. The rate you see is all in.
          </p>
          <p className="text-[11px] text-muted mt-1.5 text-center" style={{ fontWeight: 300 }}>
            These rates are our opening position — the final rate is agreed per engagement.
          </p>
        </div>
      </section>

      {/* ── FAQ ── */}
      <section className="py-16 px-6 border-b border-frame bg-cream">
        <div className="max-w-2xl mx-auto">
          <p
            className="text-[10px] uppercase font-medium mb-10 text-center tracking-widest"
            style={{ color: NAVY, letterSpacing: '0.22em' }}
          >
            Common Questions
          </p>
          <div className="space-y-6">
            {FAQS.map(({ q, a }) => (
              <div key={q} className="border-b border-frame pb-6 last:border-b-0 last:pb-0">
                <p className="text-sm font-semibold text-navy mb-2">{q}</p>
                <p className="text-[13px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>{a}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── CTA ── */}
      <section style={{ background: NAVY }} className="py-16 px-6 text-center">
        <h2 className="font-display text-cream mb-3" style={{ fontSize: 'clamp(1.4rem, 3vw, 2rem)', fontWeight: 500 }}>
          Questions? Let's talk.
        </h2>
        <p className="text-cream/50 text-sm mb-7" style={{ fontWeight: 300 }}>
          Request access and we'll walk you through the platform with a real brief.
        </p>
        <Link
          href="/request-access"
          className="inline-block px-10 py-3.5 text-[11px] font-medium uppercase"
          style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
        >
          Request Access
        </Link>
      </section>

      <MarketingFooter activePath="/pricing" />
    </div>
  );
}

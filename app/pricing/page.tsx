import type { Metadata } from 'next';
import Link from 'next/link';
import NavBar from '../../components/NavBar';

export const metadata: Metadata = {
  title: 'Pricing — ExpertMatch',
  description: 'Flat monthly fee. Per-minute billing on calls. No minimums, no contracts.',
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
          <Link href="/request-access" className="text-[11px] text-cream/40 hover:text-cream/60 transition-colors" style={{ letterSpacing: '0.1em' }}>Request Access</Link>
        </div>
        <p className="text-[10px] text-cream/25" style={{ letterSpacing: '0.06em' }}>© {new Date().getFullYear()} ExpertMatch</p>
      </div>
    </footer>
  );
}

const PLANS = [
  {
    name: 'Starter',
    price: '$1,500',
    period: '/month',
    tagline: 'For small teams with occasional expert projects.',
    featured: false,
    features: [
      '3 analyst seats',
      '10 expert calls per month',
      'AI expert sourcing',
      'Direct outreach on your behalf',
      'Calendar and scheduling support',
      'Per-minute billing and invoicing',
      'Email support',
    ],
  },
  {
    name: 'Growth',
    price: '$3,500',
    period: '/month',
    tagline: 'For funds with multiple active research workstreams.',
    featured: true,
    features: [
      '10 analyst seats',
      '25 expert calls per month',
      'Everything in Starter',
      'Priority sourcing queue',
      'Dedicated onboarding session',
      'Custom conflict exclusion rules',
      'Phone and email support',
    ],
  },
  {
    name: 'Enterprise',
    price: 'Custom',
    period: '',
    tagline: 'For large teams with compliance requirements.',
    featured: false,
    features: [
      'Unlimited analyst seats',
      'Unlimited expert calls',
      'Everything in Growth',
      'Custom data integrations',
      'SOC 2 and compliance package',
      'SLA with uptime guarantee',
      'Dedicated account manager',
    ],
  },
];

const CALL_TIERS = [
  { tier: 'Mid-Level',           rate: '$400/hr', desc: 'Directors, VPs, Senior Managers' },
  { tier: 'Senior',              rate: '$600/hr', desc: 'C-1 level: SVPs, Partners, MDs' },
  { tier: 'Executive / C-Suite', rate: '$800/hr', desc: 'CEOs, CFOs, Board members' },
];

const FAQS = [
  {
    q: 'Are there per-call fees on top of the subscription?',
    a: 'No. The rates below are what clients pay per call. Calls within your monthly allowance are included in the subscription. Calls beyond your limit are billed at standard rates.',
  },
  {
    q: 'What happens if I exceed my monthly call limit?',
    a: "Additional calls are billed at the standard per-call rates. We'll notify you before you hit the limit.",
  },
  {
    q: 'How do experts get paid?',
    a: 'Experts are compensated competitively and paid directly through the platform within 5 business days of a completed call. No invoicing required on their end.',
  },
  {
    q: 'Can I switch plans at any time?',
    a: 'Yes. Plan changes take effect at the start of your next billing cycle. Upgrades can be activated immediately.',
  },
  {
    q: 'Is there a setup fee or long-term contract?',
    a: 'No setup fees. Plans are month-to-month. Enterprise contracts are available for teams that prefer annual billing.',
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
          Flat fee. No markups.
        </h1>
        <p className="text-cream/50 text-sm leading-relaxed mx-auto" style={{ maxWidth: '480px', fontWeight: 300 }}>
          One monthly subscription covers sourcing, outreach, and billing.
          Experts are compensated competitively for their time.
        </p>
      </section>

      {/* ── Plan cards ── */}
      <section className="py-16 px-6 border-b border-frame bg-cream">
        <div className="max-w-5xl mx-auto">
          <div className="grid sm:grid-cols-3 gap-5">
            {PLANS.map(({ name, price, period, tagline, featured, features }) => (
              <div
                key={name}
                className="flex flex-col p-7"
                style={{
                  background: featured ? NAVY : '#FFFFFF',
                  border: featured ? `2px solid ${GOLD}` : '1px solid #DDE3EA',
                }}
              >
                {featured && (
                  <p
                    className="text-[9px] uppercase font-bold mb-4 tracking-widest self-start px-2 py-0.5"
                    style={{ background: GOLD, color: NAVY, letterSpacing: '0.2em' }}
                  >
                    Most Popular
                  </p>
                )}
                <p
                  className="text-[11px] uppercase font-semibold mb-1"
                  style={{ letterSpacing: '0.18em', color: featured ? GOLD : NAVY }}
                >
                  {name}
                </p>
                <p
                  className="text-[12px] mb-4 leading-snug"
                  style={{ color: featured ? 'rgba(255,255,255,0.45)' : '#8A9BAD', fontWeight: 300 }}
                >
                  {tagline}
                </p>
                <div className="flex items-baseline gap-1 mb-6 border-b pb-6" style={{ borderColor: featured ? 'rgba(255,255,255,0.1)' : '#DDE3EA' }}>
                  <span
                    className="font-display"
                    style={{ fontSize: '2.2rem', fontWeight: 500, color: featured ? '#FFFFFF' : NAVY }}
                  >
                    {price}
                  </span>
                  {period && (
                    <span className="text-sm" style={{ color: featured ? 'rgba(255,255,255,0.4)' : '#8A9BAD' }}>
                      {period}
                    </span>
                  )}
                </div>
                <ul className="space-y-2.5 flex-1 mb-8">
                  {features.map(f => (
                    <li key={f} className="flex items-start gap-2.5">
                      <span style={{ color: GOLD, fontSize: '11px', marginTop: '2px', flexShrink: 0 }}>✓</span>
                      <span
                        className="text-[12px] leading-snug"
                        style={{ color: featured ? 'rgba(255,255,255,0.65)' : '#5A6B7A', fontWeight: 300 }}
                      >
                        {f}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/request-access"
                  className="block text-center text-[10px] uppercase font-medium py-3 transition-colors"
                  style={{
                    letterSpacing: '0.14em',
                    background: featured ? GOLD : 'transparent',
                    color: NAVY,
                    border: featured ? 'none' : `1px solid ${NAVY}30`,
                  }}
                >
                  {name === 'Enterprise' ? 'Contact Us' : 'Request Access'}
                </Link>
              </div>
            ))}
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
            Call allowances are included in your plan. These rates apply to additional calls.
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
            Billed per minute. Experts are compensated competitively for their time.
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

      <Footer />
    </div>
  );
}

import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = {
  title: 'Pricing — ExpertMatch',
  description: 'Flat monthly fee. No per-call markups. Experts keep 70% of every call.',
};

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';

function Nav() {
  return (
    <header style={{ background: NAVY, borderBottom: `2px solid ${GOLD}` }}>
      <div className="max-w-6xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between">
        <Link
          href="/"
          className="font-display text-cream font-semibold"
          style={{ letterSpacing: '0.15em', fontSize: '13px' }}
        >
          EXPERTMATCH
        </Link>
        <nav className="flex items-center gap-6">
          <Link
            href="/pricing"
            className="text-[11px] uppercase font-medium hidden sm:block"
            style={{ letterSpacing: '0.14em', color: GOLD }}
          >
            Pricing
          </Link>
          <Link
            href="/login"
            className="text-[11px] uppercase border px-4 py-2 transition-colors"
            style={{ letterSpacing: '0.14em', color: GOLD, borderColor: `${GOLD}40` }}
          >
            Log In
          </Link>
        </nav>
      </div>
    </header>
  );
}

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

// ─── Plan data ────────────────────────────────────────────────────────────────

const PLANS = [
  {
    name: 'Starter',
    price: '$1,500',
    period: '/month',
    tagline: 'For small teams running occasional expert projects.',
    featured: false,
    features: [
      '3 analyst seats',
      '10 expert calls per month',
      'AI expert sourcing',
      'Automated outreach sequences',
      'Scheduling & calendar integration',
      'Stripe billing & invoicing',
      'Email support',
    ],
  },
  {
    name: 'Growth',
    price: '$3,500',
    period: '/month',
    tagline: 'For funds running multiple active research workstreams.',
    featured: true,
    features: [
      '10 analyst seats',
      '25 expert calls per month',
      'Everything in Starter',
      'Priority sourcing queue',
      'Dedicated onboarding session',
      'Custom conflict exclusion rules',
      'Phone & email support',
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
      'SOC 2 & compliance package',
      'SLA with uptime guarantee',
      'Dedicated account manager',
    ],
  },
];

// ─── Per-call fee table data ──────────────────────────────────────────────────

const CALL_TIERS = [
  { tier: 'Mid-Level',        clientPays: '$400', expertReceives: '$280', platformFee: '$120', desc: 'Directors, VPs, Senior Managers' },
  { tier: 'Senior',           clientPays: '$600', expertReceives: '$420', platformFee: '$180', desc: 'C-1 level: SVPs, Partners, MDs' },
  { tier: 'Executive / C-Suite', clientPays: '$800', expertReceives: '$560', platformFee: '$240', desc: 'CEOs, CFOs, Board members' },
];

// ─── FAQ data ─────────────────────────────────────────────────────────────────

const FAQS = [
  {
    q: 'Are there per-call fees on top of the subscription?',
    a: 'No per-call markups. The per-call rates above are what clients pay experts directly — the platform fee is the difference. These rates are built into your monthly subscription call allowance.',
  },
  {
    q: 'What happens if I exceed my monthly call limit?',
    a: 'Additional calls beyond your plan limit are billed at the standard per-call rates. We\'ll notify you before you hit the limit so you can upgrade your plan.',
  },
  {
    q: 'How do experts get paid?',
    a: 'Experts receive 70% of the agreed call rate via Stripe, processed within 5 business days of the completed call. No invoicing required on the expert side.',
  },
  {
    q: 'Can I switch plans at any time?',
    a: 'Yes. Plan changes take effect at the start of your next billing cycle. Upgrades can be activated immediately on request.',
  },
  {
    q: 'Is there a setup fee or long-term contract?',
    a: 'No setup fees. Plans are month-to-month with no minimum commitment. Enterprise contracts are available for teams that prefer annual billing.',
  },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function PricingPage() {
  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>
      <Nav />

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
        <p className="text-cream/50 text-sm leading-relaxed mx-auto" style={{ maxWidth: '520px', fontWeight: 300 }}>
          One monthly subscription covers sourcing, outreach, scheduling, and billing.
          Experts keep 70% of every call — no hidden intermediary fees.
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
                    color: featured ? NAVY : NAVY,
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

      {/* ── Per-call fees ── */}
      <section className="py-16 px-6 border-b border-frame" style={{ background: '#F7F9FC' }}>
        <div className="max-w-3xl mx-auto">
          <p
            className="text-[10px] uppercase font-medium mb-2 text-center tracking-widest"
            style={{ color: NAVY, letterSpacing: '0.22em' }}
          >
            Per-Call Rates
          </p>
          <p className="text-center text-muted text-sm mb-8" style={{ fontWeight: 300 }}>
            Call allowances are included in your plan. These rates apply to additional calls or when billing clients directly.
          </p>
          <div className="border border-frame overflow-hidden">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr style={{ background: NAVY }}>
                  <th className="text-left px-5 py-3.5 text-[10px] uppercase font-medium text-cream/50" style={{ letterSpacing: '0.14em' }}>Seniority Tier</th>
                  <th className="text-center px-5 py-3.5 text-[10px] uppercase font-medium text-cream/50" style={{ letterSpacing: '0.14em' }}>Client Pays</th>
                  <th className="text-center px-5 py-3.5 text-[10px] uppercase font-medium" style={{ letterSpacing: '0.14em', color: GOLD }}>Expert Receives</th>
                  <th className="text-center px-5 py-3.5 text-[10px] uppercase font-medium text-cream/50" style={{ letterSpacing: '0.14em' }}>Platform Fee</th>
                </tr>
              </thead>
              <tbody>
                {CALL_TIERS.map(({ tier, clientPays, expertReceives, platformFee, desc }, i) => (
                  <tr key={tier} style={{ background: i % 2 === 0 ? '#FFFFFF' : '#F7F9FC' }} className="border-b border-frame last:border-b-0">
                    <td className="px-5 py-4">
                      <p className="text-[12px] font-semibold text-ink">{tier}</p>
                      <p className="text-[11px] text-muted mt-0.5" style={{ fontWeight: 300 }}>{desc}</p>
                    </td>
                    <td className="px-5 py-4 text-center text-[13px] font-medium text-ink">{clientPays}</td>
                    <td className="px-5 py-4 text-center text-[13px] font-semibold" style={{ color: GOLD }}>{expertReceives}</td>
                    <td className="px-5 py-4 text-center text-[13px] text-muted">{platformFee}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-muted mt-3 text-center" style={{ fontWeight: 300 }}>
            All rates are per 60-minute call. Calls under 60 minutes are billed pro-rata.
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
            Frequently Asked Questions
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
          Request access and we'll walk you through the platform live.
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

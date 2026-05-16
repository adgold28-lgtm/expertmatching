import type { Metadata } from 'next';
import Link from 'next/link';
import NavBar from '../components/NavBar';

export const metadata: Metadata = {
  title: 'ExpertMatch — Expert Calls, Sourced and Billed in Hours.',
  description: 'ExpertMatch replaces traditional expert networks for PE firms, hedge funds, and strategy consultants. AI-sourced practitioners, direct outreach, per-minute billing. No account managers, no markups.',
};

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';


function Footer() {
  return (
    <footer style={{ background: NAVY, borderTop: `1px solid rgba(198,167,94,0.2)` }}>
      <div className="max-w-6xl mx-auto px-6 sm:px-10 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <span
          className="font-display text-cream/40 font-semibold"
          style={{ letterSpacing: '0.15em', fontSize: '11px' }}
        >
          EXPERTMATCH
        </span>
        <div className="flex items-center gap-6">
          <Link href="/pricing" className="text-[11px] text-cream/40 hover:text-cream/60 transition-colors" style={{ letterSpacing: '0.1em' }}>Pricing</Link>
          <Link href="/request-access" className="text-[11px] text-cream/40 hover:text-cream/60 transition-colors" style={{ letterSpacing: '0.1em' }}>Request Access</Link>
        </div>
        <p className="text-[10px] text-cream/25" style={{ letterSpacing: '0.06em' }}>
          © {new Date().getFullYear()} ExpertMatch
        </p>
      </div>
    </footer>
  );
}

export default function LandingPage() {
  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>
      <NavBar />

      {/* ── Hero ── */}
      <section style={{ background: NAVY }} className="py-24 sm:py-32 px-6">
        <div className="max-w-4xl mx-auto text-center">
          <p
            className="text-[10px] uppercase font-medium mb-6 tracking-widest"
            style={{ color: GOLD, letterSpacing: '0.22em' }}
          >
            Expert Network Operations
          </p>
          <h1
            className="font-display text-cream leading-tight mb-6"
            style={{ fontSize: 'clamp(2.2rem, 5vw, 3.6rem)', fontWeight: 500, letterSpacing: '-0.01em' }}
          >
            Expert calls, sourced<br />
            <span style={{ fontStyle: 'italic', fontWeight: 300, color: 'rgba(255,255,255,0.6)' }}>
              and billed in hours.
            </span>
          </h1>
          <p
            className="text-cream/60 leading-relaxed mx-auto mb-10"
            style={{ fontSize: '1rem', maxWidth: '520px', fontWeight: 300 }}
          >
            ExpertMatch replaces traditional expert networks for PE firms, hedge funds, and strategy consultants.
            We identify the right practitioners, handle outreach, and bill by the minute.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/request-access"
              className="inline-block px-8 py-3.5 text-[11px] font-medium uppercase transition-colors"
              style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
            >
              Request Access
            </Link>
            <Link
              href="/pricing"
              className="inline-block px-8 py-3.5 text-[11px] uppercase transition-colors border"
              style={{ color: GOLD, borderColor: `${GOLD}40`, letterSpacing: '0.14em' }}
            >
              See Pricing
            </Link>
          </div>
        </div>
      </section>

      {/* ── Stats strip ── */}
      <section className="border-b border-frame bg-cream py-10 px-6">
        <div className="max-w-4xl mx-auto grid grid-cols-3 gap-6 text-center">
          {[
            { stat: '< 2 hours',    label: 'Brief to expert shortlist' },
            { stat: 'Per minute',   label: 'Pay for time used, not a flat hourly rate' },
            { stat: 'No contracts', label: 'No minimums. No account managers.' },
          ].map(({ stat, label }) => (
            <div key={stat}>
              <p
                className="font-display"
                style={{ fontSize: 'clamp(1.4rem, 2.5vw, 2rem)', color: NAVY, fontWeight: 500 }}
              >
                {stat}
              </p>
              <p className="text-[11px] text-muted mt-1 leading-snug" style={{ fontWeight: 300 }}>
                {label}
              </p>
            </div>
          ))}
        </div>
      </section>

      {/* ── How it works ── */}
      <section className="py-20 px-6 bg-surface">
        <div className="max-w-4xl mx-auto">
          <p
            className="text-[10px] uppercase font-medium mb-12 tracking-widest text-center"
            style={{ color: NAVY, letterSpacing: '0.22em' }}
          >
            How It Works
          </p>
          <div className="grid sm:grid-cols-3 gap-10">
            {[
              {
                n: '01',
                title: 'Describe your research question',
                body: 'Tell us the sector, geography, and what you need to understand.',
              },
              {
                n: '02',
                title: 'We find and contact the right experts',
                body: 'Operators, advisors, and domain experts are identified from public records and contacted on your behalf.',
              },
              {
                n: '03',
                title: 'Get on a call. Billed by the minute.',
                body: 'Once an expert confirms, the call is set up. You pay for the time actually used.',
              },
            ].map(({ n, title, body }) => (
              <div key={n} className="flex flex-col">
                <div
                  className="w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold mb-4 shrink-0"
                  style={{ background: NAVY, color: GOLD, letterSpacing: '0.04em' }}
                >
                  {n}
                </div>
                <h3
                  className="text-sm font-semibold text-navy mb-2"
                  style={{ letterSpacing: '0.02em' }}
                >
                  {title}
                </h3>
                <p className="text-[13px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>
                  {body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Comparison table ── */}
      <section className="py-20 px-6 border-t border-frame" style={{ background: '#F7F9FC' }}>
        <div className="max-w-3xl mx-auto">
          <p
            className="text-[10px] uppercase font-medium mb-10 tracking-widest text-center"
            style={{ color: NAVY, letterSpacing: '0.22em' }}
          >
            ExpertMatch vs. Traditional Networks
          </p>
          <div className="border border-frame overflow-hidden">
            <table className="w-full text-sm border-collapse">
              <thead>
                <tr style={{ background: NAVY }}>
                  <th className="text-left px-5 py-3.5 text-[10px] uppercase font-medium text-cream/50" style={{ letterSpacing: '0.14em', width: '40%' }}>
                    Capability
                  </th>
                  <th className="text-center px-5 py-3.5 text-[10px] uppercase font-medium" style={{ letterSpacing: '0.14em', color: GOLD, width: '30%' }}>
                    ExpertMatch
                  </th>
                  <th className="text-center px-5 py-3.5 text-[10px] uppercase font-medium text-cream/40" style={{ letterSpacing: '0.14em', width: '30%' }}>
                    Traditional Networks
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  ['Expert sourcing',     'AI, from public records',  'Manual researcher'],
                  ['Sourcing turnaround', '< 2 hours',                '2–5 business days'],
                  ['Outreach',           'Handled for you',           'Not offered'],
                  ['Scheduling',         'Handled for you',           'Manual back-and-forth'],
                  ['Billing',            'Per-minute, instant',       'Invoice + 30-day net'],
                  ['Per-call markup',    'None',                      '3–10× expert rate'],
                  ['Sourcing evidence',  'Full evidence trail',       'Opaque'],
                ].map(([cap, em, trad], i) => (
                  <tr
                    key={cap}
                    style={{ background: i % 2 === 0 ? '#FFFFFF' : '#F7F9FC' }}
                    className="border-b border-frame last:border-b-0"
                  >
                    <td className="px-5 py-3.5 text-[12px] text-ink font-medium">{cap}</td>
                    <td className="px-5 py-3.5 text-[12px] text-center font-medium" style={{ color: GOLD }}>
                      {em}
                    </td>
                    <td className="px-5 py-3.5 text-[12px] text-center text-muted">{trad}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* ── Pricing teaser ── */}
      <section className="py-20 px-6 border-t border-frame bg-cream">
        <div className="max-w-4xl mx-auto">
          <p
            className="text-[10px] uppercase font-medium mb-2 tracking-widest text-center"
            style={{ color: NAVY, letterSpacing: '0.22em' }}
          >
            Pricing
          </p>
          <p className="text-center text-muted text-sm mb-10" style={{ fontWeight: 300 }}>
            Flat monthly fee. Per-minute billing on calls. No contracts.
          </p>
          <div className="grid sm:grid-cols-3 gap-5">
            {[
              {
                name: 'Starter',
                price: '$1,500',
                period: '/month',
                features: ['3 seats', '10 expert calls/mo', 'AI sourcing', 'Outreach automation', 'Call coordination and billing'],
                featured: false,
              },
              {
                name: 'Growth',
                price: '$3,500',
                period: '/month',
                features: ['10 seats', '25 expert calls/mo', 'Everything in Starter', 'Priority sourcing queue', 'Dedicated onboarding'],
                featured: true,
              },
              {
                name: 'Enterprise',
                price: 'Custom',
                period: '',
                features: ['Unlimited seats', 'Unlimited calls', 'Everything in Growth', 'Custom integrations', 'SLA and compliance'],
                featured: false,
              },
            ].map(({ name, price, period, features, featured }) => (
              <div
                key={name}
                className="flex flex-col p-6"
                style={{
                  background: featured ? NAVY : '#FFFFFF',
                  border: featured ? `2px solid ${GOLD}` : '1px solid #DDE3EA',
                }}
              >
                <p
                  className="text-[10px] uppercase font-semibold mb-3"
                  style={{ letterSpacing: '0.18em', color: featured ? GOLD : NAVY }}
                >
                  {name}
                </p>
                <div className="flex items-baseline gap-1 mb-5">
                  <span
                    className="font-display"
                    style={{ fontSize: '1.8rem', fontWeight: 500, color: featured ? '#FFFFFF' : NAVY }}
                  >
                    {price}
                  </span>
                  {period && (
                    <span className="text-xs" style={{ color: featured ? 'rgba(255,255,255,0.5)' : '#8A9BAD' }}>
                      {period}
                    </span>
                  )}
                </div>
                <ul className="space-y-2 flex-1 mb-6">
                  {features.map(f => (
                    <li key={f} className="flex items-start gap-2">
                      <span style={{ color: GOLD, fontSize: '10px', marginTop: '3px' }}>✓</span>
                      <span
                        className="text-[12px]"
                        style={{ color: featured ? 'rgba(255,255,255,0.7)' : '#5A6B7A', fontWeight: 300 }}
                      >
                        {f}
                      </span>
                    </li>
                  ))}
                </ul>
                <Link
                  href="/request-access"
                  className="block text-center text-[10px] uppercase font-medium py-2.5 transition-colors"
                  style={{
                    letterSpacing: '0.14em',
                    background: featured ? GOLD : 'transparent',
                    color: NAVY,
                    border: featured ? 'none' : `1px solid ${NAVY}40`,
                  }}
                >
                  {name === 'Enterprise' ? 'Contact Us' : 'Request Access'}
                </Link>
              </div>
            ))}
          </div>
          <p className="text-center mt-6">
            <Link
              href="/pricing"
              className="text-[11px] text-muted hover:text-navy transition-colors"
              style={{ letterSpacing: '0.1em' }}
            >
              Full pricing details →
            </Link>
          </p>
        </div>
      </section>

      {/* ── CTA ── */}
      <section style={{ background: NAVY }} className="py-20 px-6">
        <div className="max-w-2xl mx-auto text-center">
          <h2
            className="font-display text-cream mb-4"
            style={{ fontSize: 'clamp(1.6rem, 3.5vw, 2.4rem)', fontWeight: 500 }}
          >
            See it with a question you're working on.
          </h2>
          <p className="text-cream/50 mb-8 text-sm leading-relaxed" style={{ fontWeight: 300 }}>
            Request access. We'll run a live sourcing brief on a real question from your pipeline.
          </p>
          <Link
            href="/request-access"
            className="inline-block px-10 py-3.5 text-[11px] font-medium uppercase transition-colors"
            style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
          >
            Request Access
          </Link>
        </div>
      </section>

      <Footer />
    </div>
  );
}

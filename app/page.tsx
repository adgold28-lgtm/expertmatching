import type { Metadata } from 'next';
import Link from 'next/link';
import NavBar from '../components/NavBar';
import MarketingFooter from '../components/MarketingFooter';
import { createClient } from '../lib/supabase/server';
import { SEAT_TIERS, formatUsdFromCents } from '../lib/pricing';

export const metadata: Metadata = {
  title: 'ExpertMatch — Expert Calls, Sourced and Billed in Hours.',
  description: 'ExpertMatch replaces traditional expert networks for PE firms, family offices, consulting firms, and law firms. We source the expert, run the outreach, book the call, and bill it — no account managers, no research fees.',
};

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';


export default async function LandingPage() {
  let isSignedIn = false;
  try {
    const supabase = createClient();
    const { data: { user } } = await supabase.auth.getUser();
    isSignedIn = !!user;
  } catch { /* signed out */ }

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
            For PE, family offices, consulting and law
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
            ExpertMatch replaces traditional expert networks for PE firms, family offices,
            consulting firms, and law firms. We find the right practitioners, run the outreach,
            book the call from your calendar, and bill it to your card — 15-minute minimum,
            per-minute after that.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            {isSignedIn ? (
              <Link
                href="/app"
                className="inline-block px-8 py-3.5 text-[11px] font-medium uppercase transition-colors"
                style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
              >
                Go to Your Projects
              </Link>
            ) : (
              <Link
                href="/request-access"
                className="inline-block px-8 py-3.5 text-[11px] font-medium uppercase transition-colors"
                style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
              >
                Request Access
              </Link>
            )}
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
            { stat: '< 2 hours',       label: 'Brief to expert candidates' },
            { stat: '15 min minimum',  label: 'Then per minute. Pay for the time actually used.' },
            { stat: 'Month to month',  label: 'No annual contract. No account managers.' },
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
                title: 'We find them and reach out',
                body: 'We identify the operators and advisors who fit. Matchy contacts them anonymously on your behalf and handles the conflict and rate conversation.',
              },
              {
                n: '03',
                title: 'Get on the call',
                body: 'We book the Zoom from your calendar. 15-minute minimum, per minute after that, charged to your card when the call ends.',
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
                  ['Expert sourcing',     'Automated, in minutes',    'Manual researcher'],
                  ['Sourcing turnaround', '< 2 hours',                '2–5 business days'],
                  ['Outreach',           'Handled for you',           'Not offered'],
                  ['Scheduling',         'Handled for you',           'Manual back-and-forth'],
                  ['Billing',            'Per-minute after 15 min, charged instantly', 'Invoice + 30-day net'],
                  ['Per-call pricing',   'One rate, shown up front',  'Opaque markup, 3–10× expert rate'],
                  ['Expert vetting',     'Verified background, identity revealed at booking', 'Opaque'],
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
        <div className="max-w-3xl mx-auto">
          <p
            className="text-[10px] uppercase font-medium mb-2 tracking-widest text-center"
            style={{ color: NAVY, letterSpacing: '0.22em' }}
          >
            Pricing
          </p>
          <p className="text-center text-muted text-sm mb-10 mx-auto" style={{ fontWeight: 300, maxWidth: '520px' }}>
            Billed monthly per active seat; every seat is billed at the tier your team size
            falls into. Add or remove seats any time, prorated. Calls are billed by the minute after a 15-minute minimum.
          </p>

          <div className="border border-frame overflow-x-auto bg-white">
            <table className="w-full text-sm border-collapse min-w-[360px]">
              <thead>
                <tr style={{ background: NAVY }}>
                  <th className="text-left px-5 py-3 text-[10px] uppercase font-medium text-cream/50" style={{ letterSpacing: '0.14em' }}>
                    Team Size
                  </th>
                  <th className="text-right px-5 py-3 text-[10px] uppercase font-medium" style={{ letterSpacing: '0.14em', color: GOLD }}>
                    Per Seat / Month
                  </th>
                </tr>
              </thead>
              <tbody>
                {SEAT_TIERS.map((tier, i) => (
                  <tr
                    key={tier.minSeats}
                    style={{ background: i % 2 === 0 ? '#FFFFFF' : '#F7F9FC' }}
                    className="border-b border-frame last:border-b-0"
                  >
                    <td className="px-5 py-3 text-[12px] font-semibold text-ink whitespace-nowrap">
                      {tier.maxSeats === null
                        ? `${tier.minSeats}+ seats`
                        : `${tier.minSeats}–${tier.maxSeats} seats`}
                    </td>
                    <td className="px-5 py-3 text-right text-[13px] font-semibold whitespace-nowrap" style={{ color: GOLD }}>
                      {tier.contactSales ? 'Talk to us' : formatUsdFromCents(tier.unitPriceCents)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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

      <MarketingFooter activePath="/" />
    </div>
  );
}

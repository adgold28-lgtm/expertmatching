import type { Metadata } from 'next';
import Link from 'next/link';
import NavBar from '../../components/NavBar';
import MarketingFooter from '../../components/MarketingFooter';

// Contact page.
//
// One email address and one postal address — no form. The postal address must
// match OUTREACH_POSTAL_ADDRESS, which is what our outreach email footers carry
// for CAN-SPAM; a stranger who got a cold email should be able to check that the
// address on the email is the address on the site.

export const metadata: Metadata = {
  title: 'Contact — ExpertMatch',
  description: 'How to reach ExpertMatch: one email address, one postal address, and where to request access.',
};

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';

export default function ContactPage() {
  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>
      <NavBar />

      {/* ── Hero ── */}
      <section style={{ background: NAVY }} className="py-16 px-6 text-center">
        <p className="text-[10px] uppercase font-medium mb-4" style={{ color: GOLD, letterSpacing: '0.22em' }}>
          Contact
        </p>
        <h1 className="font-display text-cream mb-4" style={{ fontSize: 'clamp(1.8rem, 4vw, 2.6rem)', fontWeight: 500 }}>
          Reach a person.
        </h1>
        <p className="text-cream/50 text-sm mx-auto" style={{ maxWidth: '420px', fontWeight: 300 }}>
          One address, read by the people who build ExpertMatch. No ticket queue.
        </p>
      </section>

      {/* ── Body ── */}
      <main className="flex-1 py-16 px-6">
        <div className="max-w-xl mx-auto">

          <div className="bg-surface border border-frame px-6 sm:px-10 py-10">

            <div className="pb-8 border-b border-frame">
              <p className="text-[10px] uppercase font-medium text-muted mb-2" style={{ letterSpacing: '0.18em' }}>
                Email
              </p>
              <p className="font-display text-navy" style={{ fontSize: '1.25rem', fontWeight: 500 }}>
                [CONFIRM: contact email]
              </p>
              <p className="text-[13px] text-muted leading-relaxed mt-2" style={{ fontWeight: 300 }}>
                Sales questions, billing questions, privacy and data requests, and anything an expert
                wants to ask us — all to the same address.
              </p>
            </div>

            <div className="py-8 border-b border-frame">
              <p className="text-[10px] uppercase font-medium text-muted mb-2" style={{ letterSpacing: '0.18em' }}>
                Post
              </p>
              <p className="text-[14px] text-ink leading-relaxed" style={{ fontWeight: 400 }}>
                [CONFIRM: postal address — same value as OUTREACH_POSTAL_ADDRESS]
              </p>
              <p className="text-[13px] text-muted leading-relaxed mt-2" style={{ fontWeight: 300 }}>
                This is the address that appears at the bottom of every email we send.
              </p>
            </div>

            <div className="pt-8">
              <p className="text-[10px] uppercase font-medium text-muted mb-2" style={{ letterSpacing: '0.18em' }}>
                Access
              </p>
              <p className="text-[13px] text-muted leading-relaxed" style={{ fontWeight: 300 }}>
                For access requests use{' '}
                <Link href="/request-access" className="text-navy underline hover:no-underline" style={{ fontWeight: 400 }}>
                  /request-access
                </Link>
                .
              </p>
            </div>

          </div>

          <p className="mt-6 text-center text-[11px] text-muted" style={{ fontWeight: 300 }}>
            <Link href="/terms" className="hover:text-navy transition-colors">Terms of Service</Link>
            {' · '}
            <Link href="/privacy" className="hover:text-navy transition-colors">Privacy Policy</Link>
          </p>

        </div>
      </main>

      <MarketingFooter activePath="/contact" />
    </div>
  );
}

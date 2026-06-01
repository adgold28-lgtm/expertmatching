import type { Metadata } from 'next';
import Link from 'next/link';
import NavBar from '../../components/NavBar';

export const metadata: Metadata = {
  title: 'Privacy Policy & Data Retention — ExpertMatch',
  description: 'How ExpertMatch collects, uses, retains, and deletes your data.',
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
    title: 'Data We Collect',
    body: [
      'ExpertMatch collects information necessary to operate the platform and deliver expert-matching services:',
      '• Account information: email address, first and last name, job title, firm name, and firm domain.',
      '• Research briefs and project data: descriptions, sector and geography parameters, and any notes you provide.',
      '• Expert engagement data: expert profiles sourced from public records, outreach correspondence, scheduling details, and call metadata (duration, timestamp).',
      '• Billing information: subscription tier and Stripe-managed payment details. ExpertMatch does not store raw card numbers.',
      '• Usage data: session tokens, login timestamps, and platform activity logs used for security and audit purposes.',
    ],
  },
  {
    title: 'How We Use Your Data',
    body: [
      'We use the data we collect solely to provide and improve the ExpertMatch service:',
      '• Delivering expert sourcing, outreach, scheduling, and billing for your research projects.',
      '• Authenticating your identity and maintaining session security.',
      '• Communicating service updates, invoice summaries, and scheduling confirmations.',
      '• Detecting and preventing unauthorized access or abuse.',
      'We do not sell personal data to third parties. We do not use your research briefs or expert engagement data for purposes unrelated to your projects.',
    ],
  },
  {
    title: 'Data Retention',
    body: [
      'We retain data for as long as your account is active or as needed to provide the service, subject to the following defaults:',
      '• Account records: retained for the duration of the subscription plus 90 days after cancellation, to support invoicing and dispute resolution.',
      '• Project and research data: retained for 24 months from the date of last activity on the project. After that period, project data is permanently deleted from our systems.',
      '• Expert contact and outreach records: retained for 12 months from the date of last activity, then permanently deleted.',
      '• Call metadata (timestamp, duration): retained for 36 months for billing and audit purposes.',
      '• Session tokens and authentication logs: purged within 30 days of session expiry.',
      '• Billing records: retained for 7 years to meet legal and financial reporting requirements, even after account deletion.',
      'Shorter retention periods can be requested — see "Requesting Deletion" below.',
    ],
  },
  {
    title: 'Your Rights',
    body: [
      'Depending on your jurisdiction, you may have the following rights regarding your personal data:',
      '• Access: request a summary of the personal data we hold about you.',
      '• Correction: request corrections to inaccurate or incomplete data.',
      '• Deletion: request permanent deletion of your account and associated data (see below).',
      '• Portability: request an export of your account and project data in a machine-readable format.',
      '• Restriction: request that we limit processing of your data while a dispute is pending.',
      'To exercise any of these rights, contact us at privacy@expertmatch.io. We will respond within 30 days.',
    ],
  },
  {
    title: 'Requesting Deletion',
    body: [
      'You can request deletion of your ExpertMatch account and all associated personal data at any time.',
      'To submit a deletion request:',
      '1. Email privacy@expertmatch.io from the address associated with your account, with the subject line "Account Deletion Request."',
      '2. An administrator will verify your identity and initiate deletion within 5 business days.',
      '3. You will receive a confirmation email once deletion is complete.',
      'What gets deleted: your account record, profile data, research briefs, project history, expert engagement records, and session data.',
      'What is retained: billing records required for legal or financial compliance are kept for up to 7 years in accordance with applicable regulations, but are not used for any other purpose.',
      'Deletion is permanent and cannot be undone. If you wish to use ExpertMatch after deletion, you would need a new invitation from an administrator.',
    ],
  },
  {
    title: 'Data Security',
    body: [
      'ExpertMatch implements industry-standard security practices:',
      '• Passwords are hashed using bcrypt and never stored in plaintext.',
      '• Sessions are authenticated using HMAC-signed cookies.',
      '• Data at rest is stored in Upstash Redis with encrypted connections.',
      '• Access to production data is restricted to authorized personnel only.',
      '• Platform access is invite-only — there is no open registration.',
      'If you discover a security concern, contact us at security@expertmatch.io.',
    ],
  },
  {
    title: 'Third-Party Services',
    body: [
      'ExpertMatch uses the following third-party processors:',
      '• Stripe — payment processing. Subject to Stripe\'s own privacy policy.',
      '• Upstash — database storage. Data is stored in-region with encryption in transit.',
      '• Resend — transactional email delivery.',
      '• Vercel — application hosting and infrastructure.',
      'Each processor is bound by a data processing agreement and handles data only as directed by ExpertMatch.',
    ],
  },
  {
    title: 'Changes to This Policy',
    body: [
      'We may update this policy periodically. When we make material changes, we will notify account holders by email and update the "Last updated" date at the top of this page. Continued use of the platform after notification constitutes acceptance of the updated policy.',
    ],
  },
  {
    title: 'Contact',
    body: [
      'For privacy inquiries, data access requests, or deletion requests:',
      'Email: privacy@expertmatch.io',
      'For security disclosures: security@expertmatch.io',
    ],
  },
];

export default function PrivacyPage() {
  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>
      <NavBar />

      {/* ── Hero ── */}
      <section style={{ background: NAVY }} className="py-20 px-6 text-center">
        <p
          className="text-[10px] uppercase font-medium mb-4"
          style={{ color: GOLD, letterSpacing: '0.22em' }}
        >
          Legal
        </p>
        <h1
          className="font-display text-cream mb-4"
          style={{ fontSize: 'clamp(2rem, 4vw, 3rem)', fontWeight: 500 }}
        >
          Privacy Policy &amp; Data Retention
        </h1>
        <p className="text-cream/50 text-sm leading-relaxed mx-auto" style={{ maxWidth: '480px', fontWeight: 300 }}>
          Last updated: June 2026
        </p>
        <p className="text-cream/40 text-xs leading-relaxed mx-auto mt-2" style={{ maxWidth: '560px', fontWeight: 300 }}>
          This policy describes how ExpertMatch collects, uses, retains, and deletes information
          in connection with the ExpertMatch platform.
        </p>
      </section>

      {/* ── Content ── */}
      <section className="py-16 px-6 flex-1">
        <div className="max-w-3xl mx-auto space-y-12">
          {SECTIONS.map(({ title, body }) => (
            <div key={title} className="border-b border-frame pb-12 last:border-b-0 last:pb-0">
              <h2
                className="text-[10px] uppercase font-semibold mb-4 tracking-widest"
                style={{ color: NAVY, letterSpacing: '0.2em' }}
              >
                {title}
              </h2>
              <div className="space-y-2">
                {body.map((line, i) => (
                  <p
                    key={i}
                    className="text-[13px] leading-relaxed"
                    style={{ color: '#3D4F5F', fontWeight: line.startsWith('•') || line.match(/^\d\./) ? 300 : 400 }}
                  >
                    {line}
                  </p>
                ))}
              </div>
            </div>
          ))}
        </div>
      </section>

      {/* ── CTA ── */}
      <section style={{ background: NAVY }} className="py-12 px-6 text-center">
        <p className="text-cream/50 text-sm mb-5" style={{ fontWeight: 300 }}>
          Questions about your data? We&apos;re here to help.
        </p>
        <a
          href="mailto:privacy@expertmatch.io"
          className="inline-block px-8 py-3 text-[11px] font-medium uppercase transition-colors"
          style={{ background: GOLD, color: NAVY, letterSpacing: '0.14em' }}
        >
          Contact Privacy Team
        </a>
      </section>

      <Footer />
    </div>
  );
}

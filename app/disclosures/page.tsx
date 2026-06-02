import type { Metadata } from 'next';
import Link from 'next/link';
import NavBar from '../../components/NavBar';

export const metadata: Metadata = {
  title: 'AI & Third-Party Tool Disclosures — ExpertMatch',
  description: 'Disclosure of the AI providers and third-party tools used to power ExpertMatch.',
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

interface ProviderCardProps {
  name: string;
  category: string;
  purpose: string;
  dataShared: string;
  learnMore?: string;
}

function ProviderCard({ name, category, purpose, dataShared, learnMore }: ProviderCardProps) {
  return (
    <div
      className="p-5 border border-frame"
      style={{ background: '#FFFFFF' }}
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div>
          <p className="text-sm font-semibold text-navy">{name}</p>
          <p
            className="text-[10px] uppercase font-medium mt-0.5"
            style={{ color: GOLD, letterSpacing: '0.14em' }}
          >
            {category}
          </p>
        </div>
        {learnMore && (
          <a
            href={learnMore}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] uppercase shrink-0 transition-colors"
            style={{ color: GOLD, letterSpacing: '0.1em' }}
          >
            Privacy Policy ↗
          </a>
        )}
      </div>
      <div className="space-y-2">
        <div>
          <p className="text-[10px] uppercase font-medium text-muted mb-0.5" style={{ letterSpacing: '0.1em' }}>Purpose</p>
          <p className="text-[12px] text-ink leading-relaxed" style={{ fontWeight: 300 }}>{purpose}</p>
        </div>
        <div>
          <p className="text-[10px] uppercase font-medium text-muted mb-0.5" style={{ letterSpacing: '0.1em' }}>Data Shared</p>
          <p className="text-[12px] text-ink leading-relaxed" style={{ fontWeight: 300 }}>{dataShared}</p>
        </div>
      </div>
    </div>
  );
}

const AI_PROVIDERS: ProviderCardProps[] = [
  {
    name: 'Anthropic (Claude)',
    category: 'AI Provider',
    purpose: 'Expert identification and sourcing from public records. Generating personalized outreach emails, vetting questions, and interview guides based on research briefs.',
    dataShared: 'Research brief content, expert profile summaries, and project context. No personally identifiable client information is included in AI prompts.',
    learnMore: 'https://www.anthropic.com/privacy',
  },
  {
    name: 'OpenAI',
    category: 'AI Provider',
    purpose: 'Expert ranking and scoring based on relevance to research briefs. Generating outreach copy and contact enrichment analysis.',
    dataShared: 'Expert profile metadata and anonymized brief context. No client contact details are transmitted.',
    learnMore: 'https://openai.com/policies/privacy-policy',
  },
];

const SEARCH_PROVIDERS: ProviderCardProps[] = [
  {
    name: 'Exa',
    category: 'Search & Research',
    purpose: 'Semantic web search to identify relevant experts and practitioners from public sources such as LinkedIn, company websites, and industry publications.',
    dataShared: 'Search queries derived from research brief topics. No client or user data is shared.',
    learnMore: 'https://exa.ai/privacy',
  },
  {
    name: 'Tavily',
    category: 'Search & Research',
    purpose: 'Supplemental web search for expert background research and verification of professional credentials from publicly available information.',
    dataShared: 'Search queries based on expert names and professional topics. No client data is shared.',
    learnMore: 'https://tavily.com/privacy',
  },
  {
    name: 'ScrapingBee',
    category: 'Search & Research',
    purpose: 'Retrieval of publicly available web pages to gather expert profile information from professional directories and company sites.',
    dataShared: 'URLs of publicly accessible pages to retrieve. No client data is shared.',
    learnMore: 'https://www.scrapingbee.com/privacy-policy/',
  },
];

const CONTACT_PROVIDERS: ProviderCardProps[] = [
  {
    name: 'Hunter.io',
    category: 'Contact Enrichment',
    purpose: 'Finding professional email addresses for experts identified through research, enabling the platform to send outreach on behalf of clients.',
    dataShared: 'Expert names and employer domain names. No client contact details are shared.',
    learnMore: 'https://hunter.io/privacy',
  },
];

const PAYMENT_PROVIDERS: ProviderCardProps[] = [
  {
    name: 'Stripe',
    category: 'Payments',
    purpose: 'Processing subscription billing, per-minute call charges, and expert compensation payouts. All payment data is handled directly by Stripe and never stored on ExpertMatch servers.',
    dataShared: 'Billing contact information and payment method tokens. Raw card numbers are never transmitted to ExpertMatch.',
    learnMore: 'https://stripe.com/privacy',
  },
];

const SCHEDULING_PROVIDERS: ProviderCardProps[] = [
  {
    name: 'Google Calendar',
    category: 'Scheduling',
    purpose: 'Reading client and expert calendar availability to propose and confirm call times. Calendar access is used solely for scheduling expert calls.',
    dataShared: 'Free/busy calendar data for the connected account. Calendar content and event details are not read.',
    learnMore: 'https://policies.google.com/privacy',
  },
  {
    name: 'Zoom',
    category: 'Video Conferencing',
    purpose: 'Generating unique video call links for confirmed expert calls. Zoom meetings are created automatically when a call is scheduled.',
    dataShared: 'Call participant names and scheduled meeting time. No audio, video, or transcript data is accessed by ExpertMatch.',
    learnMore: 'https://explore.zoom.us/en/privacy/',
  },
];

const EMAIL_PROVIDERS: ProviderCardProps[] = [
  {
    name: 'Resend',
    category: 'Email Delivery',
    purpose: 'Delivering transactional emails including invitations, password setup links, outreach sent on behalf of clients, and scheduling confirmations.',
    dataShared: 'Recipient email addresses and message content for each outbound email. Emails sent on behalf of clients include the client-authored brief context.',
    learnMore: 'https://resend.com/legal/privacy-policy',
  },
];

const INFRA_PROVIDERS: ProviderCardProps[] = [
  {
    name: 'Upstash (QStash & Redis)',
    category: 'Infrastructure',
    purpose: 'QStash manages background job queues for asynchronous tasks such as email sequences and availability requests. Redis provides caching for search results and contact lookups to reduce redundant API calls.',
    dataShared: 'Job payloads containing internal task parameters. Cached data is derived from expert research and does not include client PII.',
    learnMore: 'https://upstash.com/trust/privacy.pdf',
  },
];

interface SectionProps {
  title: string;
  description: string;
  providers: ProviderCardProps[];
}

function ProviderSection({ title, description, providers }: SectionProps) {
  return (
    <div className="mb-12">
      <h2
        className="text-[10px] uppercase font-semibold mb-1 tracking-widest"
        style={{ color: GOLD, letterSpacing: '0.22em' }}
      >
        {title}
      </h2>
      <p className="text-[13px] text-muted mb-5 leading-relaxed" style={{ fontWeight: 300 }}>
        {description}
      </p>
      <div className="grid sm:grid-cols-2 gap-4">
        {providers.map(p => (
          <ProviderCard key={p.name} {...p} />
        ))}
      </div>
    </div>
  );
}

export default function DisclosuresPage() {
  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>
      <NavBar />

      {/* Hero */}
      <section style={{ background: NAVY }} className="py-16 px-6 text-center">
        <p
          className="text-[10px] uppercase font-medium mb-4"
          style={{ color: GOLD, letterSpacing: '0.22em' }}
        >
          Transparency
        </p>
        <h1
          className="font-display text-cream mb-4"
          style={{ fontSize: 'clamp(1.8rem, 4vw, 2.6rem)', fontWeight: 500 }}
        >
          AI & Third-Party Tool Disclosures
        </h1>
        <p
          className="text-cream/50 text-sm leading-relaxed mx-auto"
          style={{ maxWidth: '520px', fontWeight: 300 }}
        >
          ExpertMatch uses AI models and third-party services to automate expert sourcing, outreach, scheduling, and billing.
          This page discloses each provider, its role, and what data is shared.
        </p>
      </section>

      {/* Notice banner */}
      <div className="border-b border-frame bg-cream px-6 py-4">
        <p className="max-w-4xl mx-auto text-[12px] text-muted leading-relaxed text-center" style={{ fontWeight: 300 }}>
          ExpertMatch does not sell data to third parties. Providers listed here receive only the minimum data required to perform their function.
          All integrations are governed by their respective data processing agreements.
        </p>
      </div>

      {/* Provider sections */}
      <main className="flex-1 py-16 px-6">
        <div className="max-w-4xl mx-auto">

          <ProviderSection
            title="AI Providers"
            description="Large language models are used to source experts, score relevance, and generate outreach and research materials. Research brief content may be sent to these providers to complete these tasks."
            providers={AI_PROVIDERS}
          />

          <ProviderSection
            title="Search & Research"
            description="Web search and retrieval tools are used to discover and validate expert profiles from publicly available sources. Only publicly accessible information is retrieved."
            providers={SEARCH_PROVIDERS}
          />

          <ProviderSection
            title="Contact Enrichment"
            description="Contact enrichment tools are used to locate professional email addresses for experts identified through research, enabling outreach on behalf of clients."
            providers={CONTACT_PROVIDERS}
          />

          <ProviderSection
            title="Payments"
            description="All billing — including subscriptions, per-minute call fees, and expert payouts — is processed by Stripe. ExpertMatch does not store raw payment card data."
            providers={PAYMENT_PROVIDERS}
          />

          <ProviderSection
            title="Scheduling & Conferencing"
            description="Calendar and video conferencing integrations are used to coordinate and host expert calls. Access is limited to scheduling functions only."
            providers={SCHEDULING_PROVIDERS}
          />

          <ProviderSection
            title="Email Delivery"
            description="Transactional emails — including platform invitations, outreach messages sent on behalf of clients, and scheduling confirmations — are delivered via Resend."
            providers={EMAIL_PROVIDERS}
          />

          <ProviderSection
            title="Infrastructure"
            description="Background task queues and caching layers support the platform's asynchronous operations and performance optimizations."
            providers={INFRA_PROVIDERS}
          />

          {/* Last updated */}
          <div className="border-t border-frame pt-8 mt-4">
            <p className="text-[11px] text-muted" style={{ fontWeight: 300 }}>
              Last updated: June 2026. Questions about data handling?{' '}
              <Link href="/request-access" className="underline hover:text-navy transition-colors">
                Contact us.
              </Link>
            </p>
          </div>
        </div>
      </main>

      <Footer />
    </div>
  );
}

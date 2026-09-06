import type { Metadata } from 'next';
import Link from 'next/link';
import NavBar from '../../components/NavBar';
import MarketingFooter from '../../components/MarketingFooter';

// Privacy Policy.
//
// Every processor named in section 05 was verified against the codebase on
// 2026-09-06 (lib/ and app/api). If you add, remove, or swap a vendor, update
// that table in the same commit.
//
// Verified vendor map — the founder should confirm the public naming:
//
//   [CONFIRM: contact-discovery vendors are named generically as "professional
//    contact data providers" in section 05. The actual vendors in the code are
//    Hunter.io (lib/contactProviders/hunter.ts) and Snov.io
//    (lib/contactProviders/snov.ts). Some jurisdictions (and most enterprise
//    DPAs) expect named subprocessors — decide whether to list them by name
//    here or in a separate subprocessor page.]
//
//   [CONFIRM: web search and page-retrieval vendors are likewise named
//    generically as "web search and retrieval providers". The actual vendors
//    are Exa (lib/searchProviders/exa.ts), Tavily (lib/searchProviders/tavily.ts)
//    and ScrapingBee (lib/searchProviders/scrapingbee.ts).]
//
//   [CONFIRM: whether to publish a standalone subprocessor list with a
//    change-notification commitment — PE and law-firm IT diligence usually
//    asks for one.]

export const metadata: Metadata = {
  title: 'Privacy Policy — ExpertMatch',
  description:
    'What ExpertMatch collects about clients and experts, the companies we share it with, how long we keep it, and how to opt out or ask for your data.',
};

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';

const EFFECTIVE_DATE = 'September 6, 2026';

/** Third parties that actually receive data, verified against lib/ and app/api. */
const PROCESSORS: { name: string; purpose: string; data: string }[] = [
  {
    name: 'Supabase',
    purpose: 'Accounts, sign-in, and the main database',
    data: 'Everything in your account: names, work emails, organizations, briefs, expert records, messages.',
  },
  {
    name: 'Stripe',
    purpose: 'Card storage, subscription and call billing, expert payouts',
    data: 'Card details (entered directly with Stripe — we never receive or store the number), billing contact, charge history. Experts who are paid provide their own payout details to Stripe Connect.',
  },
  {
    name: 'Resend',
    purpose: 'Sending and receiving email',
    data: 'Recipient addresses and the content of the emails we send to experts and to you, plus replies that come back.',
  },
  {
    name: 'Upstash (Redis and QStash)',
    purpose: 'Rate limiting, short-lived caches, and background job queueing',
    data: 'Short-lived tokens, cached search results, and counters. Email addresses and IPs used for rate limiting are hashed before they are stored as keys.',
  },
  {
    name: 'Zoom',
    purpose: 'Hosting the call',
    data: 'Meeting times and the participant email addresses needed to send the invitation.',
  },
  {
    name: 'Google Calendar',
    purpose: 'Checking your availability (only if you connect it)',
    data: 'Free/busy times only. We do not read event titles, descriptions, locations, or guest lists.',
  },
  {
    name: 'Calendly',
    purpose: 'Checking your availability (only if you provide a booking link)',
    data: 'The open slots your public booking link exposes.',
  },
  {
    name: 'Anthropic and OpenAI',
    purpose: 'Sourcing candidates, drafting outreach, and summarizing replies',
    data: 'Your brief text, public professional information about candidates, and message content. Sent for processing and not used by us to train models.',
  },
  {
    name: 'Professional contact data providers',
    purpose: 'Finding a work email address for an expert we want to contact',
    data: 'An expert’s name and employer, in order to look up and verify a business email address.',
  },
  {
    name: 'Web search and retrieval providers',
    purpose: 'Finding the public pages that identify and evidence a candidate',
    data: 'Search queries derived from your brief. These queries do not include your name or your firm’s name.',
  },
  {
    name: 'Vercel',
    purpose: 'Hosting the website and application',
    data: 'Standard request logs, including IP address, for security and reliability.',
  },
];

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

export default function PrivacyPage() {
  return (
    <div className="min-h-screen flex flex-col font-body" style={{ background: '#F7F9FC' }}>
      <NavBar />

      {/* ── Hero ── */}
      <section style={{ background: NAVY }} className="py-16 px-6 text-center">
        <p className="text-[10px] uppercase font-medium mb-4" style={{ color: GOLD, letterSpacing: '0.22em' }}>
          Legal
        </p>
        <h1 className="font-display text-cream mb-4" style={{ fontSize: 'clamp(1.8rem, 4vw, 2.6rem)', fontWeight: 500 }}>
          Privacy Policy
        </h1>
        <p className="text-cream/50 text-sm mx-auto" style={{ maxWidth: '480px', fontWeight: 300 }}>
          Effective {EFFECTIVE_DATE}. What we collect about clients and about the experts we
          contact, who else sees it, and how to get out.
        </p>
      </section>

      {/* ── Body ── */}
      <main className="flex-1 py-16 px-6">
        <div className="max-w-2xl mx-auto bg-surface border border-frame px-6 sm:px-10 py-10">

          <Section n="01" title="Two kinds of people are described here">
            <p>
              ExpertMatch holds data about two groups, and the rules differ for each:
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <strong className="font-medium text-ink">Clients</strong> — people at a firm who hold an
                ExpertMatch seat, plus anyone who submits the access request form.
              </li>
              <li>
                <strong className="font-medium text-ink">Experts</strong> — practitioners we identify from
                public sources and contact about a paid consultation, whether or not they reply.
              </li>
            </ul>
            <p>
              If you are an expert and you only want to stop hearing from us, skip to section 08.
            </p>
          </Section>

          <Section n="02" title="What we collect about clients">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <strong className="font-medium text-ink">Identity and account.</strong> Your name, work
                email address, firm name, job title if you give one, time zone, and your role and
                status within your organization&rsquo;s account.
              </li>
              <li>
                <strong className="font-medium text-ink">Payment.</strong> A card, entered directly into
                Stripe&rsquo;s form. <strong className="font-medium text-ink">ExpertMatch never receives
                or stores your card number.</strong> We hold a Stripe reference to it, plus the billing
                history — what was charged, when, and for which call.
              </li>
              <li>
                <strong className="font-medium text-ink">Your briefs.</strong> The research questions,
                sectors, geographies and context you submit, and the notes you add to a project. These
                are often deal-adjacent, so treat them the way you would treat any working document —
                and see section 06 on how long we keep them.
              </li>
              <li>
                <strong className="font-medium text-ink">Availability.</strong> If you connect Google
                Calendar, free/busy blocks only. If you paste a Calendly link, the open slots it
                exposes. If you enter windows by hand, those windows.
              </li>
              <li>
                <strong className="font-medium text-ink">Messages.</strong> What you write to an expert
                through the platform, and what comes back.
              </li>
              <li>
                <strong className="font-medium text-ink">Access requests.</strong> If you fill in the
                access form, the name, firm, work email and description of what you are researching
                that you enter. We use it to decide on access and to contact you about it.
              </li>
              <li>
                <strong className="font-medium text-ink">Technical.</strong> Session cookies (needed to
                keep you signed in) and standard server logs including IP address. We do not run
                advertising trackers or third-party analytics.
              </li>
            </ul>
          </Section>

          <Section n="03" title="What we collect about experts">
            <p>
              We contact experts who did not sign up for anything, so this section is deliberately
              specific.
            </p>
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <strong className="font-medium text-ink">Public professional information.</strong> Name,
                current and previous roles, employer, seniority, and the public web pages that
                evidence them. This is gathered from publicly available sources.
              </li>
              <li>
                <strong className="font-medium text-ink">A business email address.</strong> Found and
                verified through professional contact data providers so we can send one outreach
                message. We do not buy or store home addresses, personal phone numbers, or personal
                email addresses for this purpose.
              </li>
              <li>
                <strong className="font-medium text-ink">Message content.</strong> The emails we send an
                expert and the replies they send back, including anything they tell us about
                conflicts, restrictions, availability, and rate.
              </li>
              <li>
                <strong className="font-medium text-ink">Engagement and payment.</strong> For experts who
                take a call: the call record, and the payout details they provide directly to Stripe
                Connect. We do not hold their bank details.
              </li>
              <li>
                <strong className="font-medium text-ink">Opt-out record.</strong> If an expert opts out or
                declines, we keep their email address on a suppression list precisely so that we do
                not contact them again.
              </li>
            </ul>
            <p>
              Our basis for the initial outreach is our legitimate interest in offering a paid
              professional engagement to someone whose public professional background fits it. Every
              outreach email carries a one-click opt-out and our postal address.
            </p>
          </Section>

          <Section n="04" title="What we use it for">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>Running the service: sourcing candidates, contacting experts, scheduling, hosting the call, and billing it.</li>
              <li>Screening messages in both directions so identities and contact details do not cross before a call is scheduled.</li>
              <li>Keeping the platform secure — rate limiting, abuse prevention, and fraud checks.</li>
              <li>Support, and telling you about changes to the service or these terms.</li>
              <li>Meeting legal, tax, and accounting obligations.</li>
            </ul>
            <p>
              We do not sell personal data, and we do not share it with anyone for their own
              advertising.
            </p>
          </Section>

          <Section n="05" title="Who else sees it">
            <p>
              We use the companies below to run the service. Each receives only what its job needs.
            </p>
            <div className="border border-frame overflow-x-auto my-4">
              <table className="w-full text-sm border-collapse min-w-[520px]">
                <thead>
                  <tr style={{ background: NAVY }}>
                    <th className="text-left px-4 py-3 text-[10px] uppercase font-medium text-cream/50" style={{ letterSpacing: '0.14em', width: '26%' }}>
                      Company
                    </th>
                    <th className="text-left px-4 py-3 text-[10px] uppercase font-medium text-cream/50" style={{ letterSpacing: '0.14em', width: '28%' }}>
                      What it does
                    </th>
                    <th className="text-left px-4 py-3 text-[10px] uppercase font-medium" style={{ letterSpacing: '0.14em', color: GOLD }}>
                      What it receives
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {PROCESSORS.map(({ name, purpose, data }, i) => (
                    <tr key={name} style={{ background: i % 2 === 0 ? '#FFFFFF' : '#F7F9FC' }} className="border-b border-frame last:border-b-0">
                      <td className="px-4 py-3 text-[12px] font-semibold text-ink align-top">{name}</td>
                      <td className="px-4 py-3 text-[12px] text-muted align-top" style={{ fontWeight: 300 }}>{purpose}</td>
                      <td className="px-4 py-3 text-[12px] text-muted align-top" style={{ fontWeight: 300 }}>{data}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p>
              Beyond these, we share personal data only when the law requires it, or when it is
              needed to establish or defend a legal claim. If ExpertMatch is ever acquired or merged,
              data may transfer with the business; you would be told before that happened.
            </p>
            <p>
              Clients and experts see each other only through the platform, and only what the
              platform reveals: an expert&rsquo;s identity is withheld from the client until a call is
              scheduled, and an expert is never told the client firm&rsquo;s name before that point.
            </p>
          </Section>

          <Section n="06" title="How long we keep it">
            <ul className="list-disc pl-5 space-y-1.5">
              <li>
                <strong className="font-medium text-ink">Account and organization records</strong> — for as
                long as the account is open, then [CONFIRM: retention after account closure — 12 months
                is a common default] before deletion.
              </li>
              <li>
                <strong className="font-medium text-ink">Briefs, projects, and messages</strong> — for the
                life of the account, so your team can go back to earlier work. Tell us and we will
                delete a specific project.
              </li>
              <li>
                <strong className="font-medium text-ink">Billing records</strong> — kept for as long as tax
                and accounting law requires, which is longer than the account itself.
              </li>
              <li>
                <strong className="font-medium text-ink">Expert records</strong> — kept while the
                engagement is live and afterwards as part of the call and payment record.
                [CONFIRM: retention for expert candidates who never replied — deleting these after a
                fixed window, e.g. 24 months, is the defensible choice.]
              </li>
              <li>
                <strong className="font-medium text-ink">Opt-out list</strong> — kept indefinitely. This is
                the one record we will not delete on request, because deleting it is what would
                cause us to contact you again.
              </li>
              <li>
                <strong className="font-medium text-ink">Caches, rate-limit counters, and short-lived
                tokens</strong> — minutes to hours, then they expire automatically.
              </li>
            </ul>
          </Section>

          <Section n="07" title="Security">
            <p>
              Access to client data is scoped per organization and enforced in the database, not just
              in the interface. Card details go directly to Stripe and never touch our servers.
              Credentials and provider tokens are stored encrypted. Internal tools are restricted to
              platform administrators.
            </p>
            <p>
              We do not currently hold a SOC 2 report or any other third-party security
              certification, and we will not claim one until we do.
              [CONFIRM: whether to state a target date for SOC 2, given that PE and law-firm IT
              diligence asks for it early.]
            </p>
          </Section>

          <Section n="08" title="Experts: how to stop hearing from us">
            <p>
              Every email we send an expert ends with a one-click opt-out link and our postal
              address. Following that link adds your address to a permanent do-not-contact list
              immediately — you do not need to sign in, reply, or confirm anything, and the link is
              specific to your address so nobody else can use it.
            </p>
            <p>
              Replying to say you are not interested has the same effect: a decline puts the address
              on the same list.
            </p>
            <p>
              Once an address is on that list, ExpertMatch will not contact it again for any client.
            </p>
          </Section>

          <Section n="09" title="Your rights">
            <p>
              Whether you are a client or an expert, you can ask us to give you a copy of the personal
              data we hold about you, correct it if it is wrong, delete it, or stop using it for
              outreach. Depending on where you live you may also have the right to object to
              processing or to complain to your local data protection authority.
            </p>
            <p>
              Send the request to{' '}
              <strong className="font-medium text-ink">[CONFIRM: contact email]</strong>. We will
              respond within [CONFIRM: response window — 30 days meets both GDPR and CCPA]. We may
              need to verify who you are first, particularly for a deletion request.
            </p>
            <p>
              Two limits worth naming up front: we cannot delete billing records the law requires us
              to keep, and we will not delete the opt-out list (section 08).
            </p>
          </Section>

          <Section n="10" title="Cookies">
            <p>
              We set a session cookie when you sign in, and cookies needed to carry you safely
              through sign-in and calendar connection. That is all — no advertising cookies, no
              third-party analytics, no cross-site tracking. There is nothing here to opt out of, so
              we do not show a cookie banner.
            </p>
          </Section>

          <Section n="11" title="Where data is held">
            <p>
              ExpertMatch and the companies in section 05 are based in the United States, and data is
              processed there. If you are in the UK or EU, your data will be transferred to the US.
              [CONFIRM: transfer mechanism for UK/EU clients and experts — standard contractual
              clauses with each processor is the usual answer; worth settling before selling into
              London.]
            </p>
          </Section>

          <Section n="12" title="Children">
            <p>
              ExpertMatch is a business product. It is not for anyone under 18, and we do not
              knowingly collect data about children.
            </p>
          </Section>

          <Section n="13" title="Changes and contact">
            <p>
              If we change this policy materially, we will email account holders before it takes
              effect. The effective date at the top of the page always reflects the current version.
            </p>
            <p>
              Privacy questions, rights requests, and complaints go to{' '}
              <strong className="font-medium text-ink">[CONFIRM: contact email]</strong>, or by post to{' '}
              <strong className="font-medium text-ink">[CONFIRM: postal address — same value as
              OUTREACH_POSTAL_ADDRESS]</strong>.
            </p>
          </Section>

        </div>

        <p className="max-w-2xl mx-auto mt-6 text-center text-[11px] text-muted" style={{ fontWeight: 300 }}>
          Effective {EFFECTIVE_DATE} ·{' '}
          <Link href="/terms" className="hover:text-navy transition-colors">Terms of Service</Link>
          {' · '}
          <Link href="/contact" className="hover:text-navy transition-colors">Contact</Link>
        </p>
      </main>

      <MarketingFooter activePath="/privacy" />
    </div>
  );
}

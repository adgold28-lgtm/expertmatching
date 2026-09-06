import Link from 'next/link';

// One footer for every public marketing page (landing, pricing, terms,
// privacy, contact). Previously hand-duplicated in app/page.tsx and
// app/pricing/page.tsx with two different link sets — see COPY_AUDIT 11.1.

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';

interface MarketingFooterProps {
  /** The page the visitor is already on — omitted from the link row. */
  activePath?: '/' | '/pricing' | '/terms' | '/privacy' | '/contact';
}

const LINKS: { href: string; label: string }[] = [
  { href: '/',               label: 'Home' },
  { href: '/pricing',        label: 'Pricing' },
  { href: '/request-access', label: 'Request Access' },
  { href: '/terms',          label: 'Terms' },
  { href: '/privacy',        label: 'Privacy' },
  { href: '/contact',        label: 'Contact' },
];

export default function MarketingFooter({ activePath }: MarketingFooterProps = {}) {
  const links = LINKS.filter(l => l.href !== activePath);

  return (
    <footer style={{ background: NAVY, borderTop: `1px solid ${GOLD}33` }}>
      <div className="max-w-6xl mx-auto px-6 sm:px-10 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
        <Link
          href="/"
          className="font-display text-cream/40 hover:text-cream/60 font-semibold transition-colors"
          style={{ letterSpacing: '0.15em', fontSize: '11px' }}
        >
          EXPERTMATCH
        </Link>
        <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
          {links.map(({ href, label }) => (
            <Link
              key={href}
              href={href}
              className="text-[11px] text-cream/40 hover:text-cream/60 transition-colors"
              style={{ letterSpacing: '0.1em' }}
            >
              {label}
            </Link>
          ))}
        </nav>
        <p className="text-[10px] text-cream/25 whitespace-nowrap" style={{ letterSpacing: '0.06em' }}>
          © {new Date().getFullYear()} ExpertMatch
        </p>
      </div>
    </footer>
  );
}

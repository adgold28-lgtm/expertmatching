import { cookies } from 'next/headers';
import Link from 'next/link';
import { verifySessionCookie, COOKIE_NAME } from '../lib/auth';
import SignOutButton from './SignOutButton';

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';

interface NavBarProps {
  activePath?: 'pricing';
}

export default async function NavBar({ activePath }: NavBarProps = {}) {
  const cookieStore = await cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value ?? '';
  const isAuthenticated = token ? (await verifySessionCookie(token)) !== null : false;

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
            className="text-[11px] uppercase transition-colors hidden sm:block"
            style={{
              letterSpacing: '0.14em',
              color: activePath === 'pricing' ? GOLD : 'rgba(255,255,255,0.6)',
              fontWeight: activePath === 'pricing' ? 500 : 400,
            }}
          >
            Pricing
          </Link>
          {isAuthenticated ? (
            <SignOutButton />
          ) : (
            <Link
              href="/login"
              className="text-[11px] uppercase border px-4 py-2 transition-colors"
              style={{ letterSpacing: '0.14em', color: GOLD, borderColor: `${GOLD}40` }}
            >
              Sign In
            </Link>
          )}
        </nav>
      </div>
    </header>
  );
}

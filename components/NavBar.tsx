import { cookies } from 'next/headers';
import Link from 'next/link';
import { getSessionPayload, COOKIE_NAME } from '../lib/auth';
import SignOutButton from './SignOutButton';

const GOLD = '#C6A75E';
const NAVY = '#0B1F3B';

interface NavBarProps {
  activePath?: 'pricing';
}

function displayName(email: string): string {
  const local = email.split('@')[0] ?? email;
  // If it looks like a name (john.smith, john_smith), take the first token
  const first = local.split(/[._]/)[0] ?? local;
  return first.charAt(0).toUpperCase() + first.slice(1);
}

export default async function NavBar({ activePath }: NavBarProps = {}) {
  const cookieStore = cookies();
  const token = cookieStore.get(COOKIE_NAME)?.value ?? '';
  let sessionEmail: string | null = null;
  if (token) {
    try {
      const payload = await getSessionPayload(token);
      sessionEmail = payload?.email ?? null;
    } catch {
      sessionEmail = null;
    }
  }

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
          {sessionEmail ? (
            <div className="flex items-center gap-4">
              <span
                className="text-[11px] hidden sm:block"
                style={{ color: 'rgba(255,255,255,0.6)', letterSpacing: '0.05em' }}
              >
                Welcome, {displayName(sessionEmail)}
              </span>
              <SignOutButton />
            </div>
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

'use client';

// /settings — the three things a client can change about their own account:
// their calendar, the firm's card, and their name.
//
// Reachable by any fully onboarded user (middleware.ts lets an onboarded
// session through to any route; an unonboarded one is redirected to
// /onboarding before it ever gets here). Team management lives one level down
// at /settings/team and is org-admin only, which is why it is a link rather
// than a fourth panel.
//
// Each panel loads, fails and retries INDEPENDENTLY — an unreachable Stripe
// must not stop someone fixing their calendar. There is deliberately no
// page-level loading state for that reason.
//
// Mobile-first: one column that stacks, going two-up only at lg where there is
// room for it. The header matches /settings/team so moving between them does
// not feel like leaving the product.

import { useEffect, useState } from 'react';
import Link from 'next/link';
import CalendarPanel from '../../components/settings/CalendarPanel';
import PaymentPanel  from '../../components/settings/PaymentPanel';
import ProfilePanel  from '../../components/settings/ProfilePanel';

export default function SettingsPage() {
  const [canManageTeam, setCanManageTeam] = useState(false);

  // The Team link is shown only to those who can actually use it — sending a
  // member to a page that tells them they are not allowed is not navigation.
  // /api/auth/me carries orgRole; the membership endpoint is authoritative for
  // older sessions whose app_metadata predates org roles.
  useEffect(() => {
    let active = true;

    fetch('/api/auth/me')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { role?: string; orgRole?: string } | null) => {
        if (!active || !d) return;
        if (d.role === 'admin' || d.orgRole === 'org_admin') setCanManageTeam(true);
      })
      .catch(() => {});

    fetch('/api/org/membership')
      .then(r => (r.ok ? r.json() : null))
      .then((d: { canManageTeam?: boolean } | null) => {
        if (active && d?.canManageTeam) setCanManageTeam(true);
      })
      .catch(() => {});

    return () => { active = false; };
  }, []);

  return (
    <div className="min-h-screen flex flex-col" style={{ background: '#F7F9FC' }}>

      {/* ── Header ── */}
      <header className="bg-navy border-b-2 border-gold sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-6 sm:px-10 py-4 flex items-center justify-between gap-4">
          <Link
            href="/app"
            className="font-display text-cream font-semibold shrink-0"
            style={{ letterSpacing: '0.15em', fontSize: '13px' }}
          >
            EXPERTMATCH
          </Link>
          <nav className="flex items-center gap-4 sm:gap-5 flex-wrap justify-end">
            <span
              className="text-[10px] uppercase tracking-widest text-gold/80"
              style={{ letterSpacing: '0.18em' }}
            >
              Settings
            </span>
            {canManageTeam && (
              <Link
                href="/settings/team"
                className="text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors"
                style={{ letterSpacing: '0.18em' }}
              >
                Team
              </Link>
            )}
            <Link
              href="/app"
              className="text-[10px] uppercase tracking-widest text-gold/50 hover:text-gold/80 transition-colors"
              style={{ letterSpacing: '0.18em' }}
            >
              ← Projects
            </Link>
          </nav>
        </div>
      </header>

      <main className="flex-1 max-w-4xl w-full mx-auto px-6 sm:px-10 py-8 sm:py-10">
        <div className="mb-8">
          <h1
            className="font-display text-navy"
            style={{ fontSize: '1.5rem', fontWeight: 500, letterSpacing: '0.01em' }}
          >
            Settings
          </h1>
          <p className="mt-1.5 text-xs leading-relaxed text-muted" style={{ fontWeight: 300 }}>
            Your availability, your firm’s card, and your name.
          </p>
        </div>

        {/* One column on phones and tablets. At lg, calendar takes the wider
            side because it is the panel with real content in it. */}
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-6 items-start">
          <div className="lg:col-span-3">
            <CalendarPanel />
          </div>
          <div className="lg:col-span-2 space-y-6">
            <PaymentPanel />
            <ProfilePanel />
          </div>
        </div>

        {canManageTeam && (
          <p className="mt-8 text-xs text-muted">
            Adding or removing colleagues?{' '}
            <Link href="/settings/team" className="text-navy underline underline-offset-2 hover:opacity-70 transition-opacity">
              Manage your team
            </Link>
            .
          </p>
        )}
      </main>
    </div>
  );
}

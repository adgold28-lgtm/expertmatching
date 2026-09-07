// The expert's time picker page. Public — no session, no account, no cookie.
// Access is the signed picker token in the URL and nothing else.
//
// This is a THIN server shell. It verifies the token's signature and expiry so
// a dead link renders a plain, honest page instead of a spinner that never
// resolves, and then hands off to components/SchedulePicker.tsx, which fetches
// GET /api/schedule/[token] and does the real work. The revocation check (the
// stored hash) lives in that route, not here: it is one source of truth, and a
// page that duplicated it could drift out of step with the one that books.
//
// NOTHING ABOUT THE CLIENT IS RENDERED HERE. Not the name, not the firm, not
// the project, not a rate. The page does not even load the project.
//
// Never logs anything.

import { verifyAvailabilityToken } from '../../../lib/availabilityToken';
import SchedulePicker from '../../../components/SchedulePicker';

export const dynamic = 'force-dynamic';

interface Props {
  params:       { token: string };
  searchParams: { connected?: string; error?: string };
}

export default function SchedulePage({ params, searchParams }: Props) {
  const rawToken = decodeURIComponent(params.token);
  const verified = verifyAvailabilityToken(rawToken);

  if (!verified.ok || verified.data.type !== 'expert') {
    return <Expired />;
  }

  // Keep only a value we could have written ourselves, so nothing arbitrary
  // from the query string reaches the client component.
  const error = typeof searchParams.error === 'string'
    ? searchParams.error.replace(/[^a-z_]/gi, '').slice(0, 40)
    : undefined;

  return (
    <SchedulePicker
      token={rawToken}
      connected={searchParams.connected === '1'}
      oauthError={error || undefined}
    />
  );
}

// ─── Dead link ────────────────────────────────────────────────────────────────

/**
 * One page for every reason a link no longer works — expired, malformed,
 * tampered with. The expert is told what to do, and a probe learns nothing
 * about which of the three it was.
 */
function Expired() {
  return (
    <main className="min-h-screen bg-cream flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg text-center">
        <p className="text-[10px] font-bold tracking-widest-3 text-navy uppercase mb-8">
          EXPERTMATCH
        </p>
        <h1 className="font-display text-2xl text-navy mb-3">This link has expired</h1>
        <p className="text-sm text-muted leading-relaxed">
          Reply to the email and I will send a new one.
        </p>
      </div>
    </main>
  );
}

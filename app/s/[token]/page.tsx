// The expert's screening form page. Public — no session, no account, no
// cookie. Access is the signed screening token in the URL and nothing else
// (docs/SCREENING_FLOW_PLAN.md, build step 4).
//
// This is a THIN server shell, exactly like app/schedule/[token]/page.tsx. It
// verifies the token's signature and expiry so a dead link renders a plain,
// honest page instead of a spinner that never resolves, and then hands off to
// components/ScreeningForm.tsx, which fetches GET /api/s/[token] and does the
// real work.
//
// THE ROW-SIDE CHECKS ARE NOT DUPLICATED HERE. Whether the link was revoked,
// whether it has already been used, whether the request is still approved —
// all of that lives in the route, which is the one thing that writes. A page
// that re-implemented those checks would be a second source of truth, and the
// two would drift.
//
// NOTHING ABOUT THE CLIENT IS RENDERED HERE. Not the name, not the firm, not
// the rate, not the request. The page does not load the request at all.
//
// Never logs anything.

import { verifyScreeningToken } from '../../../lib/screeningToken';
import ScreeningForm from '../../../components/ScreeningForm';

export const dynamic = 'force-dynamic';

interface Props {
  params: { token: string };
}

export default function ScreeningPage({ params }: Props) {
  const rawToken = decodeURIComponent(params.token);
  const verified = verifyScreeningToken(rawToken);

  if (!verified.ok) return <Expired />;

  return <ScreeningForm token={rawToken} />;
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

// Public landing page for the email footer opt-out link.
// Reached only by redirect from GET /api/outreach/unsubscribe.
// No session, no PII on screen — the address never appears in the URL.

export const metadata = {
  title: 'Unsubscribed — ExpertMatch',
  robots: { index: false, follow: false },
};

const COPY: Record<string, { heading: string; detail: string }> = {
  ok: {
    heading: "You're unsubscribed.",
    detail:  "You won't receive further outreach from ExpertMatch.",
  },
  invalid: {
    heading: 'This link is no longer valid.',
    detail:  "Reply to any email you've received from us and we'll remove you by hand.",
  },
  error: {
    heading: "We couldn't complete that.",
    detail:  "Please try the link again in a few minutes, or reply to any email from us and we'll remove you by hand.",
  },
};

export default function OutreachUnsubscribedPage(
  { searchParams }: { searchParams: { status?: string } },
) {
  const key     = searchParams.status === 'invalid' || searchParams.status === 'error'
    ? searchParams.status
    : 'ok';
  const { heading, detail } = COPY[key];
  const isOk = key === 'ok';

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6" style={{ background: '#F7F9FC' }}>
      <div className="text-center space-y-6 max-w-sm">

        {/* Brand */}
        <p
          className="text-[10px] uppercase tracking-widest text-muted font-medium"
          style={{ letterSpacing: '0.22em' }}
        >
          ExpertMatch
        </p>

        {/* Status icon */}
        <div className="flex justify-center">
          <div className="w-14 h-14 rounded-full bg-teal-50 border border-teal-200 flex items-center justify-center">
            {isOk ? (
              <svg className="w-7 h-7 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
              </svg>
            ) : (
              <svg className="w-7 h-7 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v4m0 4h.01M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0Z" />
              </svg>
            )}
          </div>
        </div>

        {/* Heading */}
        <div className="space-y-2">
          <h1
            className="font-display text-navy font-semibold"
            style={{ fontSize: 'clamp(1.4rem, 4vw, 1.8rem)' }}
          >
            {heading}
          </h1>
          <p className="text-sm text-muted leading-relaxed">
            {detail}
          </p>
        </div>

      </div>
    </div>
  );
}

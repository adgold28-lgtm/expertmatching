// /availability/error
// Shown when the Google OAuth flow fails or produces an unexpected error.
// ?reason= is optional — maps to a human-readable message.

interface Props {
  searchParams: { reason?: string };
}

const REASON_MESSAGES: Record<string, { title: string; body: string }> = {
  access_denied: {
    title: 'Access not granted',
    body:  'You declined to connect Google Calendar. You can still share your availability by returning to the original link and choosing a different option.',
  },
  token_invalid: {
    title: 'Link expired or invalid',
    body:  'This availability link is no longer valid. Please ask your contact at ExpertMatch to send a new one.',
  },
  token_revoked: {
    title: 'Link has been replaced',
    body:  'A newer availability request was sent. Please use the most recent link from your email.',
  },
  oauth_not_configured: {
    title: 'Calendar connection unavailable',
    body:  'Google Calendar integration is not available right now. Please use Calendly or describe your availability manually.',
  },
  token_exchange_failed: {
    title: 'Connection failed',
    body:  'We could not complete the Google Calendar connection. Please try again, or share your availability another way.',
  },
  server_error: {
    title: 'Something went wrong',
    body:  'An unexpected error occurred. Please try again or contact your ExpertMatch representative.',
  },
  rate_limited: {
    title: 'Too many attempts',
    body:  'You have tried to connect too many times in a short period. Please wait a few minutes and try again.',
  },
};

const DEFAULT_MESSAGE = {
  title: 'Something went wrong',
  body:  'An unexpected error occurred. Please try again or contact your ExpertMatch representative.',
};

export default function AvailabilityErrorPage({ searchParams }: Props) {
  const reason  = searchParams.reason ?? '';
  const message = REASON_MESSAGES[reason] ?? DEFAULT_MESSAGE;

  return (
    <main className="min-h-screen bg-[#f8fafc] flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md text-center">

        <p className="text-[10px] font-bold tracking-[3px] text-[#0f172a] uppercase mb-8">
          EXPERTMATCH
        </p>

        <div className="w-12 h-12 rounded-full bg-red-50 border border-red-200 flex items-center justify-center mx-auto mb-6">
          <span className="text-red-600 text-xl">✕</span>
        </div>

        <h1 className="text-xl font-display font-semibold text-[#0f172a] mb-3">
          {message.title}
        </h1>

        <p className="text-sm text-[#64748b] leading-relaxed">
          {message.body}
        </p>

        <p className="mt-8 text-[11px] text-[#94a3b8]">
          Questions? Reply to the email you received.
        </p>

      </div>
    </main>
  );
}

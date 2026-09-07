// /schedule/connected — the standing confirmation page for the Google Calendar
// round-trip.
//
// Normally an expert who links their calendar lands back on their own picker
// (/schedule/[token]?connected=1): the OAuth state carries the raw token for
// exactly that reason. This page is the fallback for the cases where it cannot
// — a state written before that fourth segment existed, or a failure that
// happened before the token could be read at all.
//
// It names nobody and reveals nothing: no client, no firm, no project, no
// times. Only what happened and what to do next.

interface Props {
  searchParams: { error?: string };
}

const MESSAGES: Record<string, { title: string; body: string }> = {
  access_denied: {
    title: 'Calendar not linked',
    body:  'You did not grant calendar access. Open the link in your email and pick a time instead.',
  },
  token_invalid: {
    title: 'This link has expired',
    body:  'Reply to the email and I will send a new one.',
  },
  token_revoked: {
    title: 'A newer link was sent',
    body:  'Please use the most recent email.',
  },
  not_found: {
    title: 'We could not find that request',
    body:  'Reply to the email and I will send a new one.',
  },
  oauth_not_configured: {
    title: 'Calendar linking is unavailable',
    body:  'Open the link in your email and pick a time instead.',
  },
  token_exchange_failed: {
    title: 'We could not finish linking your calendar',
    body:  'Open the link in your email and pick a time instead.',
  },
  invalid_state: {
    title: 'That took too long',
    body:  'Open the link in your email and try again.',
  },
  invalid_callback: {
    title: 'That took too long',
    body:  'Open the link in your email and try again.',
  },
  rate_limited: {
    title: 'Too many attempts',
    body:  'Please wait a few minutes and try again.',
  },
  server_error: {
    title: 'Something went wrong',
    body:  'Open the link in your email and try again.',
  },
};

const CONNECTED = {
  title: 'Calendar linked',
  body:  'Thanks. Open the link in your email to pick a time, and I will only offer times you are free for.',
};

export default function ScheduleConnectedPage({ searchParams }: Props) {
  const reason  = typeof searchParams.error === 'string'
    ? searchParams.error.replace(/[^a-z_]/gi, '').slice(0, 40)
    : '';
  const failed  = reason.length > 0;
  const message = failed ? (MESSAGES[reason] ?? MESSAGES.server_error) : CONNECTED;

  return (
    <main className="min-h-screen bg-cream flex flex-col items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg text-center">
        <p className="text-[10px] font-bold tracking-widest-3 text-navy uppercase mb-8">
          EXPERTMATCH
        </p>

        <div
          className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-6 border ${
            failed
              ? 'bg-status-warning/10 border-status-warning/40'
              : 'bg-gold-pale border-gold'
          }`}
          aria-hidden="true"
        >
          <span className={failed ? 'text-status-warning text-xl' : 'text-navy text-xl'}>
            {failed ? '!' : '✓'}
          </span>
        </div>

        <h1 className="font-display text-2xl text-navy mb-3">{message.title}</h1>
        <p className="text-sm text-muted leading-relaxed">{message.body}</p>
      </div>
    </main>
  );
}

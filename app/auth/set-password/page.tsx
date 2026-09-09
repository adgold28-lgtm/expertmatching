import { verifySignupToken } from '../../../lib/signupToken';
import { getUser } from '../../../lib/firmStore';
import SetPasswordForm from './SetPasswordForm';

function ErrorPage({
  title,
  body,
  retryHref,
}: {
  title:      string;
  body:       string;
  retryHref?: string;
}) {
  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <p className="text-[11px] uppercase tracking-widest text-navy font-medium mb-8" style={{ letterSpacing: '0.22em' }}>
          ExpertMatch
        </p>
        <div className="bg-white border border-frame p-8 shadow-sm">
          <p className="text-sm font-semibold text-navy mb-2">{title}</p>
          <p className="text-xs text-muted leading-relaxed">{body}</p>
          {retryHref && (
            <a
              href={retryHref}
              className="mt-6 block w-full bg-navy text-cream text-[11px] uppercase tracking-widest py-2.5 hover:bg-navy/90 transition-colors"
              style={{ letterSpacing: '0.16em' }}
            >
              Retry
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: { token?: string; th?: string };
}) {
  const rawToken    = searchParams.token ?? '';
  const hashedToken = searchParams.th    ?? '';

  // Verify HMAC + expiry — stateless, so a tampered or stale link is refused
  // before anything is looked up.
  const verified = verifySignupToken(rawToken);

  if (!verified.valid) {
    if (verified.expired) {
      return (
        <ErrorPage
          title="Link expired"
          body="This link has expired. Ask your administrator for a new invitation, or request a new reset link from the sign-in page."
        />
      );
    }
    return (
      <ErrorPage
        title="Invalid link"
        body="This link is invalid or has already been used."
      />
    );
  }

  const { email, firmName, kind } = verified;

  // Whether the link is still UNUSED is Supabase's to say (lib/authLinks.ts):
  // the recovery token is redeemed — and burned — when the form is submitted,
  // so the page cannot peek without spending it. A link without that half is
  // from before single use moved off Redis; it cannot be redeemed.
  if (!hashedToken) {
    return kind === 'reset' ? (
      <ErrorPage
        title="Reset link no longer valid"
        body="This reset link is from an older email. Request a new one from the sign-in page."
      />
    ) : (
      <ErrorPage
        title="Invitation no longer valid"
        body="This invitation is from an older email. Ask your administrator to resend it."
      />
    );
  }

  // First name is stored at invite time — greet the invitee by it.
  const invitee = await getUser(email).catch(() => null);

  return (
    <SetPasswordForm
      token={rawToken}
      hashedToken={hashedToken}
      email={email}
      firmName={invitee?.firmName || firmName}
      firstName={invitee?.firstName ?? ''}
      kind={kind}
    />
  );
}

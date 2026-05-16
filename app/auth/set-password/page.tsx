import { verifySignupToken, hashToken } from '../../../lib/signupToken';
import { getUpstashClient } from '../../../lib/upstashRedis';
import SetPasswordForm from './SetPasswordForm';

function ErrorPage({ title, body }: { title: string; body: string }) {
  return (
    <div className="min-h-screen bg-cream flex items-center justify-center px-4">
      <div className="w-full max-w-sm text-center">
        <p className="text-[11px] uppercase tracking-widest text-navy font-medium mb-8" style={{ letterSpacing: '0.22em' }}>
          ExpertMatch
        </p>
        <div className="bg-white border border-frame p-8 shadow-sm">
          <p className="text-sm font-semibold text-navy mb-2">{title}</p>
          <p className="text-xs text-muted leading-relaxed">{body}</p>
        </div>
      </div>
    </div>
  );
}

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: { token?: string };
}) {
  const rawToken = searchParams.token ?? '';

  // Verify HMAC + expiry
  const verified = verifySignupToken(rawToken);

  if (!verified.valid) {
    if (verified.expired) {
      return (
        <ErrorPage
          title="Invitation expired"
          body="This invitation link has expired. Please contact your administrator for a new one."
        />
      );
    }
    return (
      <ErrorPage
        title="Invalid invitation"
        body="This invitation is invalid or has already been used."
      />
    );
  }

  const { email, firmName } = verified;
  const hash = hashToken(rawToken);

  // Check Redis: token must not yet be consumed
  let tokenValid = false;
  try {
    const redis = getUpstashClient();
    if (redis) {
      const stored = await redis.get(`invite-token:${hash}`);
      tokenValid = stored !== null;
    }
  } catch { /* treat as invalid if Redis is down */ }

  if (!tokenValid) {
    return (
      <ErrorPage
        title="Invitation already used"
        body="This invitation link has already been used to create an account."
      />
    );
  }

  return <SetPasswordForm token={rawToken} email={email} firmName={firmName} />;
}

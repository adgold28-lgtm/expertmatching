import { verifySignupToken, hashToken, tokenRedisKey } from '../../../lib/signupToken';
import { getUpstashClient } from '../../../lib/upstashRedis';
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

/** 'valid' — unused link · 'spent' — consumed/expired · 'unavailable' — Redis is down. */
type TokenState = 'valid' | 'spent' | 'unavailable';

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
  const hash     = hashToken(rawToken);
  const redisKey = tokenRedisKey(kind, hash);

  // Redis: the token must not yet be consumed. A storage outage is its own
  // state — telling someone their invitation was "already used" when we simply
  // could not look it up sends them to their admin for nothing.
  let tokenState: TokenState;
  try {
    const redis = getUpstashClient();
    if (!redis) {
      tokenState = 'unavailable';
    } else {
      const stored = await redis.get(redisKey);
      tokenState = stored !== null ? 'valid' : 'spent';
    }
  } catch {
    tokenState = 'unavailable';
  }

  if (tokenState === 'unavailable') {
    return (
      <ErrorPage
        title="We couldn’t check your link"
        body="We couldn’t check your invitation just now — try again in a minute. Nothing has been used up."
        retryHref={`/auth/set-password?token=${encodeURIComponent(rawToken)}`}
      />
    );
  }

  if (tokenState === 'spent') {
    return kind === 'reset' ? (
      <ErrorPage
        title="Reset link already used"
        body="This password reset link has already been used or has expired. You can request a new one from the sign-in page."
      />
    ) : (
      <ErrorPage
        title="Invitation already used"
        body="This invitation link has already been used to create an account."
      />
    );
  }

  // First name is stored at invite time — greet the invitee by it.
  const invitee = await getUser(email).catch(() => null);

  return (
    <SetPasswordForm
      token={rawToken}
      email={email}
      firmName={invitee?.firmName || firmName}
      firstName={invitee?.firstName ?? ''}
      kind={kind}
    />
  );
}

import { verifySignupToken, hashToken } from '../../../lib/signupToken';
import { getUpstashClient } from '../../../lib/upstashRedis';
import { getFirmPlan, countUsersForDomain, SEAT_LIMITS } from '../../../lib/domainWhitelist';
import SignupForm from './SignupForm';

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

export default async function SignupPage({ params }: { params: { token: string } }) {
  const rawToken = params.token ?? '';

  // Verify HMAC + expiry
  const verified = verifySignupToken(rawToken);

  if (!verified.valid) {
    if (verified.expired) {
      return (
        <ErrorPage
          title="Invitation expired"
          body="This invitation link has expired. Please contact your account admin for a new link."
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
  const domain = email.split('@')[1] ?? '';
  const hash   = hashToken(rawToken);

  // Check Redis: token not yet used
  let tokenValid = false;
  try {
    const redis = getUpstashClient();
    if (redis) {
      const stored = await redis.get(`signup-token:${hash}`);
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

  // Preliminary seat limit check
  if (domain) {
    try {
      const [plan, used] = await Promise.all([getFirmPlan(domain), countUsersForDomain(domain)]);
      const limit = SEAT_LIMITS[plan];
      if (used >= limit) {
        return (
          <ErrorPage
            title="Firm account is full"
            body="Your firm's account is full. Reach out to your account admin to add more seats."
          />
        );
      }
    } catch { /* non-fatal — API enforces this too */ }
  }

  return <SignupForm token={rawToken} email={email} firmName={firmName} />;
}

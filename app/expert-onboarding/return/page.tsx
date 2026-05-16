// Stripe Connect onboarding success page.
// Expert lands here after completing Stripe onboarding.

export default function ExpertOnboardingReturnPage() {
  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-6">
      <div className="max-w-md w-full border border-frame bg-white px-8 py-10 space-y-4">
        <div className="space-y-1">
          <p className="text-[9px] uppercase tracking-widest text-teal-600 font-medium" style={{ letterSpacing: '0.18em' }}>
            Setup Complete
          </p>
          <h1 className="text-xl font-display font-semibold text-navy">
            Your payout account is set up.
          </h1>
        </div>
        <p className="text-sm text-ink leading-relaxed">
          You will receive payment within 2 business days of your call.
        </p>
        <p className="text-xs text-muted">
          If you have any questions, contact us at{' '}
          <a href="mailto:asher@expertmatch.fit" className="underline underline-offset-2 hover:text-navy transition-colors">
            asher@expertmatch.fit
          </a>
          .
        </p>
      </div>
    </div>
  );
}

// Stripe Connect onboarding expired-link page.
// Expert lands here when their onboarding link has expired.

export default function ExpertOnboardingRefreshPage() {
  return (
    <div className="min-h-screen bg-cream flex items-center justify-center p-6">
      <div className="max-w-md w-full border border-frame bg-white px-8 py-10 space-y-4">
        <div className="space-y-1">
          <p className="text-[9px] uppercase tracking-widest text-amber-600 font-medium" style={{ letterSpacing: '0.18em' }}>
            Link Expired
          </p>
          <h1 className="text-xl font-display font-semibold text-navy">
            This link has expired.
          </h1>
        </div>
        <p className="text-sm text-ink leading-relaxed">
          Please contact us at{' '}
          <a href="mailto:asher@expertmatch.fit" className="underline underline-offset-2 hover:text-navy transition-colors">
            asher@expertmatch.fit
          </a>{' '}
          for a new link.
        </p>
      </div>
    </div>
  );
}

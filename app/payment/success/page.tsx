export default function PaymentSuccessPage() {
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

        {/* Success icon */}
        <div className="flex justify-center">
          <div className="w-14 h-14 rounded-full bg-teal-50 border border-teal-200 flex items-center justify-center">
            <svg className="w-7 h-7 text-teal-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        </div>

        {/* Heading */}
        <div className="space-y-2">
          <h1
            className="font-display text-navy font-semibold"
            style={{ fontSize: 'clamp(1.4rem, 4vw, 1.8rem)' }}
          >
            Payment received.
          </h1>
          <p className="text-sm text-muted leading-relaxed">
            Thank you — we&apos;ll be in touch shortly.
          </p>
        </div>

      </div>
    </div>
  );
}

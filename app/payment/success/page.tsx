// /payment/success — where a Stripe payment link drops the client after they
// pay a call invoice (the redirect URL is set in lib/createAndSendInvoice.ts).
//
// Purely cosmetic and public: it is reached from an emailed link with no
// session, carries no projectId, and proves nothing. The authoritative record
// of the payment is the checkout.session.completed webhook, which is what flips
// paymentStatus to 'paid' and runs the expert payout — never this page.

import Link from 'next/link';

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
            You can close this page.
          </p>
        </div>

        {/* This page is also reached from a Stripe payment link in an email, so
            the way back into the product has to be explicit. */}
        <p>
          <Link
            href="/app"
            className="inline-block text-[11px] uppercase text-navy border border-frame hover:border-navy px-4 py-2 transition-colors"
            style={{ letterSpacing: '0.14em' }}
          >
            Back to ExpertMatch
          </Link>
        </p>

      </div>
    </div>
  );
}

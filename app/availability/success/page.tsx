// /availability/success
// Shown after a successful Google Calendar OAuth connection.
// ?name=FirstName is optional — used for a personalised greeting.

interface Props {
  searchParams: { name?: string };
}

export default function AvailabilitySuccessPage({ searchParams }: Props) {
  const rawName  = searchParams.name ?? '';
  // Sanitize: keep only letters, spaces, hyphens, apostrophes — no injected markup
  const firstName = rawName.replace(/[^a-zA-Z\s'\-]/g, '').slice(0, 50).trim();

  return (
    <main className="min-h-screen bg-[#f8fafc] flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md text-center">

        <p className="text-[10px] font-bold tracking-[3px] text-[#0f172a] uppercase mb-8">
          EXPERTMATCH
        </p>

        <div className="w-12 h-12 rounded-full bg-green-50 border border-green-200 flex items-center justify-center mx-auto mb-6">
          <span className="text-green-700 text-xl">✓</span>
        </div>

        <h1 className="text-xl font-display font-semibold text-[#0f172a] mb-3">
          {firstName ? `Thanks, ${firstName}!` : 'All set — thank you!'}
        </h1>

        <p className="text-sm text-[#64748b] leading-relaxed">
          Your calendar has been connected. Our team will review your availability and
          reach out to confirm the call.
        </p>

        <p className="mt-8 text-[11px] text-[#94a3b8]">
          Questions? Reply to the email you received.
        </p>

      </div>
    </main>
  );
}

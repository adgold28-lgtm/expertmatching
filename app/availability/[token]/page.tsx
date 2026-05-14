// Public availability submission page.
// No auth required — access is gated by the signed token in the URL.
// Server component: verifies token, loads expert/project, renders AvailabilityForm.

import { notFound } from 'next/navigation';
import { verifyAvailabilityToken, hashToken } from '../../../lib/availabilityToken';
import { getProject } from '../../../lib/projectStore';
import AvailabilityForm from '../../../components/AvailabilityForm';

interface Props {
  params: { token: string };
}

export default async function AvailabilityPage({ params }: Props) {
  const rawToken = decodeURIComponent(params.token);

  // ── 1. Verify signature + expiry ──────────────────────────────────────────
  const result = verifyAvailabilityToken(rawToken);
  if (!result.ok) {
    return <ExpiredOrInvalid reason={result.reason} />;
  }

  const { type: tokenType, projectId, expertId } = result.data;

  // ── 2. Load project ───────────────────────────────────────────────────────
  const project = await getProject(projectId);
  if (!project) return notFound();

  // ── 3. Branch: client vs expert token ────────────────────────────────────

  if (tokenType === 'client') {
    // Client token: check project-level hash and submission state
    const storedHash = project.clientAvailabilityTokenHash;
    if (!storedHash || storedHash !== hashToken(rawToken)) {
      return <ExpiredOrInvalid reason="expired" />;
    }
    if (project.clientAvailabilitySubmitted) {
      return <AlreadySubmitted expertName={project.clientName ?? 'there'} />;
    }
    const firstName = (project.clientName ?? 'there').split(' ')[0];
    return (
      <main className="min-h-screen bg-[#f8fafc] flex flex-col items-center justify-start py-12 px-4">
        <div className="w-full max-w-lg mb-8">
          <p className="text-[10px] font-bold tracking-[3px] text-[#0f172a] uppercase mb-6">EXPERTMATCH</p>
          <h1 className="text-2xl font-display font-semibold text-[#0f172a] mb-2">
            Hi {firstName} — let&apos;s find a time.
          </h1>
          <p className="text-sm text-[#64748b] leading-relaxed">
            Please share a few windows that work for you. This takes less than a minute.
          </p>
        </div>
        <div className="w-full max-w-lg bg-white border border-[#e2e8f0] p-8">
          <AvailabilityForm
            token={rawToken}
            expertId={null}
            projectId={projectId}
            calendarProvider={undefined}
          />
        </div>
        <p className="mt-6 text-[11px] text-[#94a3b8]">
          Questions? Reply to the email you received.
        </p>
      </main>
    );
  }

  // Expert token path
  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe)  return notFound();

  // ── 4. Revocation check: stored hash must match ──────────────────────────
  const storedHash = pe.availabilityTokenHash;
  if (!storedHash || storedHash !== hashToken(rawToken)) {
    return <ExpiredOrInvalid reason="expired" />;
  }

  // ── 5. Already submitted? ─────────────────────────────────────────────────
  if (pe.availabilitySubmitted) {
    return <AlreadySubmitted expertName={pe.expert.name} />;
  }

  // ── 6. Render form ────────────────────────────────────────────────────────
  const firstName = pe.expert.name.split(' ')[0] ?? pe.expert.name;

  return (
    <main className="min-h-screen bg-[#f8fafc] flex flex-col items-center justify-start py-12 px-4">
      {/* Header */}
      <div className="w-full max-w-lg mb-8">
        <p className="text-[10px] font-bold tracking-[3px] text-[#0f172a] uppercase mb-6">EXPERTMATCH</p>
        <h1 className="text-2xl font-display font-semibold text-[#0f172a] mb-2">
          Hi {firstName} — let&apos;s find a time.
        </h1>
        <p className="text-sm text-[#64748b] leading-relaxed">
          Please share a few windows that work for you. This takes less than a minute.
        </p>
      </div>

      {/* Form card */}
      <div className="w-full max-w-lg bg-white border border-[#e2e8f0] p-8">
        <AvailabilityForm
          token={rawToken}
          expertId={expertId}
          projectId={projectId}
          calendarProvider={pe.calendarProvider}
        />
      </div>

      <p className="mt-6 text-[11px] text-[#94a3b8]">
        Questions? Reply to the email you received.
      </p>
    </main>
  );
}

// ─── Fallback states ──────────────────────────────────────────────────────────

function ExpiredOrInvalid({ reason }: { reason: string }) {
  const isExpired = reason === 'expired';
  return (
    <main className="min-h-screen bg-[#f8fafc] flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        <p className="text-[10px] font-bold tracking-[3px] text-[#0f172a] uppercase mb-8">EXPERTMATCH</p>
        <h1 className="text-xl font-display font-semibold text-[#0f172a] mb-3">
          {isExpired ? 'This link has expired' : 'Invalid link'}
        </h1>
        <p className="text-sm text-[#64748b] leading-relaxed">
          {isExpired
            ? 'Availability links expire after 7 days. Please ask your contact to resend the request.'
            : 'This link is not valid. Please check your email for the correct link or contact your ExpertMatch representative.'}
        </p>
      </div>
    </main>
  );
}

function AlreadySubmitted({ expertName }: { expertName: string }) {
  const firstName = expertName.split(' ')[0] ?? expertName;
  return (
    <main className="min-h-screen bg-[#f8fafc] flex flex-col items-center justify-center px-4">
      <div className="w-full max-w-md text-center">
        <p className="text-[10px] font-bold tracking-[3px] text-[#0f172a] uppercase mb-8">EXPERTMATCH</p>
        <h1 className="text-xl font-display font-semibold text-[#0f172a] mb-3">
          Thanks, {firstName}!
        </h1>
        <p className="text-sm text-[#64748b] leading-relaxed">
          We already have your availability. Our team will be in touch to confirm the call.
        </p>
      </div>
    </main>
  );
}

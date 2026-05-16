// Server component — verifies availability token, creates/retrieves Stripe Connect
// account, generates onboarding link, and redirects to Stripe hosted onboarding.
//
// Public route — token verification is the auth mechanism.

import { redirect, notFound } from 'next/navigation';
import { verifyAvailabilityToken } from '../../../lib/availabilityToken';
import { getProject } from '../../../lib/projectStore';
import {
  getConnectAccountId,
  setConnectAccountId,
  createConnectAccount,
  createOnboardingLink,
} from '../../../lib/stripeConnect';

interface Props {
  params: { token: string };
}

export default async function ExpertOnboardingPage({ params }: Props) {
  const { token } = params;

  // ── 1. Verify availability token ────────────────────────────────────────
  const verifyResult = verifyAvailabilityToken(token);
  if (!verifyResult.ok || verifyResult.data.type !== 'expert') {
    notFound();
  }

  const { projectId, expertId } = verifyResult.data;
  if (!expertId) notFound();

  // ── 2. Load project + expert ─────────────────────────────────────────────
  const project = await getProject(projectId);
  if (!project) notFound();

  const pe = project.experts.find(e => e.expert.id === expertId);
  if (!pe) notFound();

  // ── 3. Verify expert is scheduled (prevent reuse for cancelled experts) ──
  if (pe.status !== 'scheduled' && pe.status !== 'completed') {
    notFound();
  }

  const expertEmail = pe.contactEmail;
  if (!expertEmail) notFound();

  // ── 4. Create or retrieve Connect account ────────────────────────────────
  let accountId = await getConnectAccountId(expertEmail!);

  if (!accountId) {
    try {
      accountId = await createConnectAccount(expertEmail!);
      await setConnectAccountId(expertEmail!, accountId);
    } catch (err) {
      console.error('[expert-onboarding] account creation error:',
        err instanceof Error ? err.message.slice(0, 120) : 'unknown');
      // Show error state
      redirect('/expert-onboarding/refresh');
    }
  }

  // ── 5. Generate onboarding link ──────────────────────────────────────────
  const baseUrl    = process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://expertmatch.fit';
  const returnUrl  = `${baseUrl}/expert-onboarding/return`;
  const refreshUrl = `${baseUrl}/expert-onboarding/refresh`;

  let onboardingUrl: string;
  try {
    onboardingUrl = await createOnboardingLink(accountId, returnUrl, refreshUrl);
  } catch (err) {
    console.error('[expert-onboarding] link creation error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    redirect('/expert-onboarding/refresh');
  }

  // ── 6. Redirect to Stripe hosted onboarding ──────────────────────────────
  redirect(onboardingUrl!);
}

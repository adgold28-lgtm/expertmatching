// GET /api/unsubscribe?token=...
// Public endpoint — no auth required.
// Verifies HMAC-signed unsubscribe token and adds expert email to suppression list.
// Redirects to /unsubscribe?status=success|expired|invalid on completion.

import { NextRequest, NextResponse } from 'next/server';
import { verifyUnsubscribeToken } from '../../../lib/unsubscribeToken';
import { addToSuppressionList } from '../../../lib/suppressionList';

const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://expertmatch.fit';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const token = request.nextUrl.searchParams.get('token');

  if (!token) {
    return NextResponse.redirect(`${BASE_URL}/unsubscribe?status=invalid`);
  }

  const result = verifyUnsubscribeToken(token);

  if (!result.ok) {
    const status = result.reason === 'expired' ? 'expired' : 'invalid';
    return NextResponse.redirect(`${BASE_URL}/unsubscribe?status=${status}`);
  }

  try {
    await addToSuppressionList(result.email, 'unsubscribe');
  } catch (err) {
    console.error('[unsubscribe] failed to add to suppression list:', err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.redirect(`${BASE_URL}/unsubscribe?status=error`);
  }

  console.log('[unsubscribe] email suppressed via token');
  return NextResponse.redirect(`${BASE_URL}/unsubscribe?status=success`);
}

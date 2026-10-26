// app/requests/layout.tsx — the gate on every /requests page.
//
// While the Requests flow is hidden (lib/requestsFlag.ts, decision D4) a
// signed-in visitor who still has the URL lands on /app instead; a visitor
// with no session never gets this far, because middleware.ts sends them to
// /login first. A server component so the decision is made before any page
// code or data reaches the browser.

import { redirect } from 'next/navigation';
import { isRequestsFlowEnabled } from '../../lib/requestsFlag';

export default function RequestsLayout({ children }: { children: React.ReactNode }) {
  if (!isRequestsFlowEnabled()) redirect('/app');
  return <>{children}</>;
}

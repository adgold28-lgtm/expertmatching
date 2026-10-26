// scripts/test-requests-flag.ts — unit tests for lib/requestsFlag.ts, the
// switch that hides the structured-request flow. Pure: no server, no network.
//
//   npx tsx scripts/test-requests-flag.ts

import { isRequestsFlowEnabled, requestsFlowGuard } from '../lib/requestsFlag';
import { check, eq, summary } from './testHarness';

async function main(): Promise<void> {
  delete process.env.NEXT_PUBLIC_REQUESTS_FLOW_ENABLED;
  eq('unset → hidden', isRequestsFlowEnabled(), false);
  const hidden = requestsFlowGuard();
  check('unset → the guard answers', hidden !== null);
  eq('…with a 404', hidden?.status, 404);
  eq('…and a plain not_found body', JSON.stringify(await hidden?.json()), JSON.stringify({ error: 'not_found' }));

  for (const value of ['', 'false', '1', 'TRUE', 'yes', ' true']) {
    process.env.NEXT_PUBLIC_REQUESTS_FLOW_ENABLED = value;
    eq(`${JSON.stringify(value)} → still hidden (only the exact word turns it on)`, isRequestsFlowEnabled(), false);
    check(`${JSON.stringify(value)} → the guard still answers 404`, requestsFlowGuard()?.status === 404);
  }

  process.env.NEXT_PUBLIC_REQUESTS_FLOW_ENABLED = 'true';
  eq("'true' → shown", isRequestsFlowEnabled(), true);
  eq("'true' → the guard lets the handler proceed", requestsFlowGuard(), null);

  delete process.env.NEXT_PUBLIC_REQUESTS_FLOW_ENABLED;
  summary();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});

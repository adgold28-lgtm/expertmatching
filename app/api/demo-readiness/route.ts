// Demo-readiness API — server-side env var presence check.
//
// SECURITY RULES (enforced, not advisory):
// - Returns ONLY boolean presence flags (!!process.env.X).
// - NEVER returns, logs, or exposes env var values.
// - All "present" booleans are computed server-side; nothing sensitive reaches the client.
// - Platform-admin only (adminGuard) in every environment.

import { NextRequest } from 'next/server';
import { adminGuard } from '../../../lib/auth';

interface CheckResult {
  key: string;
  present: boolean;
}

interface ChecklistGroup {
  label: string;
  checks: CheckResult[];
}

function check(key: string): CheckResult {
  // !! converts truthy string to true, undefined/empty string to false.
  // The value itself is NEVER read beyond this boolean coercion.
  return { key, present: !!process.env[key] };
}

export async function GET(request: NextRequest) {
  // Platform admins only. 404 (not 403) so the endpoint's existence is not
  // confirmed to non-admins.
  const authErr = await adminGuard(request);
  if (authErr) return Response.json({ error: 'not_found' }, { status: 404 });

  const groups: ChecklistGroup[] = [
    {
      label: 'AI Provider',
      checks: [
        check('ANTRHOPICKEYREAL'),
      ],
    },
    {
      label: 'Search Providers',
      checks: [
        check('TAVILY_API_KEY'),
        check('SCRAPINGBEE_API_KEY'),
      ],
    },
    {
      label: 'Storage (Upstash Redis)',
      checks: [
        check('UPSTASH_REDIS_REST_URL'),
        check('UPSTASH_REDIS_REST_TOKEN'),
      ],
    },
    {
      label: 'Contact Enrichment',
      checks: [
        check('CONTACT_ENRICHMENT_ENABLED'),
        check('SNOV_CLIENT_ID'),
        check('SNOV_CLIENT_SECRET'),
        check('LOG_HASH_SECRET'),
      ],
    },
    {
      label: 'App Configuration',
      checks: [
        check('NEXT_PUBLIC_APP_URL'),
        check('NODE_ENV'),
      ],
    },
    {
      label: 'Security (Optional)',
      checks: [
        check('CONTACT_ENRICHMENT_ADMIN_TOKEN'),
      ],
    },
  ];

  return Response.json({ groups });
}

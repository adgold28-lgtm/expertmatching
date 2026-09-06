// POST /api/projects/[projectId]/experts/backfill-anonymization
//
// Generates and persists `anonymizedDescriptor` / `anonymizedJustification` for
// experts sourced before those fields existed. Experts that already have a
// descriptor are skipped, so the route is idempotent and safe to re-run.
//
// Admin-only. A client has no reason to trigger LLM spend, and the work reads
// raw identity data (title, company, evidence) that non-admins never see.
// GET /api/projects/[id] also fires this in the background on a non-admin load
// so shortlists self-heal without anyone pressing a button.
//
// Bounded per call (see lib/anonymizeExpert.ts): a fixed batch size and a
// concurrency of 3. A large project converges over a few calls — the response
// reports what is left.
//
// Responses:
//   200 { ok: true, scanned, enriched, remaining }
//   403 { error: 'forbidden' }        — non-admin
//   404 { error: 'not_found' }        — unknown project
//
// NEVER log: expert names, titles, companies, or evidence content.

import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../../../lib/auth';
import { getProject } from '../../../../../../lib/projectStore';
import { backfillProjectAnonymization } from '../../../../../../lib/anonymizeExpert';

const ID_RE = /^[a-f0-9]{24}$/;

export async function POST(
  _request: NextRequest,
  { params }: { params: { projectId: string } },
) {
  const authErr = await adminGuard(_request);
  if (authErr) return authErr;

  if (!ID_RE.test(params.projectId)) {
    return Response.json({ error: 'invalid_project_id' }, { status: 400 });
  }

  try {
    const project = await getProject(params.projectId);
    if (!project) return Response.json({ error: 'not_found' }, { status: 404 });

    const result = await backfillProjectAnonymization(params.projectId);
    console.info('[backfill-anonymization]', JSON.stringify({
      scanned:   result.scanned,
      enriched:  result.enriched,
      remaining: result.remaining,
    }));

    return Response.json({ ok: true, ...result });
  } catch (err) {
    console.error('[backfill-anonymization] error:',
      err instanceof Error ? err.message : String(err));
    return Response.json({ error: 'failed_to_backfill' }, { status: 500 });
  }
}

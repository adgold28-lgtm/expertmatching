// POST /api/requests/[id]/generate
//
// Turns the client's learning objectives into the screening questionnaire
// (docs/SCREENING_FLOW_PLAN.md, build step 3). Its own route rather than part
// of intake, for three reasons the plan settles: a model failure never loses
// the brief, the editor can show a real loading state, and retry is one click.
//
// IT NEVER FAILS CLOSED. lib/screeningItems.generateScreeningItems always
// resolves with a complete set — model output when the model behaved,
// deterministic fallback text when it did not, and fallback text when there is
// no API key at all. So this route does NOT 503 on a missing key the way
// /api/parse-brief does: parse-brief has nothing to hand back without a model,
// while this one has a perfectly editable questionnaire. The response says
// which it was (`generation.source` / `generation.reason`) and the editor tells
// the client the truth in one sentence.
//
// ACCESS: routeAuthGuard → guardMutatingRequest → getRequestForUser (404, never
// 403) → draft only (409) → rate limit (429).
//
// RATE LIMIT: 10 per user per hour (lib/rateLimiter.checkScreeningGenerateLimit)
// because every press costs a model call. It FAILS OPEN — an Upstash outage
// must not stop a client drafting their own screening set.
//
// Never logs: the topic, an objective, a stem, a proof prompt or any model
// output. The product event carries counts and one enum string.

import { NextRequest } from 'next/server';
import { getRequestForUser, listCandidates, updateObjectiveItems } from '../../../../../lib/requestStore';
import { guardMutatingRequest } from '../../../../../lib/projectsGuard';
import { routeAuthGuard, getSessionUser } from '../../../../../lib/auth';
import { createRateLimiterStore, checkScreeningGenerateLimit } from '../../../../../lib/rateLimiter';
import { generateScreeningItems } from '../../../../../lib/screeningItems';
import { buildRequestView } from '../../../../../lib/screeningView';
import { trackProductEvent } from '../../../../../lib/productEvents';
import type { ObjectiveItemUpdate } from '../../../../../lib/requestStore';

// One model call, plus at most one regeneration round, on a request with up to
// six objectives — the default 10 s would cut a good generation in half.
export const maxDuration = 60;

// Built once per instance. In development without Upstash the constructor logs
// and returns an in-memory store; in production it throws when the Redis
// variables are missing, and a throw at module scope would take the whole route
// down — so it is caught here and the limit fails open, exactly as
// app/api/schedule/[token] does.
const _rlStore = (() => { try { return createRateLimiterStore(); } catch { return null; } })();

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;

  try {
    const { email, role } = await getSessionUser(request);
    const found = await getRequestForUser(params.id, email, role);
    if (!found) return Response.json({ error: 'not_found' }, { status: 404 });

    if (found.status !== 'draft') {
      return Response.json(
        {
          error:   'request_not_draft',
          message: 'This screening set has been approved, so it can no longer be regenerated.',
        },
        { status: 409 },
      );
    }

    // ── Rate limit, failing open ─────────────────────────────────────────────
    if (_rlStore) {
      try {
        const limit = await checkScreeningGenerateLimit(_rlStore, email);
        if (!limit.allowed) {
          const retryAfterSec = Math.max(1, Math.ceil((limit.retryAfterMs ?? 0) / 1000));
          return Response.json(
            {
              error:   'rate_limited',
              message: 'You have redrafted a lot of screening sets in the last hour. Try again shortly.',
            },
            { status: 429, headers: { 'Retry-After': String(retryAfterSec) } },
          );
        }
      } catch {
        // Store unavailable — allow. A Redis outage must not stop a client
        // drafting their own request.
      }
    }

    // ── Generate ─────────────────────────────────────────────────────────────
    const generation = await generateScreeningItems({
      topic:      found.topicStatement,
      objectives: found.objectives.map(o => ({ id: o.id, text: o.objectiveText })),
    });

    // `clientEdited: false` is written explicitly: regenerating replaces the
    // client's edits, and the "Edited" tag has to go with them.
    const updates: ObjectiveItemUpdate[] = generation.items.map(item => ({
      id:               item.id,
      stem:             item.stem,
      proofPrompt:      item.proofPrompt,
      source:           item.source,
      modelStem:        item.modelStem,
      modelProofPrompt: item.modelProofPrompt,
      clientEdited:     false,
    }));

    const saved = updates.length > 0
      ? await updateObjectiveItems(found.id, updates)
      : found;

    void trackProductEvent({
      type:           'screening_set_generated',
      actorEmail:     email,
      organizationId: saved.organizationId,
      payload: {
        source: generation.source,
        reason: generation.reason ?? null,
        count:  generation.items.length,
      },
    });

    const candidates = await listCandidates(saved.id);
    return Response.json({
      request:    buildRequestView(saved, candidates, { email, role }),
      generation: generation.reason
        ? { source: generation.source, reason: generation.reason }
        : { source: generation.source },
    });
  } catch (err) {
    console.error('[api/requests/[id]/generate] error:', err instanceof Error ? err.message : String(err));
    return Response.json(
      { error: 'generation_failed', message: 'We could not draft the screening questions. Try again.' },
      { status: 500 },
    );
  }
}

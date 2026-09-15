// GET | PATCH  /api/requests/[id]
//
// One structured request and its screening set: the page's only read, and the
// route that saves the client's inline edits to a stem or a proof prompt
// (docs/SCREENING_FLOW_PLAN.md, build step 3).
//
// ACCESS, in this order, on both verbs:
//   1. routeAuthGuard                     — there is a session at all
//   2. guardReadRequest / guardMutatingRequest — kill switch, content-type, body size
//   3. getRequestForUser → null means 404 — owner or platform admin and nobody
//      else. There are NO collaborators on a request. A stranger must not learn
//      that a request id exists, so this is 404 and never 403.
//   4. status — a screening set is frozen at approval (409 request_not_draft)
//   5. validation — shape (400), then substance (422)
//
// THE 422 IS THE INTERESTING ONE. A client may rewrite any question; a client
// may NOT turn a proof prompt into "and what was the result?". That would make
// the screening form a free version of the call, which is the product inverted.
// lib/screeningItems.proofPromptViolation is the same test the model's own
// output has to pass, and it runs here on client-typed text.
//
// Every response body is built by lib/screeningView.buildRequestView, which
// redacts per viewer — a client never receives an expert's name, address or
// rate ask.
//
// Never logs: the topic, an objective, a stem, a proof prompt, an expert's name
// or address, or an expert's own words.

import { NextRequest } from 'next/server';
import { getRequestForUser, listCandidates, updateObjectiveItems } from '../../../../lib/requestStore';
import { guardReadRequest, guardMutatingRequest } from '../../../../lib/projectsGuard';
import { routeAuthGuard, getSessionUser } from '../../../../lib/auth';
import { validateObjectiveEdits, isValid } from '../../../../lib/screeningValidation';
import { proofPromptViolation, stemViolation } from '../../../../lib/screeningItems';
import { buildRequestView } from '../../../../lib/screeningView';
import type { ObjectiveItemUpdate } from '../../../../lib/requestStore';

const NOT_FOUND = { error: 'not_found' } as const;

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  const guardErr = guardReadRequest(request);
  if (guardErr) return guardErr;

  try {
    const { email, role } = await getSessionUser(request);
    const found = await getRequestForUser(params.id, email, role);
    if (!found) return Response.json(NOT_FOUND, { status: 404 });

    const candidates = await listCandidates(found.id);
    return Response.json({ request: buildRequestView(found, candidates, { email, role }) });
  } catch (err) {
    console.error('[api/requests/[id]] GET error:', err instanceof Error ? err.message : String(err));
    return Response.json(
      { error: 'failed_to_load_request', message: 'We could not load that request. Try again.' },
      { status: 500 },
    );
  }
}

// ─── PATCH ────────────────────────────────────────────────────────────────────

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } },
) {
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;
  const { body } = guard;

  try {
    const { email, role } = await getSessionUser(request);
    const found = await getRequestForUser(params.id, email, role);
    if (!found) return Response.json(NOT_FOUND, { status: 404 });

    if (found.status !== 'draft') {
      return Response.json(
        {
          error:   'request_not_draft',
          message: 'This screening set has been approved, so it can no longer be edited.',
        },
        { status: 409 },
      );
    }

    const validated = validateObjectiveEdits(body);
    if (!isValid(validated)) {
      return Response.json({ error: 'invalid_input', errors: validated.errors }, { status: 400 });
    }

    // ── Only what actually changed ───────────────────────────────────────────
    // An unchanged edit is skipped rather than written: re-saving identical
    // text would otherwise stamp `client_edited` and `source: 'client'` on an
    // item the client never touched, and the "Edited" tag would appear on every
    // card the moment anyone pressed Approve.
    const stored  = new Map(found.objectives.map(o => [o.id, o]));
    const changed = validated.data.filter(edit => {
      const objective = stored.get(edit.id);
      if (!objective) return false;
      return objective.stem !== edit.stem || objective.proofPrompt !== edit.proofPrompt;
    });

    // ── Substance check, before anything is written ──────────────────────────
    for (const edit of changed) {
      const objective = stored.get(edit.id);
      if (objective && objective.stem !== edit.stem) {
        const reason = stemViolation(edit.stem);
        if (reason) {
          return Response.json(
            { error: 'invalid_item', objectiveId: edit.id, field: 'stem', message: reason },
            { status: 422 },
          );
        }
      }
      if (objective && objective.proofPrompt !== edit.proofPrompt) {
        const reason = proofPromptViolation(edit.proofPrompt);
        if (reason) {
          return Response.json(
            { error: 'invalid_item', objectiveId: edit.id, field: 'proofPrompt', message: reason },
            { status: 422 },
          );
        }
      }
    }

    // `modelStem` / `modelProofPrompt` are deliberately omitted: the update is a
    // merge patch, so what the model wrote survives the client rewriting it.
    const updates: ObjectiveItemUpdate[] = changed.map(edit => ({
      id:           edit.id,
      stem:         edit.stem,
      proofPrompt:  edit.proofPrompt,
      source:       'client',
      clientEdited: true,
    }));

    const saved = changed.length > 0
      ? await updateObjectiveItems(found.id, updates)
      : found;

    const candidates = await listCandidates(saved.id);
    return Response.json({ request: buildRequestView(saved, candidates, { email, role }) });
  } catch (err) {
    console.error('[api/requests/[id]] PATCH error:', err instanceof Error ? err.message : String(err));
    return Response.json(
      { error: 'failed_to_save_request', message: 'We could not save those edits. Try again.' },
      { status: 500 },
    );
  }
}

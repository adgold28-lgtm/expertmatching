// POST /api/requests/[id]/approve
//
// Freezes the screening set and opens the request for links
// (docs/SCREENING_FLOW_PLAN.md, build step 3). This is the point of no return
// in the flow: after it, the set is read-only (PATCH returns 409) and staff can
// mint screening links against it, so everything that has to be true of a
// question an expert will read is checked HERE and nowhere later.
//
// TWO GATES, in this order:
//   1. COMPLETE — every objective has a stem and a proof prompt. An objective
//      with a blank question would reach the expert as a gap in the form and
//      come back as a gap in the client's coverage ratio. 422 incomplete_items
//      names the objectives so the editor can mark the empty fields.
//   2. COMPLIANCE — the topic, every stem and every proof prompt go through
//      lib/matchyScreen, the same screen every Matchy message passes, with the
//      client's own firm name loaded from lib/firmStore. The expert must not
//      learn who is asking (the anonymity boundary the whole product rests on)
//      and must not be handed a way off the platform. 422 screen_blocked
//      returns one finding per offending field, each with the exact substring
//      and a plain line about what to do.
//
// Only five finding kinds block: client_firm_name, email, url, scheduling_link
// and phone. `money` and `off_platform_phrase` are deliberately NOT blocking
// here — screenMessage flags money on any client_to_expert text, and the
// screening form legitimately shows the expert a rate, in its own field, put
// there by the platform rather than typed by the client.
//
// ACCESS: routeAuthGuard → guardMutatingRequest → getRequestForUser (404, never
// 403) → draft only (409) → the two gates (422) → approve.
//
// Never logs: the topic, an objective, a stem, a proof prompt, the firm name or
// any finding. The product event carries two counts.

import { NextRequest } from 'next/server';
import { getRequestForUser, listCandidates, approveRequest } from '../../../../../lib/requestStore';
import { guardMutatingRequest } from '../../../../../lib/projectsGuard';
import { routeAuthGuard, getSessionUser } from '../../../../../lib/auth';
import { screenMessage, type ScreenFindingKind } from '../../../../../lib/matchyScreen';
import { getFirmById } from '../../../../../lib/firmStore';
import { buildRequestView } from '../../../../../lib/screeningView';
import { trackProductEvent } from '../../../../../lib/productEvents';

/**
 * The kinds that stop an approval. Anything else screenMessage reports is
 * noted by the screen and ignored here — see the header for why `money` is not
 * on this list.
 */
const BLOCKING_KINDS: ReadonlySet<ScreenFindingKind> = new Set<ScreenFindingKind>([
  'client_firm_name', 'email', 'url', 'scheduling_link', 'phone',
]);

type ScreenedField = 'topic' | 'stem' | 'proofPrompt';

interface BlockingFinding {
  /** Null for the topic statement, which belongs to no single objective. */
  objectiveId: string | null;
  field:       ScreenedField;
  kind:        ScreenFindingKind;
  match:       string;
  hint:        string;
}

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
          message: 'This screening set has already been approved.',
        },
        { status: 409 },
      );
    }

    // ── Gate 1: every objective has both texts ───────────────────────────────
    const incomplete = found.objectives
      .filter(o => !o.stem?.trim() || !o.proofPrompt?.trim())
      .map(o => o.id);

    if (incomplete.length > 0) {
      return Response.json(
        {
          error:       'incomplete_items',
          objectiveIds: incomplete,
          message:     'Every objective needs a question and a proof prompt before the set can be approved.',
        },
        { status: 422 },
      );
    }

    // ── Gate 2: the compliance screen ────────────────────────────────────────
    // getFirmById returns null without a service-role client (development) or
    // for an organization that has since gone; the screen then runs without the
    // firm-name check and still catches addresses, links and phone numbers.
    const firm = await getFirmById(found.organizationId);

    const findings: BlockingFinding[] = [];
    const collect = (objectiveId: string | null, field: ScreenedField, text: string): void => {
      const result = screenMessage({
        text,
        direction:     'client_to_expert',
        clientFirmName: firm?.name,
      });
      for (const finding of result.findings) {
        if (!BLOCKING_KINDS.has(finding.kind)) continue;
        findings.push({
          objectiveId,
          field,
          kind:  finding.kind,
          match: finding.match,
          hint:  finding.hint,
        });
      }
    };

    collect(null, 'topic', found.topicStatement);
    for (const objective of found.objectives) {
      collect(objective.id, 'stem',        objective.stem ?? '');
      collect(objective.id, 'proofPrompt', objective.proofPrompt ?? '');
    }

    if (findings.length > 0) {
      return Response.json(
        {
          error:    'screen_blocked',
          findings,
          message:  'An expert must not be able to work out who is asking, or reach anyone off the platform. Fix the lines below and approve again.',
        },
        { status: 422 },
      );
    }

    // ── Approve ──────────────────────────────────────────────────────────────
    const approved = await approveRequest(found.id);

    void trackProductEvent({
      type:           'screening_set_approved',
      actorEmail:     email,
      organizationId: approved.organizationId,
      payload: {
        count:  approved.objectives.length,
        edited: approved.objectives.filter(o => o.clientEdited).length,
      },
    });

    const candidates = await listCandidates(approved.id);
    return Response.json({ request: buildRequestView(approved, candidates, { email, role }) });
  } catch (err) {
    console.error('[api/requests/[id]/approve] error:', err instanceof Error ? err.message : String(err));
    return Response.json(
      { error: 'failed_to_approve', message: 'We could not approve that screening set. Try again.' },
      { status: 500 },
    );
  }
}

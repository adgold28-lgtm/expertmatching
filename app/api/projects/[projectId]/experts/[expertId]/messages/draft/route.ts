// POST /api/projects/:projectId/experts/:expertId/messages/draft — "write the
// reply for me"
//
// The Matchy 2.0 composer's one server call. The client says what they want to
// tell the expert; Matchy writes ONE short reply in the client's voice; the
// client edits it and sends it through the sibling POST .../messages, which
// screens it again. This route never sends, never stores and never moves a
// status. There is no email, no thread write and no charge, so there is no
// entitlement check (lib/entitlements.ts gates go-live, booking and sending;
// a trial firm may draft all it likes).
//
// POST { instruction } → 200 { text }
//        Only the project owner or a platform admin: same rule as the send
//        route, because a draft is the first half of a send (spec, founder
//        answer 5 — collaborators are read-only).
//
// THE WALL, both ways (lib/matchyDraft.ts has the long version):
//
//   BEFORE THE MODEL — the instruction is screened client→expert exactly as a
//   message would be. A firm name, a phone number, a dollar figure or "call me
//   directly" in the instruction is 422 `message_blocked` with the findings,
//   and the model is never called: an instruction that would be blocked as a
//   message must not become a prompt. The thread the model sees is redacted
//   with the viewer role FORCED to 'user', whatever the caller's role.
//
//   AFTER THE MODEL — the draft is validated, never repaired: brevity, the
//   full screen, no mask token, no em dash, no '$', no markdown, no expert
//   surname or employer pre-reveal, no bare client-side rate. Any failure is
//   200 `{ error: 'no_draft' }` with Matchy's one line, and the client writes
//   it themselves. A repaired draft is a draft nobody checked.
//
// RATE LIMIT BEFORE THE MODEL: 10 per user per minute, 200 per project per
// day (lib/rateLimiter.checkDraftLimits). Over the limit is 429
// `ask_rate_limited`. The store is guarded on construction AND on every call,
// so a rate-limit outage fails OPEN (HANDOFF, Session 7: guard the call, not
// just the constructor).
//
// WALKTHROUGH MODE (lib/walkthrough.ts) changes nothing here: nothing is sent
// either way, and practising the composer is part of the walkthrough.
//
// 404, NEVER 403, on a project the caller cannot reach: the route must not
// confirm that a project exists.
//
// NOTHING OF THE EXPERT'S LEAVES THIS ROUTE. Not the address, not the rate,
// not the name — the response is the draft text or an error code.
//
// Never logs: the instruction, the draft, the thread, expert name, expert
// email, project name.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../../../lib/auth';
import { guardMutatingRequest } from '../../../../../../../../lib/projectsGuard';
import { getProjectForUser } from '../../../../../../../../lib/projectStore';
import { listThread } from '../../../../../../../../lib/conversations';
import { screenMessage } from '../../../../../../../../lib/matchyScreen';
import { isIdentityRevealed } from '../../../../../../../../lib/redactExpert';
import { loadScreenContext } from '../../../../../../../../lib/matchyScreenContext';
import { fallbackDescriptor } from '../../../../../../../../lib/anonymizeExpert';
import { draftReply, MAX_INSTRUCTION_CHARS } from '../../../../../../../../lib/matchyDraft';
import {
  createRateLimiterStore,
  checkDraftLimits,
  type RateLimiterStore,
} from '../../../../../../../../lib/rateLimiter';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

const NO_DRAFT_MESSAGE = "I could not write that one cleanly. Write it in your words and I'll screen it.";

// ─── Rate limit, fail open ────────────────────────────────────────────────────

// Built once per instance; null when it cannot be built (no Upstash in
// production, say). Null means allow — a missing limiter must not take the
// composer down.
const _rlStore: RateLimiterStore | null = (() => {
  try { return createRateLimiterStore(); } catch { return null; }
})();

/** True when the caller may draft. Fails open on a store that will not build or a call that rejects. */
async function withinDraftLimit(userEmail: string, projectId: string): Promise<boolean> {
  if (!_rlStore) return true;
  try {
    const { allowed } = await checkDraftLimits(_rlStore, userEmail, projectId);
    return allowed;
  } catch {
    return true;
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function badIds(projectId: string, expertId: string): NextResponse | null {
  if (!ID_RE.test(projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }
  return null;
}

// ─── POST ─────────────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error as NextResponse;

  const idError = badIds(params.projectId, params.expertId);
  if (idError) return idError;

  const rawInstruction = guard.body.instruction;
  if (typeof rawInstruction !== 'string') {
    return NextResponse.json({ error: 'instruction_required' }, { status: 400 });
  }
  const instruction = rawInstruction.trim();
  if (!instruction) {
    return NextResponse.json({ error: 'instruction_required' }, { status: 400 });
  }
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    return NextResponse.json(
      { error: 'instruction_too_long', message: `Keep it under ${MAX_INSTRUCTION_CHARS} characters.` },
      { status: 400 },
    );
  }

  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === params.expertId);
    if (!pe) return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

    // Collaborators read the thread; only the owner (or staff) writes to an
    // expert on the project's behalf, and a draft is the start of a write.
    if (role !== 'admin' && project.ownerEmail !== email) {
      return NextResponse.json(
        { error: 'read_only', message: 'Only the project owner can message experts.' },
        { status: 403 },
      );
    }

    // There has to be a thread to reply on: an outreach token (the expert's
    // reply-to) and an address the intro actually went to.
    if (!pe.outreachToken || !pe.contactEmail) {
      return NextResponse.json(
        { error: 'thread_not_started', message: 'Nothing has been sent to this expert yet.' },
        { status: 422 },
      );
    }

    // Counted before the model so a refused draft still spends a slot: the
    // cost being limited is the call, not the success.
    if (!(await withinDraftLimit(email, params.projectId))) {
      return NextResponse.json(
        { error: 'ask_rate_limited', message: 'Give me a minute before the next draft.' },
        { status: 429 },
      );
    }

    const identityRevealed = isIdentityRevealed(pe);
    const { clientFirmName, clientFullName } = await loadScreenContext(project, email);

    // The instruction is screened as if it were the message. Blocked means the
    // client fixes it and tries again; the model never sees it.
    const screenResult = screenMessage({
      text:             instruction,
      direction:        'client_to_expert',
      identityRevealed,
      clientFirmName,
      expertFullName:   pe.expert.name,
      clientFullName,
    });
    if (screenResult.blocked) {
      return NextResponse.json(
        { error: 'message_blocked', findings: screenResult.findings },
        { status: 422 },
      );
    }

    const thread = await listThread(params.projectId, params.expertId);

    const result = await draftReply({
      instruction,
      thread,
      identityRevealed,
      clientFirmName,
      clientFullName,
      expertFullName:   pe.expert.name,
      expertCompany:    pe.expert.company,
      // The card's descriptor is the only thing the model learns about the
      // expert — never the name, title or company.
      expertDescriptor: pe.expert.anonymizedDescriptor?.trim() || fallbackDescriptor(pe.expert),
      // Every client-side number this client has seen for the engagement.
      knownClientFigures: [
        pe.clientRate,
        pe.clientCounterRate,
        project.clientRateMin,
        project.clientRateMax,
      ],
    });

    if ('error' in result) {
      return NextResponse.json({ error: 'no_draft', message: NO_DRAFT_MESSAGE }, { status: 200 });
    }
    return NextResponse.json({ text: result.text }, { status: 200 });
  } catch (err) {
    console.error('[messages/draft] failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'draft_failed' }, { status: 500 });
  }
}

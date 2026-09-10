// GET  /api/projects/:projectId/experts/:expertId/messages — read the thread
// POST /api/projects/:projectId/experts/:expertId/messages — the client writes
//
// This is the client half of Matchy's relay. The expert half is ordinary email
// arriving at /api/inbound-email; neither side ever learns the other's address
// (docs/MATCHY_SPEC.md, "The idea in one paragraph").
//
// GET  → { messages, projectExpert }
//        Every project member may read — owner, collaborators and staff. Each
//        message goes through lib/conversations.redactMessageForViewer, which
//        never returns the raw email and, before the identity reveal, masks
//        every contact detail and name out of what the expert wrote. The
//        expert record goes through lib/redactExpert.redactExpertForViewer, so
//        `contactEmail` and `expertRate` are gone before the response is built.
//
// POST { text } → 201 { message }, or 200 { ok, held, message } when the send
//        was held.
//        ONLY the project owner or a platform admin may send. Collaborators are
//        read-only by product decision (spec, founder answer 5) and get 403
//        `read_only`. The message is screened client→expert first: if the
//        screen blocks it, the response is 422 `message_blocked` with the
//        findings and NOTHING IS STORED — a blocked message is not a message,
//        and storing it would put the leaked detail in the database anyway.
//
// A HELD SEND IS NEVER REPORTED AS A SENT ONE. Four things hold a reply:
// walkthrough mode (checked here), and the chokepoint's three —
// DISABLE_EMAILS, an organization with no card on file, and the global
// do-not-contact list (lib/emailSequence.sendSequenceEmail). The message is
// still screened and still stored, marked with the reason, and the response
// carries `held` so the thread renders the grey tag rather than implying the
// expert has it. Only a message Resend accepted answers 201.
//
// 404, NEVER 403, on a project the caller cannot reach: the route must not
// confirm that a project exists.
//
// NO ADDRESS EVER LEAVES THIS ROUTE. Not in a message, not in an error, not in
// the projectExpert.
//
// Never logs: message text, expert name, expert email, project name, token.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../../lib/auth';
import { guardMutatingRequest, guardReadRequest } from '../../../../../../../lib/projectsGuard';
import { getProjectForUser } from '../../../../../../../lib/projectStore';
import {
  appendMessage,
  listThread,
  redactMessageForViewer,
} from '../../../../../../../lib/conversations';
import { screenMessage } from '../../../../../../../lib/matchyScreen';
import { redactExpertForViewer, isIdentityRevealed } from '../../../../../../../lib/redactExpert';
import { sendSequenceEmail, dispositionOf } from '../../../../../../../lib/emailSequence';
import { isWalkthrough } from '../../../../../../../lib/walkthrough';
import { loadScreenContext } from '../../../../../../../lib/matchyScreenContext';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

/** Longest message a client may send in one go. */
const MAX_MESSAGE_CHARS = 4000; // not exported: Next rejects non-handler exports from route files

function badIds(projectId: string, expertId: string): NextResponse | null {
  if (!ID_RE.test(projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }
  return null;
}

// ─── GET ──────────────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  const guard = guardReadRequest(request);
  if (guard) return guard as NextResponse;

  const idError = badIds(params.projectId, params.expertId);
  if (idError) return idError;

  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === params.expertId);
    if (!pe) return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

    const rows = await listThread(params.projectId, params.expertId);
    const messages = rows.map(row => redactMessageForViewer(row, {
      role,
      revealed:       isIdentityRevealed(pe),
      expertFullName: pe.expert.name,
      expertCompany:  pe.expert.company,
    }));

    return NextResponse.json({
      messages,
      projectExpert: redactExpertForViewer(pe, { role }),
    });
  } catch (err) {
    console.error('[messages] read failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'thread_read_failed' }, { status: 500 });
  }
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

  const rawText = guard.body.text;
  if (typeof rawText !== 'string') {
    return NextResponse.json({ error: 'text_required' }, { status: 400 });
  }
  const text = rawText.trim();
  if (!text) {
    return NextResponse.json({ error: 'text_required' }, { status: 400 });
  }
  if (text.length > MAX_MESSAGE_CHARS) {
    return NextResponse.json(
      { error: 'text_too_long', message: `Keep it under ${MAX_MESSAGE_CHARS} characters.` },
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
    // expert on the project's behalf.
    if (role !== 'admin' && project.ownerEmail !== email) {
      return NextResponse.json(
        { error: 'read_only', message: 'Only the project owner can send to an expert.' },
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

    const { clientFirmName, clientFullName } = await loadScreenContext(project, email);

    const screenResult = screenMessage({
      text,
      direction:        'client_to_expert',
      identityRevealed: isIdentityRevealed(pe),
      clientFirmName,
      expertFullName:   pe.expert.name,
      clientFullName,
    });

    // Blocked means the sender fixes it and tries again. Nothing is stored and
    // nothing is sent — the findings say exactly what to take out.
    if (screenResult.blocked) {
      return NextResponse.json(
        { error: 'message_blocked', findings: screenResult.findings },
        { status: 422 },
      );
    }

    // Same subject line the thread has always carried, so the expert's client
    // keeps it in one conversation. The reply-to token is the continuity.
    const base = pe.outreachSubject?.trim() || 'Paid expert call';
    const subject = /^re:/i.test(base) ? base : `Re: ${base}`;

    // Walkthrough: the screen has already run (above) — only the send is
    // skipped. lib/emailSequence would hold it anyway; refusing here is what
    // lets the message be STORED as held rather than as sent.
    //
    // THE OUTCOME IS READ (H-4). The chokepoint holds on 'trial' (no card on
    // file), 'disabled' (DISABLE_EMAILS) and the global do-not-contact list
    // (H-3) as well as on walkthrough, and every one of those means the expert
    // did not receive this reply. `dispositionOf` turns the attempt into the
    // one thing this route has to decide: which hold to store on the thread
    // copy, so the client reads a held tag instead of a message that appears
    // to have been delivered.
    const disposition = dispositionOf(
      isWalkthrough(project)
        ? { kind: 'walkthrough' }
        : {
            kind:    'outcome',
            outcome: await sendSequenceEmail(
              pe.contactEmail, subject, text, pe.outreachToken, 'client_reply',
            ),
          },
    );
    const held = disposition.held;

    const stored = await appendMessage({
      projectId: params.projectId,
      expertId:  params.expertId,
      direction: 'outbound',
      author:    'client',
      bodyClean: text,
      screenResult,
      ...(held && { held }),
    });

    if (!stored) {
      // Say plainly which of the two happened rather than pretending the send
      // failed — after a real send, a resend would double-email the expert.
      // When the send was held nothing went out, so the line says only that.
      return NextResponse.json(
        {
          error:   'message_not_recorded',
          message: disposition.delivered
            ? 'Your message was sent but could not be saved to the thread.'
            : 'Your message could not be saved to the thread.',
        },
        { status: 500 },
      );
    }

    const message = redactMessageForViewer(stored, {
      role,
      revealed:       isIdentityRevealed(pe),
      expertFullName: pe.expert.name,
      expertCompany:  pe.expert.company,
    });

    // A held reply is still a 2xx with the stored message — the thread has to
    // render what the client wrote — but it carries `held` so the browser can
    // say the expert has not received it. 201 stays the "it went out" answer.
    if (held) {
      return NextResponse.json({ ok: true, held, message }, { status: 200 });
    }

    return NextResponse.json({ message }, { status: 201 });
  } catch (err) {
    console.error('[messages] send failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'message_send_failed' }, { status: 500 });
  }
}

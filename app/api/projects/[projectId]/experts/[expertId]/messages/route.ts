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
// POST { text } → 201 { message }
//        ONLY the project owner or a platform admin may send. Collaborators are
//        read-only by product decision (spec, founder answer 5) and get 403
//        `read_only`. The message is screened client→expert first: if the
//        screen blocks it, the response is 422 `message_blocked` with the
//        findings and NOTHING IS STORED — a blocked message is not a message,
//        and storing it would put the leaked detail in the database anyway.
//
// WALKTHROUGH MODE (lib/walkthrough.ts): the screen still runs, and a blocked
// message still 422s — practising the compliance rules is the point of a
// walkthrough. What changes is the send: the message is stored marked
// `held: 'walkthrough'` and nothing goes to the expert. Still 201, still with
// the message, so the thread renders the reply the client just wrote.
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
import { sendSequenceEmail } from '../../../../../../../lib/emailSequence';
import { isWalkthrough } from '../../../../../../../lib/walkthrough';
import { getFirm, getUser } from '../../../../../../../lib/firmStore';
import type { Project } from '../../../../../../../types';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

/** Longest message a client may send in one go. */
const MAX_MESSAGE_CHARS = 4000; // not exported: Next rejects non-handler exports from route files

// ─── Shared context ───────────────────────────────────────────────────────────

/**
 * The firm name and the client's real name — the two things the compliance
 * screen needs to stop an identity crossing the wall. Best-effort on both: a
 * name we do not have is a check the screen cannot run, not a reason to fail.
 */
async function loadScreenContext(project: Project, fallbackEmail: string) {
  const firm = await getFirm(project.firmDomain).catch(() => null);

  let clientFullName = project.clientName?.trim() || undefined;
  if (!clientFullName) {
    const owner = await getUser(project.ownerEmail || fallbackEmail).catch(() => null);
    const parts = [owner?.firstName, owner?.lastName].filter(Boolean);
    if (parts.length > 0) clientFullName = parts.join(' ');
  }

  return {
    clientFirmName: firm?.name?.trim() || undefined,
    clientFullName,
  };
}

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
    const held = isWalkthrough(project);
    if (!held) {
      await sendSequenceEmail(pe.contactEmail, subject, text, pe.outreachToken, 'client_reply');
    }

    const stored = await appendMessage({
      projectId: params.projectId,
      expertId:  params.expertId,
      direction: 'outbound',
      author:    'client',
      bodyClean: text,
      screenResult,
      ...(held && { held: 'walkthrough' as const }),
    });

    if (!stored) {
      // The email went out; the copy did not. Say so plainly rather than
      // pretending the send failed — a resend would double-email the expert.
      // In walkthrough nothing went out, so the line says only that.
      return NextResponse.json(
        {
          error:   'message_not_recorded',
          message: held
            ? 'Your message could not be saved to the thread.'
            : 'Your message was sent but could not be saved to the thread.',
        },
        { status: 500 },
      );
    }

    return NextResponse.json(
      {
        message: redactMessageForViewer(stored, {
          role,
          revealed:       isIdentityRevealed(pe),
          expertFullName: pe.expert.name,
          expertCompany:  pe.expert.company,
        }),
      },
      { status: 201 },
    );
  } catch (err) {
    console.error('[messages] send failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'message_send_failed' }, { status: 500 });
  }
}

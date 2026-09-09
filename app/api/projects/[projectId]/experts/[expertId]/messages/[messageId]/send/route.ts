// POST /api/projects/:projectId/experts/:expertId/messages/:messageId/send
//
// Approve and send one drafted message.
//
// On a "review first" project Matchy still does the work — when an expert says
// yes, it writes the follow-up (conflict / NDA questions plus the rate ask) —
// but it does not send it. The draft is stored as an ordinary outbound message
// carrying `{ "pending": true }` inside its `screen_result` jsonb
// (lib/conversations.ts, "PENDING APPROVAL"; Phase 1 ships no second
// migration, so the flag lives in jsonb rather than a column). This route is
// the button that sends it.
//
// WHO MAY: the project owner or a platform admin. Collaborators are read-only.
// 404 rather than 403 on an inaccessible project.
//
// WALKTHROUGH MODE: 409 `walkthrough_mode`, before any side effect. A held
// message is never marked pending in the first place (lib/conversations), so
// this is the belt to that braces — a stale client cannot release anything
// while the project is not live.
//
// IDEMPOTENT: the pending flag is what makes a message sendable, and it is
// cleared as part of sending. A second POST finds no pending flag and answers
// 409 rather than mailing the expert twice.
//
// MONEY: the draft already carries `expertRate`, because it was built by
// lib/matchyTemplates.buildFollowUpEmail for an expert audience. Nothing here
// touches the text; `rate_offered` records both numbers as event data, which
// no one reads as a message.
//
// Never logs: message text, expert name, expert email, project name, token.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../../../../lib/auth';
import { guardMutatingRequest } from '../../../../../../../../../lib/projectsGuard';
import { getProjectForUser, updateExpertStatus } from '../../../../../../../../../lib/projectStore';
import {
  getMessage,
  updateMessage,
  redactMessageForViewer,
} from '../../../../../../../../../lib/conversations';
import { sendSequenceEmail } from '../../../../../../../../../lib/emailSequence';
import { emitEngagementEvent } from '../../../../../../../../../lib/engagementEvents';
import { isSuppressed } from '../../../../../../../../../lib/outreachSuppressions';
import { clientRateFor } from '../../../../../../../../../lib/pricing';
import { getFirm } from '../../../../../../../../../lib/firmStore';
import { isWalkthrough } from '../../../../../../../../../lib/walkthrough';
import { isIdentityRevealed } from '../../../../../../../../../lib/redactExpert';
import type { StoredScreenResult } from '../../../../../../../../../lib/conversations';

const ID_RE         = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE  = /^[a-zA-Z0-9\-_]+$/;
const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string; messageId: string } },
): Promise<NextResponse> {
  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error as NextResponse;

  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }
  if (!MESSAGE_ID_RE.test(params.messageId)) {
    return NextResponse.json({ error: 'invalid_message_id' }, { status: 400 });
  }

  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === params.expertId);
    if (!pe) return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

    if (role !== 'admin' && project.ownerEmail !== email) {
      return NextResponse.json(
        { error: 'read_only', message: 'Only the project owner can send to an expert.' },
        { status: 403 },
      );
    }

    // Walkthrough: nothing may be sent from this project at all. Refuse before
    // any side effect — no suppression lookup, no status write, no Resend call.
    if (isWalkthrough(project)) {
      return NextResponse.json(
        {
          error:   'walkthrough_mode',
          message: 'Nothing is sent in walkthrough mode. Switch the project to live first.',
        },
        { status: 409 },
      );
    }

    // Scoped by (project, expert, id) — an id from another thread simply misses.
    const stored = await getMessage(params.projectId, params.expertId, params.messageId);
    if (!stored) return NextResponse.json({ error: 'message_not_found' }, { status: 404 });

    const screen = (stored.screen_result ?? null) as StoredScreenResult | null;
    if (screen?.pending !== true) {
      return NextResponse.json(
        { error: 'not_pending', message: 'That message has already been sent.' },
        { status: 409 },
      );
    }
    if (stored.direction !== 'outbound') {
      return NextResponse.json({ error: 'not_sendable' }, { status: 409 });
    }

    const body = stored.body_clean?.trim();
    if (!body) return NextResponse.json({ error: 'empty_message' }, { status: 422 });

    if (!pe.contactEmail || !pe.outreachToken) {
      return NextResponse.json(
        { error: 'thread_not_started', message: 'Nothing has been sent to this expert yet.' },
        { status: 422 },
      );
    }

    // The opt-out list can have gained this address since the draft was
    // written. Fails CLOSED.
    const suppression = await isSuppressed(pe.contactEmail);
    if (!suppression.ok || suppression.suppressed) {
      return NextResponse.json(
        {
          error:   suppression.ok ? 'contact_suppressed' : 'contact_check_unavailable',
          message: suppression.ok
            ? 'This expert has opted out of outreach.'
            : 'I could not check the opt-out list, so I have not sent anything.',
        },
        { status: 409 },
      );
    }

    const base = pe.outreachSubject?.trim() || 'Paid expert call';
    const subject = /^re:/i.test(base) ? base : `Re: ${base}`;

    // The stored body is the template's text with the CAN-SPAM footer already
    // stripped off, so the sender appends a fresh one for this recipient.
    await sendSequenceEmail(pe.contactEmail, subject, body, pe.outreachToken, 'followup_approved');

    // Clearing the flag is what makes this route idempotent.
    const updatedRow = await updateMessage(stored.id, {
      screenResult: { blocked: screen.blocked, findings: screen.findings ?? [] },
      summary:      'Sent the conflict questions and the rate ask. Waiting on their terms.',
    });

    const expertRate = pe.expertRate ?? 0;

    await updateExpertStatus(params.projectId, params.expertId, {
      status:         'followup_sent',
      followupSentAt: Date.now(),
    });

    const firm = await getFirm(project.firmDomain).catch(() => null);
    await emitEngagementEvent({
      projectId: params.projectId,
      expertId:  params.expertId,
      orgId:     firm?.id ?? null,
      type:      'rate_offered',
      payload:   {
        approved:   true,
        expertRate,
        clientRate: expertRate > 0 ? clientRateFor(expertRate) : 0,
      },
    });

    return NextResponse.json({
      message: redactMessageForViewer(updatedRow ?? stored, {
        role,
        revealed:       isIdentityRevealed(pe),
        expertFullName: pe.expert.name,
        expertCompany:  pe.expert.company,
      }),
    });
  } catch (err) {
    console.error('[messages/send] failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'message_send_failed' }, { status: 500 });
  }
}

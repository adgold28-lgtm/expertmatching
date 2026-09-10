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
// IDEMPOTENT: the pending flag is what makes a message sendable. It is SPENT
// BEFORE the Resend call, not after, so a failure between the two cannot leave
// a flag that a second click spends again; a second POST finds no pending flag
// and answers 409 rather than mailing the expert twice. If the message turns
// out not to have gone (the chokepoint held it), the flag is put back and the
// answer carries `held` rather than pretending the expert has it.
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
  clearPendingIfPending,
  redactMessageForViewer,
} from '../../../../../../../../../lib/conversations';
import { sendSequenceEmail, dispositionOf, type SendDisposition } from '../../../../../../../../../lib/emailSequence';
import { emitEngagementEvent } from '../../../../../../../../../lib/engagementEvents';
import { isSuppressed } from '../../../../../../../../../lib/outreachSuppressions';
import { clientRateFor } from '../../../../../../../../../lib/pricing';
import { getFirm } from '../../../../../../../../../lib/firmStore';
import { isWalkthrough, type HeldReason } from '../../../../../../../../../lib/walkthrough';
import { isIdentityRevealed } from '../../../../../../../../../lib/redactExpert';
import type { StoredScreenResult } from '../../../../../../../../../lib/conversations';

const ID_RE         = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE  = /^[a-zA-Z0-9\-_]+$/;
const MESSAGE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Put the pending flag back on a draft that did not go out.
 *
 * Only the flag and its hold change; the screen's own verdict is preserved.
 * Recording the hold alongside `pending` is deliberate: the client sees WHY it
 * is still sitting there, and the draft stays releasable once the account is
 * live again.
 *
 * Best effort — the send did not happen either way, and an owner who reloads
 * sees the truth from the row.
 */
async function restorePending(
  messageId: string,
  screen:    StoredScreenResult,
  held?:     HeldReason | null,
) {
  return updateMessage(messageId, {
    screenResult: {
      blocked:  screen.blocked,
      findings: screen.findings ?? [],
      pending:  true,
      ...(held ? { held } : {}),
    },
    // The draft's own summary is left alone unless there is a hold to explain:
    // it already says the message is waiting on the client.
    ...(held ? { summary: 'Held. Nothing was sent to them, so the draft is still waiting.' } : {}),
  });
}

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

    // CLEAR THE FLAG BEFORE THE SEND, NOT AFTER (M-30). The pending flag is the
    // permission to mail this draft, so it is spent first, ATOMICALLY: the
    // conditional update in lib/conversations.clearPendingIfPending only wins
    // when the row still carries `pending: true`, so two POSTs racing on the
    // same message can no longer both spend the flag — the loser sees zero
    // rows updated and is answered 409 `not_pending` before any send is
    // attempted. Everything after this point restores the flag if the expert
    // did not actually receive the draft.
    const clearedRow = await clearPendingIfPending(stored.id, {
      screenResult: { blocked: screen.blocked, findings: screen.findings ?? [] },
      summary:      'Sent the conflict questions and the rate ask. Waiting on their terms.',
    });
    if (!clearedRow) {
      return NextResponse.json(
        { error: 'not_pending', message: 'That message has already been sent.' },
        { status: 409 },
      );
    }

    // The stored body is the template's text with the CAN-SPAM footer already
    // stripped off, so the sender appends a fresh one for this recipient.
    //
    // THE OUTCOME IS READ (H-4). A Resend failure throws and the catch answers
    // 500; a chokepoint HOLD ('trial', 'disabled', or the do-not-contact list)
    // returns normally, and it must not be mistaken for a send. On a hold the
    // pending flag goes back on the message, the expert stays where they are,
    // no `rate_offered` is emitted, and the response says what happened.
    let disposition: SendDisposition;
    try {
      disposition = dispositionOf({
        kind:    'outcome',
        outcome: await sendSequenceEmail(pe.contactEmail, subject, body, pe.outreachToken, 'followup_approved'),
      });
    } catch (err) {
      await restorePending(stored.id, screen);
      throw err;
    }

    if (!disposition.advance) {
      const restored = await restorePending(stored.id, screen, disposition.held);
      return NextResponse.json({
        ok:      true,
        held:    disposition.held,
        message: redactMessageForViewer(restored ?? clearedRow ?? stored, {
          role,
          revealed:       isIdentityRevealed(pe),
          expertFullName: pe.expert.name,
          expertCompany:  pe.expert.company,
        }),
      });
    }

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
      message: redactMessageForViewer(clearedRow ?? stored, {
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

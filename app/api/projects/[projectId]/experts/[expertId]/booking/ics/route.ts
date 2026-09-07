// GET /api/projects/:projectId/experts/:expertId/booking/ics
//
// The booked call as a downloadable .ics. Any project MEMBER may fetch it —
// owner, collaborator or platform staff — because reading a calendar entry is
// a read, and collaborators see everything on a project they are on.
//
// WHY IT EXISTS. The confirmation email carries the same invite, but an email
// can bounce, be filtered, or be read on a phone that will not open an
// attachment. This is the copy the client can always get, and it is generated
// from lib/bookCall.bookingIcsEvent so it carries the SAME UID and the SAME
// SEQUENCE as the one that was mailed: importing it twice updates one event
// rather than creating two.
//
// 404 on a project the caller cannot reach, so the route never confirms one
// exists, and 404 when nothing is booked.
//
// NO ADDRESS EVER LEAVES THIS ROUTE beyond the client's own: the attendee list
// is the client, and the expert's address is deliberately not on it (they got
// their own copy). The expert's NAME is present, which is correct — a booked
// call is exactly where lib/redactExpert.ts reveals the identity.
//
// Never logs: names, addresses, project names, call times.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../../../lib/auth';
import { guardReadRequest } from '../../../../../../../../lib/projectsGuard';
import { getProjectForUser } from '../../../../../../../../lib/projectStore';
import { generateIcs } from '../../../../../../../../lib/generateIcs';
import { bookingIcsEvent } from '../../../../../../../../lib/bookCall';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  const guard = guardReadRequest(request);
  if (guard) return guard as NextResponse;

  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }

  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === params.expertId);
    if (!pe) return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

    const event = bookingIcsEvent(project, pe);
    if (!event) return NextResponse.json({ error: 'nothing_booked' }, { status: 404 });

    return new NextResponse(generateIcs(event), {
      status: 200,
      headers: {
        'Content-Type':        'text/calendar; charset=utf-8; method=REQUEST',
        'Content-Disposition': 'attachment; filename="expert-call.ics"',
        // A booking can move. Never let a proxy or a browser serve a stale one.
        'Cache-Control':       'no-store',
      },
    });
  } catch (err) {
    console.error('[booking-ics] failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'ics_failed' }, { status: 500 });
  }
}

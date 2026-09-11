// scripts/test-call-policies.ts — the cancellation policy, end to end as far as
// it can go without a database (docs/CALL_POLICIES_DRAFT.md, founder decisions
// 1 to 4).
//
//   npx tsx scripts/test-call-policies.ts
//
// FAILS ON THE OLD CODE at the very first import: lib/callPolicies.ts did not
// exist and lib/bookCall.ts had no cancelCall, so `npx tsx` exits non-zero
// before a single check runs. Once it resolves, "cancelCall exists" and the
// refusal-path section below are the checks that could not pass before.
//
// What it proves:
//
//   cancelWindow     exactly 24 hours before the start is 'free', one
//                    millisecond inside it is 'late', the start itself and
//                    anything after is 'started', and an unparseable start
//                    fails CLOSED to 'late'. Walked across a US DST boundary in
//                    UTC, where 24 hours of wall clock is not 24 hours of time.
//   lateCancelFee    both numbers come from lib/pricing.ts at 15 minutes, and
//                    the client number is the client-side rate, never the
//                    expert's.
//   cancelOutcome    all nine (who x window) branches.
//   cancelCall       the refusal paths that need no side effect: nothing
//                    booked, already cancelled, and a late client cancel with
//                    no confirmation (which must answer BEFORE any write and
//                    must carry the fee).
//   the copy         the two cancellation bodies and the removal apology obey
//                    the same house rules scripts/test-scheduling.ts enforces
//                    on every other outbound template.
//
// DISABLE_EMAILS is set before the imports so nothing here can reach Resend,
// and with no Supabase credentials lib/projectStore falls back to its in-memory
// store, which is what makes the cancelCall section runnable at all.

process.env.DISABLE_EMAILS = 'true';

import {
  CANCEL_WINDOW_MS,
  LATE_CANCEL_MINUTES,
  cancelOutcome,
  cancelWindow,
  lateCancelFee,
  type CancelWindow,
  type CancelledBy,
} from '../lib/callPolicies';
import { callChargeDollars, expertPayoutDollars, clientRateFor } from '../lib/pricing';
import { cancelCall } from '../lib/bookCall';
import {
  cancelledEmail,
  clientCancelledEmail,
  expertRemovedApologyEmail,
} from '../lib/schedulingTemplates';
import { createProject, updateExpertStatus } from '../lib/projectStore';
import type { BookingState, Expert } from '../types';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ─── The window ──────────────────────────────────────────────────────────────

section('cancelWindow: the 24-hour line');

const START    = '2026-05-14T18:00:00.000Z';
const startMs  = Date.parse(START);

eq('the window is 24 hours', CANCEL_WINDOW_MS, 24 * 60 * 60 * 1000);
eq('exactly 24 hours before is free', cancelWindow(startMs - CANCEL_WINDOW_MS, START), 'free');
eq('one ms inside is late',           cancelWindow(startMs - CANCEL_WINDOW_MS + 1, START), 'late');
eq('one ms outside is still free',    cancelWindow(startMs - CANCEL_WINDOW_MS - 1, START), 'free');
eq('a week out is free',              cancelWindow(startMs - 7 * 24 * 3_600_000, START), 'free');
eq('an hour out is late',             cancelWindow(startMs - 3_600_000, START), 'late');
eq('one ms before the start is late', cancelWindow(startMs - 1, START), 'late');
eq('the start itself has started',    cancelWindow(startMs, START), 'started');
eq('after the start has started',     cancelWindow(startMs + 60_000, START), 'started');

section('cancelWindow fails closed');

eq('garbage start is late',   cancelWindow(startMs, 'not-a-date'), 'late');
eq('empty start is late',     cancelWindow(startMs, ''), 'late');
eq('NaN now is late',         cancelWindow(Number.NaN, START), 'late');
eq('Infinity now is late',    cancelWindow(Number.POSITIVE_INFINITY, START), 'late');

section('cancelWindow across a DST change');

// 2026-03-08 is the US spring-forward. A call at 13:00 UTC on the 9th is 24
// hours after 13:00 UTC on the 8th whatever the wall clock in New York did, so
// the boundary must land on the instant, not on the calendar day.
const DST_START = '2026-03-09T13:00:00.000Z';
const dstMs     = Date.parse(DST_START);
eq('DST: exactly 24h before is free', cancelWindow(dstMs - CANCEL_WINDOW_MS, DST_START), 'free');
eq('DST: 23h59m before is late',      cancelWindow(dstMs - CANCEL_WINDOW_MS + 60_000, DST_START), 'late');
// The autumn fall-back, 2026-11-01, where a wall-clock day is 25 hours long.
const FALL_START = '2026-11-02T13:00:00.000Z';
const fallMs     = Date.parse(FALL_START);
eq('fall-back: exactly 24h before is free', cancelWindow(fallMs - CANCEL_WINDOW_MS, FALL_START), 'free');
eq('fall-back: 24h minus 1ms is late',      cancelWindow(fallMs - CANCEL_WINDOW_MS + 1, FALL_START), 'late');

// ─── The fee ─────────────────────────────────────────────────────────────────

section('lateCancelFee is 15 minutes at the agreed rates');

eq('the fee is 15 minutes', LATE_CANCEL_MINUTES, 15);

for (const rate of [400, 650, 675, 800, 1000]) {
  const fee = lateCancelFee(rate);
  eq(`client charge at ${rate} matches pricing`, fee.clientCharge, callChargeDollars(rate, 15));
  eq(`expert payout at ${rate} matches pricing`, fee.expertPayout, expertPayoutDollars(rate, 15));
  eq(`minutes at ${rate}`, fee.minutes, 15);
  check(`the client pays more than the expert at ${rate}`, fee.clientCharge > fee.expertPayout,
    `${fee.clientCharge} vs ${fee.expertPayout}`);
}

// The one arithmetic identity worth stating outright: a quarter of the hourly
// client rate, which is what "15 minutes" has to mean for a client reading it.
eq('at $650 the client pays a quarter of the client rate',
  lateCancelFee(650).clientCharge, Math.round(clientRateFor(650) / 4));
eq('at $650 the expert is paid a quarter of their own rate',
  lateCancelFee(650).expertPayout, Math.round(650 / 4));

section('lateCancelFee on a row with no agreed rate');

const noRate = lateCancelFee(0);
eq('no rate charges nothing', noRate.clientCharge, 0);
eq('no rate pays nothing',    noRate.expertPayout, 0);

// ─── The outcome ─────────────────────────────────────────────────────────────

section('cancelOutcome: every branch');

const WINDOWS: CancelWindow[] = ['free', 'late', 'started'];
const ACTORS:  CancelledBy[]  = ['client', 'expert', 'staff'];

for (const by of ACTORS) {
  const free = cancelOutcome(by, 'free');
  check(`${by} free: not late`, !free.late);
  check(`${by} free: no charge`, !free.clientCharged && !free.expertPaid);
  check(`${by} free: no removal`, !free.expertRemoved);
}

for (const window of ['late', 'started'] as const) {
  const client = cancelOutcome('client', window);
  check(`client ${window}: late`, client.late);
  check(`client ${window}: charged and the expert is paid`, client.clientCharged && client.expertPaid);
  check(`client ${window}: the expert is not removed`, !client.expertRemoved);

  const expert = cancelOutcome('expert', window);
  check(`expert ${window}: late`, expert.late);
  check(`expert ${window}: removed`, expert.expertRemoved);
  check(`expert ${window}: nobody is charged or paid`, !expert.clientCharged && !expert.expertPaid);

  const staff = cancelOutcome('staff', window);
  check(`staff ${window}: late is recorded`, staff.late);
  check(`staff ${window}: never charges`, !staff.clientCharged && !staff.expertPaid);
  check(`staff ${window}: never removes`, !staff.expertRemoved);
}

for (const by of ACTORS) {
  for (const window of WINDOWS) {
    const outcome = cancelOutcome(by, window);
    eq(`${by}/${window}: the engagement ends`, outcome.status, 'rejected_after_outreach');
    check(`${by}/${window}: the expert is paid only when the client is charged`,
      outcome.expertPaid === outcome.clientCharged);
    check(`${by}/${window}: nobody is both charged and removed`,
      !(outcome.clientCharged && outcome.expertRemoved));
  }
}

// ─── The copy ────────────────────────────────────────────────────────────────

section('the cancellation copy keeps the house rules');

const CLIENT_NAME = 'Dana Clientperson';
const CLIENT_FIRM = 'Northgate Capital';
const PROJECT     = 'Project Lighthouse';

const expertCopy = cancelledEmail({
  expertFirstName: 'Casey Testperson',
  whenLabel:       'Tue Sep 15, 2:00 PM ET',
  recipientEmail:  'casey@example.com',
  subject:         'Re: Paid expert call',
});

check('expert copy greets by first name', expertCopy.text.startsWith('Hi Casey,'));
check('expert copy names no client',      !expertCopy.text.includes(CLIENT_NAME));
check('expert copy names no firm',        !expertCopy.text.includes(CLIENT_FIRM));
check('expert copy names no project',     !expertCopy.text.includes(PROJECT));
check('expert copy carries no money',     !expertCopy.text.includes('$'));
check('expert copy has no em dash',       !expertCopy.text.includes('—') && !expertCopy.html.includes('—'));
check('expert copy says it is cancelled', /cancelled/i.test(expertCopy.text));
check('expert copy leaves the footer to the sender',
  !/unsubscribe|opt out|opt-out/i.test(expertCopy.text));

const clientFree = clientCancelledEmail({
  clientFirstName: CLIENT_NAME,
  whenLabel:       'Tue Sep 15, 2:00 PM ET',
  expertName:      'Casey Testperson',
  feeDollars:      null,
  recipientEmail:  'dana@northgate.example',
  subject:         'Call cancelled',
});
check('free client copy names the expert', clientFree.text.includes('Casey Testperson'));
check('free client copy mentions no money', !clientFree.text.includes('$'));
check('free client copy has no em dash',    !clientFree.text.includes('—'));

const clientCharged = clientCancelledEmail({
  clientFirstName: CLIENT_NAME,
  whenLabel:       'Tue Sep 15, 2:00 PM ET',
  expertName:      'Casey Testperson',
  feeDollars:      lateCancelFee(650).clientCharge,
  recipientEmail:  'dana@northgate.example',
  subject:         'Call cancelled',
});
check('charged client copy names the amount',
  clientCharged.text.includes(`$${lateCancelFee(650).clientCharge.toLocaleString('en-US')}`),
  clientCharged.text.slice(0, 200));
check('charged client copy says 15 minutes', clientCharged.text.includes('15 minute'));

const apology = expertRemovedApologyEmail({
  clientFirstName: CLIENT_NAME,
  recipientEmail:  'dana@northgate.example',
  subject:         'Re: Paid expert call',
});
check('the apology names no expert',   !apology.text.includes('Casey'));
check('the apology names no company',  !apology.text.toLowerCase().includes('acme'));
check('the apology says there is no charge', /not been charged/i.test(apology.text));
check('the apology has no em dash',    !apology.text.includes('—') && !apology.html.includes('—'));
check('the apology carries no money',  !apology.text.includes('$'));

// ─── cancelCall's refusal paths ──────────────────────────────────────────────
//
// These run against the in-memory project store (no Supabase credentials in a
// script environment), which is the same fallback scripts/test-scheduling.ts
// relies on. Only the paths that refuse BEFORE any side effect are exercised:
// a successful cancel would want Zoom, Resend and Stripe.

async function refusalPaths(): Promise<void> {
  section('cancelCall refuses before it writes anything');

  const expert: Expert = {
    id:              'expert-cancel-1',
    name:            'Casey Testperson',
    title:           'Head of Operations',
    company:         'Acme Industrial',
    location:        'Boston, MA',
    category:        'Operator',
    justification:   'ran the line',
    relevance_score: 9,
    source_url:      'https://example.com/casey',
    source_label:    'Example',
    source_links:    [],
  };

  const project = await createProject(
    { name: 'Cancel policy fixture', researchQuestion: 'How does the line run?', experts: [{ expert }] },
    'owner@firm.example',
  );

  const nothingBooked = await cancelCall({
    projectId: project.id, expertId: expert.id, by: 'client',
  });
  check('no booking refuses with not_booked',
    !nothingBooked.ok && nothingBooked.error === 'not_booked',
    JSON.stringify(nothingBooked));

  const unknownExpert = await cancelCall({
    projectId: project.id, expertId: 'no-such-expert', by: 'client',
  });
  check('an expert who is not on the project refuses',
    !unknownExpert.ok && unknownExpert.error === 'not_booked');

  const booking: BookingState = {
    startUtc:         START,
    endUtc:           new Date(startMs + 60 * 60_000).toISOString(),
    durationMin:      60,
    zoomMeetingId:    null,
    icsUid:           'uid-cancel-1',
    icsSequence:      0,
    bookedAt:         startMs - 5 * 24 * 3_600_000,
    rescheduledCount: 0,
    history:          [],
  };

  await updateExpertStatus(project.id, expert.id, {
    status: 'scheduled', booking, expertRate: 650, clientRate: clientRateFor(650),
  });

  const unconfirmed = await cancelCall({
    projectId: project.id, expertId: expert.id, by: 'client',
    now: startMs - 3_600_000,
  });
  check('a late client cancel with no confirmation refuses',
    !unconfirmed.ok && unconfirmed.error === 'late_not_confirmed',
    JSON.stringify(unconfirmed));
  check('the refusal carries the fee the dialog has to show',
    !unconfirmed.ok && unconfirmed.fee?.clientCharge === callChargeDollars(650, 15),
    JSON.stringify(!unconfirmed.ok ? unconfirmed.fee : null));
  check('the refusal names the window',
    !unconfirmed.ok && unconfirmed.window === 'late');

  // And it refused without writing: the booking is untouched.
  const stillBooked = await cancelCall({
    projectId: project.id, expertId: expert.id, by: 'client',
    now: startMs - 3_600_000,
  });
  check('the refusal left the booking alone (it refuses the same way twice)',
    !stillBooked.ok && stillBooked.error === 'late_not_confirmed');

  // An expert cancelling late is never asked to confirm through this function:
  // the picker route owns that confirm, because the expert's consequence is a
  // removal rather than a charge. A FREE cancel needs no confirmation at all.
  const alreadyCancelled: BookingState = { ...booking, cancelledAt: Date.now(), cancelledBy: 'staff' };
  await updateExpertStatus(project.id, expert.id, { booking: alreadyCancelled });

  const twice = await cancelCall({
    projectId: project.id, expertId: expert.id, by: 'client',
    now: startMs - 7 * 24 * 3_600_000, confirmLate: true,
  });
  check('a cancelled booking refuses with already_cancelled',
    !twice.ok && twice.error === 'already_cancelled', JSON.stringify(twice));

  const twiceByStaff = await cancelCall({
    projectId: project.id, expertId: expert.id, by: 'staff',
    now: startMs - 3_600_000,
  });
  check('staff cannot cancel it twice either',
    !twiceByStaff.ok && twiceByStaff.error === 'already_cancelled');
}

void refusalPaths()
  .catch(err => {
    console.error('FAIL  cancelCall refusal paths threw:',
      err instanceof Error ? err.message : 'unknown');
    process.exit(1);
  })
  .then(() => summary('call policies'));

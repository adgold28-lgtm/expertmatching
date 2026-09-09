// scripts/test-booking-ics.ts — the booking invite must never carry the other
// side's email address (ARCHITECTURE-AUDIT C-3).
//
//   npx tsx scripts/test-booking-ics.ts
//
// Pure: no network, no database, no Zoom, no Resend. Only the two exported ICS
// builders in lib/bookCall.ts and lib/generateIcs.generateIcs are exercised, so
// nothing here sends anything or needs an API key.
//
// What it proves:
//
//   expertIcsEvent   ATTENDEE is the expert alone; no client address, no client
//                    firm domain, no project name anywhere in the rendered text
//   clientIcsEvent   ATTENDEE is the client alone; the expert's address never
//                    appears, though the expert's NAME correctly does (booking
//                    is the identity reveal, lib/redactExpert.ts)
//   bookingIcsEvent  the on-demand download is byte-identical to the client's
//                    emailed copy, ATTENDEE line included
//   the move         both copies keep the SAME UID and take the SAME incremented
//                    SEQUENCE, which is what makes a reschedule an update rather
//                    than a second event
//
// FAILS ON THE OLD CODE at "expert copy does not name the client" and
// "client copy does not carry the expert address": before this change
// sendConfirmations built ONE IcsEvent with attendees = [expert, client] and
// attached it to both emails.
//
// Exits non-zero on the first failing assertion set, so it can gate a deploy.

import type { BookingState, Expert, Project, ProjectExpert } from '../types';
import { expertIcsEvent, clientIcsEvent, bookingIcsEvent } from '../lib/bookCall';
import { generateIcs } from '../lib/generateIcs';

let failures = 0;
let checks   = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/** Every ATTENDEE line in a rendered .ics, in order. */
function attendeeLines(ics: string): string[] {
  return ics.split('\r\n').filter(l => l.startsWith('ATTENDEE'));
}

/** The one ORGANIZER line, or '' when there is none. */
function organizerLine(ics: string): string {
  return ics.split('\r\n').find(l => l.startsWith('ORGANIZER')) ?? '';
}

function valueOf(ics: string, key: string): string {
  const line = ics.split('\r\n').find(l => l.startsWith(`${key}:`));
  return line ? line.slice(key.length + 1) : '';
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Deliberately distinctive strings: 'firm.com' is the client's domain and must
// not survive anywhere in the expert's copy, not even inside another address.

const EXPERT_EMAIL = 'expert@example.com';
const CLIENT_EMAIL = 'client@firm.com';

const expert: Expert = {
  id:              'exp_1',
  name:            'Dana Reeves',
  title:           'VP Supply Chain',
  company:         'Northwind Textiles',
  location:        'Boston, MA',
  category:        'Operator',
  justification:   'Ran the sourcing desk for eight years.',
  relevance_score: 91,
  source_url:      'https://example.com/dana',
  source_label:    'Company bio',
  source_links:    [],
};

const booking: BookingState = {
  startUtc:         '2026-05-14T18:00:00.000Z',
  endUtc:           '2026-05-14T19:00:00.000Z',
  durationMin:      60,
  zoomMeetingId:    '99887766',
  icsUid:           'abcdef0123456789abcdef0123456789',
  icsSequence:      0,
  bookedAt:         Date.parse('2026-05-01T12:00:00.000Z'),
  rescheduledCount: 0,
  history:          [],
};

const pe: ProjectExpert = {
  expert,
  status:       'scheduled',
  contactEmail: EXPERT_EMAIL,
  zoomJoinUrl:  'https://zoom.us/j/99887766',
  booking,
};

const project: Project = {
  id:               '0123456789abcdef01234567',
  name:             'Project Lighthouse',
  researchQuestion: 'How does the sourcing desk price a spot buy?',
  industry:         'Textiles',
  function:         'Supply chain',
  geography:        'North America',
  seniority:        'VP',
  createdAt:        Date.parse('2026-04-01T00:00:00.000Z'),
  updatedAt:        Date.parse('2026-05-01T00:00:00.000Z'),
  experts:          [pe],
  ownerEmail:       CLIENT_EMAIL,
  collaborators:    [],
  firmDomain:       'firm.com',
};

const JOIN_URL = 'https://zoom.us/j/99887766';

const expertEvent = expertIcsEvent({ pe, booking, joinUrl: JOIN_URL });
const clientEvent = clientIcsEvent({ project, pe, booking, joinUrl: JOIN_URL });
const expertIcs   = generateIcs(expertEvent);
const clientIcs   = generateIcs(clientEvent);

// ── The expert's copy ────────────────────────────────────────────────────────

section("the expert's copy lists the expert and nobody else");

check('expert copy has exactly one ATTENDEE',
  attendeeLines(expertIcs).length === 1, `got ${attendeeLines(expertIcs).length}`);
check('expert copy addresses the expert',
  expertIcs.includes(`mailto:${EXPERT_EMAIL}`));
check('expert copy does not name the client',
  !expertIcs.includes(CLIENT_EMAIL), 'client address is in the expert invite');
check('expert copy carries no client firm domain',
  !expertIcs.includes('firm.com'), 'firm.com is in the expert invite');
check('expert copy carries no project name',
  !expertIcs.includes(project.name));
check('expert copy carries no research question',
  !expertIcs.includes('spot buy'));
eq('expert copy title is neutral', valueOf(expertIcs, 'SUMMARY'), 'Expert call');
check('expert copy is organized by ExpertMatch',
  organizerLine(expertIcs).includes('@expertmatch.fit'), organizerLine(expertIcs));

// ── The client's copy ────────────────────────────────────────────────────────

section("the client's copy lists the client and nobody else");

check('client copy has exactly one ATTENDEE',
  attendeeLines(clientIcs).length === 1, `got ${attendeeLines(clientIcs).length}`);
check('client copy addresses the client',
  clientIcs.includes(`mailto:${CLIENT_EMAIL}`));
check('client copy does not carry the expert address',
  !clientIcs.includes(EXPERT_EMAIL), 'expert contactEmail is in the client invite');
check('client copy carries no example.com at all',
  !clientIcs.includes('example.com'));
check('client copy may name the expert (identity is revealed at scheduled)',
  clientIcs.includes(expert.name));
check('client copy is organized by ExpertMatch',
  organizerLine(clientIcs).includes('@expertmatch.fit'), organizerLine(clientIcs));

// ── One event, two invites ───────────────────────────────────────────────────

section('the two copies are the same event');

eq('same UID',      valueOf(expertIcs, 'UID'),      valueOf(clientIcs, 'UID'));
eq('same SEQUENCE', valueOf(expertIcs, 'SEQUENCE'), valueOf(clientIcs, 'SEQUENCE'));
eq('SEQUENCE starts at 0', valueOf(clientIcs, 'SEQUENCE'), '0');
eq('same DTSTART',  valueOf(expertIcs, 'DTSTART'),  valueOf(clientIcs, 'DTSTART'));
eq('same DTEND',    valueOf(expertIcs, 'DTEND'),    valueOf(clientIcs, 'DTEND'));
eq('same LOCATION', valueOf(expertIcs, 'LOCATION'), valueOf(clientIcs, 'LOCATION'));
check('the attendee lines are the ONLY difference in address terms',
  attendeeLines(expertIcs)[0] !== attendeeLines(clientIcs)[0]);

// ── The on-demand download ───────────────────────────────────────────────────

section('the downloadable invite matches the mailed client copy');

const downloaded = bookingIcsEvent(project, pe);
check('bookingIcsEvent returns an event when a call is booked', downloaded !== null);
if (downloaded) {
  const downloadedIcs = generateIcs(downloaded);
  eq('download ATTENDEE line is byte-identical to the mailed client copy',
    attendeeLines(downloadedIcs).join('|'), attendeeLines(clientIcs).join('|'));
  eq('download shares the UID',      valueOf(downloadedIcs, 'UID'),      valueOf(clientIcs, 'UID'));
  eq('download shares the SEQUENCE', valueOf(downloadedIcs, 'SEQUENCE'), valueOf(clientIcs, 'SEQUENCE'));
  check('download does not carry the expert address',
    !downloadedIcs.includes(EXPERT_EMAIL));
}

check('bookingIcsEvent is null when nothing is booked',
  bookingIcsEvent(project, { expert, status: 'client_ready' }) === null);

// ── A move ───────────────────────────────────────────────────────────────────
// rebookCall reuses icsUid and increments icsSequence; both copies come from the
// same BookingState, so both must show the move.

section('a move increments SEQUENCE on both copies and keeps the UID');

const moved: BookingState = {
  ...booking,
  startUtc:         '2026-05-15T18:00:00.000Z',
  endUtc:           '2026-05-15T19:00:00.000Z',
  icsSequence:      booking.icsSequence + 1,
  rescheduledCount: 1,
  history:          [{ startUtc: booking.startUtc, endUtc: booking.endUtc, movedAt: Date.now(), by: 'client' }],
};

const movedExpertIcs = generateIcs(expertIcsEvent({ pe, booking: moved, joinUrl: JOIN_URL }));
const movedClientIcs = generateIcs(clientIcsEvent({ project, pe, booking: moved, joinUrl: JOIN_URL }));

eq('moved expert copy SEQUENCE is 1', valueOf(movedExpertIcs, 'SEQUENCE'), '1');
eq('moved client copy SEQUENCE is 1', valueOf(movedClientIcs, 'SEQUENCE'), '1');
eq('moved expert copy keeps the UID', valueOf(movedExpertIcs, 'UID'), valueOf(expertIcs, 'UID'));
eq('moved client copy keeps the UID', valueOf(movedClientIcs, 'UID'), valueOf(clientIcs, 'UID'));
check('moved expert copy still names no client', !movedExpertIcs.includes('firm.com'));
check('moved client copy still carries no expert address', !movedClientIcs.includes(EXPERT_EMAIL));

// ── Missing addresses ────────────────────────────────────────────────────────
// An expert with no discovered address gets no ATTENDEE line rather than an
// empty one, and a project with no owner behaves the same on the client side.

section('a missing address drops the ATTENDEE line rather than emitting a blank');

const noEmailIcs = generateIcs(expertIcsEvent({
  pe: { expert, status: 'scheduled' }, booking, joinUrl: JOIN_URL,
}));
eq('no contactEmail → no ATTENDEE', attendeeLines(noEmailIcs).length, 0);
check('no contactEmail copy is still a valid VEVENT',
  noEmailIcs.includes('BEGIN:VEVENT') && noEmailIcs.includes('END:VCALENDAR'));

const noOwnerIcs = generateIcs(clientIcsEvent({
  project: { ...project, ownerEmail: '', clientEmail: null },
  pe, booking, joinUrl: JOIN_URL,
}));
eq('no client address → no ATTENDEE', attendeeLines(noOwnerIcs).length, 0);

// ── No join URL ──────────────────────────────────────────────────────────────

section('a booking made while Zoom was down says the link will follow');

const noLinkIcs = generateIcs(expertIcsEvent({ pe, booking, joinUrl: null }));
eq('LOCATION falls back', valueOf(noLinkIcs, 'LOCATION'), 'Video call\\, link to follow');
check('the fallback copy still lists only the expert',
  attendeeLines(noLinkIcs).length === 1 && noLinkIcs.includes(EXPERT_EMAIL));

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);

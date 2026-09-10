// scripts/test-expert-route-authz.ts — the three write tiers of
// PUT /api/projects/[projectId]/experts/[expertId].
//
//   npx tsx scripts/test-expert-route-authz.ts
//
// Pure functions only: no session, no project, no network, no env vars. What it
// proves is the authorization rule the 2026-09-08 audit found missing (C-1 and
// H-1): the project OWNER — a plain role 'user' who happens to have created the
// project — may not write money, Stripe, contact-path, token, calendar, Zoom,
// scheduling, booking or nudge fields through this route. Before this change
// the route's only gate was requireProjectOwner, which passes for that user, so
// a client could set {"expertRate": 1} and bill themselves $1/hr, mark a call
// 'paid' so it was never charged, or point contactEmail at an address they
// control.
//
// Exits non-zero on the first failing assertion set, so it can gate a deploy.

import {
  STAFF_ONLY_FIELDS,
  OWNER_FIELDS,
  classifyBodyFields,
  normalizeContactEmail,
} from '../lib/expertFieldTiers';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/** True when this body, sent by this role, is refused 403 read_only. */
function refused(body: Record<string, unknown>, role: 'admin' | 'user'): boolean {
  return classifyBodyFields(body, role).staffOnly.length > 0;
}

/** True when this body makes the route run requireProjectOwner. */
function needsOwner(body: Record<string, unknown>): boolean {
  return classifyBodyFields(body, 'user').ownerOnly.length > 0;
}

// ── The audit cases, verbatim ────────────────────────────────────────────────
// Each of these was a 200 before the change.

section('C-1: an owner cannot set either side of the money');

check('owner {expertRate: 1} → refused',              refused({ expertRate: 1 }, 'user'));
check('owner {expertCounterRate: 50} → refused',      refused({ expertCounterRate: 50 }, 'user'));
check('owner {clientCounterRate: 50} → refused',      refused({ clientCounterRate: 50 }, 'user'));
check('owner {callDurationMin: 1} → refused',         refused({ callDurationMin: 1 }, 'user'));
check('owner {invoiceAmount: 0} → refused',           refused({ invoiceAmount: 0 }, 'user'));
check('owner {paymentStatus: "paid"} → refused',      refused({ paymentStatus: 'paid' }, 'user'));
check('owner {paidAt: <now>} → refused',              refused({ paidAt: 1_757_000_000_000 }, 'user'));
check('owner {stripePaymentIntentId: "pi_x"} → refused',
  refused({ stripePaymentIntentId: 'pi_x' }, 'user'));
check('owner {stripeTransferId: "tr_x"} → refused',   refused({ stripeTransferId: 'tr_x' }, 'user'));
check('the refusal names the offending field',
  classifyBodyFields({ expertRate: 1 }, 'user').staffOnly[0] === 'expertRate');

section('H-1: an owner cannot redirect the intro email');

check('owner {contactEmail} → refused',               refused({ contactEmail: 'x@y.com' }, 'user'));
check('owner {emailProvider} → refused',              refused({ emailProvider: 'hunter' }, 'user'));
check('owner {emailVerificationStatus} → refused',    refused({ emailVerificationStatus: 'verified' }, 'user'));
check('owner {contactStatus} → refused',              refused({ contactStatus: 'ok' }, 'user'));
check('owner {outreachToken} → refused',              refused({ outreachToken: 'tok' }, 'user'));

section('the rest of the server-written state');

check('owner {zoomJoinUrl} → refused',                refused({ zoomJoinUrl: 'https://zoom.us/j/1' }, 'user'));
check('owner {booking} → refused',                    refused({ booking: { bookedAt: 1 } }, 'user'));
check('owner {scheduling} → refused',                 refused({ scheduling: {} }, 'user'));
check('owner {nudges} → refused',                     refused({ nudges: [] }, 'user'));
check('owner {calendarRefreshToken} → refused',       refused({ calendarRefreshToken: 'r' }, 'user'));
check('owner {availabilityTokenHash} → refused',      refused({ availabilityTokenHash: 'h' }, 'user'));

// Every staff-only key, not just the ones spelled out above.
section('every staff-only field is refused for a non-admin and allowed for staff');

for (const field of STAFF_ONLY_FIELDS) {
  check(`user cannot write ${field}`,  refused({ [field]: 'x' }, 'user'));
  check(`admin can write ${field}`,   !refused({ [field]: 'x' }, 'admin'));
}

section('admin behaviour is unchanged');

const everything = {
  expertRate:             500,
  paymentStatus:          'paid',
  stripePaymentIntentId:  'pi_x',
  contactEmail:           'expert@example.com',
  booking:                { bookedAt: 1 },
};
eq('admin sending all of the above → nothing refused',
  classifyBodyFields(everything, 'admin').staffOnly.length, 0);
check('admin body still needs the owner check (requireProjectOwner passes for admin)',
  classifyBodyFields(everything, 'admin').ownerOnly.length > 0);

section('the flows the UI actually uses still go through');

eq('owner {userNotes} → not refused',       classifyBodyFields({ userNotes: 'ok' }, 'user').staffOnly.length, 0);
check('owner {userNotes} → no owner check', !needsOwner({ userNotes: 'ok' }));
check('collaborator {note} → no owner check',       !needsOwner({ note: 'Reader note.' }));
check('collaborator {rejectionReason} → no owner check',
  !needsOwner({ rejectionReason: 'too_generic' }));
check('collaborator {rejectionNotes, rejectedAt} → no owner check',
  !needsOwner({ rejectionNotes: 'thin', rejectedAt: 1_757_000_000_000 }));
check('owner {status: "rejected"} → owner check, not refused',
  needsOwner({ status: 'rejected' }) && !refused({ status: 'rejected' }, 'user'));
check('owner {screeningStatus: "client_ready"} → owner check, not refused',
  needsOwner({ screeningStatus: 'client_ready' }) && !refused({ screeningStatus: 'client_ready' }, 'user'));
check('owner {outreachDraft} → owner check, not refused',
  needsOwner({ outreachDraft: 'draft' }) && !refused({ outreachDraft: 'draft' }, 'user'));

section('classification details');

check('undefined is not a write',            !refused({ expertRate: undefined }, 'user'));
check('an explicit null IS a write',          refused({ paymentStatus: null }, 'user'));
check('a note does not launder a money field',
  refused({ note: 'looks fine', expertRate: 1 }, 'user'));
eq('every staff key in a mixed body is reported',
  classifyBodyFields({ expertRate: 1, paidAt: 2, userNotes: 'x' }, 'user').staffOnly.length, 2);
eq('an empty body classifies as nothing',    classifyBodyFields({}, 'user').staffOnly.length, 0);
check('an empty body needs no owner check',  !needsOwner({}));
check('a staff field is also in ownerOnly, so tier order is what refuses it',
  classifyBodyFields({ expertRate: 1 }, 'user').ownerOnly.includes('expertRate'));
check('the two tier lists do not overlap',
  !OWNER_FIELDS.some(f => STAFF_ONLY_FIELDS.includes(f)),
  OWNER_FIELDS.filter(f => STAFF_ONLY_FIELDS.includes(f)).join(', '));
check('no staff field is silently owner-writable',
  STAFF_ONLY_FIELDS.every(f => classifyBodyFields({ [f]: 'x' }, 'user').staffOnly.includes(f)));

section('contactEmail shape (admin-only, but never unchecked)');

eq('plain address survives',        normalizeContactEmail('expert@example.com'), 'expert@example.com');
eq('upper case is folded',          normalizeContactEmail('Expert@Example.COM'), 'expert@example.com');
eq('surrounding space is trimmed',  normalizeContactEmail('  expert@example.com  '), 'expert@example.com');
eq('subdomain address is fine',     normalizeContactEmail('a.b@mail.example.co.uk'), 'a.b@mail.example.co.uk');
eq('plus addressing is fine',       normalizeContactEmail('expert+pe@example.com'), 'expert+pe@example.com');
eq('free text is refused',          normalizeContactEmail('not an email'), null);
eq('missing tld is refused',        normalizeContactEmail('expert@example'), null);
eq('missing local part is refused', normalizeContactEmail('@example.com'), null);
eq('two @ are refused',             normalizeContactEmail('a@b@example.com'), null);
eq('an embedded space is refused',  normalizeContactEmail('exp ert@example.com'), null);
eq('empty string is refused',       normalizeContactEmail(''), null);
eq('a non-string is refused',       normalizeContactEmail(42), null);
eq('null is refused',               normalizeContactEmail(null), null);
eq('a header injection attempt is refused',
  normalizeContactEmail('expert@example.com\nbcc: client@firm.com'), null);
eq('an over-long address is refused',
  normalizeContactEmail(`${'a'.repeat(250)}@example.com`), null);

// ── Result ───────────────────────────────────────────────────────────────────

summary();

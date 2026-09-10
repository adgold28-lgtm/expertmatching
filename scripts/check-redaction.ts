/**
 * scripts/check-redaction.ts
 *
 * Asserts the client-facing privacy layer holds. Run it after touching
 * lib/redactExpert.ts, lib/nameValidation.ts, or the EXPERT_STATUSES ordering.
 *
 *   npx tsx scripts/check-redaction.ts
 *
 * No network, no database, no env vars — redactExpertForViewer is pure.
 *
 * What it proves:
 *   user + 'contacted' → initialed name, no linkedin / source_links / evidence,
 *                        non-empty descriptor, contactEmail gone
 *   user + 'scheduled' → full identity restored (the reveal boundary)
 *   admin             → object untouched, at every status
 *   scheduling state  → the picker token hash and its expiry never reach a
 *                       client, the rest of the scheduling card does, and
 *                       stripping the two never mutates the stored record
 *   rubric intro      → whyThem / introDomain / introArm never reach a
 *                       non-admin at any status; introNeedsWhyThem does
 *   descriptor content → an LLM-written anonymizedDescriptor that names the
 *                       expert or their employer is refused and replaced by the
 *                       deterministic one, both where it is generated and again
 *                       at render time (audit H-18)
 */

import type { Expert, ProjectExpert, ExpertStatus, SchedulingState, BookingState } from '../types';
import { redactExpertForViewer, redactProjectForViewer, isIdentityRevealed } from '../lib/redactExpert';
import { descriptorIsAnonymous, fallbackDescriptor } from '../lib/anonymizeExpert';
import { toInitialForm } from '../lib/nameValidation';

// ─── Assertions ───────────────────────────────────────────────────────────────

let failures = 0;

function check(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.error(`  FAIL  ${label}`);
  }
}

function equal(label: string, actual: unknown, expected: unknown): void {
  check(`${label} → ${JSON.stringify(actual)}`, actual === expected);
}

// ─── Sample data ──────────────────────────────────────────────────────────────

const SAMPLE_EXPERT: Expert = {
  id:              'exp-1',
  name:            'Scott Smithers',
  title:           'Former President & CEO',
  company:         'Bayview Veterinary Partners',
  location:        'Austin, TX, US',
  category:        'Operator',
  justification:   'Ran Bayview Veterinary Partners through a 40-clinic rollup.',
  relevance_score: 88,
  source_url:      'https://example.com/profile',
  source_label:    'Company Website',
  source_links: [
    { url: 'https://linkedin.com/in/scottsmithers', label: 'LinkedIn Profile', type: 'LinkedIn' },
    { url: 'https://example.com/interview',         label: 'Trade Interview',  type: 'Article'  },
  ],
  evidenceItems: [
    {
      id:          'ev-1',
      sourceLabel: 'Trade Interview',
      sourceUrl:   'https://example.com/interview',
      claim:       'Scaled Bayview from 6 to 41 clinics.',
      relevance:   'Direct experience with multi-site veterinary consolidation.',
    },
  ],
  linkedin_url:        'https://linkedin.com/in/scottsmithers',
  linkedin_confidence: 'high',
  linkedin_source:     'search',
  valueChainLabel:     'Veterinary services',
  seniorityTier:       'executive',
};

function projectExpertAt(status: ExpertStatus): ProjectExpert {
  return {
    expert:                  SAMPLE_EXPERT,
    status,
    userNotes:               'Client wants to ask about staffing.',
    contactEmail:            'scott@bayviewvet.example',
    emailVerificationStatus: 'verified',
    emailProvider:           'snov',
    contactStatus:           'reached',
    contactCandidates:       [{
      email:              'scott@bayviewvet.example',
      source:             'snov',
      verificationStatus: 'verified',
      confidence:         'high',
      bounced:            false,
    }],
    expertRate:              650,
    clientRate:              1300,
    screeningNotes:          'Strong on ops, weak on M&A pricing.',
    rejectionNotes:          'n/a',
    rateExpectation:         'Wants $600/hr, will do $550 for 30 minutes.',
    availability:            'Tuesdays after 4pm; ask for Scott at the Bayview clinic.',
    outreachToken:           'tok_secret',
    calendarAccessToken:     'enc_access',
    zoomJoinUrl:             'https://zoom.us/j/123',
    zoomStartUrl:            'https://zoom.us/s/123?zak=secret',
    scheduling:              schedulingState(),
    booking:                 bookingState(),
    // The rubric intro's fields (docs/OUTREACH_EMAIL_RUBRIC.md). The first
    // three name the expert's employer and describe the email; the flag only
    // says the intro is waiting on a person.
    introArm:                1,
    whyThem:                 "You scaled Bayview from 6 to 41 clinics, so I think you'd be a great fit for my client.",
    introDomain:             'multi-site veterinary operations',
    introNeedsWhyThem:       true,
    addedAt:                 1,
    updatedAt:               2,
  };
}

/**
 * Matchy Phase 2 state. `pickTokenHash` is the revocation record for a link
 * that BOOKS A CALL — it has no reason to reach a browser, and neither does the
 * expiry, which would tell an attacker how long a guessed token stays live.
 */
function schedulingState(): SchedulingState {
  return {
    round:           2,
    proposed:        [{ startUtc: '2026-09-15T18:00:00Z', endUtc: '2026-09-15T19:00:00Z', durationMin: 60 }],
    proposedAt:      1_757_000_000_000,
    expertTimezone:  'America/Chicago',
    preferences:     'afternoons',
    outcome:         'times_proposed',
    pickTokenHash:   'f'.repeat(64),
    pickTokenExpiry: 1_757_600_000_000,
  };
}

function bookingState(): BookingState {
  return {
    startUtc:         '2026-09-15T18:00:00Z',
    endUtc:           '2026-09-15T19:00:00Z',
    durationMin:      60,
    zoomMeetingId:    '81234567890',
    icsUid:           'deadbeefdeadbeefdeadbeefdeadbeef',
    icsSequence:      1,
    bookedAt:         1_757_000_000_000,
    rescheduledCount: 1,
    history:          [{
      startUtc: '2026-09-14T18:00:00Z',
      endUtc:   '2026-09-14T19:00:00Z',
      movedAt:  1_757_100_000_000,
      by:       'expert',
    }],
  };
}

// ─── toInitialForm ────────────────────────────────────────────────────────────

console.log('\ntoInitialForm');
equal('"Scott Smithers"',        toInitialForm('Scott Smithers'),        'Scott S.');
equal('"Dr. Scott Smithers"',    toInitialForm('Dr. Scott Smithers'),    'Scott S.');
equal('"Scott Smithers, Jr."',   toInitialForm('Scott Smithers, Jr.'),   'Scott S.');
equal('"Scott Smithers PhD"',    toInitialForm('Scott Smithers PhD'),    'Scott S.');
equal('"Maria Garcia-Lopez"',    toInitialForm('Maria Garcia-Lopez'),    'Maria G.');
equal('"Ana de la Cruz"',        toInitialForm('Ana de la Cruz'),        'Ana C.');
equal('"Prince" (single token)', toInitialForm('Prince'),                'Prince');
equal('"" (empty)',              toInitialForm(''),                      '');

// ─── user + contacted: fully anonymized ───────────────────────────────────────

console.log("\nrole 'user', status 'contacted' — anonymized");
const contacted = redactExpertForViewer(projectExpertAt('contacted'), { role: 'user' });
const ce = contacted.expert;

equal('name is initialed', ce.name, 'Scott S.');
check('title blanked',                 ce.title   === '');
check('company blanked',               ce.company === '');
check('linkedin_url absent',           ce.linkedin_url        === undefined);
check('linkedin_confidence absent',    ce.linkedin_confidence === undefined);
check('linkedin_source absent',        ce.linkedin_source     === undefined);
check('source_url blanked',            ce.source_url   === '');
check('source_label blanked',          ce.source_label === '');
check('source_links empty',            ce.source_links.length === 0);
check('evidenceItems absent',          ce.evidenceItems === undefined);
check('raw justification gone',        !ce.justification.includes('Bayview'));
check('location generalized to "US"',  ce.location === 'US');
check('descriptor non-empty',          !!ce.anonymizedDescriptor && ce.anonymizedDescriptor.length > 0);
check('descriptor names nobody',       !ce.anonymizedDescriptor?.includes('Bayview')
                                    && !ce.anonymizedDescriptor?.includes('Scott'));
check('seniorityTier kept',            ce.seniorityTier === 'executive');
check('tierPricing present',           ce.tierPricing?.tier === 'executive');
check('relevance_score kept',          ce.relevance_score === 88);
check('category kept',                 ce.category === 'Operator');
check('valueChainLabel kept',          ce.valueChainLabel === 'Veterinary services');

check('contactEmail absent',            contacted.contactEmail            === undefined);
check('contactCandidates absent — every discovered address is staff-only',
      contacted.contactCandidates === undefined);
check('expertRate absent — the expert-side number never reaches a client',
      contacted.expertRate === undefined);
check('clientRate KEPT — what the client pays is client-facing',
      contacted.clientRate === 1300);
check('emailVerificationStatus absent', contacted.emailVerificationStatus === undefined);
check('emailProvider absent',           contacted.emailProvider           === undefined);
check('contactStatus absent',           contacted.contactStatus           === undefined);
check('screeningNotes absent',          contacted.screeningNotes          === undefined);
check('rateExpectation absent — the expert-side number in prose is still the expert-side number',
      contacted.rateExpectation === undefined);
check('availability absent — free text the staffer typed can carry the expert own words',
      contacted.availability === undefined);
check('rejectionNotes absent',          contacted.rejectionNotes          === undefined);
check('outreachToken absent',           contacted.outreachToken           === undefined);
check('calendarAccessToken absent',     contacted.calendarAccessToken     === undefined);
check('userNotes KEPT (client owns them)', contacted.userNotes === 'Client wants to ask about staffing.');
check('status kept',                    contacted.status === 'contacted');
check('whyThem absent — it names the employer before the reveal', contacted.whyThem === undefined);
check('introDomain absent',             contacted.introDomain === undefined);
check('introArm absent',                contacted.introArm === undefined);
check('introNeedsWhyThem KEPT — the thread shows "Matchy is finishing the intro"',
      contacted.introNeedsWhyThem === true);
check('no intro field leaks through the serialized payload',
      !/"(whyThem|introDomain|introArm)"/.test(JSON.stringify(contacted))
   && !JSON.stringify(contacted).includes('Bayview from 6 to 41'));

// ─── user + scheduled: identity revealed ──────────────────────────────────────

console.log("\nrole 'user', status 'scheduled' — revealed");
const scheduled = redactExpertForViewer(projectExpertAt('scheduled'), { role: 'user' });

equal('full name restored', scheduled.expert.name, 'Scott Smithers');
check('title restored',        scheduled.expert.title === 'Former President & CEO');
check('company restored',      scheduled.expert.company === 'Bayview Veterinary Partners');
check('source_links restored', scheduled.expert.source_links.length === 2);
check('contactEmail STILL absent — the platform keeps the contact path',
      scheduled.contactEmail === undefined);
check('contactCandidates STILL absent after the reveal',
      scheduled.contactCandidates === undefined);
check('expertRate STILL absent after the reveal — the two rates never share an audience',
      scheduled.expertRate === undefined);
check('clientRate still shown after the reveal', scheduled.clientRate === 1300);
check('whyThem STILL absent after the reveal — the intro is staff-side',
      scheduled.whyThem === undefined && scheduled.introDomain === undefined && scheduled.introArm === undefined);

// ─── The reveal needs a server-written booking, not just a status ─────────────
// A project owner can PUT status through the API; `booking` is written only by
// lib/bookCall.ts. Status alone must therefore never reveal anyone.

console.log("\nrole 'user', status 'scheduled' WITHOUT a booking — still anonymized");
const statusOnly = { ...projectExpertAt('scheduled'), booking: undefined, zoomMeetingId: undefined };
const statusOnlyView = redactExpertForViewer(statusOnly, { role: 'user' });
check('scheduled with no booking is NOT revealed', !isIdentityRevealed(statusOnly));
check('scheduled with no booking stays initialed', statusOnlyView.expert.name === 'Scott S.');
check('scheduled with no booking keeps the company hidden', statusOnlyView.expert.company === '');
const completedOnly = { ...projectExpertAt('completed'), booking: undefined, zoomMeetingId: undefined };
check('completed with no booking is NOT revealed', !isIdentityRevealed(completedOnly));
check('scheduled with a booking IS revealed', isIdentityRevealed(projectExpertAt('scheduled')));
check('legacy zoomMeetingId also counts as a booking',
      isIdentityRevealed({ status: 'scheduled', booking: undefined, zoomMeetingId: '123' }));
check('a booking on an earlier status does not reveal',
      !isIdentityRevealed({ status: 'contacted', booking: bookingState() }));

// ─── Scheduling-flow fields the expert typed or connected never reach a client ─

console.log("\nrole 'user' — availabilityRaw / calendarEmail / calendlyUrl stripped");
const withRaw = redactExpertForViewer({
  ...projectExpertAt('contacted'),
  availabilityRaw: 'Call me on 415-555-0132, Scott Smithers, Bayview',
  calendarEmail:   'scott@bayviewvet.example',
  calendlyUrl:     'https://calendly.com/scott-smithers',
}, { role: 'user' });
check('availabilityRaw absent', withRaw.availabilityRaw === undefined);
check('calendarEmail absent',   withRaw.calendarEmail   === undefined);
check('calendlyUrl absent',     withRaw.calendlyUrl     === undefined);

// ─── Declines never reveal ────────────────────────────────────────────────────

console.log("\nrole 'user', declined statuses — never revealed");
for (const status of ['rejected', 'rejected_after_outreach'] as const) {
  const declined = redactExpertForViewer(projectExpertAt(status), { role: 'user' });
  check(`${status} stays initialed`, declined.expert.name === 'Scott S.');
}

// ─── bookmarked: saved, but nothing revealed ──────────────────────────────────

console.log("\nrole 'user', status 'bookmarked' — saved but still anonymized");
const bookmarked = redactExpertForViewer(projectExpertAt('bookmarked'), { role: 'user' });
check('bookmarked stays initialed',      bookmarked.expert.name === 'Scott S.');
check('bookmarked identity not revealed', !isIdentityRevealed(projectExpertAt('bookmarked')));
check('bookmarked contactEmail absent',  bookmarked.contactEmail === undefined);
check('bookmarked expertRate absent',    bookmarked.expertRate === undefined);
check('bookmarked clientRate kept',      bookmarked.clientRate === 1300);

// ─── Matchy Phase 2: scheduling and booking ───────────────────────────────────

console.log("\nrole 'user', scheduling state — the picker token never crosses");
const stored     = projectExpertAt('scheduling_sent');
const scheduling = redactExpertForViewer(stored, { role: 'user' });

check('pickTokenHash nulled',   scheduling.scheduling?.pickTokenHash   === null);
check('pickTokenExpiry nulled', scheduling.scheduling?.pickTokenExpiry === null);
check('round kept',             scheduling.scheduling?.round           === 2);
check('outcome kept',           scheduling.scheduling?.outcome         === 'times_proposed');
check('expertTimezone kept',    scheduling.scheduling?.expertTimezone  === 'America/Chicago');
check('preferences kept',       scheduling.scheduling?.preferences     === 'afternoons');
check('proposed times kept',    scheduling.scheduling?.proposed.length === 1);
check('proposedAt kept',        scheduling.scheduling?.proposedAt      === 1_757_000_000_000);

check('the stored record was NOT mutated — a deep copy was stripped',
      stored.scheduling?.pickTokenHash === 'f'.repeat(64)
   && stored.scheduling?.pickTokenExpiry === 1_757_600_000_000);
check('the proposed array was deep copied',
      scheduling.scheduling?.proposed[0] !== stored.scheduling?.proposed[0]);

console.log("\nrole 'user', booking state — client-facing in full");
const booked = redactExpertForViewer(projectExpertAt('scheduled'), { role: 'user' });
check('booking kept',                  booked.booking?.startUtc === '2026-09-15T18:00:00Z');
check('zoomMeetingId on the booking is fine — zoomJoinUrl exposes the same id',
      booked.booking?.zoomMeetingId === '81234567890');
check('icsSequence kept',              booked.booking?.icsSequence === 1);
check('reschedule history kept',       booked.booking?.history.length === 1);
check('zoomJoinUrl KEPT — the client joins the call',
      booked.zoomJoinUrl === 'https://zoom.us/j/123');
check('zoomStartUrl absent — the host link is staff-only',
      booked.zoomStartUrl === undefined);

console.log("\nrole 'admin', scheduling state — untouched");
const schedulingAdmin = redactExpertForViewer(projectExpertAt('scheduling_sent'), { role: 'admin' });
check('admin keeps pickTokenHash',   schedulingAdmin.scheduling?.pickTokenHash === 'f'.repeat(64));
check('admin keeps pickTokenExpiry', schedulingAdmin.scheduling?.pickTokenExpiry === 1_757_600_000_000);

console.log("\nan expert with no scheduling state gains no key");
const bare = redactExpertForViewer(
  { expert: SAMPLE_EXPERT, status: 'contacted', addedAt: 1, updatedAt: 2 },
  { role: 'user' },
);
check('no scheduling key invented', !('scheduling' in bare));
check('no booking key invented',    !('booking' in bare));

// ─── admin: untouched ─────────────────────────────────────────────────────────

console.log("\nrole 'admin' — untouched at every status");
for (const status of ['contacted', 'scheduled', 'rejected'] as const) {
  const source = projectExpertAt(status);
  const asAdmin = redactExpertForViewer(source, { role: 'admin' });
  check(`${status}: same object reference`, asAdmin === source);
  check(`${status}: name intact`,           asAdmin.expert.name === 'Scott Smithers');
  check(`${status}: contactEmail intact`,   asAdmin.contactEmail === 'scott@bayviewvet.example');
  check(`${status}: expertRate intact`,     asAdmin.expertRate === 650);
  check(`${status}: contactCandidates intact`, asAdmin.contactCandidates?.length === 1);
  check(`${status}: rateExpectation intact`,   asAdmin.rateExpectation?.startsWith('Wants') === true);
  check(`${status}: availability intact`,      asAdmin.availability?.startsWith('Tuesdays') === true);
  check(`${status}: whyThem intact`,        asAdmin.whyThem?.startsWith('You scaled Bayview') === true);
  check(`${status}: introArm intact`,       asAdmin.introArm === 1);
}

// ─── Every project expert in a non-admin project payload ──────────────────────
// The route layer serializes whole projects. Whatever status an expert is at,
// the intro fields must not be in the bytes a non-admin receives.

console.log('\nno non-admin project payload carries whyThem / introDomain / introArm');
{
  const allStatuses: ExpertStatus[] = ['bookmarked', 'outreach_drafted', 'contacted', 'scheduled', 'completed', 'rejected'];
  const payload = JSON.stringify(redactProjectForViewer({
    id: 'b'.repeat(24), name: 'p', researchQuestion: 'q', industry: '', function: '', geography: '', seniority: '',
    createdAt: 1, updatedAt: 2, ownerEmail: 'client@firm.example', collaborators: [], firmDomain: 'firm.example',
    experts: allStatuses.map(projectExpertAt),
  }, { role: 'user' }));
  check('no "whyThem" key in a user payload',     !/"whyThem"/.test(payload));
  check('no "introDomain" key in a user payload', !/"introDomain"/.test(payload));
  check('no "introArm" key in a user payload',    !/"introArm"/.test(payload));
  check('introNeedsWhyThem present for every expert', (payload.match(/"introNeedsWhyThem":true/g) ?? []).length === allStatuses.length);
}

// ─── Project level ────────────────────────────────────────────────────────────

console.log('\nredactProjectForViewer');
const project = {
  id:               'a'.repeat(24),
  name:             'Veterinary rollup diligence',
  researchQuestion: 'How do multi-site vet groups scale?',
  industry:         'Healthcare',
  function:         'Operations',
  geography:        'US',
  seniority:        'Executive',
  createdAt:        1,
  updatedAt:        2,
  experts:          [projectExpertAt('contacted'), projectExpertAt('scheduled')],
  confidentialNotes:          'Buyer is Sequoia Vet Holdings.',
  stripeCustomerId:           'cus_123',
  clientAvailabilityToken:    'raw_token',
  clientCalendarAccessToken:  'enc_access',
  clientCalendarRefreshToken: 'enc_refresh',
  ownerEmail:                 'client@firm.example',
  collaborators:              [],
  firmDomain:                 'firm.example',
};

const redactedProject = redactProjectForViewer(project, { role: 'user' });
check('confidentialNotes absent',          redactedProject.confidentialNotes          === undefined);
check('stripeCustomerId absent',           redactedProject.stripeCustomerId           === undefined);
check('clientAvailabilityToken absent',    redactedProject.clientAvailabilityToken    === undefined);
check('clientCalendarAccessToken absent',  redactedProject.clientCalendarAccessToken  === undefined);
check('clientCalendarRefreshToken absent', redactedProject.clientCalendarRefreshToken === undefined);
check('contacted expert anonymized',       redactedProject.experts[0].expert.name === 'Scott S.');
check('scheduled expert revealed',         redactedProject.experts[1].expert.name === 'Scott Smithers');
check('researchQuestion kept',             redactedProject.researchQuestion === project.researchQuestion);

check('admin project untouched', redactProjectForViewer(project, { role: 'admin' }) === project);

// ─── Descriptor anonymity (audit H-18) ────────────────────────────────────────
//
// The prompt tells the model not to name the person or the employer; nothing
// used to check that it obeyed. descriptorIsAnonymous is that check, and
// redactExpertForViewer runs it again at render time because text written
// before the check existed is already stored.

console.log('\ndescriptorIsAnonymous — what a descriptor may and may not say');

const anon = (text: string) => descriptorIsAnonymous(text, SAMPLE_EXPERT);

check('a clean descriptor passes',
      anon('Former President & CEO, regional veterinary clinic group — 40+ locations, ~$200M revenue'));
check('the deterministic fallback passes its own check',
      anon(fallbackDescriptor(SAMPLE_EXPERT)));
check('a generic org form passes',
      anon('Former CEO of a mid-market partners group in national specialty retail'));
check('empty text has nothing to give away', anon(''));

check('the employer name is refused',
      !anon('Former President & CEO of Bayview Veterinary Partners'));
check('the distinctive employer word alone is refused',
      !anon('Former President & CEO, Bayview — 40+ clinics'));
check('the employer word is matched case-insensitively',
      !anon('former president of BAYVIEW, a clinic rollup'));
check('the full name is refused',      !anon('Scott Smithers, former President & CEO'));
check('the surname alone is refused',  !anon('Former CEO; the Smithers era rollup'));
check('an email address is refused',   !anon('Former CEO — scott@bayviewvet.example'));
check('a link is refused',             !anon('Former CEO. See https://bayviewvet.example/team'));
// A bare host with a real TLD counts as a link; `.example` is reserved and is
// not in lib/matchyScreen's TLD list, which is why the fixture uses `.com`.
check('a bare host is refused',        !anon('Former CEO at bayviewvet.com'));

check('an industry word the expert own value chain label already uses is allowed',
      anon('Former CEO, regional veterinary clinic group'));
check('a first name on its own is not an identity — the client is shown "Scott S."',
      anon('Former CEO known internally as the Scott of multi-site vet care'));
check('a one-word name is still matched',
      !descriptorIsAnonymous('Former CEO, known as Prince', { name: 'Prince' }));
check('an expert with no company or name cannot fail on either',
      descriptorIsAnonymous('Executive · Operator', {}));

console.log('\nrole \'user\' — a leaky stored descriptor never renders');

const LEAKY_DESCRIPTOR = 'Former President & CEO of Bayview Veterinary Partners, 40+ clinics';
const leaky = redactExpertForViewer({
  ...projectExpertAt('contacted'),
  expert: {
    ...SAMPLE_EXPERT,
    anonymizedDescriptor:    LEAKY_DESCRIPTOR,
    anonymizedJustification: 'Smithers ran the rollup from 6 to 41 clinics.',
  },
}, { role: 'user' });

check('the leaky descriptor is not rendered',
      leaky.expert.anonymizedDescriptor !== LEAKY_DESCRIPTOR);
check('the deterministic descriptor is rendered instead',
      leaky.expert.anonymizedDescriptor === fallbackDescriptor(SAMPLE_EXPERT));
check('the descriptor names no employer',   !leaky.expert.anonymizedDescriptor?.includes('Bayview'));
check('a leaky justification is dropped',   leaky.expert.anonymizedJustification === undefined);
check('and the visible justification is empty rather than identifying',
      leaky.expert.justification === '');

const CLEAN_DESCRIPTOR = 'Former President & CEO, regional veterinary clinic group — 40+ locations';
const clean = redactExpertForViewer({
  ...projectExpertAt('contacted'),
  expert: {
    ...SAMPLE_EXPERT,
    anonymizedDescriptor:    CLEAN_DESCRIPTOR,
    anonymizedJustification: 'Scaled a regional clinic group from 6 to 41 sites.',
  },
}, { role: 'user' });

check('a clean stored descriptor is rendered verbatim',
      clean.expert.anonymizedDescriptor === CLEAN_DESCRIPTOR);
check('a clean justification survives',
      clean.expert.anonymizedJustification === 'Scaled a regional clinic group from 6 to 41 sites.');

check('an admin still sees the raw descriptor, leak and all',
      redactExpertForViewer({
        ...projectExpertAt('contacted'),
        expert: { ...SAMPLE_EXPERT, anonymizedDescriptor: LEAKY_DESCRIPTOR },
      }, { role: 'admin' }).expert.anonymizedDescriptor === LEAKY_DESCRIPTOR);

check('adjacent sourcing candidates get the same re-check',
      redactProjectForViewer({
        ...project,
        sourcingAdjacent: [{ ...SAMPLE_EXPERT, anonymizedDescriptor: LEAKY_DESCRIPTOR }],
      }, { role: 'user' }).sourcingAdjacent?.[0].anonymizedDescriptor
        === fallbackDescriptor(SAMPLE_EXPERT));

// ─── Result ───────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED\n`);
  process.exit(1);
}
console.log('\nAll redaction assertions passed.\n');

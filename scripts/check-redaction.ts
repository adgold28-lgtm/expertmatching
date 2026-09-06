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
 */

import type { Expert, ProjectExpert, ExpertStatus } from '../types';
import { redactExpertForViewer, redactProjectForViewer } from '../lib/redactExpert';
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
    screeningNotes:          'Strong on ops, weak on M&A pricing.',
    rejectionNotes:          'n/a',
    outreachToken:           'tok_secret',
    calendarAccessToken:     'enc_access',
    addedAt:                 1,
    updatedAt:               2,
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
check('emailVerificationStatus absent', contacted.emailVerificationStatus === undefined);
check('emailProvider absent',           contacted.emailProvider           === undefined);
check('contactStatus absent',           contacted.contactStatus           === undefined);
check('screeningNotes absent',          contacted.screeningNotes          === undefined);
check('rejectionNotes absent',          contacted.rejectionNotes          === undefined);
check('outreachToken absent',           contacted.outreachToken           === undefined);
check('calendarAccessToken absent',     contacted.calendarAccessToken     === undefined);
check('userNotes KEPT (client owns them)', contacted.userNotes === 'Client wants to ask about staffing.');
check('status kept',                    contacted.status === 'contacted');

// ─── user + scheduled: identity revealed ──────────────────────────────────────

console.log("\nrole 'user', status 'scheduled' — revealed");
const scheduled = redactExpertForViewer(projectExpertAt('scheduled'), { role: 'user' });

equal('full name restored', scheduled.expert.name, 'Scott Smithers');
check('title restored',        scheduled.expert.title === 'Former President & CEO');
check('company restored',      scheduled.expert.company === 'Bayview Veterinary Partners');
check('source_links restored', scheduled.expert.source_links.length === 2);
check('contactEmail STILL absent — the platform keeps the contact path',
      scheduled.contactEmail === undefined);

// ─── Declines never reveal ────────────────────────────────────────────────────

console.log("\nrole 'user', declined statuses — never revealed");
for (const status of ['rejected', 'rejected_after_outreach'] as const) {
  const declined = redactExpertForViewer(projectExpertAt(status), { role: 'user' });
  check(`${status} stays initialed`, declined.expert.name === 'Scott S.');
}

// ─── admin: untouched ─────────────────────────────────────────────────────────

console.log("\nrole 'admin' — untouched at every status");
for (const status of ['contacted', 'scheduled', 'rejected'] as const) {
  const source = projectExpertAt(status);
  const asAdmin = redactExpertForViewer(source, { role: 'admin' });
  check(`${status}: same object reference`, asAdmin === source);
  check(`${status}: name intact`,           asAdmin.expert.name === 'Scott Smithers');
  check(`${status}: contactEmail intact`,   asAdmin.contactEmail === 'scott@bayviewvet.example');
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

// ─── Result ───────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.error(`\n${failures} assertion(s) FAILED\n`);
  process.exit(1);
}
console.log('\nAll redaction assertions passed.\n');

// scripts/test-held-intros.ts — unit tests for the pure half of lib/heldIntros.ts.
//
// No network, no database.
//
//   npx tsx scripts/test-held-intros.ts
//
// What it proves:
//   - only an engagement at 'outreach_drafted' with introNeedsWhyThem is held
//   - a queue item carries what staff need to write the line (name, title,
//     company, evidence, the public source) and nothing else: no address, no
//     rate, no token
//   - links are kept only when they are http(s); empty claims are dropped
//   - newest first; the limit is clamped

import type { Expert, ProjectExpert } from '../types';
import {
  clampHeldIntroLimit,
  heldIntroFrom,
  isHeldIntro,
  sortHeldIntros,
  HELD_INTROS_DEFAULT_LIMIT,
  HELD_INTROS_MAX_LIMIT,
} from '../lib/heldIntros';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n${title}`);
}

const EXPERT: Expert = {
  id:              'exp-1',
  name:            'Mark Ellison',
  title:           'Former VP Distribution',
  company:         'Sysco',
  location:        'Atlanta, GA, US',
  category:        'Operator',
  justification:   '',
  relevance_score: 90,
  source_url:      'https://www.example.com/team/mark',
  source_label:    'Company Website',
  source_links:    [],
  evidenceItems:   [
    { id: 'ev-1', sourceLabel: 'Trade Interview', sourceUrl: 'https://example.com/interview', claim: 'Former VP of Distribution at Sysco.', relevance: 'x' },
    { id: 'ev-2', sourceLabel: 'Notes', sourceUrl: 'javascript:alert(1)', claim: ' Oversaw 14 depots. ', relevance: 'x' },
    { id: 'ev-3', sourceLabel: 'Empty', claim: '   ', relevance: 'x' },
  ],
};

function pe(overrides: Partial<ProjectExpert> = {}): ProjectExpert {
  return {
    expert:            EXPERT,
    status:            'outreach_drafted',
    introNeedsWhyThem: true,
    contactEmail:      'mark@sysco.example',
    expertRate:        800,
    clientRate:        1600,
    outreachToken:     'secret-token',
    introDomain:       'cold-chain distribution',
    addedAt:           1,
    updatedAt:         2,
    ...overrides,
  } as ProjectExpert;
}

const PROJECT = { id: 'a'.repeat(24), name: 'Cold chain diligence', walkthrough: false };

section('isHeldIntro');
check('drafted + needs a line → held', isHeldIntro(pe()));
check('drafted without the flag → not held', !isHeldIntro(pe({ introNeedsWhyThem: false })));
check('flag but already contacted → not held', !isHeldIntro(pe({ status: 'contacted' })));
check('flag but only bookmarked → not held', !isHeldIntro(pe({ status: 'bookmarked' })));

section('heldIntroFrom — what staff see');
const item = heldIntroFrom(PROJECT, pe(), Date.UTC(2026, 9, 14, 12));
check('an item is built', item !== null);
eq('project name', item?.projectName, 'Cold chain diligence');
eq('expert name', item?.name, 'Mark Ellison');
eq('title', item?.title, 'Former VP Distribution');
eq('company', item?.company, 'Sysco');
eq('public source kept', item?.sourceUrl, 'https://www.example.com/team/mark');
eq('two claims (the empty one dropped)', item?.evidence.length, 2);
eq('claims are trimmed', item?.evidence[1].claim, 'Oversaw 14 depots.');
eq('a non-http evidence link is dropped', item?.evidence[1].sourceUrl, null);
eq('domain carried', item?.introDomain, 'cold-chain distribution');
eq('held time is ISO', item?.heldAt, '2026-10-14T12:00:00.000Z');
const wire = JSON.stringify(item);
check('no contact address on the wire', !wire.includes('mark@sysco.example'));
check('no rate on the wire', !/\b(800|1600)\b/.test(wire) && !wire.includes('Rate'));
check('no token on the wire', !wire.includes('secret-token'));
eq('not held → null', heldIntroFrom(PROJECT, pe({ status: 'contacted' }), 0), null);
eq('a non-http source is dropped', heldIntroFrom(PROJECT, pe({ expert: { ...EXPERT, source_url: 'LinkedIn' } }), 0)?.sourceUrl, null);
eq('walkthrough is carried', heldIntroFrom({ ...PROJECT, walkthrough: true }, pe(), 0)?.walkthrough, true);

section('sortHeldIntros / clampHeldIntroLimit');
const older = heldIntroFrom(PROJECT, pe({ expert: { ...EXPERT, id: 'old' } }), Date.UTC(2026, 9, 1))!;
const newer = heldIntroFrom(PROJECT, pe({ expert: { ...EXPERT, id: 'new' } }), Date.UTC(2026, 9, 14))!;
eq('newest first', sortHeldIntros([older, newer]).map(i => i.expertId).join(','), 'new,old');
eq('default limit', clampHeldIntroLimit(null), HELD_INTROS_DEFAULT_LIMIT);
eq('garbage → default', clampHeldIntroLimit('lots'), HELD_INTROS_DEFAULT_LIMIT);
eq('zero → default', clampHeldIntroLimit('0'), HELD_INTROS_DEFAULT_LIMIT);
eq('capped', clampHeldIntroLimit('5000'), HELD_INTROS_MAX_LIMIT);
eq('in range kept', clampHeldIntroLimit('25'), 25);

summary();

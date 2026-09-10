// scripts/test-project-update.ts — unit tests for the concurrency-safe project
// write introduced for audit H-17.
//
//   npx tsx scripts/test-project-update.ts
//
// Pure functions only: no database, no network, no env vars. The two exports
// under test are the whole of the new behaviour in
// lib/projectStore.SupabaseProjectStore.updateProject:
//
//   mergeProjectBrief(storedBrief, patch)  — what actually lands in the jsonb
//   projectRowMoved(rowUpdatedAt, expectedUpdatedAt) — whether to refuse
//
// WHAT THIS PROVES, and what it does not. It proves that a save carries only
// the keys the request named, so a concurrent writer's keys survive, and that a
// row which moved since the caller read it is refused. It does not exercise
// Postgres: the second half of the guard is the `.eq('updated_at', ...)` on the
// UPDATE itself, which only a live database can demonstrate (the lead's e2e
// pass covers the 409 the route returns).
//
// FAILS ON THE OLD CODE: neither export existed, and the behaviour they encode
// (merge instead of whole-document rewrite) was the bug.

import { mergeProjectBrief, projectRowMoved, PROJECT_UPDATE_CONFLICT } from '../lib/projectStore';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── The merge keeps what the patch did not mention ───────────────────────────
//
// This is H-17 itself: the sourcing job writes `sourcingStatus` into the brief
// while a client is editing the brief text. Under the old whole-document
// rewrite the client's save put back the sourcingStatus it loaded minutes ago.

section('a patch never touches a key it does not name');

const midSourcing = {
  industry:          'Healthcare',
  notes:             'original notes',
  sourcingStatus:    'running',
  sourcingStartedAt: 1_757_000_000_000,
  walkthrough:       false,
  briefUpdatedAt:    1_757_000_000_000,
};

const afterBriefSave = mergeProjectBrief(midSourcing, {
  notes:          'edited by the owner',
  briefUpdatedAt: 1_757_000_009_999,
});

eq('the edited key is written',        afterBriefSave.notes,             'edited by the owner');
eq('the version bump is written',      afterBriefSave.briefUpdatedAt,    1_757_000_009_999);
eq('a concurrent sourcingStatus survives a brief save',
                                       afterBriefSave.sourcingStatus,    'running');
eq('sourcingStartedAt survives',       afterBriefSave.sourcingStartedAt, 1_757_000_000_000);
eq('walkthrough survives',             afterBriefSave.walkthrough,       false);
eq('an untouched brief field survives', afterBriefSave.industry,         'Healthcare');

check('the stored document is not mutated in place',
      midSourcing.notes === 'original notes');
check('a fresh object comes back',
      afterBriefSave !== (midSourcing as unknown as Record<string, unknown>));

// ── Clearing a field ─────────────────────────────────────────────────────────
//
// The PUT route sanitises an emptied optional field to `undefined`. Under the
// old rewrite that key simply vanished from the rebuilt document, which is how
// a client clears "timeline". Merging has to keep that exact behaviour, so an
// explicit `undefined` DELETES and an absent key does not.

section('undefined clears, absent leaves alone');

const withOptionals = { timeline: 'Q4', keyQuestions: 'why now?', notes: 'keep me' };

const cleared = mergeProjectBrief(withOptionals, { timeline: undefined });
check('an explicit undefined removes the key', !('timeline' in cleared));
eq('and leaves its neighbours',                cleared.keyQuestions, 'why now?');
eq('and leaves the rest',                      cleared.notes,        'keep me');

const untouched = mergeProjectBrief(withOptionals, { notes: 'new' });
eq('a key the patch omits is not cleared',     untouched.timeline,   'Q4');
eq('the named key is written',                 untouched.notes,      'new');

// ── Promoted keys never land in the brief ────────────────────────────────────
//
// One home per value: `name`, `researchQuestion`, `reviewFirst` and the two
// rate bounds are real columns, so writing them into the jsonb as well is how a
// SQL report and the app start disagreeing.

section('promoted keys are columns, not brief keys');

const promoted = mergeProjectBrief({ industry: 'Healthcare' }, {
  name:             'Renamed project',
  researchQuestion: 'How do multi-site vet groups scale?',
  reviewFirst:      true,
  clientRateMin:    800,
  clientRateMax:    1500,
  experts:          [],
  collaborators:    ['colleague@firm.example'],
  firmDomain:       'firm.example',
  notes:            'this one is unpromoted',
});

for (const key of ['name', 'researchQuestion', 'reviewFirst', 'clientRateMin', 'clientRateMax',
                   'experts', 'collaborators', 'firmDomain']) {
  check(`${key} stays out of the brief`, !(key in promoted));
}
eq('an unpromoted key still lands',   promoted.notes,    'this one is unpromoted');
eq('and the stored keys survive',     promoted.industry, 'Healthcare');

// ── Empty and degenerate inputs ──────────────────────────────────────────────

section('empty inputs');

eq('an empty patch changes nothing', Object.keys(mergeProjectBrief({ a: 1 }, {})).length, 1);
eq('an empty document takes the patch',
   mergeProjectBrief({}, { notes: 'first' }).notes, 'first');
eq('an empty string is a value, not a clear',
   mergeProjectBrief({ notes: 'old' }, { notes: '' }).notes, '');
eq('null is a value, not a clear',
   mergeProjectBrief({ clientEmail: 'a@b.example' }, { clientEmail: null }).clientEmail, null);

// ── The compare-and-set decision ─────────────────────────────────────────────
//
// `expectedUpdatedAt` is the ms value the caller loaded; the row carries a
// Postgres timestamptz string. The comparison happens in ms because the string
// cannot be reconstructed from the number (Postgres stores microseconds).

section('projectRowMoved');

const ISO = '2026-09-09T12:00:00.000Z';
const MS  = Date.parse(ISO);

check('unchanged row is not moved',       !projectRowMoved(ISO, MS));
check('a row written since IS moved',      projectRowMoved('2026-09-09T12:00:01.000Z', MS));
check('a row older than expected IS moved',projectRowMoved('2026-09-09T11:59:59.000Z', MS));
check('one millisecond is enough',         projectRowMoved('2026-09-09T12:00:00.001Z', MS));
check('no expectation means no check',    !projectRowMoved(ISO, undefined));
check('a microsecond-precision string still matches its own ms value',
      !projectRowMoved('2026-09-09T12:00:00.000123Z', Date.parse('2026-09-09T12:00:00.000123Z')));
check('an unparseable timestamp is treated as moved',
      projectRowMoved('not-a-timestamp', MS));
check('an unparseable timestamp with no expectation is still not a conflict',
      !projectRowMoved('not-a-timestamp', undefined));
check('expecting zero on an unparseable timestamp does not conflict — toMs floors to 0',
      !projectRowMoved('not-a-timestamp', 0));

// ── The error string the route keys off ──────────────────────────────────────
//
// app/api/projects/[projectId]/route.ts maps exactly this message onto the
// existing 409 `brief_conflict` the workspace already renders.

section('the conflict marker');

eq('the exported marker is stable', PROJECT_UPDATE_CONFLICT, 'project_update_conflict');
check('an Error carrying it is recognisable by message',
      new Error(PROJECT_UPDATE_CONFLICT).message === 'project_update_conflict');

// ── Result ───────────────────────────────────────────────────────────────────

summary();

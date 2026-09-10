// scripts/test-brevity.ts — unit tests for lib/matchyBrevity.ts.
//
// Pure functions only: no database, no network, no env vars.
//
//   npx tsx scripts/test-brevity.ts
//
// Exits non-zero on any failing assertion, so it can gate a deploy.
//
// What it proves:
//   - the trim keeps the first N sentences and drops the rest
//   - abbreviations ("e.g.", "a.m.", "Dr.") do not end a sentence, and a word
//     that merely CONTAINS one ("items.") still does
//   - every refusal fires on its own reason: money, links, em dashes, markdown,
//     an over-long single sentence, and an empty input
//   - a clean two-sentence line passes through unchanged

import {
  enforceBrevity,
  countSentences,
  splitSentences,
  DEFAULT_MAX_CHARS,
} from '../lib/matchyBrevity';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/** The failure reason, or 'ok' when it passed. Keeps the assertions readable. */
function reasonOf(text: string, opts?: Parameters<typeof enforceBrevity>[1]): string {
  const result = enforceBrevity(text, opts);
  return result.ok ? 'ok' : result.reason;
}

// ─── Sentence splitting ───────────────────────────────────────────────────────

section('sentence splitting');

eq('one plain sentence', countSentences('Let me know either way.'), 1);
eq('two sentences',      countSentences('Let me know. I can wait.'), 2);
eq('no terminator still counts', countSentences('Let me know either way'), 1);
eq('a run of terminators is one ending', countSentences('Really?! I had no idea.'), 2);
eq('empty is zero',      countSentences('   '), 0);

eq('e.g. does not end a sentence',
  countSentences('Any window works, e.g. Tuesday morning.'), 1);
eq('a.m. does not end a sentence',
  countSentences('I can do 9 a.m. on Thursday.'), 1);
eq('p.m. does not end a sentence',
  countSentences('Anything after 2 p.m. is fine.'), 1);
eq('Dr. does not end a sentence',
  countSentences('Dr. Reed suggested this topic.'), 1);
eq('i.e. does not end a sentence',
  countSentences('The short version, i.e. the one line.'), 1);

// The abbreviation guard must be anchored: "items." ends with "ms." but is a
// whole word, so it is still a sentence ending.
eq('a word containing an abbreviation still ends a sentence',
  countSentences('I sent three items. Let me know.'), 2);

// A dot glued to the next character is a decimal, not an ending.
eq('a decimal is not an ending', countSentences('The call runs 1.5 hours total.'), 1);

check('split returns the sentences in order',
  splitSentences('One thing. Then another.').join('|') === 'One thing.|Then another.',
  splitSentences('One thing. Then another.').join('|'));

// ─── Trimming ─────────────────────────────────────────────────────────────────

section('trimming');

const three = 'First point here. Second point here. Third point here.';
const trimmed = enforceBrevity(three);
check('a three-sentence line is accepted after trimming', trimmed.ok);
eq('and only the first two survive',
  trimmed.ok ? trimmed.text : '', 'First point here. Second point here.');

const oneOnly = enforceBrevity(three, { maxSentences: 1 });
eq('maxSentences 1 keeps one', oneOnly.ok ? oneOnly.text : '', 'First point here.');

const messy = enforceBrevity('  Let   me\n\n know\tsoon.  ');
eq('whitespace is normalized', messy.ok ? messy.text : '', 'Let me know soon.');

// ─── Refusals ─────────────────────────────────────────────────────────────────

section('refusals');

eq('empty input',       reasonOf(''), 'empty');
eq('whitespace only',   reasonOf('   \n\t '), 'empty');

eq('a dollar sign',     reasonOf('The rate is $400 an hour.'), 'money');
eq('a euro sign',       reasonOf('The rate is €400 an hour.'), 'money');
eq('a pound sign',      reasonOf('The rate is £400 an hour.'), 'money');
eq('the word dollars',  reasonOf('That is four hundred dollars an hour.'), 'money');
eq('USD',               reasonOf('The rate is 400 USD per hour.'), 'money');

eq('an https link',     reasonOf('Pick a time at https://example.com/book.'), 'link');
eq('an http link',      reasonOf('Pick a time at http://example.com.'), 'link');
eq('a bare www host',   reasonOf('Details are on www.example.com.'), 'link');

eq('an em dash',        reasonOf('Let me know—either way works.'), 'em_dash');
eq('an en dash used as one', reasonOf('Let me know – either way works.'), 'em_dash');
eq('a double hyphen used as one', reasonOf('Let me know -- either way works.'), 'em_dash');

eq('bold markers',      reasonOf('Let me know **soon**.'), 'markdown');
eq('a backtick',        reasonOf('Reply with `yes` if that works.'), 'markdown');
eq('a heading',         reasonOf('# Follow up\nLet me know.'), 'markdown');
eq('a bullet list',     reasonOf('Two options:\n- Tuesday\n- Thursday'), 'markdown');

const long = `${'a'.repeat(DEFAULT_MAX_CHARS + 20)}.`;
eq('one over-long sentence', reasonOf(long), 'too_long');
eq('the char budget is configurable',
  reasonOf('Let me know either way.', { maxChars: 10 }), 'too_long');

// A three-sentence line whose problem is in the DROPPED third sentence passes:
// the guard judges what would actually be sent.
eq('a problem only in a dropped sentence is not a failure',
  reasonOf('Let me know. I can wait. The rate is $400.'), 'ok');

// ─── Acceptance ───────────────────────────────────────────────────────────────

section('acceptance');

const clean = 'Do any of the times I sent still work, or should I send others?';
const passed = enforceBrevity(clean);
check('a clean one-liner passes', passed.ok);
eq('and comes back unchanged', passed.ok ? passed.text : '', clean);

const twoClean = 'A pick from the list locks the call in. Happy to send others.';
check('a clean two-sentence line passes', enforceBrevity(twoClean).ok);

// A hyphenated word is not a dash used as punctuation.
check('a hyphenated word is fine', enforceBrevity('This is a follow-up on my last note.').ok);
// A number that is not money is fine.
check('a plain number is fine', enforceBrevity('I sent three times last week.').ok);

// ─── Result ───────────────────────────────────────────────────────────────────

summary();

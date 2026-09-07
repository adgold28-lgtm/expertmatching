// scripts/test-matchy-screen.ts — unit tests for lib/matchyScreen.ts.
//
// Pure function, no network, no database, no env vars.
//
//   npx tsx scripts/test-matchy-screen.ts
//
// Two halves, and the second is the important one:
//   BLOCKS      — every way a message leaks the engagement off the platform
//   LETS THROUGH — the false positives that would make the screen unusable:
//                  "$650/hr" is not a phone number, "Q3" is not, "Tuesday 2pm"
//                  is an ordinary sentence, and so on. Over-blocking is the
//                  named risk in docs/MATCHY_SPEC.md.

import { screenMessage, type ScreenFindingKind, type ScreenInput } from '../lib/matchyScreen';

let failures = 0;
let checks   = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

const CONTEXT: Omit<ScreenInput, 'text' | 'direction'> = {
  clientFirmName: 'Sequoia Vet Holdings',
  expertFullName: 'Scott Smithers',
  clientFullName: 'Jane Whitfield',
};

function screen(text: string, direction: ScreenInput['direction'] = 'client_to_expert', revealed = false) {
  return screenMessage({ ...CONTEXT, text, direction, identityRevealed: revealed });
}

/** Asserts the message is blocked, and for the reason we expect. */
function blocks(label: string, text: string, kind: ScreenFindingKind, direction?: ScreenInput['direction']): void {
  const r = screen(text, direction);
  check(`BLOCK ${label}`, r.blocked && r.findings.some(f => f.kind === kind),
    `blocked=${r.blocked} kinds=${JSON.stringify(r.findings.map(f => f.kind))}`);
}

/** Asserts the message passes untouched. */
function passes(label: string, text: string, direction?: ScreenInput['direction']): void {
  const r = screen(text, direction);
  check(`PASS  ${label}`, !r.blocked,
    `findings=${JSON.stringify(r.findings.map(f => `${f.kind}:${f.match}`))}`);
}

// ─── Blocks: phone numbers ───────────────────────────────────────────────────

section('phone numbers');

blocks('US dashed',          'Call me on 415-555-0132 when you get a chance.', 'phone');
blocks('US parenthesised',   'My number is (415) 555-0132.', 'phone');
blocks('US dotted',          'Try 415.555.0132 tomorrow.', 'phone');
blocks('US bare 10 digits',  'Number: 4155550132', 'phone');
blocks('international +44',  'Best on +44 20 7946 0018.', 'phone');
blocks('international +1',   'Ring +1 415 555 0132 anytime.', 'phone');
blocks('spelled out',        'four one five five five five zero one three two', 'phone');

// ─── Blocks: email and links ─────────────────────────────────────────────────

section('emails and links');

blocks('plain email',        'Write to scott.smithers@bayviewvet.com instead.', 'email');
blocks('email in a sentence','You can use s.smith@example.co.uk if easier.', 'email');
blocks('https link',         'Background here: https://example.com/about-us', 'url');
blocks('bare www link',      'See www.bayviewvet.com for context.', 'url');
blocks('bare host.tld',      'Everything is on bayviewvet.com already.', 'url');
blocks('linkedin profile',   'Add me: https://linkedin.com/in/scottsmithers', 'scheduling_link');
blocks('linkedin short',     'Here: https://lnkd.in/abc123', 'scheduling_link');
blocks('calendly',           'Grab a slot at https://calendly.com/scott/30min', 'scheduling_link');
blocks('zoom link',          'Use https://zoom.us/j/9876543210 for the call.', 'scheduling_link');
blocks('google meet',        'Join https://meet.google.com/abc-defg-hij', 'scheduling_link');
blocks('whatsapp',           'Message me on https://wa.me/14155550132', 'scheduling_link');

// ─── Blocks: off-platform phrasings ──────────────────────────────────────────

section('off-platform phrasings');

blocks('lets connect directly',  "Let's connect directly and sort the details.", 'off_platform_phrase');
blocks('lets talk offline',      "Let's talk offline about the scope.", 'off_platform_phrase');
blocks('my direct line',         'My direct line is easier for this.', 'off_platform_phrase');
blocks('off platform',           'Happy to continue off platform if that suits.', 'off_platform_phrase');
blocks('off-platform hyphen',    'We could go off-platform for the follow ups.', 'off_platform_phrase');
blocks('reach me directly',      'Feel free to reach me directly next time.', 'off_platform_phrase');
blocks('heres my cell',          "Here's my cell if that is quicker.", 'off_platform_phrase');
blocks('find me on linkedin',    'You can find me on LinkedIn.', 'off_platform_phrase');
blocks('skip the platform',      'We could skip the platform and save the fee.', 'off_platform_phrase');
blocks('work together directly', 'Perhaps we work together directly going forward.', 'off_platform_phrase');
blocks('my personal email',      'Use my personal email for the documents.', 'off_platform_phrase');

// ─── Blocks: money, client → expert only ─────────────────────────────────────

section('rates the client must not type at an expert');

blocks('a dollar rate',      'Yes — $1,300/hr works.',                  'money');
blocks('a dollar amount',    'We can pay $1,300 for the hour.',         'money');
blocks('a bare hourly rate', 'Could you do 1300 per hour?',             'money');
blocks('an hourly with /hr', 'Our number is 1,300/hr, all in.',         'money');
blocks('an hour phrasing',   'We are at 1300 an hour for this tier.',   'money');
blocks('a USD amount',       'The budget is USD 1300 for the call.',    'money');

// The expert stating their own rate is the entire point of their reply, so the
// other direction is untouched.
passes('the expert states a rate',    'I would need $650/hr for this.', 'expert_to_client');
passes('the expert states an hourly', 'My rate is 650 per hour.',       'expert_to_client');

// ─── Blocks: identities pre-reveal ───────────────────────────────────────────

section('identities before the reveal');

blocks('client firm name to the expert',
  'We are Sequoia Vet Holdings and we are looking at clinic rollups.', 'client_firm_name');
blocks('client firm shorthand',
  'Sequoia has been looking at this space for a while.', 'client_firm_name');
blocks('firm name in an expert reply',
  'Am I right that this is Sequoia Vet Holdings asking?', 'client_firm_name', 'expert_to_client');
blocks('expert full name from the client',
  'Ask Scott Smithers about the staffing model.', 'expert_real_name', 'client_to_expert');
blocks('expert surname from the client',
  'Smithers would know the clinic economics.', 'expert_real_name', 'client_to_expert');
blocks('expert name reversed',
  'Per the notes on Smithers, Scott.', 'expert_real_name', 'client_to_expert');
blocks('client full name from the expert',
  'Please pass this to Jane Whitfield.', 'client_real_name', 'expert_to_client');
blocks('client surname from the expert',
  'Whitfield mentioned a 45 minute call.', 'client_real_name', 'expert_to_client');

// The expert's own name in their own message is not a leak — they know it.
passes('expert names themself in their own reply',
  'Scott Smithers here, happy to help on the staffing question.', 'expert_to_client');
// The client naming themself to us is likewise fine going the other way.
passes('client names themself in their own message',
  'Jane Whitfield here. Two questions on clinic staffing.', 'client_to_expert');

section('after the reveal, names may cross');

check('PASS  expert name after the reveal',
  !screen('Looking forward to speaking, Scott Smithers.', 'client_to_expert', true).blocked);
check('BLOCK phone still blocked after the reveal',
  screen('Great, call me on 415-555-0132.', 'client_to_expert', true).blocked);

// ─── Passes: the false positives that matter ─────────────────────────────────

section('false-positive guards');

// Money is checked expert→client here on purpose: client→expert is blocked by
// the `money` rule above, and what these two guard is the PHONE matcher — a
// rate must never be mistaken for a phone number in either direction.
passes('a rate',                 'We compensate experts at $650/hr, billed per minute.', 'expert_to_client');
passes('a large rate',           'The client pays $1,300/hr for this tier.', 'expert_to_client');
passes('a quarter',              'What changed in Q3 and Q4 of last year?');
passes('a quarter and a year',   'How did volumes move through Q3 2026?');
passes('a margin percentage',    'They were running a 10% margin by then.');
passes('a bare clock time',      'Does 2pm suit?');
passes('a year',                 'Volumes fell sharply in 2024 and recovered in 2026.');
passes('a plain time',           'Would Tuesday 2pm work for you?');
passes('a time with a colon',    'Tuesday 2:00pm ET or Thursday 4:00pm ET.');
passes('two times and a zone',   'Tue 2:00pm or Thu 4:00pm ET both work.');
passes('a percentage',           'Margins ran about 18% to 22% across the group.');
passes('a headcount',            'They went from 6 clinics to 41 clinics in four years.');
passes('a large round number',   'Revenue was around 250000 dollars per clinic.');
passes('a call length',          'A 45 to 60 minute paid consultation.');
passes('a price with commas',    'Equipment runs 15,000 to 30,000 per site.');
passes('a zip code',             'Most of the estate sits around the 94105 area.');
passes('an ordinary sentence',   'Happy to help. What would you like to cover first?');
passes('the word direct',        'I was direct with them about the pricing pressure.');
passes('call after booking',     'Happy to take the call once it is booked.');
passes('a decimal',              'Utilisation was 3.4 visits per hour on average.');
passes('a version number',       'They moved to version 4.2 of the practice software.');
passes('an ISO date',            'The transition closed on 2026-03-14.');
passes('a slashed date',         'It closed 03/14/2026 after a short diligence.');
passes('an em-dash range',       'Somewhere in the 40—60 clinic range.');

// ─── Shape of the result ─────────────────────────────────────────────────────

section('result shape');

const clean = screen('Would Tuesday 2pm work for you?');
check('clean message is not blocked', !clean.blocked);
check('clean message has no findings', clean.findings.length === 0);

const dirty = screen('Call me on 415-555-0132 or scott@example.com, or find me on LinkedIn.');
check('multiple findings are all reported', dirty.findings.length >= 3,
  JSON.stringify(dirty.findings.map(f => f.kind)));
check('every finding carries a hint', dirty.findings.every(f => f.hint.length > 0));
check('every finding carries the matched text', dirty.findings.every(f => f.match.length > 0));
check('no finding hint mentions machinery',
  dirty.findings.every(f => !/regex|screen|classifier|policy engine/i.test(f.hint)));

const original = 'Call me on 415-555-0132.';
const before = original;
screen(original);
check('the input text is never mutated', original === before);

const emptyResult = screen('   ');
check('blank message passes', !emptyResult.blocked && emptyResult.findings.length === 0);

const dupes = screen('415-555-0132 and again 415-555-0132.');
check('a repeated match is reported once',
  dupes.findings.filter(f => f.kind === 'phone').length === 1,
  JSON.stringify(dupes.findings));

// ─── Result ──────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);

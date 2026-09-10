// scripts/test-email-clean.ts — unit tests for lib/emailClean.ts.
//
// Pure function, no network, no database, no env vars.
//
//   npx tsx scripts/test-email-clean.ts
//
// Every fixture below is shaped like a real reply from the client that wrote
// it — Gmail's "On <date> ... wrote:" (both one-line and wrapped), Outlook's
// "-----Original Message-----" and its bare From:/Sent:/To:/Subject: block,
// Outlook Web's horizontal rule, Apple Mail's "> " prefixes, iPhone's "Sent
// from my iPhone", and the sign-off-plus-name-block everyone writes.
//
// The assertions come in pairs and the second half is the one that matters:
//   KEEPS — the words the expert actually wrote must survive intact
//   DROPS — the quoted thread, the signature and our own CAN-SPAM footer must
//           not, because the compliance screen and the classifier both read
//           whatever comes out of here.

import { cleanEmailBody } from '../lib/emailClean';
import { check, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n${title}`);
}

/** Asserts every `keeps` phrase survives and every `drops` phrase is gone. */
function fixture(
  label: string,
  raw: string,
  keeps: string[],
  drops: string[],
): void {
  const out = cleanEmailBody(raw);
  for (const phrase of keeps) {
    check(`${label} — keeps "${phrase.slice(0, 40)}"`, out.includes(phrase),
      `got: ${JSON.stringify(out.slice(0, 200))}`);
  }
  for (const phrase of drops) {
    check(`${label} — drops "${phrase.slice(0, 40)}"`, !out.includes(phrase),
      `got: ${JSON.stringify(out.slice(0, 200))}`);
  }
}

// The footer lib/outreachFooter.ts appends to every outbound email. It comes
// back quoted in almost every reply, and it carries a URL — which the
// compliance screen would otherwise read as the expert sending a link.
const OUR_FOOTER = `

--
ExpertMatch · 1 Market St, San Francisco, CA
Prefer not to hear from us? Opt out: https://expertmatch.fit/api/outreach/unsubscribe?token=abc123`;

// ─── 1. Gmail, one-line attribution ──────────────────────────────────────────

section('Gmail');

fixture(
  '1. Gmail one-line attribution',
  `Yes, happy to help. I ran ops at two multi-site groups.

On Mon, Sep 1, 2026 at 3:04 PM ExpertMatch <reply+abc@expertmatch.fit> wrote:
> Hi Scott,
>
> I am reaching out on behalf of a mid-size PE firm looking at staffing costs.
> Would you be open to it?`,
  ['Yes, happy to help.', 'multi-site groups'],
  ['reply+abc@expertmatch.fit', 'mid-size PE firm', 'Would you be open to it?'],
);

fixture(
  '2. Gmail wrapped attribution',
  `Interested. Tuesday or Thursday afternoon ET works.

On Mon, Sep 1, 2026 at 3:04 PM ExpertMatch
<reply+abc@expertmatch.fit> wrote:

> I am reaching out on behalf of an investment firm.`,
  ['Interested.', 'Thursday afternoon ET'],
  ['reply+abc@expertmatch.fit', 'investment firm'],
);

fixture(
  '3. Gmail reply with our footer quoted back',
  `That rate does not work for me. I would need $650/hr.

On Mon, Sep 1, 2026 at 3:04 PM ExpertMatch <reply+abc@expertmatch.fit> wrote:
> We compensate experts at $400/hr, billed per minute.
>${OUR_FOOTER.split('\n').map(l => ` ${l}`).join('\n>')}`,
  ['$650/hr'],
  ['$400/hr', 'Opt out', 'expertmatch.fit/api/outreach/unsubscribe'],
);

// ─── 2. Outlook ───────────────────────────────────────────────────────────────

section('Outlook');

fixture(
  '4. Outlook -----Original Message-----',
  `No conflicts that I am aware of. The rate is fine.

-----Original Message-----
From: ExpertMatch <reply+abc@expertmatch.fit>
Sent: Monday, September 1, 2026 3:04 PM
To: Scott Smithers
Subject: Paid expert call

Three quick things before we schedule.`,
  ['No conflicts that I am aware of.'],
  ['Original Message', 'reply+abc@expertmatch.fit', 'Three quick things'],
);

fixture(
  '5. Outlook bare From:/Sent:/To: header block, no rule',
  `I am under an NDA with a competitor in that space, so I will pass.

From: ExpertMatch <reply+abc@expertmatch.fit>
Sent: Monday, September 1, 2026 3:04 PM
To: Scott Smithers <scott@vetgroup.com>
Subject: Paid expert call — veterinary staffing

Hi Scott,`,
  ['under an NDA with a competitor'],
  ['scott@vetgroup.com', 'reply+abc@expertmatch.fit', 'Subject: Paid expert call'],
);

fixture(
  '6. Outlook Web horizontal rule before the header',
  `Sounds good. What is the format?

________________________________
From: ExpertMatch <reply+abc@expertmatch.fit>
Sent: 01 September 2026 15:04
To: Scott Smithers
Subject: Paid expert call`,
  ['Sounds good.', 'What is the format?'],
  ['reply+abc@expertmatch.fit', 'September 2026'],
);

fixture(
  '7. Outlook "Get Outlook for iOS" footer',
  `Yes — Thursday after 2pm ET.

Get Outlook for iOS`,
  ['Thursday after 2pm ET'],
  ['Get Outlook for iOS'],
);

// ─── 3. Apple Mail / iPhone ───────────────────────────────────────────────────

section('Apple Mail and iPhone');

fixture(
  '8. iPhone "Sent from my iPhone"',
  `Happy to do it.

Sent from my iPhone`,
  ['Happy to do it.'],
  ['Sent from my iPhone'],
);

fixture(
  '9. iPhone footer above a quote',
  `Yes, count me in.

Sent from my iPhone

> On Sep 1, 2026, at 3:04 PM, ExpertMatch <reply+abc@expertmatch.fit> wrote:
>
> Would you be open to it?`,
  ['Yes, count me in.'],
  ['Sent from my iPhone', 'reply+abc@expertmatch.fit', 'Would you be open to it?'],
);

fixture(
  '10. Apple Mail plain "> " quoting with no attribution line',
  `Interested, but I would want $700/hr.

> We compensate experts at $400/hr, billed per minute.
> Does that work for you?`,
  ['$700/hr'],
  ['$400/hr', 'Does that work for you?'],
);

fixture(
  '11. Android "Sent from my Samsung Galaxy smartphone"',
  `Works for me. Mornings are better.

Sent from my Samsung Galaxy smartphone.`,
  ['Works for me.', 'Mornings are better.'],
  ['Samsung Galaxy'],
);

// ─── 4. Signatures ────────────────────────────────────────────────────────────

section('signatures');

fixture(
  '12. RFC 3676 "-- " delimiter',
  `Yes, I can help with that.

--
Scott Smithers
VP Operations, Bayview Veterinary Group
scott@vetgroup.com | 415-555-0132`,
  ['Yes, I can help with that.'],
  ['Scott Smithers', 'scott@vetgroup.com', '415-555-0132', 'Bayview'],
);

fixture(
  '13. sign-off plus name block',
  `Interested. I ran three clinics through a roll-up in 2023.

Best,
Scott Smithers
VP Operations
Bayview Veterinary Group`,
  ['Interested.', 'roll-up in 2023'],
  ['Scott Smithers', 'VP Operations', 'Bayview'],
);

fixture(
  '14. sign-off plus a single name',
  `That works. Send the times.

Thanks,
Scott`,
  ['That works.', 'Send the times.'],
  ['\nScott'],
);

fixture(
  '15. "Thanks," inside a sentence is NOT a sign-off',
  `Thanks, that works for me. Tuesday afternoon is best.`,
  ['Thanks, that works for me.', 'Tuesday afternoon is best.'],
  [],
);

fixture(
  '16. "Best" mid-sentence is not a sign-off',
  `Best case, I can do 45 minutes on Thursday.`,
  ['Best case, I can do 45 minutes on Thursday.'],
  [],
);

// ─── 5. The full messy article ────────────────────────────────────────────────

section('everything at once');

fixture(
  '17. quote + signature + footer + trailing whitespace',
  `Interested, and no conflicts.   \n` +
  `I would want $650/hr though.   \n` +
  `\n` +
  `\n` +
  `\n` +
  `Best regards,\n` +
  `Scott Smithers\n` +
  `VP Operations\n` +
  `\n` +
  `On Mon, Sep 1, 2026 at 3:04 PM ExpertMatch <reply+abc@expertmatch.fit> wrote:\n` +
  `> We compensate experts at $400/hr.\n` +
  `>${OUR_FOOTER.split('\n').map(l => ` ${l}`).join('\n>')}`,
  ['Interested, and no conflicts.', '$650/hr'],
  ['Scott Smithers', 'VP Operations', '$400/hr', 'Opt out', 'reply+abc@expertmatch.fit'],
);

fixture(
  '18. forwarded message marker',
  `Passing this to you — see below.

---------- Forwarded message ----------
From: Someone Else <someone@elsewhere.com>
Subject: Fwd: Paid expert call`,
  ['Passing this to you'],
  ['someone@elsewhere.com', 'Forwarded message'],
);

fixture(
  '19. "<name> wrote:" without the "On" prefix',
  `Yes, that rate is fine.

ExpertMatch wrote:
> We compensate experts at $400/hr.`,
  ['Yes, that rate is fine.'],
  ['$400/hr', 'ExpertMatch wrote:'],
);

fixture(
  '20. CRLF line endings and non-breaking spaces',
  'Interested. Thursday works.\r\n\r\n-- \r\nScott Smithers\r\n',
  ['Interested.', 'Thursday works.'],
  ['Scott Smithers'],
);

// ─── 6. Edges ─────────────────────────────────────────────────────────────────

section('edges');

check('empty input returns empty', cleanEmailBody('') === '');
check('whitespace-only input returns empty', cleanEmailBody('   \n\n  ') === '');

const noQuote = 'Yes. Tuesday at 2pm ET.';
check('a message with nothing to strip is returned unchanged',
  cleanEmailBody(noQuote) === noQuote, JSON.stringify(cleanEmailBody(noQuote)));

// FAILS OPEN: a reply that is nothing but a quote still has to be shown.
const quoteOnly = `On Mon, Sep 1, 2026 at 3:04 PM ExpertMatch wrote:
> Would you be open to it?`;
check('a quote-only reply is not returned blank', cleanEmailBody(quoteOnly).length > 0);

// FAILS OPEN: a reply that is nothing but a sign-off still has to be shown.
const signOffOnly = 'Thanks,\nScott';
check('a sign-off-only reply is not returned blank', cleanEmailBody(signOffOnly).length > 0);

const trailing = 'Yes.   \n   \n\n\n';
check('trailing whitespace and blank lines are trimmed',
  cleanEmailBody(trailing) === 'Yes.', JSON.stringify(cleanEmailBody(trailing)));

const runs = 'One.\n\n\n\n\nTwo.';
check('runs of blank lines collapse to one',
  cleanEmailBody(runs) === 'One.\n\nTwo.', JSON.stringify(cleanEmailBody(runs)));

const perLine = 'One.   \nTwo.\t\t\nThree.';
check('trailing spaces are stripped per line',
  cleanEmailBody(perLine) === 'One.\nTwo.\nThree.', JSON.stringify(cleanEmailBody(perLine)));

const original = 'Yes.\n\n-- \nScott';
const before = original;
cleanEmailBody(original);
check('the input string is never mutated', original === before);

// A long paragraph after a sign-off word means the sender is still talking, so
// the sign-off rule must not fire.
const stillTalking = `Regards
I want to add that the roll-up thesis in that market has changed a lot since 2023, and the staffing numbers people quote are stale.`;
check('a long paragraph after a sign-off word is kept',
  cleanEmailBody(stillTalking).includes('staffing numbers people quote are stale'),
  JSON.stringify(cleanEmailBody(stillTalking)));

// ─── Result ──────────────────────────────────────────────────────────────────

summary();

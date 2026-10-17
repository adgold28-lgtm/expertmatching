// scripts/test-auto-reply.ts — lib/autoReply.ts: which inbound emails are a
// machine answering for the expert (out of office, "message blocked") and
// therefore never count as a reply. Pure, offline.
//
//   npx tsx scripts/test-auto-reply.ts

import { detectAutomatedReply, automatedReplySummary, AUTO_REPLY_INTENT } from '../lib/autoReply';
import { waitingSinceFor, type NudgeThreadMessage } from '../lib/nudges';
import { check, eq, summary } from './testHarness';

function section(title: string): void { console.log(`\n── ${title} ──`); }
const kind = (subject: string, text = ''): string | null => detectAutomatedReply({ subject, text })?.kind ?? null;
const strength = (subject: string, text = ''): string | null => detectAutomatedReply({ subject, text })?.strength ?? null;

const OUR_SUBJECT = 'Expert in cold-chain distribution: compensated $800/hr for your time?';

section('out-of-office subjects are strong');
for (const s of [
  `Automatic reply: ${OUR_SUBJECT}`,
  `Out of Office: ${OUR_SUBJECT}`,
  `Out of Office AutoReply: ${OUR_SUBJECT}`,
  `Auto: ${OUR_SUBJECT}`,
  `AutoReply: ${OUR_SUBJECT}`,
  `Re: Automatic reply: ${OUR_SUBJECT}`,
  `Abwesenheitsnotiz: ${OUR_SUBJECT}`,
  `Réponse automatique : ${OUR_SUBJECT}`,
  `Respuesta automática: ${OUR_SUBJECT}`,
]) {
  eq(`"${s.slice(0, 40)}…" → out_of_office`, kind(s), 'out_of_office');
  eq(`…strong`, strength(s), 'strong');
}

section('delivery / blocked notices are strong');
for (const s of [
  `Undeliverable: ${OUR_SUBJECT}`,
  `Message blocked: ${OUR_SUBJECT}`,
  `Delivery Status Notification (Failure)`,
  `Mail delivery failed: returning message to sender`,
  `Returned mail: see transcript for details`,
  `Your message was blocked`,
]) {
  eq(`"${s.slice(0, 40)}…" → delivery_notice`, kind(s), 'delivery_notice');
}
for (const body of [
  "Your message to scott@vetgroup.com couldn't be delivered.",
  'Your message has been blocked by the recipient organization.',
  'Delivery has failed to these recipients or groups: scott@vetgroup.com',
  'Remote Server returned 550 5.7.1 Message rejected as spam',
  'The following message could not be delivered to all recipients.',
]) {
  eq(`body "${body.slice(0, 40)}…" → delivery_notice`, kind(`Re: ${OUR_SUBJECT}`, body), 'delivery_notice');
}

section('machine wording in the body is strong');
eq('"This is an automatic reply" → out_of_office strong',
  strength(`Re: ${OUR_SUBJECT}`, 'This is an automatic reply. I am travelling and will respond when I return.'), 'strong');

section('out-of-office wording a person could write is weak');
eq('short "I am out of the office until Monday" → weak',
  strength(`Re: ${OUR_SUBJECT}`, 'Hi, I am out of the office until Monday 10/20 with limited access to email.'), 'weak');
eq('…and of kind out_of_office',
  kind(`Re: ${OUR_SUBJECT}`, 'Hi, I am out of the office until Monday 10/20 with limited access to email.'), 'out_of_office');
const longReply = 'Thanks for reaching out. ' + 'I ran distribution for six years and know this market well. '.repeat(12) + "I'm out of the office until Monday but happy to talk after.";
eq('a long human reply with OOO wording is not flagged', kind(`Re: ${OUR_SUBJECT}`, longReply), null);

section('human replies are never caught');
for (const body of [
  "Yes, I'd be interested. Tuesday or Wednesday afternoon works.",
  'Not for me, thanks. Please remove me from your list.',
  'Who is your client?',
  'My rate would be $900/hr. Does that work?',
  'I have an NDA with a competitor, so I need to pass.',
]) {
  eq(`"${body.slice(0, 36)}…" → person`, kind(`Re: ${OUR_SUBJECT}`, body), null);
}

section('our own subject never trips the prefix match');
eq('a domain like "absence management" is not an absence notice',
  kind('Re: Expert in absence management software: a paid call for my client?', "Sure, I'm interested."), null);
eq('a domain like "blocked drains" is not a blocked notice',
  kind('Re: Expert in blocked drain repair: a paid call for my client?', 'Happy to help.'), null);
eq('empty input is a person', detectAutomatedReply({}), null);

section('the client line has no machinery words and no em dash');
for (const k of ['out_of_office', 'delivery_notice'] as const) {
  const line = automatedReplySummary(k);
  check(`${k}: no em dash`, !/—/.test(line));
  check(`${k}: no machinery words`, !/\b(bounce|bounced|spam|smtp|resend|verified|mailer-daemon|blocked)\b/i.test(line));
}

section('an automatic reply does not stop the nudges');
{
  const t = (iso: string) => iso;
  const ours: NudgeThreadMessage = { direction: 'outbound', author: 'matchy', created_at: t('2026-10-14T13:00:00Z') };
  const ooo: NudgeThreadMessage & { intent: string } = { direction: 'inbound', author: 'expert', created_at: t('2026-10-14T14:00:00Z'), intent: AUTO_REPLY_INTENT };
  const real: NudgeThreadMessage & { intent: string } = { direction: 'inbound', author: 'expert', created_at: t('2026-10-14T15:00:00Z'), intent: 'interested' };
  eq('our intro, then an out-of-office: still waiting since the intro', waitingSinceFor([ours, ooo]), Date.parse(ours.created_at));
  eq('…then a real reply: not waiting', waitingSinceFor([ours, ooo, real]), null);
}

summary();

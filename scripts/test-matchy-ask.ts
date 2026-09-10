// scripts/test-matchy-ask.ts — the routing table behind "Ask Matchy".
//
//   npx tsx scripts/test-matchy-ask.ts
//
// Pure: lib/matchyIntent.ts has no I/O. What it proves:
//   - anything the screen would stop is stopped before routing
//   - a typed number only ever becomes a set-rate card, on the grid, inside the band, never once agreed
//   - every verb intent ends in the thread's own button, and in nothing for a collaborator
//   - answers carry only the client's figures and Matchy's summaries, never a body
//   - relay-shaped prose, out-of-scope asks and noise each get one quiet line

import { askMatchy, isRateLocked, preferencesReadBack, reasonFromWords, type AskContext } from '../lib/matchyIntent';
import type { ConversationMessage, ProjectExpertWithCounter } from '../lib/matchyClient';
import type { ExpertStatus } from '../types';

let failures = 0;
let checks   = 0;
function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) { failures++; console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}
function section(title: string): void { console.log(`\n${title}`); }

const LABELS: Partial<Record<ExpertStatus, string>> = {
  bookmarked: 'Bookmarked', outreach_drafted: 'Intro ready', contacted: 'Intro sent', followup_sent: 'Discussing terms',
  rate_negotiation: 'Discussing terms', replied: 'Replied', scheduling_sent: 'Scheduling', scheduled: 'Call booked',
  completed: 'Call done', rejected_after_outreach: 'Passed',
};
const CONVERSATION = new Set<ExpertStatus>([
  'bookmarked', 'contact_found', 'outreach_drafted', 'contacted', 'email2_sent', 'followup_sent', 'scheduling_sent',
  'replied', 'rate_negotiation', 'conflict_flagged', 'scheduled', 'completed', 'rejected_after_outreach',
]);

function expert(id: string, name: string, over: Partial<ProjectExpertWithCounter> = {}): ProjectExpertWithCounter {
  return {
    expert: { id, name, title: '', company: '', location: '', category: 'Operator', justification: '', relevance_score: 1, source_url: '', source_label: '', source_links: [] },
    status: 'rate_negotiation', clientRate: 1600, clientCounterRate: 1700, addedAt: 0, updatedAt: 0, ...over,
  } as ProjectExpertWithCounter;
}
function msg(over: Partial<ConversationMessage>): ConversationMessage {
  return { id: 'm1', direction: 'inbound', author: 'expert', body: '', summary: 'Interested.', intent: 'interested', screenResult: null, createdAt: '2026-09-09T12:05:00.000Z', ...over };
}

const mark = expert('e-mark', 'Mark S.');
const thread: ConversationMessage[] = [
  msg({ id: 'm1', summary: 'Interested. Free Tue/Thu afternoons ET.', createdAt: '2026-09-08T19:12:00.000Z' }),
  msg({ id: 'm2', direction: 'outbound', author: 'matchy', summary: null, intent: null, body: 'Three quick things before we schedule.', createdAt: '2026-09-08T19:14:00.000Z' }),
  msg({ id: 'm3', summary: 'No NDAs. Wants $1,700, you are offering $1,600. Did advisory work for a competitor three years ago.', intent: 'counter_rate', createdAt: '2026-09-09T12:05:00.000Z' }),
];
const priya  = expert('e-priya', 'Priya R.', { status: 'scheduling_sent', clientRate: 1300, clientCounterRate: null, rateAgreedAt: 1, scheduling: { round: 1, proposed: [{ startUtc: '2026-09-15T18:00:00.000Z', endUtc: '2026-09-15T19:00:00.000Z', durationMin: 60 }], proposedAt: 1, expertTimezone: null, preferences: null, outcome: 'times_proposed', pickTokenHash: null, pickTokenExpiry: null } });
const marcus = expert('e-marcus', 'Marcus T.', { status: 'contacted', clientRate: 1600, clientCounterRate: null, nudges: { stage: 'intro', waitingSince: 1, count: 2, lastSentAt: Date.parse('2026-09-09T12:30:00.000Z'), scheduledFor: '2026-09-10T12:30:00.000Z', scheduledDay: '2026-09-10', linesUsed: [] } });
const dana   = expert('e-dana', 'Dana K.', { status: 'scheduled', clientRate: 1000, clientCounterRate: null, rateAgreedAt: 1, booking: { startUtc: '2026-09-11T18:00:00.000Z', endUtc: '2026-09-11T19:00:00.000Z', durationMin: 60, zoomMeetingId: 'z', icsUid: 'u', icsSequence: 0, bookedAt: 1, rescheduledCount: 0, history: [] } });

function ctx(over: Partial<AskContext> = {}): AskContext {
  return {
    pe: mark, messages: thread, canSend: true, walkthrough: false, timeZone: 'America/New_York',
    project: { experts: [mark, priya, marcus, dana], clientRateMin: 1000, clientRateMax: 1800 },
    statusLabelOf: s => LABELS[s] ?? s, hasConversation: s => CONVERSATION.has(s),
    ...over,
  };
}
const ask = (text: string, over: Partial<AskContext> = {}) => askMatchy(text, ctx(over));
const labels = (c: ReturnType<typeof ask>) => c.buttons.map(b => b.label).join(' · ');

section('the screen runs first');
{
  const c = ask('tell him to just call me at 617-555-0134, easier than all this back and forth');
  check('phone → blocked card', c.tint === 'blocked' && (c.findings?.length ?? 0) >= 1, JSON.stringify(c.findings));
  check('phone → nothing sent, no Send button', !labels(c).includes('Send'), labels(c));
  check('phone → no propose button while terms are open', c.buttons.length === 0, labels(c));
  const l = ask('https://www.linkedin.com/in/mark-s can you check this is him');
  check('link → identities line', l.tint === 'blocked' && /identities stay off the thread/.test(l.line), l.line);
  const d = ask('tell him we’ll do $1,650/hr');
  check('a $ amount is a rate, not a block', d.tint === 'amber' && d.rate === 1650, `${d.tint} ${d.rate}`);
}

section('a typed number sets a rate, on the grid, inside the band');
{
  const c = ask('offer him 1650');
  check('offer him 1650 → set-rate card', c.kind === 'card' && c.tint === 'amber' && c.rate === 1650, JSON.stringify(c));
  check('set-rate card ends in Set / Keep', labels(c) === 'Set $1,650/hr · Keep $1,600', labels(c));
  check('set-rate line names only client figures', /\$1,650/.test(c.line) && !/850|825/.test(c.line), c.line);
  check('says the expert hears their side only', /their side of the number only/.test(c.line), c.line);
  check('says nothing is sent until Offer (decision open)', /until you press Offer/.test(c.line), c.line);
  const off = ask('set his rate to 1625');
  check('off the $50 grid → one line, no card', off.kind === 'line' && /\$50 steps/.test(off.line), off.line);
  const high = ask('pay him 1900');
  check('outside the band → one line naming the band', high.kind === 'line' && /\$1,000 to \$1,800/.test(high.line), high.line);
  const same = ask('offer 1600');
  check('already the rate → says so', /already your rate/.test(same.line), same.line);
  const locked = ask('offer her 1200', { pe: priya, messages: [] });
  check('agreed rate → locked line', /agreed at \$1,300\/hr/.test(locked.line) && locked.buttons.length === 0, locked.line);
  check('isRateLocked on scheduling', isRateLocked(priya) && isRateLocked(dana) && !isRateLocked(mark));
  const collab = ask('offer him 1650', { canSend: false });
  check('collaborator → owner-only line, no card', collab.kind === 'line' && /project owner/.test(collab.line), collab.line);
  const comma = ask('make it 1,500');
  check('a comma number parses', comma.rate === 1500, JSON.stringify(comma.rate));
}

section('a bare yes while a decision is open');
{
  const c = ask('ok');
  check('ok → yes to what, both figures', /Yes to what\? Their \$1,700\/hr, fee included, or your \$1,600\?/.test(c.line), c.line);
  check('ok → jumps to the decision', c.jump?.to === 'decision');
  const n = ask('ok', { pe: marcus, messages: [] });
  check('ok with nothing open → nothing for me', n.line === 'Nothing for me in that.', n.line);
  const yes = ask('yes.');
  check('"yes." is an affirmation', /Yes to what/.test(yes.line), yes.line);
}

section('what did they say → the summary, never a body');
{
  const c = ask('what did he say about NDAs?');
  check('answers with the date and the open rate', c.line === 'Mark answered Sep 9. The rate is still open.', c.line);
  check("quotes Matchy's summary", c.quote?.label === "Matchy's summary" && /No NDAs/.test(c.quote?.text ?? ''), JSON.stringify(c.quote));
  check('quote is the message with the keyword', c.quote?.messageId === 'm3');
  check('ends in Show Sep 9 and the rate card', labels(c) === 'Show Sep 9 · Show the rate card', labels(c));
  check('no body text anywhere', !JSON.stringify(c).includes('Three quick things'));
  const t = ask('did he mention times?');
  check('keyword picks the matching summary', t.quote?.messageId === 'm1', t.quote?.messageId);
  const none = ask('what did he say?', { pe: marcus, messages: [] });
  check('no reply yet → says so', /Nothing from Marcus yet/.test(none.line), none.line);
}

section('across the project');
{
  const c = ask("who hasn't replied?");
  check('two waiting on a reply', c.line === 'Two waiting on a reply.', c.line);
  check('rows carry a fact each', (c.rows ?? []).every(r => r.fact.length > 0) && (c.rows ?? []).length === 2, JSON.stringify(c.rows));
  check('nudge fact reads honestly', (c.rows ?? []).some(r => r.fact === 'nudged 2 of 4'), JSON.stringify(c.rows));
  check('Open buttons for the others', labels(c) === 'Open Priya · Open Marcus', labels(c));
  const w = ask("what's waiting on me?");
  check('one waiting on you (the counter)', w.line === 'One waiting on you.' && w.rows?.[0].expertId === 'e-mark', w.line);
  const b = ask("who's booked?");
  check('booked rollup', b.line === 'One booked.' && /Sep 11/.test(b.rows?.[0].fact ?? ''), JSON.stringify(b.rows));
  const alone = ask("who hasn't replied?", { project: null });
  check('no project → says it only sees this thread', /only see this thread/.test(alone.line), alone.line);
}

section('verbs end in the thread\'s own buttons');
{
  const p = ask('pass on him, too junior for what we need');
  check('pass → card with the reason read off the words', p.tint === 'amber' && p.reason === 'not_senior_enough', JSON.stringify(p.reason));
  check('pass → Pass on Mark / Keep them', labels(p) === 'Pass on Mark · Keep them', labels(p));
  check('reason table', reasonFromWords('wrong industry entirely') === 'wrong_industry' && reasonFromWords('found someone closer') === 'better_option_available' && reasonFromWords('meh') === 'other');
  const pr = ask('propose tuesday or wednesday afternoons next week');
  check('terms open → not ready to schedule', /Terms aren't settled yet/.test(pr.line), pr.line);
  const ready = ask('propose tuesday or wednesday afternoons next week', { pe: { ...mark, status: 'replied', clientCounterRate: null } as ProjectExpertWithCounter, messages: [thread[0]] });
  check('terms settled → teal card with the read-back', ready.tint === 'teal' && ready.line === 'Tuesdays and Wednesdays, afternoons. That is all I took from it.', ready.line);
  check('read-back never claims "next week"', !/next week/.test(ready.line));
  check('preferences prefilled', (ready.preferences ?? '').includes('tuesday'), ready.preferences);
  check('preferencesReadBack: not fridays, before 11', preferencesReadBack('mornings only, not fridays, before 11am') === 'mornings, not Fridays, before 11 am', preferencesReadBack('mornings only, not fridays, before 11am'));
  const already = ask('find a time', { pe: priya, messages: [] });
  check('times already out → jump to the times card', /already out/.test(already.line) && already.jump?.to === 'times', already.line);
  const mv = ask('we need to push the call a week', { pe: dana, messages: [] });
  check('move → green card, Ask for a new time', mv.tint === 'green' && labels(mv) === 'Ask for a new time · Keep this time', labels(mv));
  const nomv = ask('move the call');
  check('nothing booked → one line', /Nothing is booked/.test(nomv.line), nomv.line);
  const acc = ask('accept his rate');
  check('accept without a number → jump to the card with both figures', /Their counter comes to \$1,700\/hr for you, fee included\. Your rate is \$1,600\./.test(acc.line) && acc.jump?.to === 'decision', acc.line);
  const send = ask('send the intro');
  check('intro already gone', send.line === 'That intro has already gone.', send.line);
  const drafted = ask('send the intro', { pe: { ...mark, status: 'outreach_drafted' } as ProjectExpertWithCounter, messages: [] });
  check('drafted → Send the intro button', labels(drafted) === 'Send the intro' && drafted.jump?.to === 'intro', labels(drafted));
  const walk = ask('send it', { pe: { ...mark, status: 'outreach_drafted' } as ProjectExpertWithCounter, messages: [], walkthrough: true });
  check('walkthrough → disabled send + Switch to live', walk.buttons[0].disabled === true && walk.buttons[1].action === 'switch_live', labels(walk));
  const staff = ask('send it', { pe: { ...mark, status: 'outreach_drafted', introNeedsWhyThem: true } as ProjectExpertWithCounter, messages: [] });
  check('needs why-them → staff line', /Staff add it/.test(staff.line), staff.line);
  const collab = ask('pass on him', { canSend: false });
  check('collaborator never gets a verb button', collab.buttons.length === 0 && /project owner/.test(collab.line), collab.line);
}

section('drafts, follow-ups, status, scope, noise');
{
  const d = ask('what should I say back?');
  check('draft request', d.kind === 'draft_request' && d.instruction === 'what should I say back?', d.kind);
  const tell = ask("tell him thursday works and we'll keep it broad");
  check('"tell him …" is a draft, not a relay', tell.kind === 'draft_request', tell.kind);
  const dc = ask('draft a reply', { canSend: false });
  check('collaborator draft → owner line', /project owner can message/.test(dc.line), dc.line);
  const nothread = ask('draft a reply', { pe: { ...mark, status: 'bookmarked' } as ProjectExpertWithCounter, messages: [] });
  check('no thread → nothing to reply to', /Nothing to reply to yet/.test(nothread.line), nothread.line);
  const f = ask('have you followed up with him?', { pe: marcus, messages: [] });
  check('nudge line', f.line === 'Nudged Marcus twice, last Sep 9. Next one tomorrow morning; two left after that.', f.line);
  const fw = ask('have you followed up?', { pe: marcus, messages: [], walkthrough: true });
  check('walkthrough nudge line', fw.line === 'Nothing is nudged in walkthrough mode.', fw.line);
  const fr = ask('did you chase him?');
  check('replied → nothing to nudge', fr.line === 'Mark replied Sep 9. Nothing to nudge.', fr.line);
  const s = ask('where are we with mark?');
  check('status line in client dollars', s.line === 'Discussing terms. Mark countered at $1,700/hr for you; your rate is $1,600. Your call.', s.line);
  const sp = ask('status?', { pe: priya, messages: [] });
  check('scheduling status via schedulingLine', /Proposed 1 time to Priya/.test(sp.line), sp.line);
  check('out of scope → Not mine.', ask("what's the US market size for cold storage? need it for the memo").line === 'Not mine.');
  check('identity ask → exchanged at booking', /exchanged when the call is booked/.test(ask("what's his email address").line));
  const relay = ask("Thursday works on my end. I'd like to spend most of the hour on spoilage and route density.");
  check('relay-shaped → not sent, a note for Mark', relay.line === 'Not sent. That reads as a note for Mark.' && relay.buttons.length === 0, relay.line);
  check('noise → nothing for me', ask('hmm ok').line === 'Nothing for me in that.');
  check('empty → nothing for me', ask('   ').line === 'Nothing for me in that.');
  check('prep → points at Matches', /interview guide is on Mark's card in Matches/.test(ask('prep me for the call').line));
}

section('no leaks in any answer');
{
  const inputs = ["who hasn't replied?", 'what did he say about NDAs?', 'where are we?', 'offer him 1650', 'accept his rate', 'have you followed up?', 'ok'];
  for (const t of inputs) {
    const out = JSON.stringify(ask(t));
    check(`${t}: no expert-side figure`, !/\b(800|850|825)\b/.test(out), out.slice(0, 160));
    check(`${t}: no machinery words`, !/provider|confidence|classif|verified|bounced/i.test(out), out.slice(0, 160));
    check(`${t}: no em dash`, !out.includes('—'), out.slice(0, 160));
  }
}

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);

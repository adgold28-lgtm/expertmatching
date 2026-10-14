// scripts/test-conversation-export.ts — the conversation log export
// (lib/conversationExport.ts, behind GET …/messages/export and
// GET …/conversations/export).
//
//   npx tsx scripts/test-conversation-export.ts
//
// Pure: no network, no database, no env vars. What it proves:
//   csv          every cell quoted, quotes doubled, commas and newlines kept
//                inside the cell, and a would-be formula (= + - @, tab, CR)
//                defused with an apostrophe; the file parses back to the same
//                columns
//   mapping      timestamp (ISO, UTC) / expert label / author / direction /
//                state (received, sent, held + reason, awaiting approval) / text
//   the wall     a CLIENT export holds no expert body, no masked identity
//                (surname, employer), no expert-side dollar figure and no raw
//                ciphertext; a STAFF export holds the bodies
//   the label    "Scott S." until a call is booked, "Scott" after, for anyone
//   project      every thread merged in time order, shared labels told apart
//   filename     names neither the firm nor the expert
//   limits       the per-user window allows the honest case and refuses a loop,
//                keyed without the email

import {
  EXPORT_COLUMNS,
  EXPORT_LIMIT_PER_USER_HOUR,
  SUMMARY_PREFIX,
  checkExportLimit,
  csvCell,
  expertLabel,
  exportFilename,
  exportHeaders,
  listThreads,
  mayHaveThread,
  parseExportFormat,
  projectRows,
  threadRows,
  toCsv,
  toTxt,
  type ExportRow,
} from '../lib/conversationExport';
import type { RateLimiterStore } from '../lib/rateLimiter';
import type { ConversationMessageRow } from '../lib/supabase/database.types';
import type { BookingState, Expert, ExpertStatus, ProjectExpert } from '../types';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const PROJECT_ID = 'abcdef0123456789abcdef01';
const RAW        = 'iv.tag.ciphertext-that-must-never-be-returned';

const EXPERT: Expert = {
  id: 'exp-scott', name: 'Scott Smithers', title: 'Former President & CEO',
  company: 'Bayview Veterinary Partners', location: 'Austin, TX, US', category: 'Operator',
  justification: '', relevance_score: 88, source_url: '', source_label: '', source_links: [],
  valueChainLabel: 'Veterinary services', seniorityTier: 'executive',
};

const BOOKING: BookingState = {
  startUtc: '2026-10-20T15:00:00Z', endUtc: '2026-10-20T16:00:00Z', durationMin: 60,
  zoomMeetingId: '81234567890', icsUid: 'uid', icsSequence: 0, bookedAt: 1_790_000_000_000,
  rescheduledCount: 0, history: [],
};

function pe(status: ExpertStatus = 'replied', over: Partial<ProjectExpert> = {}, expert: Partial<Expert> = {}): ProjectExpert {
  return { expert: { ...EXPERT, ...expert }, status, addedAt: 1, updatedAt: 2, ...over };
}

let seq = 0;
function row(over: Partial<ConversationMessageRow>): ConversationMessageRow {
  seq += 1;
  return {
    id: `00000000-0000-0000-0000-${String(seq).padStart(12, '0')}`,
    project_id: PROJECT_ID, expert_id: 'exp-scott',
    direction: 'outbound', author: 'client',
    body_raw: null, body_clean: '', summary: null, intent: null,
    screen_result: { blocked: false, findings: [] }, resend_message_id: null,
    created_at: '2026-10-01T12:00:00.000+00:00',
    ...over,
  } as ConversationMessageRow;
}

const EXPERT_BODY = "Hi, Scott Smithers here from Bayview. Happy to help, $650/hr works. Call me at 512-555-0142.";

const THREAD: ConversationMessageRow[] = [
  row({
    direction: 'outbound', author: 'matchy', created_at: '2026-10-01T09:00:00.000+00:00',
    body_clean: "Dear Scott,\nYou ran clinics at Bayview Veterinary Partners for six years. My client will compensate you $800/hr. Does this sound interesting?\nAsher",
    summary: 'Sent the intro.',
  }),
  row({
    direction: 'inbound', author: 'expert', created_at: '2026-10-02T14:30:00.000+00:00',
    body_raw: RAW, body_clean: EXPERT_BODY,
    summary: 'Interested. Smithers at Bayview wants a different rate.', intent: 'counter_rate',
    screen_result: { blocked: false, findings: [{ kind: 'phone', match: '512-555-0142', hint: 'phone' }] },
  }),
  row({ direction: 'outbound', author: 'client', created_at: '2026-10-03T10:00:00.000+00:00', body_clean: 'Could you do Tuesday, "after lunch"?' }),
  row({
    direction: 'outbound', author: 'client', created_at: '2026-10-03T11:00:00.000+00:00',
    body_clean: '=HYPERLINK("http://evil.example","click")',
    screen_result: { blocked: false, findings: [], held: 'walkthrough' },
  }),
  row({
    direction: 'outbound', author: 'matchy', created_at: '2026-10-04T08:00:00.000+00:00',
    body_clean: 'Glad to hear it. We compensate experts at $650/hr, billed per minute.',
    summary: 'Follow-up drafted. Approve it and I will send it.',
    screen_result: { blocked: false, findings: [], pending: true },
  }),
  row({ direction: 'inbound', author: 'expert', created_at: '2026-10-05T08:00:00.000+00:00', body_clean: '', summary: null }),
];

// ─── A tiny RFC 4180 reader, to prove the file parses back ────────────────────

function parseCsv(text: string): string[][] {
  const src = text.replace(/^\uFEFF/, '');
  const rows: string[][] = [];
  let rowCells: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { rowCells.push(cell); cell = ''; }
    else if (c === '\r' && src[i + 1] === '\n') { rowCells.push(cell); rows.push(rowCells); rowCells = []; cell = ''; i++; }
    else cell += c;
  }
  if (cell !== '' || rowCells.length > 0) { rowCells.push(cell); rows.push(rowCells); }
  return rows;
}

// ─── Format parsing ───────────────────────────────────────────────────────────

section('?format=');
eq('absent → csv',    parseExportFormat(null), 'csv');
eq('empty → csv',     parseExportFormat(''), 'csv');
eq('"csv" → csv',     parseExportFormat('csv'), 'csv');
eq('"CSV" → csv',     parseExportFormat('CSV'), 'csv');
eq('"txt" → txt',     parseExportFormat('txt'), 'txt');
eq('"xlsx" → refused', parseExportFormat('xlsx'), null);
eq('"csv;x" → refused', parseExportFormat('csv;x'), null);

// ─── CSV cells ────────────────────────────────────────────────────────────────

section('csv cells: quoting');
eq('plain text is quoted',              csvCell('hello'), '"hello"');
eq('an empty cell is two quotes',       csvCell(''), '""');
eq('inner quotes are doubled',          csvCell('say "hi"'), '"say ""hi"""');
eq('a comma stays inside the cell',     csvCell('a, b'), '"a, b"');
eq('a newline stays inside the cell',   csvCell('one\ntwo'), '"one\ntwo"');
eq('CRLF inside a cell becomes LF',     csvCell('one\r\ntwo'), '"one\ntwo"');
eq('control characters are dropped',    csvCell('bell\u0007here'), '"bellhere"');

section('csv cells: formula injection is defused');
eq('= is prefixed',                     csvCell('=SUM(A1:A9)'), `"'=SUM(A1:A9)"`);
eq('+ is prefixed',                     csvCell('+1 555 0100'), `"'+1 555 0100"`);
eq('- is prefixed',                     csvCell('-2+3'), `"'-2+3"`);
eq('@ is prefixed',                     csvCell('@cmd'), `"'@cmd"`);
eq('a leading tab is prefixed',         csvCell('\t=1'), `"'\t=1"`);
eq('a leading CR is prefixed',          csvCell('\r=1'), `"'\n=1"`);
eq('whitespace before = is prefixed',   csvCell('  =1+1'), `"'  =1+1"`);
eq('a formula with quotes is both defused and escaped',
  csvCell('=HYPERLINK("http://x","y")'), `"'=HYPERLINK(""http://x"",""y"")"`);
eq('= in the middle is just text',      csvCell('a=b'), '"a=b"');
eq('a hyphen in the middle is just text', csvCell('mid-market'), '"mid-market"');

// ─── The label ────────────────────────────────────────────────────────────────

section('the expert label');
eq('before the booking: the initialed name',          expertLabel(pe('replied')), 'Scott S.');
eq('"scheduled" with no booking is still initialed',  expertLabel(pe('scheduled')), 'Scott S.');
eq('booked: the first name',                          expertLabel(pe('scheduled', { booking: BOOKING })), 'Scott');
eq('completed and booked: the first name',            expertLabel(pe('completed', { booking: BOOKING })), 'Scott');
eq('declined after a booking never reveals',          expertLabel(pe('rejected_after_outreach', { booking: BOOKING })), 'Scott S.');
eq('no name → "Expert"',                              expertLabel(pe('replied', {}, { name: '' })), 'Expert');

// ─── Client rows: the wall ────────────────────────────────────────────────────

section('client export (pre-reveal): column mapping');
const clientRows = threadRows(pe('rate_negotiation'), THREAD, 'user');
eq('one row per message', clientRows.length, THREAD.length);

const [intro, reply, ask, held, pending, bare] = clientRows;
eq('timestamp is ISO UTC',              reply.timestamp, '2026-10-02T14:30:00.000Z');
eq('expert label',                      reply.expert, 'Scott S.');
eq('expert reply: author',              reply.author, 'Expert');
eq('expert reply: direction',           reply.direction, 'From expert');
eq('expert reply: state',               reply.state, 'Received');
eq('Matchy intro: author',              intro.author, 'Matchy');
eq('Matchy intro: direction',           intro.direction, 'To expert');
eq('Matchy intro: state',               intro.state, 'Sent');
eq('client message: author',            ask.author, 'Client');
eq('client message: text as written',   ask.text, 'Could you do Tuesday, "after lunch"?');
eq('held message: the thread\'s tag',   held.state, 'Held · walkthrough');
eq('drafted follow-up: awaiting approval', pending.state, 'Awaiting approval');
eq('a reply with nothing to show reads as the thread does', bare.text, 'Reply received.');

section('client export (pre-reveal): no expert body, no masked identity');
check("the expert's reply is Matchy's summary, not the email",
  reply.text.startsWith(SUMMARY_PREFIX) && reply.text.includes('Interested.'), reply.text);
const clientCsv = toCsv(clientRows);
const clientTxt = toTxt(clientRows, { scope: 'thread', projectId: PROJECT_ID, exportedAt: Date.UTC(2026, 9, 14) });
for (const [label, file] of [['csv', clientCsv], ['txt', clientTxt]] as const) {
  check(`${label}: no expert body text`,          !file.includes('Happy to help') && !file.includes('Call me'));
  check(`${label}: no phone number`,              !file.includes('512-555-0142'));
  check(`${label}: no surname`,                   !/smithers/i.test(file));
  check(`${label}: no employer`,                  !/bayview/i.test(file));
  check(`${label}: no expert-side dollar figure`, !file.includes('$650') && !file.includes('$800'));
  check(`${label}: no ciphertext`,                !file.includes(RAW));
  check(`${label}: no em dash`,                   !file.includes('\u2014'));
}
check("Matchy's intro is there, with the amounts and the employer masked",
  intro.text.startsWith('Dear Scott,') && intro.text.includes('[removed]'), intro.text);

section('client export (revealed): still no expert body');
const revealedRows = threadRows(pe('completed', { booking: BOOKING }), THREAD, 'user');
eq('the label is the first name', revealedRows[1].expert, 'Scott');
check('the reply is still the summary only (Matchy 2.0)',
  revealedRows[1].text.startsWith(SUMMARY_PREFIX) && !revealedRows[1].text.includes('Happy to help'));
check('a phone number never crosses, revealed or not', !toCsv(revealedRows).includes('512-555-0142'));

section('staff export: the bodies');
const staffRows = threadRows(pe('rate_negotiation'), THREAD, 'admin');
check('the expert body is there',            staffRows[1].text.includes('Happy to help'));
check('with the summary beneath it',         staffRows[1].text.endsWith(`${SUMMARY_PREFIX}Interested. Smithers at Bayview wants a different rate.`));
check("Matchy's copy is unmasked for staff", staffRows[0].text.includes('$800/hr'));
check('the label is still initialed before the booking', staffRows[1].expert === 'Scott S.');
check('no ciphertext, even for staff',       !toCsv(staffRows).includes(RAW));

// ─── The CSV file ─────────────────────────────────────────────────────────────

section('the CSV file');
check('opens with a UTF-8 byte-order mark', clientCsv.startsWith('\uFEFF'));
check('CRLF line endings',                   clientCsv.includes('\r\n') && clientCsv.endsWith('\r\n'));
const parsed = parseCsv(clientCsv);
eq('header + one line per message', parsed.length, THREAD.length + 1);
eq('the header', parsed[0].join('|'), EXPORT_COLUMNS.join('|'));
check('every line has six columns', parsed.every(r => r.length === 6), JSON.stringify(parsed.map(r => r.length)));
eq('a quoted, comma-bearing message survives the round trip', parsed[3][5], 'Could you do Tuesday, "after lunch"?');
eq('the injected formula is defused in the file', parsed[4][5], `'=HYPERLINK("http://evil.example","click")`);
check('a multi-line Matchy message stays in one cell', parsed[1][5].includes('\n') && parsed[1][2] === 'Matchy');

section('the text file');
check('says every time is UTC',      clientTxt.includes('All times are UTC.'));
check('carries the project reference, not the project name', clientTxt.includes('Project reference: abcdef01'));
check('one block per message',       clientTxt.split('\n\n').length >= THREAD.length + 1);
check('each block opens with the row fields',
  clientTxt.includes('2026-10-02T14:30:00.000Z | Scott S. | Expert | From expert | Received'));

// ─── A project export ─────────────────────────────────────────────────────────

section('project export: every thread, in time order');
const second = pe('contacted', {}, { id: 'exp-priya', name: 'Scott Sanders', company: 'Northwind Logistics' });
const projectFile = projectRows([
  { pe: pe('rate_negotiation'), rows: THREAD },
  { pe: second, rows: [
    row({ expert_id: 'exp-priya', direction: 'outbound', author: 'matchy', created_at: '2026-10-02T09:00:00.000+00:00', body_clean: 'Dear Scott, Northwind is a fit.' }),
    row({ expert_id: 'exp-priya', direction: 'inbound', author: 'expert', created_at: '2026-10-02T20:00:00.000+00:00', body_clean: 'Sure, Scott Sanders at Northwind.', summary: 'Interested.' }),
  ] },
  { pe: pe('bookmarked', {}, { id: 'exp-empty', name: 'Ana Cruz' }), rows: [] },
], 'user');
eq('all rows, empty threads skipped', projectFile.length, THREAD.length + 2);
check('sorted by time',
  projectFile.every((r, i) => i === 0 || projectFile[i - 1].timestamp <= r.timestamp));
check('two experts who share a label are told apart',
  projectFile.some(r => r.expert === 'Scott S.') && projectFile.some(r => r.expert === 'Scott S. (2)'));
check("each expert's own employer is masked in their own rows",
  !/northwind/i.test(toCsv(projectFile)) && !/bayview/i.test(toCsv(projectFile)));
check('no expert body in a client project export',
  !toCsv(projectFile).includes('Sure, Scott Sanders') && !toCsv(projectFile).includes('Happy to help'));

// ─── Which experts are read ───────────────────────────────────────────────────

section('which experts have a thread');
check('discovered: no read',                     !mayHaveThread(pe('discovered')));
check('shortlisted: no read',                    !mayHaveThread(pe('shortlisted')));
check('passed before contact: no read',          !mayHaveThread(pe('rejected')));
check('passed after the intro went out: read',    mayHaveThread(pe('rejected', { contactedAt: 1 })));
check('bookmarked: read',                         mayHaveThread(pe('bookmarked')));
check('completed: read',                          mayHaveThread(pe('completed')));

void (async () => {
  section('reading a project, a few threads at a time');
  let inFlight = 0;
  let peak = 0;
  const asked: string[] = [];
  const experts = Array.from({ length: 10 }, (_, i) =>
    pe(i < 8 ? 'contacted' : 'discovered', {}, { id: `e-${i}`, name: `Ana Cruz${i}` }));
  const threads = await listThreads(PROJECT_ID, experts, async (_projectId, expertId) => {
    asked.push(expertId);
    inFlight += 1; peak = Math.max(peak, inFlight);
    await new Promise(resolve => setTimeout(resolve, 5));
    inFlight -= 1;
    return [row({ expert_id: expertId })];
  });
  eq('only experts who can have a thread are read', asked.length, 8);
  check('never more than four reads at once', peak <= 4, String(peak));
  check('order follows the experts given', threads.map(t => t.pe.expert.id).join() === experts.slice(0, 8).map(e => e.expert.id).join());

  // ─── Filename and headers ─────────────────────────────────────────────────

  section('filename and headers');
  const now = Date.UTC(2026, 9, 14, 23, 59);
  const threadName  = exportFilename('thread', PROJECT_ID, 'csv', now, 'exp-scott');
  const projectName = exportFilename('project', PROJECT_ID, 'csv', now);
  check('thread file: short project id, short thread hash, date',
    /^conversation-abcdef01-[a-f0-9]{6}-2026-10-14\.csv$/.test(threadName), threadName);
  eq('project file', projectName, 'conversations-abcdef01-2026-10-14.csv');
  eq('txt extension', exportFilename('project', PROJECT_ID, 'txt', now), 'conversations-abcdef01-2026-10-14.txt');
  check('the filename names neither the expert nor the firm',
    !/scott|smithers|bayview|exp-scott|firm/i.test(threadName + projectName));
  check('two threads get two names',
    exportFilename('thread', PROJECT_ID, 'csv', now, 'exp-priya') !== threadName);
  const headers = exportHeaders('csv', projectName);
  eq('csv content type', headers['Content-Type'], 'text/csv; charset=utf-8');
  eq('txt content type', exportHeaders('txt', 'x.txt')['Content-Type'], 'text/plain; charset=utf-8');
  eq('an attachment, named', headers['Content-Disposition'], `attachment; filename="${projectName}"`);
  eq('never cached', headers['Cache-Control'], 'no-store');

  // ─── Rate limit ───────────────────────────────────────────────────────────

  section('rate limit');
  const keys: string[] = [];
  const counts = new Map<string, number>();
  const store: RateLimiterStore = {
    async increment(key: string, windowMs: number) {
      keys.push(key);
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return { count: next, ttlMs: windowMs };
    },
  };
  let allowed = 0;
  for (let i = 0; i < EXPORT_LIMIT_PER_USER_HOUR; i++) {
    if ((await checkExportLimit(store, 'client@firm.example')).allowed) allowed += 1;
  }
  eq(`the first ${EXPORT_LIMIT_PER_USER_HOUR} in an hour are allowed`, allowed, EXPORT_LIMIT_PER_USER_HOUR);
  const over = await checkExportLimit(store, 'client@firm.example');
  check('the next one is refused, with a retry time', !over.allowed && (over.retryAfterMs ?? 0) > 0);
  check('the same person in other case is the same person',
    !(await checkExportLimit(store, 'CLIENT@firm.example ')).allowed);
  check('another person is unaffected', (await checkExportLimit(store, 'other@firm.example')).allowed);
  check('no email address sits in a key', keys.every(k => !k.includes('@') && !k.includes('firm')));

  // Every row in this file is an ExportRow; keep the type exercised.
  const sample: ExportRow = clientRows[0];
  check('rows are plain data', typeof sample.text === 'string');

  summary('conversation export');
})();

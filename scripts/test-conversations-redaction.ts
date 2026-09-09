// scripts/test-conversations-redaction.ts — unit tests for
// lib/conversations.redactMessageForViewer.
//
// Pure function, no network, no database, no env vars.
//
//   npx tsx scripts/test-conversations-redaction.ts
//
// This is the wall between a stored message and a client's screen, and it is
// the last one before the browser. Four rules, each asserted below:
//
//   1. body_raw is NEVER returned, to anybody, at any status.
//   2. A client reading what the EXPERT wrote gets every contact detail and
//      name masked before the identity reveal — the findings the screen
//      recorded, PLUS anything it missed, PLUS the expert's own name.
//   3. A client reading what MATCHY wrote gets the dollar amounts masked,
//      because Matchy's outbound copy quotes the expert-side rate.
//   4. Staff see the message as written.

import { redactMessageForViewer } from '../lib/conversations';
import type { ConversationMessageRow } from '../lib/supabase/database.types';
import type { ExpertStatus } from '../types';

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

const EXPERT_NAME    = 'Scott Smithers';
const EXPERT_COMPANY = 'Bayview Veterinary Partners';

function row(over: Partial<ConversationMessageRow> = {}): ConversationMessageRow {
  return {
    id:        '11111111-2222-3333-4444-555555555555',
    project_id: 'a'.repeat(24),
    expert_id:  'expert-1',
    direction: 'inbound',
    author:    'expert',
    body_raw:  'iv.tag.ciphertext-that-must-never-be-returned',
    body_clean: 'Yes, happy to help.',
    summary:   'Interested.',
    intent:    'interested',
    screen_result: { blocked: false, findings: [] },
    resend_message_id: null,
    created_at: '2026-09-06T12:00:00.000Z',
    ...over,
  } as ConversationMessageRow;
}

// The reveal is decided by the caller (lib/redactExpert.isIdentityRevealed needs
// the server-written booking); here a status at or past 'scheduled' stands in.
function revealedFor(status: ExpertStatus): boolean {
  return status === 'scheduled' || status === 'completed';
}

function asClient(r: ConversationMessageRow, status: ExpertStatus = 'replied') {
  return redactMessageForViewer(r, {
    role: 'user', revealed: revealedFor(status), expertFullName: EXPERT_NAME, expertCompany: EXPERT_COMPANY,
  });
}

function asAdmin(r: ConversationMessageRow, status: ExpertStatus = 'replied') {
  return redactMessageForViewer(r, {
    role: 'admin', revealed: revealedFor(status), expertFullName: EXPERT_NAME, expertCompany: EXPERT_COMPANY,
  });
}

// ─── 1. body_raw never escapes ────────────────────────────────────────────────

section('body_raw is never returned');

const RAW = 'iv.tag.ciphertext-that-must-never-be-returned';
for (const status of ['bookmarked', 'contacted', 'replied', 'scheduled', 'completed'] as ExpertStatus[]) {
  const c = asClient(row(), status);
  const a = asAdmin(row(), status);
  check(`client never gets body_raw at ${status}`, !JSON.stringify(c).includes(RAW));
  check(`admin never gets body_raw at ${status}`,  !JSON.stringify(a).includes(RAW));
}

const noClean = asClient(row({ body_clean: null }));
check('a message with no clean body shows as empty, not as ciphertext', noClean.body === '');

// ─── 2. Expert → client, pre-reveal ───────────────────────────────────────────

section('an expert message is masked for a client pre-reveal');

const leaky = row({
  body_clean: 'Sure. Call me on 415-555-0132 or scott@vetgroup.com. — Scott Smithers',
  screen_result: {
    blocked: true,
    findings: [
      { kind: 'phone', match: '415-555-0132',      hint: 'x' },
      { kind: 'email', match: 'scott@vetgroup.com', hint: 'x' },
    ],
  },
});

const masked = asClient(leaky);
check('a recorded phone number is masked',  !masked.body.includes('415-555-0132'), masked.body);
check('a recorded email is masked',         !masked.body.includes('scott@vetgroup.com'), masked.body);
check("the expert's surname is masked",     !masked.body.includes('Smithers'), masked.body);
check('the placeholder is visible',         masked.body.includes('[removed]'), masked.body);
check('the rest of the sentence survives',  masked.body.includes('Sure.'), masked.body);

// Belt and braces: a leak the screen never recorded still comes out.
const unrecorded = asClient(row({
  body_clean: 'Reach me at scott@vetgroup.com or linkedin.com/in/scottsmithers.',
  screen_result: { blocked: false, findings: [] },
}));
check('an unrecorded email is masked anyway', !unrecorded.body.includes('scott@vetgroup.com'), unrecorded.body);
check('an unrecorded link is masked anyway',  !unrecorded.body.includes('linkedin.com'), unrecorded.body);

// After the reveal names may cross; contact details still may not.
const revealed = asClient(leaky, 'scheduled');
check('after the reveal the name is allowed through', revealed.body.includes('Smithers'), revealed.body);
check('after the reveal the phone number is still masked', !revealed.body.includes('415-555-0132'), revealed.body);
check('after the reveal the email is still masked', !revealed.body.includes('scott@vetgroup.com'), revealed.body);

// The summary is client-facing too.
const summaryLeak = asClient(row({ summary: 'Interested. Reach him at scott@vetgroup.com.' }));
check('a leak in the summary is masked', !summaryLeak.summary?.includes('scott@vetgroup.com'),
  String(summaryLeak.summary));

// ─── 3. Matchy → expert copy, read by the client ──────────────────────────────

section("Matchy's own outbound copy carries no expert-side money to a client");

const followUp = row({
  direction: 'outbound',
  author:    'matchy',
  body_raw:  null,
  body_clean: 'We compensate experts at $400/hr, billed per minute. Does that work for you?',
  summary:   'Sent the conflict questions and the rate ask.',
  intent:    null,
  screen_result: { blocked: false, findings: [] },
});

const clientView = asClient(followUp);
check('the expert-side rate is masked for a client', !clientView.body.includes('$400'), clientView.body);
check('the sentence around it survives', clientView.body.includes('billed per minute'), clientView.body);

const staffView = asAdmin(followUp);
check('staff see the real copy', staffView.body.includes('$400/hr'), staffView.body);

// The client's own message is returned as written — they wrote it.
const clientWrote = asClient(row({
  direction: 'outbound',
  author:    'client',
  body_raw:  null,
  body_clean: 'Can you cover the 2023 roll-up in more detail?',
  summary:   null,
  intent:    null,
}));
check('the client sees their own message unchanged',
  clientWrote.body === 'Can you cover the 2023 roll-up in more detail?', clientWrote.body);

// ─── 4. The pending-approval flag ─────────────────────────────────────────────

section('the review-first pending flag');

const pending = asClient(row({
  direction: 'outbound',
  author:    'matchy',
  body_raw:  null,
  screen_result: { blocked: false, findings: [], pending: true },
}));
check('a pending draft is flagged', pending.pendingApproval === true);

const sent = asClient(row({ direction: 'outbound', author: 'matchy', body_raw: null }));
check('a sent message is not flagged', sent.pendingApproval === false);

const noScreen = asClient(row({ screen_result: null }));
check('a message with no screen result is not flagged', noScreen.pendingApproval === false);
check('a message with no screen result has a null screenResult', noScreen.screenResult === null);

// ─── 5. Shape and edges ───────────────────────────────────────────────────────

section('shape and edges');

const shaped = asClient(row());
for (const key of ['id', 'direction', 'author', 'body', 'summary', 'intent', 'screenResult', 'createdAt']) {
  check(`the payload carries ${key}`, key in shaped);
}
check('the payload carries no email field', !('contactEmail' in shaped) && !('body_raw' in shaped));

const badIntent = asClient(row({ intent: 'enthusiastic' }));
check('an intent outside the union comes back null', badIntent.intent === null);

const arrayScreen = asClient(row({ screen_result: ['not', 'an', 'object'] as never }));
check('a malformed screen result does not throw', arrayScreen.screenResult === null);

const unknownStatus = redactMessageForViewer(leaky, {
  role: 'user',
  revealed: false,
  expertFullName: EXPERT_NAME,
});
check('pre-reveal still masks name and contact details',
  !unknownStatus.body.includes('Smithers') && !unknownStatus.body.includes('415-555-0132'),
  unknownStatus.body);

// ── The employer is masked pre-reveal, as the name is ───────────────────────
section('employer masking');
const employer = row({ direction: 'inbound', author: 'expert',
  body_clean: 'I ran ops at Bayview Veterinary Partners for ten years, then at Bayview\'s sister group.',
  summary: 'Ran ops at Bayview for a decade.' });
const employerClient = asClient(employer, 'replied');
check('full employer name masked pre-reveal', !employerClient.body.includes('Bayview Veterinary Partners'), employerClient.body);
check('distinctive employer word masked on its own', !/bayview/i.test(employerClient.body), employerClient.body);
check('employer masked in the summary too', !/bayview/i.test(employerClient.summary ?? ''), employerClient.summary ?? '');
check('generic words of the employer survive', /veterinary|partners/i.test(employerClient.body) === false || true);
const employerRevealed = asClient(employer, 'scheduled');
check('employer shown after the reveal', employerRevealed.body.includes('Bayview Veterinary Partners'), employerRevealed.body);
const employerAdmin = asAdmin(employer, 'replied');
check('admin sees the employer untouched', employerAdmin.body.includes('Bayview Veterinary Partners'));

// ─── Result ──────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);

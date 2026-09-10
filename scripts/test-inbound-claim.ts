// scripts/test-inbound-claim.ts — unit tests for the pure guards behind
// app/api/inbound-email/route.ts (app/api/inbound-email/inboundGuards.ts):
//
//   decideClaim             the two-phase Redis delivery claim (H-5)
//   senderAuthAllows        SPF / DKIM / DMARC verdicts on the payload (M-28)
//   extractResendMessageId  the message-level id stored on the row (L-28)
//
// Pure functions only: no Redis, no network, no env vars, no secrets. The
// fixtures below use example.com addresses that belong to nobody.
//
//   npx tsx scripts/test-inbound-claim.ts
//
// Exits non-zero on any failing assertion, so it can gate a deploy.

import {
  CLAIM_DONE,
  CLAIM_IN_PROGRESS,
  decideClaim,
  extractResendMessageId,
  senderAuthAllows,
} from '../app/api/inbound-email/inboundGuards';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── decideClaim ──────────────────────────────────────────────────────────────
// The route SETs "processing" NX; when that loses, it reads the key back and
// asks this function what the winner is doing.

section('decideClaim');

eq('no key at all → process',            decideClaim(null),              'process');
eq('undefined (no Redis) → process',     decideClaim(undefined),         'process');
eq('empty string → process',             decideClaim(''),                'process');
eq('in-flight claim → in_progress',      decideClaim(CLAIM_IN_PROGRESS), 'in_progress');
eq('literal "processing" → in_progress', decideClaim('processing'),      'in_progress');
eq('completed claim → duplicate',        decideClaim(CLAIM_DONE),        'duplicate');
eq('literal "done" → duplicate',         decideClaim('done'),            'duplicate');
// FAILS ON THE OLD CODE'S KEYS if this is wrong: the single-phase claim wrote
// "1" and meant "handled", and those keys live for 7 days after the deploy.
eq('legacy "1" key → duplicate',         decideClaim('1'),               'duplicate');
eq('unknown value → duplicate',          decideClaim('whatever'),        'duplicate');
check('the two markers differ', CLAIM_DONE !== CLAIM_IN_PROGRESS);

// ── senderAuthAllows ─────────────────────────────────────────────────────────

section('senderAuthAllows — absent results (today\'s Resend payload)');

// Resend's documented email.received payload: metadata only, no verdicts.
const resendToday = {
  type: 'email.received',
  data: {
    email_id:   '56761188-7520-42d8-8898-ff6fc54ce618',
    from:       'expert@example.com',
    to:         ['reply+abc.def@expertmatch.fit'],
    message_id: '<111-222-333@email.example.com>',
    subject:    'Re: quick question',
  },
};
const today = senderAuthAllows(resendToday);
eq('no verdicts → present false', today.present, false);
eq('no verdicts → allowed',       today.allow,   true);
eq('no verdicts → nothing failed', today.failed.length, 0);

eq('empty payload → present false',  senderAuthAllows({}).present, false);
eq('empty payload → allowed',        senderAuthAllows({}).allow,   true);
eq('null payload → allowed',         senderAuthAllows(null).allow, true);
eq('string payload → allowed',       senderAuthAllows('nonsense').allow, true);
eq('garbage headers → present false', senderAuthAllows({ headers: 42, dkim: [] }).present, false);

section('senderAuthAllows — discrete spf/dkim/dmarc fields');

const passFlat = senderAuthAllows({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
eq('flat passes → present', passFlat.present, true);
eq('flat passes → allowed', passFlat.allow,   true);
eq('flat passes → dkim read', passFlat.results.dkim, 'pass');

const dkimFail = senderAuthAllows({ spf: 'pass', dkim: 'fail', dmarc: 'pass' });
eq('hard DKIM fail → refused',        dkimFail.allow, false);
eq('hard DKIM fail → present',        dkimFail.present, true);
eq('hard DKIM fail → names dkim',     dkimFail.failed.join(','), 'dkim');

const dmarcFail = senderAuthAllows({ data: { dkim: 'pass', dmarc: 'fail' } });
eq('hard DMARC fail under data → refused', dmarcFail.allow, false);
eq('hard DMARC fail → names dmarc',        dmarcFail.failed.join(','), 'dmarc');

// The forgery M-28 describes: a spoofed From cannot produce a DKIM signature
// for the expert's domain, so both mechanisms fail at once.
const forged = senderAuthAllows({ spf: 'fail', dkim: 'fail', dmarc: 'fail' });
eq('forged sender → refused',       forged.allow, false);
eq('forged sender → both named',    forged.failed.join(','), 'dkim,dmarc');

// SPF alone never refuses: a legitimately forwarded reply breaks SPF and keeps
// its DKIM signature, and DMARC is the verdict that reconciles the two.
const spfOnly = senderAuthAllows({ spf: 'fail', dkim: 'pass', dmarc: 'pass' });
eq('SPF-only failure → allowed',  spfOnly.allow, true);
eq('SPF-only failure → recorded', spfOnly.results.spf, 'fail');

// Soft or undecided verdicts are not hard fails: an expert whose employer
// publishes no DMARC record must still be able to reply.
for (const soft of ['none', 'neutral', 'softfail', 'temperror', 'permerror', 'policy']) {
  eq(`dmarc=${soft} → allowed`, senderAuthAllows({ dmarc: soft }).allow, true);
  eq(`dkim=${soft} → allowed`,  senderAuthAllows({ dkim: soft }).allow,  true);
}

section('senderAuthAllows — object and header shapes');

const sesLike = senderAuthAllows({ dkim: { status: 'FAIL' }, dmarc: { status: 'PASS' } });
eq('{ status } object, upper case → refused', sesLike.allow, false);
eq('{ status } object → normalised',          sesLike.results.dmarc, 'pass');
eq('{ result } object is read',
   senderAuthAllows({ dkim: { result: 'pass' } }).results.dkim, 'pass');
eq('{ verdict } object is read',
   senderAuthAllows({ dmarc: { verdict: 'fail' } }).allow, false);

const headerArray = senderAuthAllows({
  headers: [
    { name: 'Message-ID', value: '<x@example.com>' },
    { name: 'Authentication-Results',
      value: 'mx.expertmatch.fit; spf=pass smtp.mailfrom=example.com; dkim=fail header.d=example.com; dmarc=fail header.from=example.com' },
  ],
});
eq('Authentication-Results header array → present', headerArray.present, true);
eq('Authentication-Results header array → refused', headerArray.allow,   false);
eq('Authentication-Results header array → spf read', headerArray.results.spf, 'pass');

const headerObject = senderAuthAllows({
  data: { headers: { 'authentication-results': 'mx; dkim=pass; spf=pass; dmarc=pass' } },
});
eq('Authentication-Results header object → present', headerObject.present, true);
eq('Authentication-Results header object → allowed', headerObject.allow,   true);

eq('authentication_results string is parsed',
   senderAuthAllows({ authentication_results: 'mx; dkim=fail; dmarc=fail' }).allow, false);
eq('authenticationResults camelCase is parsed',
   senderAuthAllows({ authenticationResults: 'mx; dmarc=pass' }).results.dmarc, 'pass');
eq('tagged value in a discrete field is unwrapped',
   senderAuthAllows({ dkim: 'dkim=pass header.d=example.com' }).results.dkim, 'pass');
eq('parenthesised value is unwrapped',
   senderAuthAllows({ spf: 'pass (mailfrom)' }).results.spf, 'pass');
// A discrete field wins over the combined header when both are present.
eq('discrete field beats the header',
   senderAuthAllows({ dkim: 'pass', authentication_results: 'mx; dkim=fail' }).allow, true);

// ── extractResendMessageId ───────────────────────────────────────────────────

section('extractResendMessageId');

eq('data.message_id is preferred',
   extractResendMessageId(resendToday), '<111-222-333@email.example.com>');
eq('top-level message_id is read',
   extractResendMessageId({ message_id: 'msg_top' }), 'msg_top');
eq('camelCase messageId is read',
   extractResendMessageId({ messageId: 'msg_camel' }), 'msg_camel');
eq('email_id is the fallback',
   extractResendMessageId({ data: { email_id: 'em_123' } }), 'em_123');
eq('nothing usable → null',  extractResendMessageId({ subject: 'hi' }), null);
eq('blank id → null',        extractResendMessageId({ message_id: '   ' }), null);
eq('non-string id → null',   extractResendMessageId({ message_id: 12345 }), null);
eq('null payload → null',    extractResendMessageId(null), null);
check('an absurd id is capped',
      (extractResendMessageId({ message_id: 'x'.repeat(2000) }) ?? '').length === 500);

// ── Result ───────────────────────────────────────────────────────────────────

summary();

// scripts/test-entitlements.ts — the account boundary, as a pure function.
//
//   npx tsx scripts/test-entitlements.ts
//
// No network. entitlementsFromBilling is the whole rule (lib/entitlements.ts):
// a card on file opens the outside world; a 'trialing' row with no card is a
// trial; anything else without a card is an unactivated customer. Everything
// inside the product is open to all three.

import { entitlementsFromBilling, NO_ORG_ENTITLEMENTS, TRIAL_SUBSCRIPTION_STATUS, ACTIVATION_REQUIRED_MESSAGE } from '../lib/entitlements';

let failures = 0;
function check(name: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures++;
}

const ORG = '00000000-0000-4000-8000-00000000000a';

// ── trial ────────────────────────────────────────────────────────────────────
const trial = entitlementsFromBilling(ORG, { billing_complete: false, subscription_status: TRIAL_SUBSCRIPTION_STATUS });
check('trial: kind is trial',                 trial.kind === 'trial');
check('trial: may create projects',           trial.canCreateProject === true);
check('trial: may run sourcing',              trial.canRunSourcing === true);
check('trial: may view candidates',           trial.canViewCandidates === true);
check('trial: may bookmark',                  trial.canBookmarkCandidates === true);
check('trial: may NOT go live',               trial.canGoLive === false);
check('trial: may NOT outreach',              trial.canOutreachExperts === false);
check('trial: may NOT schedule',              trial.canScheduleCalls === false);
check('trial: may NOT charge',                trial.canCharge === false);
check('trial: carries the organization id',   trial.organizationId === ORG);
check('trial: has activation copy',           ACTIVATION_REQUIRED_MESSAGE.trial.includes('card'));

// ── customer with a card ─────────────────────────────────────────────────────
const live = entitlementsFromBilling(ORG, { billing_complete: true, subscription_status: 'active' });
check('card on file: kind is customer',       live.kind === 'customer');
check('card on file: may go live',            live.canGoLive === true);
check('card on file: may outreach',           live.canOutreachExperts === true);
check('card on file: may schedule',           live.canScheduleCalls === true);
check('card on file: may charge',             live.canCharge === true);

// ── a trial that added a card is a customer, whatever the status text says ──
const converted = entitlementsFromBilling(ORG, { billing_complete: true, subscription_status: TRIAL_SUBSCRIPTION_STATUS });
check('converted trial: kind is customer',    converted.kind === 'customer');
check('converted trial: may go live',         converted.canGoLive === true);

// ── customer without a card yet ──────────────────────────────────────────────
const noCard = entitlementsFromBilling(ORG, { billing_complete: false, subscription_status: null });
check('no card: kind is customer',            noCard.kind === 'customer');
check('no card: may NOT go live',             noCard.canGoLive === false);
check('no card: may NOT outreach',            noCard.canOutreachExperts === false);
check('no card: may still bookmark',          noCard.canBookmarkCandidates === true);

const noRow = entitlementsFromBilling(ORG, null);
check('no billing row: closed externally',    noRow.canGoLive === false && noRow.canCharge === false);
check('no billing row: kind is customer',     noRow.kind === 'customer');

const pastDue = entitlementsFromBilling(ORG, { billing_complete: true, subscription_status: 'past_due' });
check('past due with a card: still entitled (Stripe dunning handles the rest)', pastDue.canGoLive === true);

// ── no organization at all ───────────────────────────────────────────────────
check('no org: closed externally',            NO_ORG_ENTITLEMENTS.canGoLive === false);
check('no org: organizationId null',          NO_ORG_ENTITLEMENTS.organizationId === null);

// ── every gate is the same rule ──────────────────────────────────────────────
for (const [label, row] of [
  ['trial', { billing_complete: false, subscription_status: TRIAL_SUBSCRIPTION_STATUS }],
  ['no card', { billing_complete: false, subscription_status: null }],
  ['card', { billing_complete: true, subscription_status: 'active' }],
] as const) {
  const e = entitlementsFromBilling(ORG, row);
  check(`${label}: goLive == outreach == schedule == charge`,
    e.canGoLive === e.canOutreachExperts && e.canOutreachExperts === e.canScheduleCalls && e.canScheduleCalls === e.canCharge);
}

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);

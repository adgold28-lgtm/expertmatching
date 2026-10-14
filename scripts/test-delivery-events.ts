// scripts/test-delivery-events.ts — bounces and spam complaints
// (lib/deliveryEvents.ts, launch pack item 3).
//
// What is pinned here is what costs reputation or a client's trust when it
// drifts:
//   1. which webhook types the inbound route dispatches where
//   2. reading Resend's bounce / complaint payloads defensively
//   3. permanent vs transient, and which engagements a bounce may touch
//   4. the retry cap, and the exact row a bounce or a complaint writes
//   5. discovery and its cache can never hand back a bounced address
//   6. send-once lets ONE intro go to the new address, never a second to the old
//   7. the client's lines: plain, no machinery, no em dash, no address
//   8. the whole handler on an in-memory store: who is listed, what is written,
//      which jobs start, which events and staff rows go out
//   9. a redelivered svix id does nothing twice
//  10. the real route: dispatch by type, signature, and a 500 on a failed handler
//
// No network, no database, no Redis, no provider credits. Every dependency is
// an in-memory stub declared in this file; the route section clears the
// Supabase / Upstash / QStash variables first so nothing can reach out.
//
//   npx tsx scripts/test-delivery-events.ts
//
// Exits non-zero when any assertion fails, so it can gate a deploy.

import { Webhook } from 'svix';
import {
  webhookRouteFor,
  parseDeliveryEvent,
  bounceSeverityOf,
  bounceActionFor,
  planHardBounce,
  planComplaint,
  deliveryLineFor,
  handleDeliveryEvent,
  MAX_BOUNCE_RETRIES,
  type DeliveryEventDeps,
  type EngagementRef,
} from '../lib/deliveryEvents';
import {
  pickBestCandidate,
  cachedAnswerFor,
  discoverContact,
  invalidateCachedContact,
  cacheKeysForContact,
  isExcludedAddress,
  normalizeExclusions,
  afterBounceNote,
  type DiscoveryJobOutcome,
} from '../lib/contactDiscovery';
import type { CacheStore } from '../lib/contactCache';
import type { ContactProvider, ProviderEmailResult } from '../lib/contactProviders/types';
import {
  introAlreadySent,
  claimPredatesBounce,
  introLockKey,
  runSequenceStep,
  type SequenceStepDeps,
} from '../lib/outreachSteps';
import type { UpdateExpertInput } from '../lib/projectStore';
import { nudgeStageFor, shouldSchedule, type NudgeThreadMessage } from '../lib/nudges';
import { bookmarkLine, matchyLineFor, type BookmarkOutcome } from '../lib/matchyClient';
import { redactExpertForViewer } from '../lib/redactExpert';
import {
  CLAIM_DONE,
  CLAIM_IN_PROGRESS,
  decideClaim,
} from '../app/api/inbound-email/inboundGuards';
import type { AppendMessageInput } from '../lib/conversations';
import type { EmitEngagementEventInput, RecordSystemFailureInput } from '../lib/engagementEvents';
import type { SuppressionReason } from '../lib/outreachSuppressions';
import type { ContactDiscoveryJob } from '../lib/contactDiscovery';
import type { ContactEnrichment, Expert, ExpertStatus, Project, ProjectExpert } from '../types';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

/** Words a client must never read (the brief's list, plus their stems). */
const MACHINERY = /bounc|spam|complain|verif|suppress|resend|snov|hunter|confidence|provider|webhook/i;

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const DANA_RAW = 'Dana.Reyes@AcmeCoatings.com';
const DANA     = 'dana.reyes@acmecoatings.com';
const NEW_ADDR = 'd.reyes@acmecoatings.com';
const OTHER    = 'sam.ortiz@harborfreight.example';

const T0  = 1_760_000_000_000;   // the first intro
const NOW = T0 + 60_000;         // the bounce, a minute later

function expert(id: string, name = 'Dana Reyes'): Expert {
  return {
    id,
    name,
    title:           'VP Operations',
    company:         'Acme Coatings',
    location:        'Ohio',
    category:        'Operator',
    justification:   'Ran coatings operations.',
    relevance_score: 90,
    source_url:      'https://acmecoatings.com/team',
    source_label:    'Company site',
    source_links:    [{ url: 'https://acmecoatings.com/team' } as Expert['source_links'][number]],
  } as Expert;
}

function engagement(id: string, status: ExpertStatus, contactEmail: string | undefined, extra: Partial<ProjectExpert> = {}): ProjectExpert {
  return {
    expert:        expert(id),
    status,
    ...(contactEmail ? { contactEmail } : {}),
    outreachToken: `tok_${id}`,
    email1SentAt:  T0,
    outreachStep:  'email1',
    contactedAt:   T0,
    expertRate:    650,
    clientRate:    1300,
    nudges:        { stage: 'intro', waitingSince: T0, count: 1, lastSentAt: T0, scheduledFor: '2026-10-15T12:00:00.000Z', scheduledDay: '2026-10-15', linesUsed: [] },
    addedAt:       1,
    updatedAt:     2,
    ...extra,
  } as ProjectExpert;
}

function project(id: string, experts: ProjectExpert[], extra: Partial<Project> = {}): Project {
  return {
    id,
    name:             'Coatings diligence',
    researchQuestion: 'Coatings margins',
    industry:         'Chemicals',
    function:         'Operations',
    geography:        'US',
    seniority:        'Senior',
    createdAt:        1,
    updatedAt:        2,
    experts,
    ownerEmail:       'owner@pe-firm.example',
    collaborators:    [],
    firmDomain:       'pe-firm.example',
    walkthrough:      false,
    ...extra,
  } as Project;
}

/** `NO_BOUNCE` leaves the bounce object out entirely. */
const NO_BOUNCE = Symbol('no bounce object');

function bouncePayload(to: unknown, bounceType: unknown = 'Permanent'): Record<string, unknown> {
  return {
    type:       'email.bounced',
    created_at: '2026-10-14T12:00:00.000Z',
    data: {
      email_id: 'em_1',
      from:     'Asher <asher@expertmatch.fit>',
      to,
      subject:  'Paid call?',
      ...(bounceType === NO_BOUNCE ? {} : { bounce: { type: bounceType, subType: 'Suppressed', message: 'mailbox does not exist' } }),
    },
  };
}

function complaintPayload(to: unknown): Record<string, unknown> {
  return {
    type:       'email.complained',
    created_at: '2026-10-14T12:00:00.000Z',
    data: { email_id: 'em_2', from: 'Asher <asher@expertmatch.fit>', to, subject: 'Paid call?', tags: { category: 'intro' } },
  };
}

// ─── In-memory world for the handler ──────────────────────────────────────────

interface Calls {
  lookups:     string[][];
  suppress:    Array<{ email: string; reason: SuppressionReason; projectId?: string }>;
  notes:       AppendMessageInput[];
  events:      EmitEngagementEventInput[];
  failures:    RecordSystemFailureInput[];
  jobs:        ContactDiscoveryJob[];
  invalidated: Array<{ expertId: string; addresses: string[] }>;
  writes:      number;
}

function world(projects: Project[], opts: { suppressOk?: boolean; jobOk?: boolean; lookupThrows?: boolean } = {}) {
  const store = new Map<string, Project>(projects.map(p => [p.id, structuredClone(p)]));
  const calls: Calls = { lookups: [], suppress: [], notes: [], events: [], failures: [], jobs: [], invalidated: [], writes: 0 };

  const deps: DeliveryEventDeps = {
    async findEngagements(variants) {
      calls.lookups.push([...variants]);
      if (opts.lookupThrows) throw new Error('engagement_lookup_failed:PGRST000');
      // `.in('contact_email', variants)`: an EXACT match on the stored string.
      const refs: EngagementRef[] = [];
      store.forEach(p => {
        for (const pe of p.experts) {
          if (pe.contactEmail && variants.includes(pe.contactEmail)) refs.push({ projectId: p.id, expertId: pe.expert.id });
        }
      });
      return refs;
    },
    async getProject(projectId) {
      const p = store.get(projectId);
      return p ? structuredClone(p) : null;
    },
    async mutateExpert(projectId, expertId, mutate) {
      const p = store.get(projectId);
      if (!p) throw new Error('Project not found');
      const index = p.experts.findIndex(e => e.expert.id === expertId);
      if (index < 0) throw new Error('Expert not found');
      const next = mutate(structuredClone(p.experts[index]));   // throws → nothing written
      p.experts[index] = next;
      calls.writes++;
      return structuredClone(p);
    },
    async suppress(email, reason, projectId) {
      calls.suppress.push({ email, reason, projectId });
      return opts.suppressOk ?? true;
    },
    async appendMessage(input) { calls.notes.push(input); return { id: `m${calls.notes.length}` }; },
    async emitEngagementEvent(input) { calls.events.push(input); },
    async recordSystemFailure(input) { calls.failures.push(input); },
    async orgIdFor() { return 'org_1'; },
    async invalidateCachedContact(e, addresses) { calls.invalidated.push({ expertId: e.id, addresses: [...addresses] }); },
    async startContactDiscovery(job) { calls.jobs.push(job); return opts.jobOk ?? true; },
    now: () => NOW,
  };

  const pe = (projectId: string, expertId: string): ProjectExpert =>
    store.get(projectId)!.experts.find(e => e.expert.id === expertId)!;

  return { store, calls, deps, pe };
}

/** Runs `fn` with console output captured, so a test can assert what was logged. */
async function captureLogs<T>(fn: () => Promise<T>): Promise<{ value: T; logs: string }> {
  const lines: string[] = [];
  const original = { info: console.info, warn: console.warn, error: console.error, log: console.log };
  const grab = (...args: unknown[]) => { lines.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ')); };
  console.info = grab; console.warn = grab; console.error = grab; console.log = grab;
  try {
    const value = await fn();
    return { value, logs: lines.join('\n') };
  } finally {
    Object.assign(console, original);
  }
}

async function main(): Promise<void> {
  // ── 1. Routing ─────────────────────────────────────────────────────────────

  section('1. webhookRouteFor: which pipeline a payload belongs to');

  eq('email.received → the reply pipeline',             webhookRouteFor('email.received'), 'reply');
  eq('no type (the legacy flat inbound) → reply',       webhookRouteFor(undefined), 'reply');
  eq('null type → reply',                               webhookRouteFor(null), 'reply');
  eq('email.bounced → delivery',                        webhookRouteFor('email.bounced'), 'delivery');
  eq('email.complained → delivery',                     webhookRouteFor('email.complained'), 'delivery');
  eq('case and whitespace are forgiven',                webhookRouteFor('  Email.Bounced '), 'delivery');
  for (const t of ['email.sent', 'email.delivered', 'email.delivery_delayed', 'email.opened',
    'email.clicked', 'email.failed', 'email.suppressed', 'email.scheduled', 'contact.created', 'domain.updated']) {
    eq(`${t} → acknowledged and ignored`, webhookRouteFor(t), 'ignore');
  }
  eq('a non-string type → ignore', webhookRouteFor(42), 'ignore');

  // ── 2. Parsing ─────────────────────────────────────────────────────────────

  section('2. parseDeliveryEvent: Resend shapes, read defensively');

  const resendShape = parseDeliveryEvent(bouncePayload([DANA_RAW]));
  eq('bounce kind',                         resendShape?.kind, 'bounce');
  eq('Permanent → permanent',               resendShape?.severity, 'permanent');
  eq('one recipient',                       resendShape?.recipients.length, 1);
  eq('address is trimmed and lowercased',   resendShape?.recipients[0]?.address, DANA);
  eq('raw keeps the case Resend echoed',    resendShape?.recipients[0]?.raw, DANA_RAW);
  eq('not assumed when the type is given',  resendShape?.severityAssumed, false);

  const asString = parseDeliveryEvent(bouncePayload(`  ${DANA_RAW}  `));
  eq('`to` as a bare string',               asString?.recipients[0]?.address, DANA);

  const display = parseDeliveryEvent(bouncePayload(['Dana Reyes <Dana.Reyes@AcmeCoatings.com>']));
  eq('display-name form is unwrapped',      display?.recipients[0]?.address, DANA);

  const objects = parseDeliveryEvent(bouncePayload([{ email: DANA_RAW }]));
  eq('{ email } objects are read',          objects?.recipients[0]?.address, DANA);

  const dupes = parseDeliveryEvent(bouncePayload([DANA_RAW, DANA, ` ${DANA.toUpperCase()} `, OTHER]));
  eq('duplicates collapse on the normalized form', dupes?.recipients.length, 2);

  const junk = parseDeliveryEvent(bouncePayload(['not an address', '', 7, null, DANA]));
  eq('junk entries are dropped',            junk?.recipients.map(r => r.address).join(','), DANA);

  const noTo = parseDeliveryEvent(bouncePayload(undefined));
  eq('no `to` → no recipients, still parsed', noTo?.recipients.length, 0);

  eq('PERMANENT (any case) → permanent',    parseDeliveryEvent(bouncePayload([DANA], 'PERMANENT'))?.severity, 'permanent');
  eq('Transient → transient',               parseDeliveryEvent(bouncePayload([DANA], 'Transient'))?.severity, 'transient');
  eq('Temporary → transient',               parseDeliveryEvent(bouncePayload([DANA], 'Temporary'))?.severity, 'transient');
  eq('Undetermined → unknown',              parseDeliveryEvent(bouncePayload([DANA], 'Undetermined'))?.severity, 'unknown');
  const untyped = parseDeliveryEvent(bouncePayload([DANA], NO_BOUNCE));
  eq('no bounce object → permanent, by the event definition', untyped?.severity, 'permanent');
  eq('…and flagged as assumed',             untyped?.severityAssumed, true);
  eq('bounceSeverityOf(number) → unknown',  bounceSeverityOf(3).severity, 'unknown');

  const flat = parseDeliveryEvent({ type: 'email.bounced', to: DANA_RAW, bounce: { type: 'permanent' } });
  eq('flat legacy shape is read too',       flat?.recipients[0]?.address, DANA);

  const complained = parseDeliveryEvent(complaintPayload([DANA_RAW]));
  eq('complaint kind',                      complained?.kind, 'complaint');
  eq('a complaint has no severity',         complained?.severity, null);
  eq('complaint recipient normalized',      complained?.recipients[0]?.address, DANA);

  eq('email.received is not a delivery event', parseDeliveryEvent({ type: 'email.received', data: { to: [DANA] } }), null);
  eq('a string payload → null',             parseDeliveryEvent('email.bounced'), null);
  eq('an array payload → null',             parseDeliveryEvent([bouncePayload([DANA])]), null);
  eq('null → null',                         parseDeliveryEvent(null), null);

  // ── 3. Which engagements a bounce may touch ───────────────────────────────

  section('3. bounceActionFor: by status, and the retry cap');

  eq('the cap is two automatic retries', MAX_BOUNCE_RETRIES, 2);
  for (const s of ['bookmarked', 'contact_found', 'outreach_drafted', 'contacted', 'email2_sent'] as ExpertStatus[]) {
    eq(`${s}, 1st bounce → retry`, bounceActionFor(s, 1), 'retry');
  }
  eq('contacted, 2nd bounce → retry',   bounceActionFor('contacted', 2), 'retry');
  eq('contacted, 3rd bounce → give up', bounceActionFor('contacted', 3), 'give_up');
  for (const s of ['replied', 'followup_sent', 'rate_negotiation', 'conflict_flagged', 'scheduling_sent'] as ExpertStatus[]) {
    eq(`${s} → record only (they had replied from it)`, bounceActionFor(s, 1), 'record_only');
  }
  for (const s of ['discovered', 'shortlisted', 'scheduled', 'completed', 'rejected', 'rejected_after_outreach'] as ExpertStatus[]) {
    eq(`${s} → left alone`, bounceActionFor(s, 1), 'ignore');
  }

  // ── 4. The row a hard bounce writes ───────────────────────────────────────

  section('4. planHardBounce: the write, per engagement');

  const waitingThread: NudgeThreadMessage[] = [{ direction: 'outbound', author: 'matchy', created_at: new Date(T0).toISOString() }];

  const first = planHardBounce(engagement('e1', 'contacted', DANA_RAW), DANA, NOW, { walkthrough: false });
  check('a contacted engagement acts', first !== null);
  eq('action retry',                     first?.action, 'retry');
  eq('a search starts',                  first?.retry, true);
  eq('status back to bookmarked',        first?.next.status, 'bookmarked');
  eq('contactEmail cleared',             first?.next.contactEmail, undefined);
  check('contactEmail key is gone, so contact_email is written null', first ? !('contactEmail' in first.next) : false);
  eq('bouncedEmails records the address', JSON.stringify(first?.next.bouncedEmails), JSON.stringify([DANA]));
  eq('contactBouncedAt stamped',         first?.next.contactBouncedAt, NOW);
  eq('nudges cleared',                   first?.next.nudges, null);
  eq('client line: looking for another', first?.next.contactStatus, 'intro_undelivered');
  eq('the bounced intro stays on record (email1SentAt)', first?.next.email1SentAt, T0);
  eq('no nudge stage at bookmarked',     nudgeStageFor(first?.next.status), null);
  eq('the planner would not queue one',  first ? shouldSchedule(first.next, waitingThread, NOW).schedule : true, false);
  eq('count is 1',                       first?.bouncedCount, 1);

  eq('a row that no longer holds the address → no write',
    planHardBounce(engagement('e1', 'contacted', NEW_ADDR), DANA, NOW, { walkthrough: false }), null);
  eq('a row whose address was already cleared (redelivery) → no write',
    planHardBounce(engagement('e1', 'bookmarked', undefined, { bouncedEmails: [DANA] }), DANA, NOW, { walkthrough: false }), null);

  const second = planHardBounce(
    engagement('e1', 'contacted', NEW_ADDR, { bouncedEmails: [DANA], contactBouncedAt: NOW - 10, email1SentAt: NOW - 5 }), NEW_ADDR, NOW, { walkthrough: false });
  eq('2nd bounce → still a retry',       second?.action, 'retry');
  eq('…two addresses recorded',          second?.next.bouncedEmails?.length, 2);
  eq('…the replacement intro was sent here (its claim postdates the 1st bounce)', second?.sentHere, true);

  const third = planHardBounce(
    engagement('e1', 'contacted', OTHER, { bouncedEmails: [DANA, NEW_ADDR], contactBouncedAt: NOW - 10, email1SentAt: NOW - 5 }), OTHER, NOW, { walkthrough: false });
  eq('3rd bounce → give up',             third?.action, 'give_up');
  eq('…no search',                       third?.retry, false);
  eq('…back to bookmarked, so "bookmark again" works', third?.next.status, 'bookmarked');
  eq('…the give-up line',                third?.next.contactStatus, 'no_other_address');
  eq('…three recorded',                  third?.next.bouncedEmails?.length, 3);

  eq('a contacted engagement sent here', first?.sentHere, true);
  const heldOnly = planHardBounce(
    engagement('e5', 'outreach_drafted', DANA, { email1SentAt: undefined, outreachStep: undefined }), DANA, NOW, { walkthrough: false });
  eq('only HELD the address (never sent): still re-searched', heldOnly?.retry, true);
  eq('…not counted as its own bounce',                         heldOnly?.sentHere, false);
  eq('…a line that does not claim an intro went',              heldOnly?.next.contactStatus, 'address_not_working');
  const afterOldBounce = planHardBounce(
    engagement('e6', 'outreach_drafted', NEW_ADDR, { bouncedEmails: [DANA], contactBouncedAt: NOW - 10 }), NEW_ADDR, NOW, { walkthrough: false });
  eq('a replacement drafted but never sent: its claim is the old bounced one, so not sent here',
    afterOldBounce?.sentHere, false);

  const walk = planHardBounce(engagement('e1', 'contacted', DANA), DANA, NOW, { walkthrough: true });
  eq('walkthrough: no search (no credit, no send)', walk?.retry, false);
  eq('walkthrough: the walkthrough line',            walk?.next.contactStatus, 'walkthrough_held');

  const afterReply = planHardBounce(engagement('e3', 'followup_sent', DANA), DANA, NOW, { walkthrough: false });
  eq('after a reply: record only',       afterReply?.action, 'record_only');
  eq('…status kept',                     afterReply?.next.status, 'followup_sent');
  eq('…address cleared (planner and worker skip a row with none)', afterReply?.next.contactEmail, undefined);
  eq('…nudges cleared',                  afterReply?.next.nudges, null);
  eq('…staff line',                      afterReply?.next.contactStatus, 'contact_lost');

  for (const s of ['scheduled', 'completed', 'rejected', 'rejected_after_outreach', 'discovered', 'shortlisted'] as ExpertStatus[]) {
    eq(`${s}: untouched`, planHardBounce(engagement('e9', s, DANA), DANA, NOW, { walkthrough: false }), null);
  }

  // ── 5. The row a complaint writes ─────────────────────────────────────────

  section('5. planComplaint: the declined path\'s terminal state');

  const stopped = planComplaint(engagement('e1', 'contacted', DANA_RAW), DANA, NOW);
  eq('live engagement → stop',           stopped?.action, 'stop');
  eq('status rejected_after_outreach (the declined path)', stopped?.next.status, 'rejected_after_outreach');
  eq('replyIntent declined (its reason)', stopped?.next.replyIntent, 'declined');
  eq('complaintAt stamped',              stopped?.next.complaintAt, NOW);
  eq('nudges cleared',                   stopped?.next.nudges, null);
  eq('no nudge stage',                   nudgeStageFor(stopped?.next.status), null);
  eq('client line',                      stopped?.next.contactStatus, 'contact_stopped');

  for (const s of ['replied', 'scheduling_sent', 'outreach_drafted'] as ExpertStatus[]) {
    eq(`${s} → stop`, planComplaint(engagement('e1', s, DANA), DANA, NOW)?.action, 'stop');
  }
  const booked = planComplaint(engagement('e2', 'scheduled', DANA), DANA, NOW);
  eq('a booked call keeps its status',   booked?.next.status, 'scheduled');
  eq('…and is only stamped',             booked?.action, 'record');
  eq('…complaintAt',                     booked?.next.complaintAt, NOW);
  eq('already stamped and settled → no write',
    planComplaint(engagement('e2', 'completed', DANA, { complaintAt: NOW - 5 }), DANA, NOW), null);
  eq('a row with another address → no write',
    planComplaint(engagement('e1', 'contacted', OTHER), DANA, NOW), null);

  // ── 6. Discovery never returns a bounced address ──────────────────────────

  section('6. Exclusion: pickBestCandidate, the cache, discoverContact');

  const candidate = (email: string, status: ProviderEmailResult['normalizedStatus'] = 'verified', confidence = 95): ProviderEmailResult => ({
    email, provider: 'snov', providerStatus: status, normalizedStatus: status, confidence,
    isWebmail: false, isDisposable: false, isValidFormat: true,
  });

  eq('normalizeExclusions trims, lowercases, de-dupes',
    JSON.stringify(normalizeExclusions([` ${DANA_RAW} `, DANA, '', null])), JSON.stringify([DANA]));
  check('isExcludedAddress is case-insensitive', isExcludedAddress(DANA_RAW, [DANA]));
  check('isExcludedAddress: another address is fine', !isExcludedAddress(NEW_ADDR, [DANA]));

  eq('the best candidate, unexcluded',   pickBestCandidate([candidate(DANA_RAW), candidate(NEW_ADDR, 'catchall')])?.email, DANA_RAW);
  eq('excluded → the next best',         pickBestCandidate([candidate(DANA_RAW), candidate(NEW_ADDR, 'catchall')], [DANA])?.email, NEW_ADDR);
  eq('only the excluded one → nothing',  pickBestCandidate([candidate(DANA_RAW)], [DANA]), null);

  const foundEntry = (email: string): ContactEnrichment => ({
    best_email: { email, status: 'verified', is_valid_format: true, is_disposable: false, is_webmail: false, is_gibberish: false, provider: 'snov' },
    domain_used: 'acmecoatings.com', name_used: { first: 'Dana', last: 'Reyes' },
    looked_up_at: NOW, expires_at: NOW + 1e12, lookup_status: 'found', provider: 'snov',
  });
  const notFoundEntry: ContactEnrichment = {
    best_email: null, domain_used: 'acmecoatings.com', name_used: { first: 'Dana', last: 'Reyes' },
    looked_up_at: NOW, expires_at: NOW + 1e12, lookup_status: 'not_found', provider: 'none',
  };
  eq('cached found, not excluded → found', cachedAnswerFor(foundEntry(NEW_ADDR), [DANA]), 'found');
  eq('cached found, excluded → excluded (a miss)', cachedAnswerFor(foundEntry(DANA_RAW), [DANA]), 'excluded');
  eq('cached not_found → not_found',     cachedAnswerFor(notFoundEntry, [DANA]), 'not_found');
  eq('nothing cached → miss',            cachedAnswerFor(null, [DANA]), 'miss');

  // A provider and a cache, both in memory.
  function memoryCache(): CacheStore & { data: Map<string, ContactEnrichment>; deletes: number } {
    const data = new Map<string, ContactEnrichment>();
    const cache = {
      data,
      deletes: 0,
      async get(key: string) { return data.get(key) ?? null; },
      async set(key: string, value: ContactEnrichment) { data.set(key, value); },
      async delete(key: string) { cache.deletes++; data.delete(key); },
    };
    return cache;
  }
  function fakeProvider(results: ProviderEmailResult[]): ContactProvider & { calls: number } {
    const p = {
      name: 'snov' as const,
      calls: 0,
      isConfigured: () => true,
      async findProfessionalEmail() { p.calls++; return results; },
      estimateCreditsPerLookup: () => 1,
    };
    return p;
  }

  const subject = { name: 'Dana Reyes', company: 'Acme Coatings', sourceUrl: 'https://acmecoatings.com/team', sourceLinks: ['https://acmecoatings.com/team'] };
  const discoverInput = { projectId: 'p1', expertId: 'e1', ...subject };

  {
    const provider = fakeProvider([candidate(DANA_RAW)]);
    const cache    = memoryCache();
    const [key]    = cacheKeysForContact(subject, [], [provider]);
    cache.data.set(key, foundEntry(DANA_RAW));
    const control = await discoverContact(discoverInput, {
      enabled: true, providers: [provider], cacheStore: cache,
      withinGlobalBudget: async () => true, domainSearchConfigured: () => false,
    });
    eq('control: no exclusion → the cached address', control.email, DANA_RAW);
    eq('control: no provider call',      provider.calls, 0);

    const excluded = await discoverContact({ ...discoverInput, exclude: [DANA] }, {
      enabled: true, providers: [provider], cacheStore: cache,
      withinGlobalBudget: async () => true, domainSearchConfigured: () => false,
    });
    eq('excluded cache hit is a miss: the provider is asked', provider.calls, 1);
    eq('the provider offers only the bounced one → not_found', excluded.outcome, 'not_found');
    check('the attempt log says hit_excluded', excluded.attempts.some(a => a.provider === 'cache' && a.outcome === 'hit_excluded'));
    eq('the stale "found" is overwritten with not_found', cache.data.get(key)?.lookup_status, 'not_found');
  }

  {
    const provider = fakeProvider([candidate(DANA_RAW, 'verified', 99), candidate(NEW_ADDR, 'verified', 80)]);
    const cache    = memoryCache();
    const [key]    = cacheKeysForContact(subject, [], [provider]);
    cache.data.set(key, foundEntry(DANA_RAW));
    const replaced = await discoverContact({ ...discoverInput, exclude: [DANA_RAW] }, {
      enabled: true, providers: [provider], cacheStore: cache,
      withinGlobalBudget: async () => true, domainSearchConfigured: () => false,
    });
    eq('a better-scored bounced address loses to the new one', replaced.email, NEW_ADDR);
    eq('the cache now holds the new one', cache.data.get(key)?.best_email?.email, NEW_ADDR);
  }

  {
    const provider = fakeProvider([]);
    const cache    = memoryCache();
    const keys     = cacheKeysForContact(subject, [DANA], [provider]);
    eq('one key per domain (source link, bounced address domain), de-duplicated', keys.length, 1);
    const otherDomainKeys = cacheKeysForContact(subject, ['dana@acme-legacy.example'], [provider]);
    eq('a bounced address on another domain adds its key', otherDomainKeys.length, 2);

    cache.data.set(otherDomainKeys[0], foundEntry(DANA_RAW));
    cache.data.set(otherDomainKeys[1], foundEntry(NEW_ADDR));
    const dropped = await invalidateCachedContact(subject, [DANA, 'dana@acme-legacy.example'], { cacheStore: cache, providers: [provider] });
    eq('only the entry naming a bounced address is dropped', dropped, 1);
    check('…it is gone',              !cache.data.has(otherDomainKeys[0]));
    check('…the other address stays', cache.data.has(otherDomainKeys[1]));
    eq('no addresses → nothing touched', await invalidateCachedContact(subject, [], { cacheStore: cache, providers: [provider] }), 0);
    eq('no cache → zero, no throw',      await invalidateCachedContact(subject, [DANA], { cacheStore: null, providers: [provider] }), 0);
  }

  // ── 7. Send-once ───────────────────────────────────────────────────────────

  section('7. introAlreadySent: one intro to the new address, never a second to the old');

  check('a claim with no bounce still refuses', introAlreadySent({ email1SentAt: T0, outreachStep: 'email1', contactEmail: DANA }));
  check('no claim → may send',                  !introAlreadySent({ contactEmail: DANA }));

  const bounced = first!.next;   // the row the first bounce wrote
  check('right after the bounce (no address on file) → still refused', introAlreadySent(bounced));

  const withNew = { ...bounced, contactEmail: NEW_ADDR };
  check('a NEW address after the bounce → allowed', !introAlreadySent(withNew));
  check('claimPredatesBounce says why',             claimPredatesBounce(withNew));

  check('the SAME address put back → refused',       introAlreadySent({ ...bounced, contactEmail: DANA }));
  check('the same address in another case → refused', introAlreadySent({ ...bounced, contactEmail: DANA_RAW }));

  const reclaimed = { ...withNew, email1SentAt: NOW + 5_000, outreachStep: 'email1' as const };
  check('once the new intro is claimed → a second one is refused', introAlreadySent(reclaimed));

  check('a half-written claim (no instant) stays standing',
    introAlreadySent({ ...withNew, email1SentAt: 0, outreachStep: 'email1' }));
  check('a claim AFTER the bounce stands',
    introAlreadySent({ ...withNew, email1SentAt: NOW + 1 }));
  check('bounce recorded without a stamp → the claim stands',
    introAlreadySent({ ...withNew, contactBouncedAt: null }));

  const released = { ...withNew, email1SentAt: T0 };   // releaseClaim restores the bounced instant
  check('a released replacement claim can be retried', !introAlreadySent(released));

  eq('lock key, first intro: the bare key it always had', introLockKey('p1', 'e1'), 'intro-lock:p1:e1');
  check('lock key after a bounce differs from the first one', introLockKey('p1', 'e1', 1) !== introLockKey('p1', 'e1', 0));
  eq('two callers after the same bounce share one key', introLockKey('p1', 'e1', 1), introLockKey('p1', 'e1', 1));
  check('the key carries no address', !/@/.test(introLockKey('p1', 'e1', 2)));

  // ── 8. The client's lines ─────────────────────────────────────────────────

  section("8. What the client reads: Matchy's voice, no machinery");

  const NEW_OUTCOMES: BookmarkOutcome[] = ['intro_undelivered', 'address_not_working', 'no_other_address', 'contact_lost', 'contact_stopped'];
  for (const outcome of NEW_OUTCOMES) {
    const line = bookmarkLine(outcome, 'Dana');
    check(`${outcome}: names the expert by first name`, line.includes('Dana'), line);
    check(`${outcome}: no machinery words`,             !MACHINERY.test(line), line);
    check(`${outcome}: no em dash`,                     !line.includes('—') && !line.includes('–'), line);
    check(`${outcome}: no address, no link`,            !/@|http/i.test(line), line);
    check(`${outcome}: short`,                          line.length <= 100, line);
  }
  eq('the searching line', bookmarkLine('intro_undelivered', 'Dana'), "The intro to Dana didn't reach them. I'm looking for another address.");
  eq('the give-up line',   bookmarkLine('no_other_address', 'Dana'), "I couldn't find another address for Dana. Bookmark again to retry, or pass.");
  eq('the complaint line', bookmarkLine('contact_stopped', 'Dana'), "Dana asked not to be contacted. I've stopped.");

  const allNoteOutcomes: DiscoveryJobOutcome[] = ['intro_sent', 'intro_drafted', 'intro_failed', 'contact_not_found',
    'no_other_address', 'contact_suppressed', 'contact_check_unavailable', 'contact_discovery_unavailable', 'expert_not_found'];
  for (const outcome of allNoteOutcomes) {
    const note = afterBounceNote(outcome, 'Dana');
    if (note === null) continue;
    check(`replacement-search note (${outcome}): no machinery`, !MACHINERY.test(note), note);
    check(`replacement-search note (${outcome}): no em dash`,   !note.includes('—'), note);
  }
  eq('after a new intro goes out: the usual sent line', afterBounceNote('intro_sent', 'Dana'), bookmarkLine('intro_sent', 'Dana'));
  eq('a drafted replacement writes no note (the thread shows the draft)', afterBounceNote('intro_drafted', 'Dana'), null);
  eq('nobody new found → the give-up line', afterBounceNote('contact_not_found', 'Dana'), bookmarkLine('no_other_address', 'Dana'));

  eq('matchyLineFor: searching line while bookmarked',
    matchyLineFor({ status: 'bookmarked', matchyOutcome: 'intro_undelivered' }, 'Dana')?.text, bookmarkLine('intro_undelivered', 'Dana'));
  eq('matchyLineFor: stale searching line once contacted again → null',
    matchyLineFor({ status: 'contacted', matchyOutcome: 'intro_undelivered' }, 'Dana'), null);
  eq('matchyLineFor: stale held-address line once drafted again → null',
    matchyLineFor({ status: 'outreach_drafted', matchyOutcome: 'address_not_working' }, 'Dana'), null);
  eq('matchyLineFor: complaint line at its terminal status',
    matchyLineFor({ status: 'rejected_after_outreach', matchyOutcome: 'contact_stopped' }, 'Dana')?.text, bookmarkLine('contact_stopped', 'Dana'));
  eq('matchyLineFor: staff line mid-conversation',
    matchyLineFor({ status: 'followup_sent', matchyOutcome: 'contact_lost' }, 'Dana')?.tone, 'quiet');

  const asClient = redactExpertForViewer({ ...first!.next, contactStatus: 'intro_undelivered', complaintAt: NOW }, { role: 'user' });
  eq('the client gets the outcome name',                     asClient.matchyOutcome, 'intro_undelivered');
  eq('…never the bounced addresses',                         asClient.bouncedEmails, undefined);
  eq('…never the bounce stamp',                              asClient.contactBouncedAt, undefined);
  eq('…never the complaint stamp',                           asClient.complaintAt, undefined);
  check('…and nothing address-shaped anywhere on the row',   !JSON.stringify(asClient).includes(DANA));
  const asStaff = redactExpertForViewer(first!.next, { role: 'admin' });
  eq('staff see the bounced addresses', JSON.stringify(asStaff.bouncedEmails), JSON.stringify([DANA]));
  eq('the server note is the same line', deliveryLineFor('intro_undelivered', 'Dana Reyes'), bookmarkLine('intro_undelivered', 'Dana'));

  // ── 9. The handler, end to end on an in-memory store ──────────────────────

  section('9a. Hard bounce: listed, re-searched, told, recorded');

  {
    const w = world([
      project('p1', [
        engagement('e1', 'contacted', DANA_RAW),
        engagement('e2', 'completed', DANA_RAW),
        engagement('e3', 'followup_sent', OTHER),
      ]),
      project('p2', [engagement('e4', 'contacted', DANA_RAW)]),
    ]);
    const { value: out, logs } = await captureLogs(() => handleDeliveryEvent(bouncePayload([DANA_RAW]), w.deps));

    eq('acted',                                   out.acted, true);
    eq('three engagements hold the address',      out.matched, 3);
    eq('two written (the completed one is left alone)', out.changed, 2);
    eq('two replacement searches started',        out.retried, 2);
    check('the lookup asked for the raw and the lowercased form',
      w.calls.lookups[0]?.includes(DANA_RAW) && w.calls.lookups[0]?.includes(DANA));
    eq('listed once',                             w.calls.suppress.length, 1);
    eq('…as manual',                              w.calls.suppress[0]?.reason, 'manual');
    eq('…normalized',                             w.calls.suppress[0]?.email, DANA);
    eq('e1 back to bookmarked',                   w.pe('p1', 'e1').status, 'bookmarked');
    eq('e1 address cleared',                      w.pe('p1', 'e1').contactEmail, undefined);
    eq('e4 (another project) handled the same way', w.pe('p2', 'e4').status, 'bookmarked');
    eq('e2 (completed) untouched',                w.pe('p1', 'e2').contactEmail, DANA_RAW);
    eq('e3 (another address) untouched',          w.pe('p1', 'e3').contactEmail, OTHER);
    eq('jobs carry the attempt number',           w.calls.jobs.map(j => j.attempt).join(','), '2,2');
    check('the jobs are for e1 and e4',           w.calls.jobs.map(j => j.expertId).sort().join(',') === 'e1,e4');
    eq('the cache is told to forget, per engagement', w.calls.invalidated.length, 2);
    eq('one thread line per engagement',          w.calls.notes.length, 2);
    eq('the line is the searching line',          w.calls.notes[0]?.summary, bookmarkLine('intro_undelivered', 'Dana'));
    eq('…written as a Matchy message',            w.calls.notes[0]?.author, 'matchy');
    const bounceEvents = w.calls.events.filter(e => e.type === 'intro_bounced');
    eq('intro_bounced per engagement',            bounceEvents.length, 2);
    eq('payload is exactly { retried }',          JSON.stringify(bounceEvents[0]?.payload), JSON.stringify({ retried: true }));
    eq('no staff row for an intro-stage bounce',  w.calls.failures.length, 0);
    check('no address in any log line',           !logs.toLowerCase().includes(DANA), logs);
    check('no address in any event payload',      !JSON.stringify(w.calls.events).includes('@'));

    // Redelivered with Redis down (the claim failed open): nothing left to do.
    // Only the completed engagement still holds the address, and it is left
    // alone; the listing is an idempotent upsert, so writing it again is free.
    const again = await handleDeliveryEvent(bouncePayload([DANA_RAW]), w.deps);
    eq('redelivery: only the completed engagement still holds it', again.matched, 1);
    eq('redelivery: nothing written',             again.changed, 0);
    eq('redelivery: no second search',            w.calls.jobs.length, 2);
    eq('redelivery: no second event',             w.calls.events.length, 2);
    eq('redelivery: no second line',              w.calls.notes.length, 2);
    eq('redelivery: the listing is the same row again', w.calls.suppress.every(s => s.email === DANA && s.reason === 'manual'), true);

    // The replacement address arrives (the discovery job's write), and the
    // send-once rule lets exactly one intro through to it.
    const afterJob = { ...w.pe('p1', 'e1'), contactEmail: NEW_ADDR };
    check('the new address may get its one intro', !introAlreadySent(afterJob));
    check('the bounced one may not',               introAlreadySent({ ...afterJob, contactEmail: DANA_RAW }));
  }

  section('9a2. The same address in a project whose intro never went');

  {
    const w = world([
      project('p1', [engagement('e1', 'contacted', DANA)]),
      project('p3', [engagement('e5', 'outreach_drafted', DANA, { email1SentAt: undefined, outreachStep: undefined })], { reviewFirst: true }),
    ]);
    await handleDeliveryEvent(bouncePayload([DANA]), w.deps);
    eq('both re-searched',                        w.calls.jobs.length, 2);
    eq('the held one is back at bookmarked',      w.pe('p3', 'e5').status, 'bookmarked');
    const lines = w.calls.notes.map(n => `${n.projectId}:${n.summary}`).sort();
    eq('the sender is told its intro did not arrive', lines[0], `p1:${bookmarkLine('intro_undelivered', 'Dana')}`);
    eq('the holder is told the address is not working', lines[1], `p3:${bookmarkLine('address_not_working', 'Dana')}`);
    eq('intro_bounced only where an intro bounced', w.calls.events.map(e => `${e.projectId}:${e.type}`).join(','), 'p1:intro_bounced');
  }

  section('9b. Transient, unknown, unmatched, empty');

  {
    const w = world([project('p1', [engagement('e1', 'contacted', DANA)])]);
    const transient = await handleDeliveryEvent(bouncePayload([DANA], 'Transient'), w.deps);
    eq('transient: not acted on',  transient.acted, false);
    eq('transient: no lookup',     w.calls.lookups.length, 0);
    eq('transient: no listing',    w.calls.suppress.length, 0);
    eq('transient: row untouched', w.pe('p1', 'e1').contactEmail, DANA);

    const unknown = await handleDeliveryEvent(bouncePayload([DANA], 'Undetermined'), w.deps);
    eq('unknown type: not acted on', unknown.acted, false);

    const unmatched = await handleDeliveryEvent(bouncePayload(['client@pe-firm.example']), w.deps);
    eq('an address no engagement holds: acknowledged', unmatched.matched, 0);
    eq('…not listed (a client notification, say)', w.calls.suppress.length, 0);

    const empty = await handleDeliveryEvent(bouncePayload([]), w.deps);
    eq('no recipients: acknowledged', empty.recipients, 0);

    const unreadable = await handleDeliveryEvent({ type: 'email.received' }, w.deps);
    eq('not a delivery event: unreadable, acknowledged', unreadable.kind, 'unreadable');
  }

  section('9c. Retry cap, walkthrough, a search that cannot start, after a reply');

  {
    const w = world([project('p1', [engagement('e1', 'contacted', OTHER, { bouncedEmails: [DANA, NEW_ADDR], contactBouncedAt: NOW - 10, email1SentAt: NOW - 5 })])]);
    await handleDeliveryEvent(bouncePayload([OTHER]), w.deps);
    eq('third bounce: no search',                 w.calls.jobs.length, 0);
    eq('…the give-up line',                       w.calls.notes[0]?.summary, bookmarkLine('no_other_address', 'Dana'));
    eq('…event says not retried',                 JSON.stringify(w.calls.events[0]?.payload), JSON.stringify({ retried: false }));
    eq('…status bookmarked',                      w.pe('p1', 'e1').status, 'bookmarked');
  }
  {
    const w = world([project('p1', [engagement('e1', 'contacted', DANA)], { walkthrough: true })]);
    await handleDeliveryEvent(bouncePayload([DANA]), w.deps);
    eq('walkthrough: no search',                  w.calls.jobs.length, 0);
    eq('walkthrough: the walkthrough line',       w.calls.notes[0]?.summary, bookmarkLine('walkthrough_held', 'Dana'));
  }
  {
    const w = world([project('p1', [engagement('e1', 'contacted', DANA)])], { jobOk: false });
    await handleDeliveryEvent(bouncePayload([DANA]), w.deps);
    eq('queue down: the outcome falls back to intro_failed', w.pe('p1', 'e1').contactStatus, 'intro_failed');
    eq('…and says so on the thread',              w.calls.notes[1]?.summary, bookmarkLine('intro_failed', 'Dana'));
    eq('…one staff row',                          w.calls.failures.map(f => f.reason).join(','), 'bounce_retry_not_queued');
    eq('…event says not retried',                 JSON.stringify(w.calls.events[0]?.payload), JSON.stringify({ retried: false }));
  }
  {
    const w = world([project('p1', [engagement('e3', 'followup_sent', DANA)])]);
    await handleDeliveryEvent(bouncePayload([DANA]), w.deps);
    eq('after a reply: no cold intro',            w.calls.jobs.length, 0);
    eq('…status kept',                            w.pe('p1', 'e3').status, 'followup_sent');
    eq('…staff have it',                          w.calls.failures[0]?.reason, 'expert_address_bounced_after_reply');
    eq('…and the client is told plainly',         w.calls.notes[0]?.summary, bookmarkLine('contact_lost', 'Dana'));
  }

  {
    const w = world([project('p1', [engagement('e7', 'scheduled', DANA)])]);
    await handleDeliveryEvent(bouncePayload([DANA]), w.deps);
    eq('a booked call: left alone',               w.pe('p1', 'e7').contactEmail, DANA);
    eq('…status kept',                            w.pe('p1', 'e7').status, 'scheduled');
    eq('…no thread line, no event',               w.calls.notes.length + w.calls.events.length, 0);
    eq('…but staff hear about it',                w.calls.failures[0]?.reason, 'expert_address_bounced_call_booked');
    eq('…and the dead address is still listed',   w.calls.suppress.length, 1);
  }

  section('9d. Failures that must be retried');

  {
    const w = world([project('p1', [engagement('e1', 'contacted', DANA)])], { suppressOk: false });
    let threw = false;
    try { await handleDeliveryEvent(bouncePayload([DANA]), w.deps); } catch { threw = true; }
    check('a listing that did not land throws (→ 500, Resend redelivers)', threw);
    eq('…and NOTHING was written first, so the retry still finds the engagement', w.pe('p1', 'e1').contactEmail, DANA);
    eq('…no search started',                      w.calls.jobs.length, 0);
  }
  {
    const w = world([project('p1', [engagement('e1', 'contacted', DANA)])], { lookupThrows: true });
    let threw = false;
    try { await handleDeliveryEvent(bouncePayload([DANA]), w.deps); } catch { threw = true; }
    check('a failed engagement lookup throws', threw);
  }

  section('9e. Spam complaint');

  {
    const w = world([
      project('p1', [engagement('e1', 'contacted', DANA_RAW), engagement('e2', 'scheduled', DANA_RAW)]),
    ]);
    const { value: out, logs } = await captureLogs(() => handleDeliveryEvent(complaintPayload([DANA_RAW]), w.deps));
    eq('acted',                                   out.acted, true);
    eq('listed as opt_out',                       w.calls.suppress[0]?.reason, 'opt_out');
    eq('…normalized',                             w.calls.suppress[0]?.email, DANA);
    eq('the live engagement stops',               w.pe('p1', 'e1').status, 'rejected_after_outreach');
    eq('…complaintAt',                            w.pe('p1', 'e1').complaintAt, NOW);
    eq('…nudges cleared',                         w.pe('p1', 'e1').nudges, null);
    eq('the booked one keeps its status',         w.pe('p1', 'e2').status, 'scheduled');
    eq('…but is stamped',                         w.pe('p1', 'e2').complaintAt, NOW);
    eq('one thread line, for the stopped one',    w.calls.notes.length, 1);
    eq('…the complaint line',                     w.calls.notes[0]?.summary, bookmarkLine('contact_stopped', 'Dana'));
    eq('complaint_received for each',             w.calls.events.filter(e => e.type === 'complaint_received').length, 2);
    eq('…payload says which stopped',             w.calls.events.map(e => JSON.stringify(e.payload)).join(','),
      `${JSON.stringify({ stopped: true })},${JSON.stringify({ stopped: false })}`);
    eq('exactly one staff row',                   w.calls.failures.length, 1);
    eq('…area mail, reason spam_complaint',       `${w.calls.failures[0]?.area}:${w.calls.failures[0]?.reason}`, 'mail:spam_complaint');
    eq('no discovery, ever',                      w.calls.jobs.length, 0);
    check('no address in any log line',           !logs.toLowerCase().includes(DANA), logs);

    const again = await handleDeliveryEvent(complaintPayload([DANA_RAW]), w.deps);
    eq('redelivered complaint: nothing written twice', again.changed, 0);
    eq('…no second line',                         w.calls.notes.length, 1);
  }
  {
    const w = world([]);
    await handleDeliveryEvent(complaintPayload(['client@pe-firm.example']), w.deps);
    eq('unmatched complaint: still listed',       w.calls.suppress[0]?.reason, 'opt_out');
    eq('…with no project',                        w.calls.suppress[0]?.projectId, undefined);
    eq('…and still one staff row',                w.calls.failures[0]?.reason, 'spam_complaint_unmatched');
  }

  // ── 9f. The replacement intro, through the real send-claim path ───────────

  section('9f. The re-send writes a fresh email1SentAt, later than the bounce');

  {
    // lib/outreachStats.ts (feat/launch-pack) counts "intro sent" from
    // email1SentAt > 0 and an engagement as BOUNCED while contactBouncedAt is
    // at or after that send with no reply. The rule, as the scoreboard reads it:
    const countsAsBounced = (pe: ProjectExpert): boolean =>
      (pe.email1SentAt ?? 0) > 0
      && typeof pe.contactBouncedAt === 'number'
      && pe.contactBouncedAt >= (pe.email1SentAt ?? 0)
      && !pe.replyDetectedAt;

    process.env.AVAILABILITY_TOKEN_SECRET ??= 'test-only-secret-0123456789abcdef0123456789';

    const PID = 'b'.repeat(24);
    let row: ProjectExpert = engagement('e1', 'contacted', DANA_RAW, {
      whyThem:     'You ran coatings operations at Acme for six years',
      introDomain: 'industrial coatings',
    });
    const proj = (): Project => project(PID, [row]);

    // The bounce handler's write, then the discovery job's.
    row = planHardBounce(row, DANA, NOW, { walkthrough: false })!.next;
    check('after the bounce: the scoreboard counts it as bounced', countsAsBounced(row));
    row = { ...row, contactEmail: NEW_ADDR, contactStatus: 'contact_found' };
    check('with the new address on file: still bounced until something new goes', countsAsBounced(row));

    // An in-memory Redis whose original intro lock (gen 0) is still alive:
    // bounces often arrive inside its 120 s TTL.
    const keys = new Map<string, string>([[introLockKey(PID, 'e1'), '1']]);
    const redis = {
      async set(key: string, value: string, opts?: { ex?: number; nx?: boolean }) {
        if (opts?.nx && keys.has(key)) return null;
        keys.set(key, value);
        return 'OK' as const;
      },
      async del(key: string) { return keys.delete(key) ? 1 : 0; },
    };

    let clock = NOW + 30_000;
    let outcome: { sent: true } | { sent: false; held: 'suppressed' } = { sent: false, held: 'suppressed' };
    const sentTo: string[] = [];
    const seqDeps: Partial<SequenceStepDeps> = {
      getProject: async () => structuredClone(proj()),
      updateExpertStatus: async (_p, _e, input: UpdateExpertInput) => {
        const { expertPatch: _patch, ...fields } = input;
        row = { ...row, ...fields } as ProjectExpert;
        return structuredClone(proj());
      },
      sendSequenceEmail: async (to: string) => {
        if (outcome.sent) sentTo.push(to);
        return outcome;
      },
      redis: () => redis,
      now:   () => clock,
    };
    const step = { projectId: PID, expertId: 'e1', step: 'intro' as const, token: 'tok_e1' };

    // A held replacement first: nothing went, so the row must still read as
    // the bounced intro (and the retry must stay open).
    const held = await runSequenceStep(step, seqDeps);
    check('held replacement: not reported as sent', held.ok && held.alreadySent !== true);
    eq('held replacement: nothing went',            sentTo.length, 0);
    eq('held replacement: the bounced instant is restored', row.email1SentAt, T0);
    eq("held replacement: outreachStep restored to the bounced intro's", row.outreachStep, 'email1');
    check('held replacement: still counts as bounced (nothing new went)', countsAsBounced(row));
    check('held replacement: the retry stays open', !introAlreadySent(row));

    // The hold clears; the replacement goes, through the normal claim.
    outcome = { sent: true };
    clock   = NOW + 45_000;
    row     = { ...row, status: 'bookmarked' };
    const sent = await runSequenceStep(step, seqDeps);
    check('replacement: sent, not refused by the old lock', sent.ok && sent.alreadySent !== true);
    eq('replacement: exactly one send',            sentTo.length, 1);
    eq('replacement: to the NEW address',          sentTo[0], NEW_ADDR);
    eq('replacement: a fresh email1SentAt from the claim', row.email1SentAt, NOW + 45_000);
    check('replacement: email1SentAt is LATER than contactBouncedAt',
      (row.email1SentAt ?? 0) > (row.contactBouncedAt ?? Infinity));
    check('replacement: the scoreboard no longer counts it as bounced', !countsAsBounced(row));
    eq('replacement: status contacted',            row.status, 'contacted');
    check('replacement: its own lock generation was used', keys.has(introLockKey(PID, 'e1', 1)));
    eq('replacement: the bounced history is kept', JSON.stringify(row.bouncedEmails), JSON.stringify([DANA]));

    clock = NOW + 90_000;
    keys.delete(introLockKey(PID, 'e1', 1));   // even with the lock long gone
    const second = await runSequenceStep(step, seqDeps);
    check('a second replacement intro is refused', second.ok && second.alreadySent === true);
    eq('…nothing sent',                            sentTo.length, 1);

    row = { ...row, contactEmail: DANA_RAW };
    const toOld = await runSequenceStep(step, seqDeps);
    check('the bounced address put back is refused', toOld.ok && toOld.alreadySent === true);
    eq('…nothing sent to it',                      sentTo.length, 1);

    // The next bounce, on the replacement, is counted against the new send.
    row = { ...row, contactEmail: NEW_ADDR };
    const next = planHardBounce(row, NEW_ADDR, NOW + 120_000, { walkthrough: false });
    eq('a bounce of the replacement: second retry',  next?.action, 'retry');
    eq('…its own intro bounced (sentHere)',          next?.sentHere, true);
    check('…and the scoreboard counts it as bounced again', next ? countsAsBounced(next.next) : false);
  }

  // ── 10. A redelivered svix id ─────────────────────────────────────────────

  section('10. Idempotency: the route\'s two-phase claim around the handler');

  {
    // The route's protocol (app/api/inbound-email/route.ts steps 5 and 5b),
    // with an in-memory map standing in for Redis.
    const claims = new Map<string, string>();
    const w = world([project('p1', [engagement('e1', 'contacted', DANA)])]);
    let handled = 0;
    let suppressOk = false;
    const deps: DeliveryEventDeps = { ...w.deps, async suppress(email, reason, projectId) {
      w.calls.suppress.push({ email, reason, projectId });
      return suppressOk;
    } };

    const deliver = async (svixId: string, payload: unknown): Promise<number> => {
      const key = `inbound-seen:svix:${svixId}`;
      if (claims.has(key)) {
        const decision = decideClaim(claims.get(key));
        if (decision === 'duplicate') return 200;
        if (decision === 'in_progress') return 409;
      }
      claims.set(key, CLAIM_IN_PROGRESS);
      try {
        handled++;
        await handleDeliveryEvent(payload, deps);
      } catch {
        claims.delete(key);
        return 500;
      }
      claims.set(key, CLAIM_DONE);
      return 200;
    };

    eq('a failed first attempt answers 500',           await deliver('msg_A', bouncePayload([DANA])), 500);
    check('…and releases the claim',                   !claims.has('inbound-seen:svix:msg_A'));
    suppressOk = true;
    eq('the redelivery is processed',                  await deliver('msg_A', bouncePayload([DANA])), 200);
    eq('…the engagement is handled once',              w.calls.jobs.length, 1);
    eq('the same svix id again → 200, deduped',        await deliver('msg_A', bouncePayload([DANA])), 200);
    eq('…the handler did not run a third time',        handled, 2);
    eq('…still one search',                            w.calls.jobs.length, 1);
    claims.set('inbound-seen:svix:msg_B', CLAIM_IN_PROGRESS);
    eq('an in-flight id → 409',                        await deliver('msg_B', bouncePayload([DANA])), 409);
  }

  // ── 11. The real route ────────────────────────────────────────────────────

  section('11. app/api/inbound-email/route.ts: dispatch, signature, failure');

  {
    // Nothing reachable: no Supabase, no Redis, no QStash, no Resend.
    for (const name of ['NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'UPSTASH_REDIS_REST_URL',
      'UPSTASH_REDIS_REST_TOKEN', 'QSTASH_TOKEN', 'RESEND_API_KEY']) {
      delete process.env[name];
    }
    const secret = `whsec_${Buffer.from('delivery-events-test-secret-0123').toString('base64')}`;
    process.env.RESEND_WEBHOOK_SECRET = secret;

    const { NextRequest } = await import('next/server');
    const { POST } = await import('../app/api/inbound-email/route');

    let n = 0;
    const post = async (payload: unknown, sign = true): Promise<{ status: number; body: Record<string, unknown> }> => {
      const body = JSON.stringify(payload);
      const id   = `msg_route_${++n}`;
      const at   = new Date();
      const signature = sign ? new Webhook(secret).sign(id, at, body) : 'v1,AAAA';
      const req = new NextRequest('http://localhost/api/inbound-email', {
        method:  'POST',
        body,
        headers: {
          'content-type':   'application/json',
          'svix-id':        id,
          'svix-timestamp': String(Math.floor(at.getTime() / 1000)),
          'svix-signature': signature,
          'x-forwarded-for': '203.0.113.7',
        },
      });
      const res = await POST(req);
      return { status: res.status, body: await res.json() as Record<string, unknown> };
    };

    const { value: results } = await captureLogs(async () => ({
      delivered:  await post({ type: 'email.delivered', data: { to: [DANA] } }),
      opened:     await post({ type: 'email.opened', data: { to: [DANA] } }),
      bounced:    await post(bouncePayload([DANA])),
      transient:  await post(bouncePayload([DANA], 'Transient')),
      complained: await post(complaintPayload([DANA])),
      unsigned:   await post(bouncePayload([DANA]), false),
      received:   await post({ type: 'email.received', data: { to: ['nobody@expertmatch.fit'], from: DANA } }),
      legacy:     await post({ to: 'nobody@expertmatch.fit', from: DANA, text: 'hello' }),
    }));

    eq('email.delivered → 200',                     results.delivered.status, 200);
    eq('…acknowledged as ignored',                  results.delivered.body.ignored, true);
    eq('email.opened → 200 ignored',                results.opened.body.ignored, true);
    eq('email.bounced → 200 (nothing holds it here)', results.bounced.status, 200);
    check('…not routed as ignored',                 results.bounced.body.ignored !== true);
    eq('a transient bounce → 200',                  results.transient.status, 200);
    eq('a complaint whose listing cannot be written → 500 (Resend retries)', results.complained.status, 500);
    eq('…processing_failed',                        results.complained.body.error, 'processing_failed');
    eq('a bad signature → 400',                     results.unsigned.status, 400);
    eq('email.received still takes the reply path (no token → ack)', results.received.status, 200);
    check('…not the ignore path',                   results.received.body.ignored !== true);
    eq('the legacy untyped payload still takes the reply path', results.legacy.status, 200);
    check('…not the ignore path',                   results.legacy.body.ignored !== true);
  }

  summary('delivery events');
}

main().catch(err => {
  console.error('test-delivery-events crashed:', err);
  process.exit(1);
});

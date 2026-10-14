// lib/deliveryEvents.ts — what Matchy does when an email of ours does not land.
//
// Resend posts two delivery events to the SAME signed webhook that carries
// expert replies (app/api/inbound-email/route.ts dispatches them here, after
// the svix signature check, the JSON parse and the two-phase delivery claim):
//
//   email.bounced     the receiving server refused the message
//   email.complained  the message arrived and the recipient marked it as spam
//
// Before this module neither was heard: a bounced intro simply went quiet, and
// a spam complaint did not stop Matchy writing to that person again.
//
// HARD BOUNCE (bounce.type 'Permanent'; a transient one is logged, nothing more)
//   The address is dead everywhere, so it goes on the global do-not-contact
//   list (lib/outreachSuppressions, reason 'manual'), which the send chokepoint
//   already honours. Then, for every engagement whose contact address it is:
//
//     intro stage   (bookmarked → contacted: no reply has come from it yet)
//                   record it, clear the address, stop nudges, forget any cached
//                   lookup that names it, put the engagement back to
//                   'bookmarked', and start the ordinary discovery job again.
//                   That job (lib/contactDiscovery.runContactDiscoveryJob) can
//                   never return a bounced address, and sends the intro to a new
//                   one exactly once, in the project's mode (walkthrough holds,
//                   review-first drafts, live sends). At most MAX_BOUNCE_RETRIES
//                   automatic searches per engagement; after that Matchy stops
//                   and says so. An engagement that only HELD the address (its
//                   own intro never went, e.g. drafted for review in a second
//                   project) gets the same search and a line that does not
//                   claim an intro was sent.
//     after a reply (replied → scheduling_sent: the address worked before)
//                   record it, clear the address, stop nudges, and hand it to
//                   staff. A cold intro to a new address in the middle of a
//                   negotiation would read as a bot that lost its place.
//     anything else (not contacted yet, booked, done, passed)
//                   left alone. A booked call also raises a staff row: the
//                   call stands, but the next email about it would be held.
//
// SPAM COMPLAINT
//   The address goes on the list as 'opt_out'. Every live engagement on it
//   moves to the terminal state the inbound "declined" path uses
//   ('rejected_after_outreach', replyIntent 'declined'), with `complaintAt` set
//   and nudges stopped; one staff attention row per complaint, because a
//   complaint is a sender-reputation risk whatever it was about.
//
// WHAT THE CLIENT SEES: one plain Matchy line on the thread (lib/matchyClient
// bookmarkLine) and the same line again from `matchyOutcome` after a reload.
// Never a bounce, a complaint, a provider or an address: the stamps and the
// bounced addresses are staff-only (lib/redactExpert strips them).
//
// IDEMPOTENT TWICE OVER. The route's svix claim drops a redelivered event; and
// if Redis was down and the claim failed open, the second run finds nothing to
// do, because engagements are found by the address they still hold and the
// first run cleared it.
//
// FAILURE: anything a retry could fix (the engagement lookup, the suppression
// write, an engagement write) throws, and the route answers 500 so Resend
// redelivers. Bookkeeping after the write (the thread line, the event, the
// cache) is best effort, like everywhere else in Matchy.
//
// Never logs: an address, a name, a project name. Counts and outcomes only.

import type { Expert, ExpertStatus, MatchyOutcome, Project, ProjectExpert } from '../types';
import { getProject, mutateExpert } from './projectStore';
import { normalizeEmail, suppress, type SuppressionReason } from './outreachSuppressions';
import { appendMessage, type AppendMessageInput } from './conversations';
import {
  emitEngagementEvent,
  recordSystemFailure,
  type EmitEngagementEventInput,
  type RecordSystemFailureInput,
} from './engagementEvents';
import { getServiceRoleClient } from './supabase/admin';
import { getFirm } from './firmStore';
import { isWalkthrough } from './walkthrough';
import { bookmarkLine, firstNameOf } from './matchyClient';
import { introAlreadySent } from './outreachSteps';
import {
  invalidateCachedContact,
  isQStashConfigured,
  publishContactDiscoveryJob,
  runContactDiscoveryJobDetached,
  type ContactDiscoveryJob,
} from './contactDiscovery';

// ─── Routing (used by the webhook route) ──────────────────────────────────────

/**
 * What the inbound-email route does with a payload, by its `type`:
 *
 *   reply     an expert's email — the existing reply pipeline. A payload with
 *             NO type is the legacy flat inbound shape and stays here too.
 *   delivery  email.bounced / email.complained — handleDeliveryEvent
 *   ignore    every other event Resend can send (email.sent, .delivered,
 *             .delivery_delayed, .opened, .clicked, .failed, .suppressed, ...):
 *             acknowledged 200 and dropped, so Resend never retries it
 *
 * Pure.
 */
export type WebhookRoute = 'reply' | 'delivery' | 'ignore';

export function webhookRouteFor(type: unknown): WebhookRoute {
  if (type === undefined || type === null) return 'reply';
  if (typeof type !== 'string') return 'ignore';
  const t = type.trim().toLowerCase();
  if (t === 'email.received') return 'reply';
  if (t === 'email.bounced' || t === 'email.complained') return 'delivery';
  return 'ignore';
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

export type BounceSeverity = 'permanent' | 'transient' | 'unknown';

export interface DeliveryRecipient {
  /** Trimmed and lowercased: what every comparison uses. */
  address: string;
  /** Trimmed, case as Resend sent it: the exact string we passed to Resend. */
  raw:     string;
}

export interface DeliveryEvent {
  kind:       'bounce' | 'complaint';
  /** De-duplicated on `address`. Empty when the payload named nobody usable. */
  recipients: DeliveryRecipient[];
  /** Bounces only; null for a complaint. */
  severity:   BounceSeverity | null;
  /**
   * True when a bounce named no type at all and 'permanent' was assumed:
   * Resend defines email.bounced as the receiving server permanently
   * rejecting the message, and only an explicit Transient / Temporary
   * says otherwise.
   */
  severityAssumed: boolean;
}

/**
 * Resend's bounce.type, case-insensitive: 'Permanent' acts; 'Transient' /
 * 'Temporary' never does; an unrecognised value is 'unknown' and does not act
 * either. A missing type is permanent, by the event's own definition. Pure.
 */
export function bounceSeverityOf(type: unknown): { severity: BounceSeverity; assumed: boolean } {
  if (type === undefined || type === null || (typeof type === 'string' && !type.trim())) {
    return { severity: 'permanent', assumed: true };
  }
  if (typeof type !== 'string') return { severity: 'unknown', assumed: false };
  const t = type.trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (t === 'permanent' || t === 'hard' || t === 'hardbounce') return { severity: 'permanent', assumed: false };
  if (t === 'transient' || t === 'temporary' || t === 'soft' || t === 'softbounce') {
    return { severity: 'transient', assumed: false };
  }
  return { severity: 'unknown', assumed: false };
}

/**
 * One recipient as Resend wrote it: a bare address, "Name <address>", or an
 * object carrying `email` / `address`. Null when it is not address-shaped.
 */
function recipientFrom(value: unknown): DeliveryRecipient | null {
  let text = '';
  if (typeof value === 'string') {
    text = value;
  } else if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    text = typeof obj.email === 'string' ? obj.email
      : typeof obj.address === 'string' ? obj.address
      : '';
  }
  const angled = text.match(/<([^<>]+)>/);
  const raw    = (angled?.[1] ?? text).trim();
  // One @ with something either side, no whitespace. Deliberately loose: this
  // is a lookup key, not a send, and a stored address is what it must match.
  if (!/^[^\s@]+@[^\s@]+$/.test(raw)) return null;
  return { raw, address: normalizeEmail(raw) };
}

/**
 * Reads an email.bounced / email.complained payload:
 *   { type, created_at, data: { email_id, from, to: string[] | string, subject,
 *     bounce?: { type, subType, message }, tags? } }
 * `to` may be an array or a single string, of bare or display-name addresses.
 * The flat legacy shape (no `data`) is read too. Null for any other type, or
 * for something that is not an object. Pure; never throws.
 */
export function parseDeliveryEvent(payload: unknown): DeliveryEvent | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;
  if (webhookRouteFor(root.type) !== 'delivery') return null;

  const kind = String(root.type).trim().toLowerCase() === 'email.bounced' ? 'bounce' : 'complaint';
  const data = root.data && typeof root.data === 'object' && !Array.isArray(root.data)
    ? root.data as Record<string, unknown>
    : root;

  const toField = data.to ?? root.to;
  const listed  = Array.isArray(toField) ? toField : [toField];
  const recipients: DeliveryRecipient[] = [];
  for (const entry of listed) {
    const recipient = recipientFrom(entry);
    if (recipient && !recipients.some(r => r.address === recipient.address)) recipients.push(recipient);
  }

  if (kind === 'complaint') return { kind, recipients, severity: null, severityAssumed: false };

  const bounceField = data.bounce ?? root.bounce;
  const bounce = bounceField && typeof bounceField === 'object'
    ? bounceField as Record<string, unknown>
    : {};
  const { severity, assumed } = bounceSeverityOf(bounce.type ?? bounce.bounceType);
  return { kind, recipients, severity, severityAssumed: assumed };
}

// ─── Decisions (pure) ─────────────────────────────────────────────────────────

/** Automatic searches for a replacement address, per engagement. Bounces count. */
export const MAX_BOUNCE_RETRIES = 2;

/** Outreach in flight, no reply yet: the intro is the last thing that went. */
const INTRO_STAGE: ReadonlySet<ExpertStatus> = new Set<ExpertStatus>([
  'bookmarked', 'contact_found', 'outreach_drafted', 'contacted', 'email2_sent',
]);

/** In flight, after the expert replied from this address at least once. */
const AFTER_REPLY_STAGE: ReadonlySet<ExpertStatus> = new Set<ExpertStatus>([
  'replied', 'followup_sent', 'rate_negotiation', 'conflict_flagged', 'scheduling_sent',
]);

/**
 * What a hard bounce does to an engagement at this status, given how many
 * distinct addresses have now bounced on it (this one included):
 *
 *   retry        intro stage, under the cap: search for another address
 *   give_up      intro stage, over the cap: stop and say so
 *   record_only  after a reply: record it and hand it to staff
 *   ignore       not contacted yet, booked, completed, or passed
 */
export type BounceAction = 'retry' | 'give_up' | 'record_only' | 'ignore';

export function bounceActionFor(status: ExpertStatus, bouncedCount: number): BounceAction {
  if (INTRO_STAGE.has(status)) return bouncedCount <= MAX_BOUNCE_RETRIES ? 'retry' : 'give_up';
  if (AFTER_REPLY_STAGE.has(status)) return 'record_only';
  return 'ignore';
}

/** True while Matchy is still working an engagement (anything before 'scheduled'). */
export function isOutreachLive(status: ExpertStatus): boolean {
  return INTRO_STAGE.has(status) || AFTER_REPLY_STAGE.has(status);
}

/** The bounced list with `address` added, normalized and de-duplicated. Pure. */
function withAddress(list: readonly unknown[] | null | undefined, address: string): string[] {
  const out: string[] = [];
  for (const entry of [...(list ?? []), address]) {
    if (typeof entry !== 'string') continue;
    const normalized = normalizeEmail(entry);
    if (normalized && !out.includes(normalized)) out.push(normalized);
  }
  return out;
}

export interface HardBouncePlan {
  /** The whole row to write. */
  next:         ProjectExpert;
  action:       Exclude<BounceAction, 'ignore'>;
  /** What `contactStatus` (and so the client's `matchyOutcome`) now says. */
  outcome:      MatchyOutcome;
  /** True when a search for a replacement address should start now. */
  retry:        boolean;
  /** Distinct bounced addresses on the engagement, this one included. */
  bouncedCount: number;
  /**
   * True when THIS engagement had written to the address (its intro claim is
   * for it, or the expert had replied from it). False when it only held the
   * address, e.g. an intro drafted for review in a second project while the
   * first project's intro bounced: nothing of its own bounced, so it gets no
   * `intro_bounced` event and a line that does not claim an intro went out.
   */
  sentHere:     boolean;
}

/**
 * The write a hard bounce makes on one engagement, or null for none: the row
 * no longer holds this address (another writer moved it, or a redelivery of
 * the same bounce), or the status is one a bounce leaves alone.
 *
 * Every acting case records the address in `bouncedEmails`, stamps
 * `contactBouncedAt`, clears `contactEmail` (and so the contact_email column),
 * and clears `nudges`. With no address and, in the intro stage, the status
 * back at 'bookmarked' (a status no nudge stage exists for), neither the
 * planner nor the worker in app/api/jobs can queue or send a nudge.
 *
 * `email1SentAt` / `outreachStep` are KEPT: the bounced intro happened, and
 * lib/outreachSteps.introAlreadySent lets exactly one intro through to a
 * different address because the claim predates `contactBouncedAt`.
 *
 * Walkthrough sends nothing and spends no provider credit, so a walkthrough
 * project gets the walkthrough line instead of a search. Pure; re-runnable
 * inside mutateExpert.
 */
export function planHardBounce(
  current: ProjectExpert,
  address: string,
  now:     number,
  opts:    { walkthrough: boolean },
): HardBouncePlan | null {
  const target = normalizeEmail(address);
  if (!target || normalizeEmail(current.contactEmail ?? '') !== target) return null;

  const bouncedEmails = withAddress(current.bouncedEmails, target);
  const bouncedCount  = bouncedEmails.length;
  const action        = bounceActionFor(current.status, bouncedCount);
  if (action === 'ignore') return null;

  // Read BEFORE the address is recorded: introAlreadySent is true when the
  // standing claim is for the address on file now, i.e. this engagement's own
  // intro is the one that bounced. After a reply, the address had worked.
  const sentHere = action === 'record_only' || introAlreadySent(current);

  const base: ProjectExpert = {
    ...current,
    bouncedEmails,
    contactBouncedAt: now,
    nudges:           null,
    emailCheckedAt:   now,
    updatedAt:        now,
  };
  delete base.contactEmail;

  if (action === 'record_only') {
    return {
      next:    { ...base, contactStatus: 'contact_lost' },
      action,
      outcome: 'contact_lost',
      retry:   false,
      bouncedCount,
      sentHere,
    };
  }

  // Back to the start of the path that already exists: 'bookmarked' with no
  // address is exactly where the discovery job (and a re-bookmark) picks an
  // engagement up.
  const outcome: MatchyOutcome = action === 'give_up'
    ? 'no_other_address'
    : opts.walkthrough ? 'walkthrough_held'
    : sentHere ? 'intro_undelivered' : 'address_not_working';

  return {
    next:    { ...base, status: 'bookmarked', contactStatus: outcome },
    action,
    outcome,
    retry:   action === 'retry' && !opts.walkthrough,
    bouncedCount,
    sentHere,
  };
}

export interface ComplaintPlan {
  next:   ProjectExpert;
  /** 'stop' ends a live engagement; 'record' only stamps one already settled. */
  action: 'stop' | 'record';
}

/**
 * The write a spam complaint makes on one engagement, or null for none (the
 * row no longer holds this address, or the complaint is already recorded on a
 * settled engagement).
 *
 * A LIVE engagement moves to the terminal state the inbound "declined" path
 * uses (app/api/inbound-email/route.ts advanceDeclined): status
 * 'rejected_after_outreach', replyIntent 'declined'. No new status. A booked,
 * completed or already-passed engagement keeps its status (a booked call or a
 * bill is not undone by an email filter) and only gains `complaintAt`; staff
 * see the attention row. Nudges are cleared either way. Pure.
 */
export function planComplaint(
  current: ProjectExpert,
  address: string,
  now:     number,
): ComplaintPlan | null {
  const target = normalizeEmail(address);
  if (!target || normalizeEmail(current.contactEmail ?? '') !== target) return null;

  if (isOutreachLive(current.status)) {
    return {
      action: 'stop',
      next: {
        ...current,
        status:        'rejected_after_outreach',
        replyIntent:   'declined',
        complaintAt:   current.complaintAt ?? now,
        contactStatus: 'contact_stopped',
        nudges:        null,
        updatedAt:     now,
      },
    };
  }

  if (current.complaintAt) return null;
  return {
    action: 'record',
    next:   { ...current, complaintAt: now, nudges: null, updatedAt: now },
  };
}

/**
 * The line Matchy writes on the thread for one of these outcomes, in the
 * client's words. Every line comes from lib/matchyClient.bookmarkLine so the
 * voice matches the rest of the product. Pure.
 */
export function deliveryLineFor(outcome: MatchyOutcome, expertName: string | undefined | null): string {
  return bookmarkLine(outcome, firstNameOf(expertName));
}

// ─── Side effects ─────────────────────────────────────────────────────────────

export interface EngagementRef {
  projectId: string;
  expertId:  string;
}

/**
 * Everything handleDeliveryEvent reaches outside itself. Production never
 * passes it; scripts/test-delivery-events.ts replaces every member with an
 * in-memory stub. Method syntax so a stub may narrow a parameter type.
 */
export interface DeliveryEventDeps {
  /** Engagements whose contact_email is one of `variants`. Throws on a failed read. */
  findEngagements(variants: string[]): Promise<EngagementRef[]>;
  getProject(projectId: string): Promise<Project | null>;
  mutateExpert(
    projectId: string,
    expertId:  string,
    mutate:    (current: ProjectExpert) => ProjectExpert,
  ): Promise<unknown>;
  suppress(email: string, reason: SuppressionReason, projectId?: string): Promise<boolean>;
  appendMessage(input: AppendMessageInput): Promise<unknown>;
  emitEngagementEvent(input: EmitEngagementEventInput): Promise<void>;
  recordSystemFailure(input: RecordSystemFailureInput): Promise<void>;
  orgIdFor(project: Project): Promise<string | null>;
  invalidateCachedContact(expert: Expert, addresses: string[]): Promise<unknown>;
  /** Hands one discovery job off. False when it could not be started at all. */
  startContactDiscovery(job: ContactDiscoveryJob): Promise<boolean>;
  now(): number;
}

/** Most engagements one address is looked up across. One person, many projects. */
const MAX_ENGAGEMENTS_PER_ADDRESS = 50;

/**
 * Engagements by contact address, on the service-role client, the same way
 * lib/expertPayout.retryPendingPayoutsForAccount reads project_experts.
 * `contact_email` holds the address as it was stored, and Resend echoes back
 * the exact string we sent, so the raw form and the lowercased one are both
 * asked for; the final match is on the normalized form.
 */
async function findEngagementsByAddress(variants: string[]): Promise<EngagementRef[]> {
  const db = getServiceRoleClient();
  if (!db) {
    console.warn('[deliveryEvents] no service-role client — engagements not looked up');
    return [];
  }

  const { data, error } = await db
    .from('project_experts')
    .select('project_id, expert_id, contact_email')
    .in('contact_email', variants)
    .limit(MAX_ENGAGEMENTS_PER_ADDRESS);

  // A fixed message: a PostgREST error can echo the filter value back.
  if (error) throw new Error(`engagement_lookup_failed:${error.code ?? 'unknown'}`);

  const wanted = variants.map(normalizeEmail);
  return (data ?? [])
    .filter(row => typeof row.contact_email === 'string' && wanted.includes(normalizeEmail(row.contact_email)))
    .map(row => ({ projectId: row.project_id, expertId: row.expert_id }));
}

/**
 * The same hand-off the bookmark route makes: QStash in production (retries
 * off, one attempt per job), the in-process job in local development.
 */
async function startContactDiscovery(job: ContactDiscoveryJob): Promise<boolean> {
  if (!isQStashConfigured()) {
    runContactDiscoveryJobDetached(job);
    return true;
  }
  try {
    await publishContactDiscoveryJob(job);
    return true;
  } catch (err) {
    console.error('[deliveryEvents] could not queue contact discovery:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return false;
  }
}

function defaultDeliveryEventDeps(): DeliveryEventDeps {
  return {
    findEngagements: findEngagementsByAddress,
    getProject,
    mutateExpert,
    suppress,
    appendMessage,
    emitEngagementEvent,
    recordSystemFailure,
    orgIdFor: async project => (await getFirm(project.firmDomain).catch(() => null))?.id ?? null,
    invalidateCachedContact: (expert, addresses) => invalidateCachedContact({
      name:        expert.name,
      company:     expert.company,
      sourceUrl:   expert.source_url,
      sourceLinks: (expert.source_links ?? []).map(link => link.url),
    }, addresses),
    startContactDiscovery,
    now: Date.now,
  };
}

/** Thrown from inside a mutate to write nothing. Never escapes this module. */
const NO_CHANGE = new Error('delivery_event_no_change');

/** What one call did. Counts only — safe to log and to return. */
export interface DeliveryEventOutcome {
  kind:       'bounce' | 'complaint' | 'unreadable';
  /** False for a transient or unknown bounce, and for an unreadable event. */
  acted:      boolean;
  severity:   BounceSeverity | null;
  recipients: number;
  /** Engagements holding one of the addresses. */
  matched:    number;
  /** Engagements written. */
  changed:    number;
  /** Replacement searches started. */
  retried:    number;
}

/**
 * Handle one email.bounced / email.complained payload. Throws only when a
 * retry could do better (see FAILURE in the header); everything it decides not
 * to act on resolves normally so the route acknowledges it.
 */
export async function handleDeliveryEvent(
  payload: unknown,
  deps:    Partial<DeliveryEventDeps> = {},
): Promise<DeliveryEventOutcome> {
  const d: DeliveryEventDeps = { ...defaultDeliveryEventDeps(), ...deps };
  const event = parseDeliveryEvent(payload);

  if (!event) {
    console.warn('[deliveryEvents] unreadable delivery event — acknowledged');
    return { kind: 'unreadable', acted: false, severity: null, recipients: 0, matched: 0, changed: 0, retried: 0 };
  }

  const result: DeliveryEventOutcome = {
    kind:       event.kind,
    acted:      false,
    severity:   event.severity,
    recipients: event.recipients.length,
    matched:    0,
    changed:    0,
    retried:    0,
  };

  if (event.recipients.length === 0) {
    console.warn('[deliveryEvents] delivery event named no recipient — acknowledged',
      JSON.stringify({ kind: event.kind }));
    return result;
  }

  if (event.kind === 'bounce') {
    if (event.severity !== 'permanent') {
      // A full mailbox or a greylisting server. Resend keeps trying on its
      // side; nothing about the person or the address has changed.
      console.info('[deliveryEvents] non-permanent bounce — logged only',
        JSON.stringify({ severity: event.severity, recipients: event.recipients.length }));
      return result;
    }
    result.acted = true;
    for (const recipient of event.recipients) await hardBounce(recipient, d, result);
  } else {
    result.acted = true;
    let first: EngagementRef | null = null;
    for (const recipient of event.recipients) {
      const ref = await complaint(recipient, d, result);
      first = first ?? ref;
    }
    // One row per complaint, matched or not: a complaint about any mail we
    // send (a client notification included) is a risk to the sending domain.
    await d.recordSystemFailure({
      area:      'mail',
      reason:    result.matched > 0 ? 'spam_complaint' : 'spam_complaint_unmatched',
      projectId: first?.projectId ?? null,
      expertId:  first?.expertId ?? null,
    });
  }

  console.info('[deliveryEvents] handled', JSON.stringify({
    kind:       result.kind,
    severity:   result.severity,
    assumed:    event.severityAssumed,
    recipients: result.recipients,
    matched:    result.matched,
    changed:    result.changed,
    retried:    result.retried,
  }));
  return result;
}

/** The raw string and its lowercased form, for the contact_email lookup. */
function lookupVariants(recipient: DeliveryRecipient): string[] {
  return recipient.raw === recipient.address ? [recipient.raw] : [recipient.raw, recipient.address];
}

/** One Matchy line on the thread. appendMessage never throws. */
async function note(d: DeliveryEventDeps, ref: EngagementRef, line: string): Promise<void> {
  await d.appendMessage({
    projectId: ref.projectId,
    expertId:  ref.expertId,
    direction: 'outbound',
    author:    'matchy',
    bodyClean: line,
    summary:   line,
  });
}

async function hardBounce(
  recipient: DeliveryRecipient,
  d:         DeliveryEventDeps,
  result:    DeliveryEventOutcome,
): Promise<void> {
  const refs = await d.findEngagements(lookupVariants(recipient));
  if (refs.length === 0) {
    // A client notification, or a bounce for an address no engagement holds
    // any more (a redelivery, or a later email to an address already handled).
    console.info('[deliveryEvents] bounce matched no engagement — acknowledged');
    return;
  }
  result.matched += refs.length;

  // SUPPRESS FIRST. Engagements are found by the address they hold, and the
  // write below clears it: if the list write came second and failed, the retry
  // would find no engagement and the dead address would never be listed.
  const listed = await d.suppress(recipient.address, 'manual', refs[0].projectId);
  if (!listed) throw new Error('suppression_not_recorded');

  for (const ref of refs) await bounceEngagement(ref, recipient.address, d, result);
}

async function bounceEngagement(
  ref:     EngagementRef,
  address: string,
  d:       DeliveryEventDeps,
  result:  DeliveryEventOutcome,
): Promise<void> {
  const project = await d.getProject(ref.projectId);
  if (!project) return;

  const now         = d.now();
  const walkthrough = isWalkthrough(project);
  const decided: { plan: HardBouncePlan | null } = { plan: null };

  // A booked call is left exactly as it is (the booking and the bill are not
  // an email's to undo), but the expert's address is now dead and the next
  // reschedule email would be held, so a person has to know.
  const held = project.experts.find(e => e.expert.id === ref.expertId);
  if (held?.status === 'scheduled' && normalizeEmail(held.contactEmail ?? '') === address) {
    await d.recordSystemFailure({
      area:           'mail',
      reason:         'expert_address_bounced_call_booked',
      organizationId: await d.orgIdFor(project).catch(() => null),
      projectId:      ref.projectId,
      expertId:       ref.expertId,
    });
    return;
  }

  try {
    await d.mutateExpert(ref.projectId, ref.expertId, current => {
      decided.plan = planHardBounce(current, address, now, { walkthrough });
      if (!decided.plan) throw NO_CHANGE;
      return decided.plan.next;
    });
  } catch (err) {
    if (err === NO_CHANGE) return;
    throw err;
  }

  const plan = decided.plan;
  if (!plan) return;
  result.changed++;

  const pe    = plan.next;
  const orgId = await d.orgIdFor(project).catch(() => null);

  // Best effort: discovery's own exclusion already refuses a bounced address.
  await d.invalidateCachedContact(pe.expert, pe.bouncedEmails ?? []).catch(() => undefined);

  await note(d, ref, deliveryLineFor(plan.outcome, pe.expert.name));

  let retried = false;
  if (plan.retry) {
    retried = await d.startContactDiscovery({
      projectId: ref.projectId,
      expertId:  ref.expertId,
      attempt:   plan.bouncedCount + 1,
    }).catch(() => false);

    if (retried) {
      result.retried++;
    } else {
      await searchNotStarted(ref, pe, now, d, orgId);
    }
  }

  if (plan.action === 'record_only') {
    await d.recordSystemFailure({
      area:           'mail',
      reason:         'expert_address_bounced_after_reply',
      organizationId: orgId,
      projectId:      ref.projectId,
      expertId:       ref.expertId,
    });
  }

  // Only an engagement whose own email bounced has an intro_bounced to record;
  // one that merely held the same address keeps the fact on its row.
  if (plan.sentHere) {
    await d.emitEngagementEvent({
      projectId: ref.projectId,
      expertId:  ref.expertId,
      orgId,
      type:      'intro_bounced',
      payload:   { retried },
    });
  }
}

/**
 * The replacement search could not be queued. Say so in the words the
 * bookmark uses for an intro that did not go ("Bookmark again to retry"), since
 * a re-bookmark from 'bookmarked' starts the same search, and tell staff.
 * Only overwrites the line this module just wrote: a job that somehow ran
 * already has the last word.
 */
async function searchNotStarted(
  ref:   EngagementRef,
  pe:    ProjectExpert,
  now:   number,
  d:     DeliveryEventDeps,
  orgId: string | null,
): Promise<void> {
  try {
    await d.mutateExpert(ref.projectId, ref.expertId, current => {
      const searching = current.contactStatus === 'intro_undelivered' || current.contactStatus === 'address_not_working';
      if (current.status !== 'bookmarked' || !searching) throw NO_CHANGE;
      return { ...current, contactStatus: 'intro_failed', updatedAt: now };
    });
    await note(d, ref, deliveryLineFor('intro_failed', pe.expert.name));
  } catch {
    // NO_CHANGE or a failed write: the "looking for another address" line
    // stands and the attention row below is what gets a person to look.
  }
  await d.recordSystemFailure({
    area:           'mail',
    reason:         'bounce_retry_not_queued',
    organizationId: orgId,
    projectId:      ref.projectId,
    expertId:       ref.expertId,
  });
}

async function complaint(
  recipient: DeliveryRecipient,
  d:         DeliveryEventDeps,
  result:    DeliveryEventOutcome,
): Promise<EngagementRef | null> {
  const refs = await d.findEngagements(lookupVariants(recipient));
  result.matched += refs.length;

  // Listed whether or not an engagement holds it: "never contact that address
  // again" is about the person, not about one project.
  const listed = await d.suppress(recipient.address, 'opt_out', refs[0]?.projectId);
  if (!listed) throw new Error('suppression_not_recorded');

  if (refs.length === 0) {
    console.info('[deliveryEvents] complaint matched no engagement — listed and acknowledged');
    return null;
  }

  for (const ref of refs) await complainEngagement(ref, recipient.address, d, result);
  return refs[0];
}

async function complainEngagement(
  ref:     EngagementRef,
  address: string,
  d:       DeliveryEventDeps,
  result:  DeliveryEventOutcome,
): Promise<void> {
  const project = await d.getProject(ref.projectId);
  if (!project) return;

  const now = d.now();
  const decided: { plan: ComplaintPlan | null } = { plan: null };

  try {
    await d.mutateExpert(ref.projectId, ref.expertId, current => {
      decided.plan = planComplaint(current, address, now);
      if (!decided.plan) throw NO_CHANGE;
      return decided.plan.next;
    });
  } catch (err) {
    if (err === NO_CHANGE) return;
    throw err;
  }

  const plan = decided.plan;
  if (!plan) return;
  result.changed++;

  const orgId = await d.orgIdFor(project).catch(() => null);

  if (plan.action === 'stop') {
    await note(d, ref, deliveryLineFor('contact_stopped', plan.next.expert.name));
  }

  await d.emitEngagementEvent({
    projectId: ref.projectId,
    expertId:  ref.expertId,
    orgId,
    type:      'complaint_received',
    payload:   { stopped: plan.action === 'stop' },
  });
}

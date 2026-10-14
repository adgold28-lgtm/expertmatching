// Outreach email sending.
//
// The 3-email cadence is GONE. Matchy answers a reply on the thread instead of
// firing a follow-up on a timer. Removed 2026-09-09 (W4-1) with the last of the
// cadence: the no-op scheduleNextEmail(), the LLM-written generateEmail1() and
// the QStash SequenceJob/EmailStep wire types, which went with
// /api/email-sequence/trigger. What is left is
//
//   sendSequenceEmail — the single Resend sender, shared with Matchy's own
//                      templates (lib/matchyTemplates.ts) and the thread relay
//
// Emails go out via Resend with Reply-To: reply+[token]@reply.expertmatch.fit.
// The reply subdomain has its own MX record pointing at Resend receiving, so the
// root domain's MX can stay with a human mailbox provider (see HANDOFF Session 9).
//
// Required env vars:
//   RESEND_API_KEY, OUTREACH_FROM_EMAIL
//   NEXT_PUBLIC_BASE_URL (defaults to https://expertmatch.fit)
// Optional:
//   OUTREACH_POSTAL_ADDRESS — physical address rendered in the CAN-SPAM footer.
//                             Unset omits the address line; the opt-out link is
//                             always present. See lib/outreachFooter.ts.

import { Resend } from 'resend';
import { buildOutreachFooter } from './outreachFooter';
import { getFromAddress } from './mailFrom';
import { verifyOutreachToken } from './outreachToken';
import { getProject } from './projectStore';
import { isWalkthrough, type HeldReason } from './walkthrough';
import { getEntitlementsForProject, recordRestrictedAttempt } from './entitlements';
import { isSuppressed, type SuppressionCheck } from './outreachSuppressions';
import { getServiceRoleClient } from './supabase/admin';
import {
  checkDoNotContact,
  checkWithoutDatabase,
  supabaseDoNotContactStore,
  type DoNotContactCheck,
} from './doNotContact';
import type { Project } from '../types';

// ─── Helpers ──────────────────────────────────────────────────────────────────

let _resend: Resend | null = null;

function getResend(): Resend {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY;
  if (!key) throw new Error('[emailSequence] RESEND_API_KEY not configured');
  _resend = new Resend(key);
  return _resend;
}


// ─── Send via Resend ──────────────────────────────────────────────────────────

export interface SendSequenceEmailOptions {
  /**
   * Set when `body` ALREADY ends with the CAN-SPAM footer, so this function
   * does not append a second one. lib/matchyTemplates.ts builds complete
   * messages, footer included; a caller that passes a bare body relies on the
   * append below.
   */
  footerIncluded?: boolean;
  /**
   * HTML alternative. When given, the message goes out multipart. The legacy
   * cadence is deliberately plain text and passes nothing.
   */
  html?: string;
}

/**
 * Whether the message actually went out.
 *
 * `held` is why it did not: 'walkthrough' when the project has not been
 * switched live (lib/walkthrough.ts), 'trial' when the organization has no card
 * on file (lib/entitlements.ts), 'disabled' when DISABLE_EMAILS is set,
 * 'suppressed' when the address is on the global do-not-contact list, or the
 * list could not be read (lib/outreachSuppressions.ts, fail-closed),
 * 'do_not_contact' when the address, its domain, or the expert's name or
 * company is on the client firm's own list, or that list could not be read
 * (lib/doNotContact.ts, fail-closed; a table not yet created reads as empty).
 *
 * EVERY CALLER READS THIS. lib/outreachSteps.ts, lib/matchyScheduling.ts,
 * app/api/jobs/send-nudge and app/api/inbound-email fall back to a drafted or
 * held record; the client reply in .../experts/[expertId]/messages/route.ts,
 * the approved follow-up in .../messages/[messageId]/send/route.ts and
 * .../rate-decision/route.ts run the outcome through `dispositionOf` below,
 * which is what stops a held message from advancing the engagement.
 */
export type SendOutcome =
  | { sent: true }
  | { sent: false; held: HeldReason };

/**
 * Everything the chokepoint is allowed to decide on, gathered by
 * `sendSequenceEmail` in the order below. A `null` means "not evaluated,
 * because an earlier gate already held the send" — and, because every gate here
 * fails closed, an unevaluated fact can only ever hold, never release.
 */
export interface SendGateFacts {
  /** DISABLE_EMAILS=true, the environment-wide kill switch. */
  disableEmails: boolean;
  /** The project has not been switched live (lib/walkthrough.ts). */
  walkthrough:   boolean;
  /** lib/entitlements.getEntitlementsForProject().canOutreachExperts. */
  canOutreach:   boolean | null;
  /** lib/outreachSuppressions.isSuppressed() on the recipient address. */
  suppression:   SuppressionCheck | null;
  /**
   * lib/doNotContact.checkDoNotContact() on the recipient address and the
   * expert's name and company, against the list of the firm that owns the
   * project. A message addressed to the project's own client is answered
   * `{ ok: true, match: null }` without a read: the firm's list is about who
   * the firm may not reach, and the client is the firm.
   */
  doNotContact:  DoNotContactCheck | null;
}

export type SendGateDecision =
  | { send: true }
  | { send: false; held: HeldReason };

/**
 * THE GATE, as a pure function: the five rules that decide whether an email may
 * leave the building, in the order the chokepoint applies them.
 *
 * Fails closed on every unknown: a missing entitlement answer, an unreadable
 * suppression list and an unreadable firm list all hold. Tested by
 * scripts/test-send-chokepoint.ts and scripts/test-do-not-contact.ts.
 */
export function resolveSendGate(facts: SendGateFacts): SendGateDecision {
  if (facts.disableEmails)        return { send: false, held: 'disabled' };
  if (facts.walkthrough)          return { send: false, held: 'walkthrough' };
  if (facts.canOutreach !== true) return { send: false, held: 'trial' };
  if (facts.suppression === null || !facts.suppression.ok || facts.suppression.suppressed) {
    return { send: false, held: 'suppressed' };
  }
  if (facts.doNotContact === null || !facts.doNotContact.ok || facts.doNotContact.match !== null) {
    return { send: false, held: 'do_not_contact' };
  }
  return { send: true };
}

/**
 * True when `to` is the project's own client (its owner, or the client contact
 * on the brief) rather than the expert. lib/expertRemoval sends the client an
 * apology through this chokepoint on the expert's token; the firm's
 * do-not-contact list must not hold a message to the firm itself.
 */
export function isClientRecipient(
  to:      string,
  project: Pick<Project, 'ownerEmail' | 'clientEmail'>,
): boolean {
  const address = to.trim().toLowerCase();
  if (!address) return false;
  return [project.ownerEmail, project.clientEmail]
    .some(client => !!client && client.trim().toLowerCase() === address);
}

/** What a caller may do with the engagement after one send attempt. */
export type SendAttempt =
  /** The route refused before the chokepoint: nothing was offered to Resend. */
  | { kind: 'walkthrough' }
  /** There is nobody to write to yet (no address, or no reply token). */
  | { kind: 'no_recipient' }
  /** The chokepoint answered. */
  | { kind: 'outcome'; outcome: SendOutcome };

export interface SendDisposition {
  /** The hold to store on the thread copy, or null when nothing was held. */
  held:      HeldReason | null;
  /**
   * May the engagement move? Status, money, engagement_events. False ONLY for a
   * chokepoint hold: the expert did not receive the message and no amount of
   * bookkeeping can pretend otherwise. Walkthrough deliberately still advances
   * — practising a decision has to leave the engagement where it really would
   * be — and so does a decision recorded with no address on file.
   */
  advance:   boolean;
  /** True only when Resend accepted the message. */
  delivered: boolean;
}

/**
 * The branch the three client-facing routes take after a send attempt, in one
 * place so they cannot drift (H-4). Pure; tested by scripts/test-walkthrough.ts.
 */
export function dispositionOf(attempt: SendAttempt): SendDisposition {
  switch (attempt.kind) {
    case 'walkthrough':
      return { held: 'walkthrough', advance: true, delivered: false };
    case 'no_recipient':
      return { held: null, advance: true, delivered: false };
    case 'outcome':
      return attempt.outcome.sent
        ? { held: null, advance: true, delivered: true }
        : { held: attempt.outcome.held, advance: false, delivered: false };
  }
}

/**
 * THE CHOKEPOINT. Every outbound expert email in the product goes through here,
 * which is why all five gates live here and not only at the call sites: no
 * route, present or future, can leak an email past them.
 *
 * The project is resolved from the reply token (the one thing every caller
 * already has). It FAILS CLOSED: an unverifiable token or a missing project
 * throws rather than sending, because a message we cannot attribute to a
 * project is a message we cannot prove is allowed to go.
 *
 * THE GLOBAL DO-NOT-CONTACT LIST IS CHECKED HERE (H-3), fourth of the five, so an
 * expert who clicks the footer opt-out mid-thread cannot receive a client
 * reply, a rate line, an auto follow-up or a scheduling proposal either. The
 * call-site checks in bookmark, outreach/approve, messages/[id]/send,
 * jobs/send-nudge and lib/contactDiscovery stay as early-exit UX: they answer
 * 409 with a written explanation instead of storing a held message.
 *
 * THE FIRM'S OWN DO-NOT-CONTACT LIST IS CHECKED HERE TOO, fifth and last
 * (lib/doNotContact.ts): the recipient address, its domain, and the expert's
 * name and company, against the list of the organization that owns the
 * project. The expert comes from the reply token, like the project. Read fresh
 * on every send, so a removal takes effect at once. A table that does not
 * exist yet reads as an empty list; any other read failure holds. The bookmark
 * route checks name and company before discovery spends anything; this is the
 * check nothing can route around.
 *
 * The gates are ordered cheapest-first and each one short-circuits the lookup
 * the next would need, so a walkthrough project still costs no entitlement read
 * and no suppression read. `resolveSendGate` above is the rule itself.
 *
 * Never logs: the recipient address, the subject, the body, or the token.
 */
/** `"Name" <address>` when `from` carries a display name, else the bare address. */
export function withFromDisplayName(from: string, address: string): string {
  const name = from.match(/^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/)?.[1]?.trim();
  return name ? `"${name.replace(/"/g, '')}" <${address}>` : address;
}

/** Domain that receives expert replies. Override only for local testing. */
export const REPLY_DOMAIN = process.env.OUTREACH_REPLY_DOMAIN ?? 'reply.expertmatch.fit';

export async function sendSequenceEmail(
  to:         string,
  subject:    string,
  body:       string,
  replyToken: string,
  fromName:   string,
  options:    SendSequenceEmailOptions = {},
): Promise<SendOutcome> {
  const disableEmails = process.env.DISABLE_EMAILS === 'true';

  // Resolve the project before Resend is ever touched. The token is the only
  // handle a caller is guaranteed to have, and it is project+expert scoped.
  const resolved    = disableEmails ? null : await resolveSendProject(replyToken);
  const project     = resolved?.project ?? null;
  const walkthrough = project !== null && isWalkthrough(project);

  // The account boundary (lib/entitlements.ts): a trial, or any organization
  // with no card on file, may never reach an expert — whatever the project's
  // own mode claims. A project cannot normally leave walkthrough without this
  // entitlement, so this is the backstop, not the gate.
  const entitlements = project && !walkthrough
    ? await getEntitlementsForProject(project.id)
    : null;

  // The do-not-contact list, keyed on the address rather than the engagement.
  // isSuppressed fails closed, and resolveSendGate treats that as a hold.
  const suppression = entitlements?.canOutreachExperts
    ? await isSuppressed(to)
    : null;

  // The firm's own list, keyed on the address AND the expert. Only read once
  // every earlier gate has passed; checkFirmList never throws and reports an
  // unreadable list as unavailable, which resolveSendGate holds.
  const doNotContact = resolved && suppression?.ok && !suppression.suppressed
    ? await checkFirmList(resolved.project, resolved.expertId, to)
    : null;

  const gate = resolveSendGate({
    disableEmails,
    walkthrough,
    canOutreach: entitlements === null ? null : entitlements.canOutreachExperts,
    suppression,
    doNotContact,
  });

  if (!gate.send) {
    if (gate.held === 'trial' && project && entitlements) {
      await recordRestrictedAttempt(entitlements, { action: 'send_email', projectId: project.id });
    }
    console.warn('[emailSequence] held', JSON.stringify({ step: fromName, reason: gate.held }));
    return { sent: false, held: gate.held };
  }

  const from    = getFromAddress();
  // Reply-To carries the thread token, but it is shown with the SAME display
  // name as From, so a reply window reads "Asher Goldstein" rather than the
  // coded address; the address is only visible on hover. Same pattern as
  // Front / HubSpot threaded replies.
  const replyTo = withFromDisplayName(from, `reply+${replyToken}@${REPLY_DOMAIN}`);
  const resend  = getResend();

  // CAN-SPAM footer: postal address (when configured) plus a per-recipient
  // opt-out link. Appended here only when the caller has not already built it
  // in — two opt-out links in one email is worse than none.
  const text = options.footerIncluded
    ? body
    : `${body}${buildOutreachFooter(to).text}`;

  const { error } = await resend.emails.send({
    from,
    to,
    replyTo,
    subject,
    text,
    ...(options.html ? { html: options.html } : {}),
  });

  if (error) {
    throw new Error(`[emailSequence] Resend error: ${error.message}`);
  }

  console.info('[emailSequence] sent', JSON.stringify({ step: fromName, status: 'ok' }));
  return { sent: true };
}

/**
 * The project and expert behind a reply token, or a throw. Split out only so
 * the gate facts above can be gathered in one readable pass; the rule is
 * unchanged — a message we cannot attribute to a project is never sent.
 */
async function resolveSendProject(replyToken: string): Promise<{ project: Project; expertId: string }> {
  const verified = verifyOutreachToken(replyToken);
  const project  = verified.ok ? await getProject(verified.data.projectId) : null;
  if (!verified.ok || !project) {
    throw new Error('[emailSequence] send refused: unresolvable project');
  }
  return { project, expertId: verified.data.expertId };
}

/**
 * The firm-list fact for one send. A message to the project's own client skips
 * the read (see isClientRecipient). No service-role client holds in
 * production (checkWithoutDatabase). The expert's name and company come off the
 * project record; an expert no longer on the project is still checked on the
 * address and its domain.
 */
async function checkFirmList(project: Project, expertId: string, to: string): Promise<DoNotContactCheck> {
  if (isClientRecipient(to, project)) return { ok: true, match: null };

  const admin = getServiceRoleClient();
  if (!admin) return checkWithoutDatabase();

  const pe = project.experts.find(e => e.expert.id === expertId);
  return checkDoNotContact(supabaseDoNotContactStore(admin), project.id, {
    email:   to,
    name:    pe?.expert.name ?? null,
    company: pe?.expert.company ?? null,
  });
}

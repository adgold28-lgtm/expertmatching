// POST — Resend inbound email webhook. Matchy's ear.
//
// Every reply an expert sends comes here. What happens to it, in order
// (docs/MATCHY_SPEC.md, "API surface"):
//
//   verify → dedupe → resolve the thread → check the sender → CLEAN → SCREEN
//   → STORE → CLASSIFY + SUMMARIZE (one model call) → advance the stage →
//   emit the events → maybe send the follow-up
//
// WHAT IS UNCHANGED FROM THE OUTREACH BOT, deliberately:
//   - Svix signature verification (Resend signs "id.timestamp.body" with the
//     base64-decoded whsec_ secret, 5-minute tolerance; the library enforces it)
//   - 100 requests/hour per IP
//   - the HMAC-signed outreach token resolves (projectId, expertId), with the
//     Redis reply-token index preferred over the token payload
//   - THE SENDER MUST MATCH THE ADDRESS WE MAILED. A forwarded thread, an
//     assistant or a colleague must not be able to decline, counter-rate or
//     advance an engagement on the expert's behalf.
//   - "no" is a fact about the person, not about this project: a decline adds
//     them to the global do-not-contact list.
//   - a reply the handler DELIBERATELY IGNORES is answered 200, so Resend does
//     not retry a decision that would come out the same way. Only an in-flight
//     duplicate (409) and an unexpected failure (500) ask for a redelivery.
//
// WHAT PHASE 2 ADDED: a SCHEDULING BRANCH that runs BEFORE the generic
// classifier. Once an engagement is at 'scheduling_sent' or 'scheduled', the
// five outreach intents are the wrong question — the only things a reply can
// mean are "that one works", "none of those work", "move it", or "forget it".
// lib/matchyScheduling.parseSchedulingReply answers exactly that, with a regex
// fast path that costs nothing and one model call when the regex is unsure, so
// a scheduling reply costs one call and not two. The message is still cleaned,
// screened and stored first: the branch decides what HAPPENS, never whether the
// reply is recorded.
//
// WHAT IS NEW:
//   - IDEMPOTENCY, IN TWO PHASES. Resend retries on any non-2xx and on a
//     timeout. The old handler had no dedupe at all, so a retry could
//     re-suppress an address, re-emit events and (now) send a second follow-up.
//     The svix message id is claimed in Redis with SET NX before any side
//     effect — but as "processing", with a 2-minute TTL, and it is rewritten to
//     "done" for 7 days only once the reply has actually been handled. A second
//     delivery therefore reads the claim rather than assuming it: "done" is
//     acknowledged and dropped, "processing" answers 409 so Resend comes back
//     after the first attempt has finished or its TTL has run out, and an
//     unexpected failure deletes the claim and answers 500 so the redelivery
//     lands inside the window instead of being deduped into oblivion. The cost
//     of that retry is a possible duplicate of the work done before the throw;
//     losing an expert's reply is the worse of the two. It still FAILS OPEN —
//     if Redis is unavailable the message is processed rather than dropped.
//   - SENDER AUTHENTICITY. The address match below is not authentication, so
//     the handler also reads whatever SPF/DKIM/DMARC verdicts the payload
//     carries and refuses a hard DKIM or DMARC fail. Resend's inbound webhook
//     does not supply them today (see inboundGuards.senderAuthAllows), so the
//     check is inert and says so once a day through recordSystemFailure.
//   - The reply is cleaned, screened, stored encrypted, and summarized.
//   - THE CADENCE IS GONE. Nothing here schedules email2 or email3. A follow-up
//     goes out because the expert said yes, not because a clock ran out, and
//     only once (`followupSentAt`). On a review-first project the follow-up is
//     DRAFTED onto the thread and waits for the client's approval.
//
// MONEY: the follow-up quotes `expertRate` because it goes to the expert. The
// counter is stored twice — `expertCounterRate` for us and the expert,
// `clientCounterRate` (= clientRateFor of it) for the client — and
// lib/redactExpert.ts is what keeps them apart. The two never share a message.
//
// Never logs: email content, expert email, expert name, project name, token.

import { NextRequest, NextResponse } from 'next/server';
import { Webhook } from 'svix';
import { getProject, updateExpertStatus } from '../../../lib/projectStore';
import { verifyOutreachToken } from '../../../lib/outreachToken';
import { suppress } from '../../../lib/outreachSuppressions';
import { createRateLimiterStore } from '../../../lib/rateLimiter';
import { getUpstashClient } from '../../../lib/upstashRedis';
import { cleanEmailBody } from '../../../lib/emailClean';
import { screenMessage } from '../../../lib/matchyScreen';
import { appendMessage, updateMessage } from '../../../lib/conversations';
import { classifyMessage, type MatchyClassification } from '../../../lib/matchyClassify';
import { emitEngagementEvent, recordSystemFailure } from '../../../lib/engagementEvents';
import {
  CLAIM_DONE,
  CLAIM_IN_PROGRESS,
  decideClaim,
  extractResendMessageId,
  senderAuthAllows,
  type ClaimDecision,
} from './inboundGuards';
import { isIdentityRevealed } from '../../../lib/redactExpert';
import { buildFollowUpEmail, deriveTopic } from '../../../lib/matchyTemplates';
import { sendSequenceEmail } from '../../../lib/emailSequence';
import {
  MAX_PROPOSAL_ROUNDS,
  emptySchedulingState,
  looksLikeReschedule,
  parseSchedulingReply,
  proposeTimes,
  writeExpert,
} from '../../../lib/matchyScheduling';
import { bookCall, rebookCall } from '../../../lib/bookCall';
import { isWalkthrough, WALKTHROUGH_HELD_SUMMARY } from '../../../lib/walkthrough';
import { clientRateFor } from '../../../lib/pricing';
import { getFirm, getUser } from '../../../lib/firmStore';
// The one pseudonymiser (audit L-49). It hard-fails in production without
// LOG_HASH_SECRET, where this route's private copy silently fell back.
import { pseudonymize } from '../../../lib/contactCache';
import type { Project, ProjectExpert } from '../../../types';

// ─── Rate limiter ─────────────────────────────────────────────────────────────

let _rlStore: ReturnType<typeof createRateLimiterStore> | null = null;

function getRlStore() {
  if (!_rlStore) _rlStore = createRateLimiterStore();
  return _rlStore;
}

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    request.headers.get('x-real-ip') ??
    'unknown'
  );
}

// ─── Resend (Svix) webhook signature verification ─────────────────────────────

// Svix signs `${svix-id}.${svix-timestamp}.${body}` with the base64-decoded
// whsec_ secret and enforces a 5-minute timestamp tolerance. verify() throws on
// any failure — a bad signature, a missing header, or a stale timestamp.
function verifyResendSignature(rawBody: string, request: NextRequest): boolean {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) return false;

  const headers = {
    'svix-id':        request.headers.get('svix-id')        ?? '',
    'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
    'svix-signature': request.headers.get('svix-signature') ?? '',
  };

  try {
    new Webhook(secret).verify(rawBody, headers);
    return true;
  } catch {
    return false;
  }
}

// ─── Idempotency ──────────────────────────────────────────────────────────────

/** How long a COMPLETED delivery id is remembered. Resend retries for ~24h. */
const DEDUPE_TTL_S = 7 * 24 * 60 * 60;

/**
 * How long an IN-FLIGHT claim is held. Long enough for the slowest reply
 * (Supabase writes, one or two model calls, an outbound send), short enough
 * that a process killed mid-flight — which never runs the catch that deletes
 * the claim — frees the id well inside Resend's retry window.
 */
const CLAIM_TTL_S = 120;

/** One alert a day is enough to tell the founder the auth check is inert. */
const AUTH_ALERT_TTL_S = 24 * 60 * 60;

/**
 * The stable id for this delivery: the svix message id when Resend sent one,
 * otherwise whatever id the payload carries. Two deliveries of the same email
 * share it; two different emails never do.
 */
function deliveryId(request: NextRequest, payload: Record<string, unknown>): string | null {
  const svixId = request.headers.get('svix-id')?.trim();
  if (svixId) return `svix:${svixId}`;

  const data = (payload.data && typeof payload.data === 'object')
    ? payload.data as Record<string, unknown>
    : {};
  for (const candidate of [payload.message_id, payload.messageId, payload.id, data.message_id, data.id]) {
    if (typeof candidate === 'string' && candidate.trim()) return `msg:${candidate.trim()}`;
  }
  return null;
}

/**
 * Phase one of the claim: take the id, or find out who holds it.
 *
 *   process      carry on (also the answer with no id and with no Redis)
 *   duplicate    already handled — acknowledge 200 and stop
 *   in_progress  another delivery of this id is mid-flight — answer 409
 *
 * FAILS OPEN on every error and when there is no Redis at all: a duplicated
 * reply is a smaller failure than a lost one.
 */
async function claimDelivery(id: string | null): Promise<ClaimDecision> {
  if (!id) return 'process';
  const redis = getUpstashClient();
  if (!redis) return 'process';

  try {
    const claimed = await redis.set(`inbound-seen:${id}`, CLAIM_IN_PROGRESS, { ex: CLAIM_TTL_S, nx: true });
    if (claimed === 'OK') return 'process';
    return decideClaim(await redis.get(`inbound-seen:${id}`));
  } catch {
    return 'process';
  }
}

/**
 * Phase two: this delivery reached a terminal decision — handled, or
 * deliberately ignored — so the id is remembered for 7 days and no retry of it
 * does anything again. Best-effort: on a Redis failure the claim simply
 * expires in CLAIM_TTL_S and a retry re-runs, which is the fail-open side.
 */
async function markDeliveryDone(id: string | null): Promise<void> {
  if (!id) return;
  const redis = getUpstashClient();
  if (!redis) return;
  try {
    await redis.set(`inbound-seen:${id}`, CLAIM_DONE, { ex: DEDUPE_TTL_S });
  } catch {
    // Non-fatal — the short claim expires on its own.
  }
}

/**
 * Releases the claim after an unexpected failure, so the 500 we answer sends
 * Resend back into an unclaimed window rather than a deduped one.
 */
async function releaseDelivery(id: string | null): Promise<void> {
  if (!id) return;
  const redis = getUpstashClient();
  if (!redis) return;
  try {
    await redis.del(`inbound-seen:${id}`);
  } catch {
    // Non-fatal — the claim expires in CLAIM_TTL_S and the retry lands then.
  }
}

/**
 * Records, at most once a day, that the inbound payload carried no SPF/DKIM/
 * DMARC verdict — so the sender-authenticity check is inert and the address
 * match is the only sender control in force. Redis holds the daily key; with
 * no Redis a module-level stamp keeps it to once a day per instance. Never
 * throws (recordSystemFailure does not either).
 */
let authAlertStampMs = 0;

async function noteMissingAuthResults(): Promise<void> {
  const redis = getUpstashClient();
  if (redis) {
    try {
      const first = await redis.set('inbound-auth-missing:alerted', '1', { ex: AUTH_ALERT_TTL_S, nx: true });
      if (first !== 'OK') return;
    } catch {
      // Fall through to the in-process stamp.
    }
  }
  const now = Date.now();
  if (now - authAlertStampMs < AUTH_ALERT_TTL_S * 1000) return;
  authAlertStampMs = now;
  await recordSystemFailure({ area: 'mail', reason: 'inbound_auth_results_missing' });
}

// ─── Token index lookup ───────────────────────────────────────────────────────

async function lookupReplyToken(token: string): Promise<{ projectId: string; expertId: string } | null> {
  const redis = getUpstashClient();
  if (!redis) return null;

  const raw = await redis.get(`reply-token:${token}`);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as { projectId: string; expertId: string };
  } catch {
    return null;
  }
}

// ─── Address extraction ───────────────────────────────────────────────────────

function extractReplyToken(toAddress: string): string | null {
  // Matches reply+TOKEN@reply.expertmatch.fit (current) and reply+TOKEN@expertmatch.fit
  // (threads started before the reply subdomain existed), with or without a
  // display name. The token, not the domain, is what authenticates the reply.
  const match = toAddress.match(/reply\+([A-Za-z0-9._~-]+)@(?:reply\.)?expertmatch\.fit/i);
  return match?.[1] ?? null;
}

// Resend's inbound payload carries `from` either as a bare address, as a
// display-name form ("Jane Doe <jane@acme.com>"), or as an object.
function extractFromAddress(fromField: unknown): string {
  let candidate = '';
  if (typeof fromField === 'string') {
    candidate = fromField;
  } else if (Array.isArray(fromField) && fromField.length > 0) {
    const first = fromField[0] as Record<string, unknown>;
    candidate = typeof first?.email === 'string' ? first.email : '';
  } else if (fromField && typeof fromField === 'object') {
    const obj = fromField as Record<string, unknown>;
    candidate = typeof obj.email === 'string' ? obj.email : '';
  }

  const angled = candidate.match(/<([^>]+)>/);
  return (angled?.[1] ?? candidate).trim().toLowerCase();
}

// ─── Thread context ───────────────────────────────────────────────────────────

interface ThreadContext {
  orgId:          string | null;
  clientFirmName: string | undefined;
  clientFullName: string | undefined;
}

/**
 * The two names the compliance screen needs, plus the org id every event
 * carries. Best-effort: a missing organization or profile weakens the screen
 * but must never stop a reply being recorded.
 */
async function loadThreadContext(project: Project): Promise<ThreadContext> {
  const firm = await getFirm(project.firmDomain).catch(() => null);

  let clientFullName = project.clientName?.trim() || undefined;
  if (!clientFullName && project.ownerEmail) {
    const owner = await getUser(project.ownerEmail).catch(() => null);
    const parts = [owner?.firstName, owner?.lastName].filter(Boolean);
    if (parts.length > 0) clientFullName = parts.join(' ');
  }

  return {
    orgId:          firm?.id ?? null,
    clientFirmName: firm?.name?.trim() || undefined,
    clientFullName,
  };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  // ── 1. Rate limit by IP ──────────────────────────────────────────────────
  const ip = getClientIp(request);
  try {
    const store = getRlStore();
    const { count } = await store.increment(`rl:inbound-email:${ip}:1h`, 60 * 60 * 1000);
    if (count > 100) {
      return NextResponse.json({ error: 'rate_limited' }, { status: 429 });
    }
  } catch {
    // Non-fatal — continue without rate limiting if store fails
  }

  // ── 2. Read raw body ──────────────────────────────────────────────────────
  const rawBody = await request.text();

  // ── 3. Verify Resend (Svix) webhook signature ────────────────────────────
  if (process.env.RESEND_WEBHOOK_SECRET) {
    if (!verifyResendSignature(rawBody, request)) {
      console.warn('[inbound-email] invalid webhook signature');
      return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
    }
  } else if (process.env.NODE_ENV === 'production') {
    console.error('[inbound-email] RESEND_WEBHOOK_SECRET missing — rejecting');
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  // ── 4. Parse payload ──────────────────────────────────────────────────────
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // ── 5. Idempotency — claim this delivery before any side effect ──────────
  // The claim is a lease, not a tombstone: "processing" for two minutes now,
  // rewritten to "done" for 7 days at every terminal decision below (handled,
  // or deliberately ignored), and deleted if the pipeline throws. A delivery
  // that dies half-way is therefore answered 500 and redelivered into an
  // unclaimed window instead of being deduped away with the reply lost.
  const claimId = deliveryId(request, payload);
  const claim   = await claimDelivery(claimId);
  if (claim === 'duplicate') {
    console.log('[inbound-email] duplicate delivery — already handled');
    return NextResponse.json({ ok: true, deduped: true });
  }
  if (claim === 'in_progress') {
    console.log('[inbound-email] delivery already in flight — asking for a retry');
    return NextResponse.json({ error: 'in_progress' }, { status: 409 });
  }

  // ── 6. Extract "to" address and reply token ───────────────────────────────
  const toField = payload.to;
  let toAddress = '';
  if (Array.isArray(toField) && toField.length > 0) {
    const first = toField[0] as Record<string, unknown>;
    toAddress = typeof first.email === 'string' ? first.email : '';
  } else if (typeof toField === 'string') {
    toAddress = toField;
  }

  // Every deliberate ignore below closes the claim first: the decision would
  // come out the same on a redelivery, so the id is spent, not released.
  const token = extractReplyToken(toAddress);
  if (!token) {
    console.warn('[inbound-email] no reply token found in to address');
    await markDeliveryDone(claimId);
    return NextResponse.json({ ok: true }); // Ack to avoid Resend retries
  }

  // ── 7. Verify HMAC-signed token ───────────────────────────────────────────
  const verifyResult = verifyOutreachToken(token);
  if (!verifyResult.ok) {
    console.warn('[inbound-email] invalid outreach token:', verifyResult.reason);
    await markDeliveryDone(claimId);
    return NextResponse.json({ ok: true }); // Ack — don't retry on invalid tokens
  }

  const { projectId, expertId } = verifyResult.data;

  // ── 8. Resolve project + expert (Redis index preferred) ──────────────────
  const indexed = await lookupReplyToken(token);
  if (!indexed) {
    console.warn('[inbound-email] token not in index — using token payload');
  }

  const resolvedProjectId = indexed?.projectId ?? projectId;
  const resolvedExpertId  = indexed?.expertId  ?? expertId;

  // These two do NOT close the claim: a missing project or row can be a
  // transient read, and the id expiring in CLAIM_TTL_S lets a later redelivery
  // look again. A genuinely deleted project simply gets ignored twice.
  const project = await getProject(resolvedProjectId);
  if (!project) {
    console.error('[inbound-email] project not found');
    return NextResponse.json({ ok: true });
  }

  const pe = project.experts.find(e => e.expert.id === resolvedExpertId);
  if (!pe) {
    console.error('[inbound-email] expert not found in project');
    return NextResponse.json({ ok: true });
  }

  // ── 9. Sender authenticity — the verdicts, then the address ──────────────
  // The address comparison below stops a forward or a colleague, which is what
  // it is for, but it is not authentication: the From header is
  // attacker-controlled, so anyone holding a reply token (a forwarded email, a
  // leaked thread) could mail reply+TOKEN@ as the expert and decline,
  // counter-rate or accept on their behalf. senderAuthAllows reads the SPF,
  // DKIM and DMARC verdicts out of the payload and refuses a hard DKIM or DMARC
  // fail — the two that a forged From cannot survive.
  //
  // As of the 2026-09 Resend docs the inbound webhook carries metadata only and
  // supplies none of those verdicts, so in production this allows every message
  // and raises one system failure a day instead, until the payload gains them
  // or the founder moves inbound to a relay that reports them.
  const auth = senderAuthAllows(payload);
  if (!auth.present) {
    await noteMissingAuthResults();
  } else if (!auth.allow) {
    console.warn('[inbound-email] sender authentication failed — ignored',
      { failed: auth.failed.join(',') });
    await markDeliveryDone(claimId);
    return NextResponse.json({ ok: true });
  }

  // ── 10. Sender check — only the address we mailed can move the thread ────
  const fromAddress    = extractFromAddress(payload.from);
  const expectedSender = pe.contactEmail?.trim().toLowerCase() ?? '';
  if (!expectedSender || fromAddress !== expectedSender) {
    const keyHash = pseudonymize(`${resolvedProjectId}:${resolvedExpertId}`);
    try {
      const store = getRlStore();
      // 30-day counter, incremented for observability only — never gates.
      await store.increment(`rl:inbound-from-mismatch:${keyHash}`, 30 * 24 * 60 * 60 * 1000);
    } catch {
      // Non-fatal — the counter is diagnostic, not a control.
    }
    console.warn('[inbound-email] sender does not match contact email — ignored', { keyHash });
    await markDeliveryDone(claimId);
    return NextResponse.json({ ok: true });
  }

  // ── 11. Body ──────────────────────────────────────────────────────────────
  const emailText = typeof payload.text === 'string' ? payload.text : '';
  if (!emailText.trim()) {
    console.warn('[inbound-email] empty email body');
    await markDeliveryDone(claimId);
    return NextResponse.json({ ok: true });
  }

  // ── 12. Handle, then close the claim ─────────────────────────────────────
  // A throw here means the thread is in an unknown state, so the claim is
  // released and the 500 asks Resend to redeliver. The retry may repeat work
  // that had already succeeded (a stored message, an emitted event); that is
  // the price of not losing the reply, and the message-level
  // `resend_message_id` makes the duplicate visible in the data.
  try {
    await handleReply({
      project, pe, token,
      rawEmail:        emailText,
      resendMessageId: extractResendMessageId(payload),
    });
  } catch (err) {
    console.error('[inbound-email] handling failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    await releaseDelivery(claimId);
    return NextResponse.json({ error: 'processing_failed' }, { status: 500 });
  }

  await markDeliveryDone(claimId);
  return NextResponse.json({ ok: true });
}

// ─── The reply pipeline ───────────────────────────────────────────────────────

interface HandleReplyInput {
  project:  Project;
  pe:       ProjectExpert;
  token:    string;
  rawEmail: string;
  /** The sender's Message-ID, stored on the row as a second dedupe signal. */
  resendMessageId: string | null;
}

async function handleReply({ project, pe, token, rawEmail, resendMessageId }: HandleReplyInput): Promise<void> {
  const projectId = project.id;
  const expertId  = pe.expert.id;
  const now       = Date.now();

  const context = await loadThreadContext(project);
  const revealed = isIdentityRevealed(pe);

  // ── Clean ────────────────────────────────────────────────────────────────
  // Quoted history and signatures are stripped BEFORE the screen runs, so a
  // phone number sitting in a quoted footer of our own email does not read as
  // the expert handing over their number.
  const bodyClean = cleanEmailBody(rawEmail);

  // ── Screen ───────────────────────────────────────────────────────────────
  // Inbound is never blocked — an expert cannot be told to rewrite their email.
  // The findings are recorded and lib/conversations.redactMessageForViewer
  // masks them out of what the client reads.
  const screenResult = screenMessage({
    text:             bodyClean,
    direction:        'expert_to_client',
    identityRevealed: revealed,
    clientFirmName:   context.clientFirmName,
    expertFullName:   pe.expert.name,
    clientFullName:   context.clientFullName,
  });

  // ── Store ────────────────────────────────────────────────────────────────
  const stored = await appendMessage({
    projectId,
    expertId,
    direction: 'inbound',
    author:    'expert',
    bodyRaw:   rawEmail,     // encrypted inside appendMessage
    bodyClean,
    screenResult,
    resendMessageId,
  });

  await emitEngagementEvent({
    projectId, expertId, orgId: context.orgId,
    type:    'reply_received',
    payload: {
      screenFindings: screenResult.findings.length,
      hoursSinceContact: pe.contactedAt ? Math.round((now - pe.contactedAt) / 3_600_000) : 0,
    },
  });

  // ── Scheduling branch — runs INSTEAD of the classifier ───────────────────
  // An engagement that is waiting on a time, or already has one, is asking a
  // narrower question than the five outreach intents can answer.
  if (pe.status === 'scheduling_sent' || pe.status === 'scheduled') {
    const handled = await advanceScheduling({ project, pe, context, bodyClean, storedId: stored?.id ?? null });
    if (handled) return;
  }

  // ── Classify + summarize — ONE model call ────────────────────────────────
  const read = await classifyMessage({
    text:             bodyClean,
    identityRevealed: revealed,
    clientFirmName:   context.clientFirmName,
    expertFullName:   pe.expert.name,
    clientFullName:   context.clientFullName,
  });

  if (stored) {
    await updateMessage(stored.id, { intent: read.intent, summary: read.summary });
  }

  await emitEngagementEvent({
    projectId, expertId, orgId: context.orgId,
    type:    'intent_classified',
    payload: { intent: read.intent, hasRate: read.ratePosition !== null, fallback: read.fallback },
  });

  // ── Stage ────────────────────────────────────────────────────────────────
  switch (read.intent) {
    case 'declined':
      await advanceDeclined({ project, pe, context, now });
      return;

    case 'counter_rate':
      await advanceCounterRate({ project, pe, context, read, now });
      return;

    case 'conflict':
      await advanceConflict({ project, pe, context, read, now });
      return;

    case 'interested':
      await advanceInterested({ project, pe, context, read, token, now });
      return;

    default:
      // 'unclear' — it lands on the thread with its summary and a person looks.
      await updateExpertStatus(projectId, expertId, {
        status:          'replied',
        replyDetectedAt: now,
        replyIntent:     'unclear',
        ...(read.availabilityNote ? { availability: read.availabilityNote } : {}),
      });
      return;
  }
}

interface AdvanceInput {
  project: Project;
  pe:      ProjectExpert;
  context: ThreadContext;
  now:     number;
}

// ─── Scheduling ───────────────────────────────────────────────────────────────

interface SchedulingInput {
  project:   Project;
  pe:        ProjectExpert;
  context:   ThreadContext;
  bodyClean: string;
  storedId:  string | null;
}

/**
 * A reply that arrived while a call was being scheduled, or after one was
 * booked. Returns TRUE when it handled the reply and the generic classifier
 * must not run.
 *
 * The five cases:
 *
 *   chosen       book it (or MOVE it, when a reschedule was already in flight,
 *                so a rebook never creates a second meeting)
 *   unavailable  store what they said they are free for, then propose again
 *                while rounds remain; out of rounds, mark
 *                'expert_declined_times' and stop guessing
 *   reschedule   only meaningful on a booked call: ask for a new time
 *   declined     hand back to the ordinary decline path, which suppresses the
 *                address globally — a "no" is a fact about the person
 *   unclear      the message is already on the thread with its summary; leave
 *                the status alone and let a person look
 *
 * Never throws: any failure returns false and the classifier runs as before,
 * which is the behaviour that existed before this branch did.
 */
async function advanceScheduling(input: SchedulingInput): Promise<boolean> {
  const { project, pe, context, bodyClean, storedId } = input;
  const projectId = project.id;
  const expertId  = pe.expert.id;
  const state     = pe.scheduling ?? emptySchedulingState();
  const booked    = pe.status === 'scheduled';

  try {
    // On a BOOKED call the cheap regex answers first: "something came up" needs
    // no model call to be understood.
    if (booked && looksLikeReschedule(bodyClean)) {
      await noteScheduling(storedId, 'reschedule', 'They want to move the call. Finding new times.');
      await requestReschedule({ project, pe });
      return true;
    }

    const read = await parseSchedulingReply({
      text:         bodyClean,
      proposed:     state.proposed,
      timezoneHint: state.expertTimezone,
    });

    if (read.kind === 'declined') return false;   // the ordinary decline path

    if (read.kind === 'chosen') {
      const result = booked
        ? await rebookCall({ projectId, expertId, startUtc: read.startUtc, by: 'expert' })
        : await bookCall({ projectId, expertId, startUtc: read.startUtc, by: 'expert' });

      if (!result.ok) {
        console.warn('[inbound-email] booking failed', JSON.stringify({ reason: result.reason }));
        await noteScheduling(storedId, 'time_chosen', 'They picked a time. I could not book it.');
        return true;
      }

      await noteScheduling(storedId, 'time_chosen', 'They picked a time. Booked.');
      return true;
    }

    if (read.kind === 'reschedule') {
      if (!booked) return false;   // nothing to move; let the classifier read it
      await noteScheduling(storedId, 'reschedule', 'They want to move the call. Finding new times.');
      await requestReschedule({ project, pe });
      return true;
    }

    if (read.kind === 'unavailable') {
      await noteScheduling(storedId, 'time_unavailable',
        'None of those times work. Looking for others.');

      // What they said they ARE free for feeds the next round's overlap.
      await writeExpert(projectId, expertId, {
        replyIntent:     'time_unavailable',
        availabilityRaw: bodyClean.slice(0, 800),
        ...(read.windows.length > 0 ? {
          availabilitySlots:     read.windows,
          availabilitySubmitted: true,
          calendarProvider:      'manual' as const,
        } : {}),
      });

      await emitEngagementEvent({
        projectId, expertId, orgId: context.orgId,
        type:    'time_declined',
        payload: { round: state.round, viaPicker: false, windows: read.windows.length },
      });

      if (state.round < MAX_PROPOSAL_ROUNDS) {
        const fresh   = await getProject(projectId);
        const freshPe = fresh?.experts.find(e => e.expert.id === expertId);
        if (fresh && freshPe) {
          await proposeTimes({ project: fresh, pe: freshPe, reason: 'initial', trigger: 'matchy' });
          return true;
        }
      }

      // Out of rounds. Record it and let the client take it from here; the
      // picker link in their last email still works, so they can still write in.
      await writeExpert(projectId, expertId, {
        scheduling: { ...state, outcome: 'expert_declined_times' },
      });
      return true;
    }

    // 'unclear' — it is on the thread, with a summary. Nothing moves.
    await noteScheduling(storedId, null, 'Replied about scheduling. Nothing I can act on yet.');
    return true;
  } catch (err) {
    console.error('[inbound-email] scheduling branch failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return false;
  }
}

/**
 * The one-line read the client sees on the stored message. Deliberately fixed
 * text rather than anything a model wrote: nothing here is generated, so
 * nothing here can leak.
 */
async function noteScheduling(
  storedId: string | null,
  intent:   'time_chosen' | 'time_unavailable' | 'reschedule' | null,
  summary:  string,
): Promise<void> {
  if (!storedId) return;
  await updateMessage(storedId, { summary, ...(intent ? { intent } : {}) });
}

/**
 * Ask the expert for a new time for a call that is already booked. The booking
 * STAYS in place and the status stays 'scheduled' until they pick: an expert
 * who never answers must not silently lose the call they already agreed to.
 */
async function requestReschedule(
  args: { project: Project; pe: ProjectExpert },
): Promise<void> {
  await proposeTimes({
    project: args.project,
    pe:      args.pe,
    reason:  'reschedule',
    trigger: 'matchy',
  });
}

async function advanceDeclined({ project, pe, context, now }: AdvanceInput): Promise<void> {
  await updateExpertStatus(project.id, pe.expert.id, {
    status:          'rejected_after_outreach',
    replyDetectedAt: now,
    replyIntent:     'declined',
  });

  // "No" is a fact about the person, not about this project — the global
  // do-not-contact list stops the next project cold-emailing them again.
  if (pe.contactEmail) {
    await suppress(pe.contactEmail, 'declined', project.id);
  }

  await emitEngagementEvent({
    projectId: project.id, expertId: pe.expert.id, orgId: context.orgId,
    type:    'rejected',
    payload: { reason: 'declined' },
  });
}

async function advanceCounterRate(
  input: AdvanceInput & { read: MatchyClassification },
): Promise<void> {
  const { project, pe, context, read, now } = input;

  // The expert stated a number, or they asked for "more" without one. Without
  // a number there is nothing to convert, so the stage still moves and the
  // client decides from the summary.
  const counter       = read.ratePosition;
  const clientCounter = counter ? clientRateFor(counter) : null;

  await updateExpertStatus(project.id, pe.expert.id, {
    status:          'rate_negotiation',
    replyDetectedAt: now,
    replyIntent:     'counter_rate',
    ...(counter ? {
      expertCounterRate:   counter,
      clientCounterRate:   clientCounter,
      // The legacy field the old cadence wrote. Kept in step so nothing that
      // still reads it goes stale.
      counterRateProposed: counter,
    } : {}),
    ...(read.availabilityNote ? { availability: read.availabilityNote } : {}),
  });

  await emitEngagementEvent({
    projectId: project.id, expertId: pe.expert.id, orgId: context.orgId,
    type:    'rate_countered',
    payload: {
      expertRate:          pe.expertRate ?? 0,
      counterRate:         counter ?? 0,
      clientRateForCounter: clientCounter ?? 0,
    },
  });
}

async function advanceConflict(
  input: AdvanceInput & { read: MatchyClassification },
): Promise<void> {
  const { project, pe, context, read, now } = input;

  await updateExpertStatus(project.id, pe.expert.id, {
    status:          'conflict_flagged',
    replyDetectedAt: now,
    replyIntent:     'conflict',
    ...(read.conflictNote ? { conflictNote: read.conflictNote } : {}),
  });

  await emitEngagementEvent({
    projectId: project.id, expertId: pe.expert.id, orgId: context.orgId,
    type:    'conflict_flagged',
    payload: { hasNote: read.conflictNote !== null },
  });
}

/**
 * A yes.
 *
 * The status becomes 'replied' first, so the pipeline is right even if the
 * follow-up cannot go out. Then, ONCE per engagement and only from the state
 * the intro left behind:
 *   - review-first project → the follow-up is DRAFTED onto the thread with the
 *     pending flag and waits for POST .../messages/[messageId]/send
 *   - walkthrough project  → the follow-up is written to the thread marked
 *     `held: 'walkthrough'`, which is NOT pending: it can never be released
 *     while the project is not live (lib/walkthrough.ts)
 *   - otherwise            → it is sent, status becomes 'followup_sent', and
 *     `rate_offered` is emitted
 *
 * `followupSentAt` is the guard: a second "sounds good" on the same thread
 * never produces a second rate ask.
 */
async function advanceInterested(
  input: AdvanceInput & { read: MatchyClassification; token: string },
): Promise<void> {
  const { project, pe, context, read, token, now } = input;
  const projectId = project.id;
  const expertId  = pe.expert.id;

  await updateExpertStatus(projectId, expertId, {
    status:          'replied',
    replyDetectedAt: now,
    replyIntent:     'interested',
    ...(read.availabilityNote ? { availability: read.availabilityNote } : {}),
    // A yes to the follow-up is a yes to the standing rate: lock the
    // per-expert rate (Matchy 2.0) in the same write as the status.
    ...(pe.status === 'followup_sent' ? { rateAgreedAt: now } : {}),
  });

  // THE FOLLOW-UP IS ALREADY OUT and they have come back with a yes. That is
  // an acceptance of the standing rate: the follow-up asked "does $X work?" and
  // nothing in the reply countered it, so the money is settled and the next
  // thing Matchy owes them is a time. Guarded on the STATUS, not just on
  // `followupSentAt`, so a yes arriving after the engagement moved on (already
  // negotiating, already scheduling, already booked) falls through as before.
  if (pe.status === 'followup_sent') {
    await emitEngagementEvent({
      projectId, expertId, orgId: context.orgId,
      type:    'rate_agreed',
      payload: {
        expertRate: pe.expertRate ?? 0,
        clientRate: pe.clientRate ?? 0,
        source:     'standing_rate_accepted',
      },
    });

    // Re-read: the status write above is not on the `pe` we were handed.
    const fresh   = await getProject(projectId);
    const freshPe = fresh?.experts.find(e => e.expert.id === expertId);
    if (fresh && freshPe) {
      await proposeTimes({ project: fresh, pe: freshPe, reason: 'initial', trigger: 'matchy' });
    }
    return;
  }

  if (pe.followupSentAt || pe.email2SentAt) {
    console.log('[inbound-email] follow-up already sent — nothing further', { projectId });
    return;
  }
  // Only the state the intro leaves behind earns a follow-up. A yes arriving
  // after the engagement moved on (already negotiating, already scheduled) is
  // just a message on the thread.
  if (pe.status !== 'contacted' && pe.status !== 'replied') {
    console.log('[inbound-email] status advanced past outreach — no follow-up', { projectId });
    return;
  }
  if (!pe.contactEmail) return;

  const expertRate = pe.expertRate ?? 0;
  if (expertRate <= 0) {
    // Fails closed, the same way the sequence does: a follow-up quotes a
    // number, and there is no default number.
    console.warn('[inbound-email] no expert rate — follow-up not sent', { projectId });
    return;
  }

  // The client's firm name is a deny term so a research question naming the
  // client's own firm cannot be generalised into the follow-up's topic.
  const firm = await getFirm(project.firmDomain).catch(() => null);
  const email = buildFollowUpEmail({
    topic:           deriveTopic(project, { denyTerms: firm?.name ? [firm.name] : [] }),
    expertRate,
    expertFirstName: pe.expert.name,
    recipientEmail:  pe.contactEmail,
  });

  // The CAN-SPAM footer is part of the template's text; cleanEmailBody strips
  // it back off for the copy stored on the thread, so the client reads the
  // message and not the legal boilerplate.
  const storedBody = cleanEmailBody(email.text);

  const held = isWalkthrough(project);

  if (held) {
    // Written, readable, and permanently not sendable from here. Held is not
    // pending, so no approve button renders and the status does not advance.
    await appendMessage({
      projectId, expertId,
      direction: 'outbound',
      author:    'matchy',
      bodyClean: storedBody,
      summary:   WALKTHROUGH_HELD_SUMMARY,
      held:      'walkthrough',
    });
    return;
  }

  if (project.reviewFirst === true) {
    await appendMessage({
      projectId, expertId,
      direction: 'outbound',
      author:    'matchy',
      bodyClean: storedBody,
      summary:   'Follow-up drafted. Approve it and I will send it.',
      pendingApproval: true,
    });
    return;
  }

  const outcome = await sendSequenceEmail(pe.contactEmail, email.subject, email.text, pe.outreachToken ?? token, 'followup', {
    footerIncluded: true,
    html:           email.html,
  });

  // The chokepoint refused it (walkthrough flipped mid-flight, or
  // DISABLE_EMAILS). Store it as pending rather than as sent, and do NOT
  // advance to 'followup_sent' — nothing has been asked of the expert yet.
  if (!outcome.sent) {
    await appendMessage({
      projectId, expertId,
      direction: 'outbound',
      author:    'matchy',
      bodyClean: storedBody,
      summary:   'Follow-up drafted. Approve it and I will send it.',
      pendingApproval: true,
    });
    return;
  }

  await appendMessage({
    projectId, expertId,
    direction: 'outbound',
    author:    'matchy',
    bodyClean: storedBody,
    summary:   'Sent the conflict questions and the rate ask. Waiting on their terms.',
  });

  await updateExpertStatus(projectId, expertId, {
    status:         'followup_sent',
    followupSentAt: Date.now(),
  });

  await emitEngagementEvent({
    projectId, expertId, orgId: context.orgId,
    type:    'rate_offered',
    payload: { expertRate, clientRate: clientRateFor(expertRate) },
  });
}

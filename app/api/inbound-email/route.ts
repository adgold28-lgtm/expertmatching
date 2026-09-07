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
//   - after a verified signature the handler always answers 200, so Resend
//     does not retry a reply we deliberately ignored.
//
// WHAT IS NEW:
//   - IDEMPOTENCY. Resend retries on any non-2xx and on a timeout. The old
//     handler had no dedupe at all, so a retry could re-suppress an address,
//     re-emit events and (now) send a second follow-up. The svix message id is
//     claimed in Redis with SET NX before any side effect; a second delivery of
//     the same id acknowledges and does nothing. It FAILS OPEN — if Redis is
//     unavailable the message is processed rather than dropped, because losing
//     a reply is worse than duplicating one.
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
import { createHmac } from 'crypto';
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
import { emitEngagementEvent } from '../../../lib/engagementEvents';
import { isIdentityRevealed } from '../../../lib/redactExpert';
import { buildFollowUpEmail, deriveTopic } from '../../../lib/matchyTemplates';
import { sendSequenceEmail } from '../../../lib/emailSequence';
import { isWalkthrough, WALKTHROUGH_HELD_SUMMARY } from '../../../lib/walkthrough';
import { clientRateFor } from '../../../lib/pricing';
import { getFirm, getUser } from '../../../lib/firmStore';
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

function pseudonymize(value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-fallback-secret';
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 16);
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

/** How long a processed delivery id is remembered. Resend retries for ~24h. */
const DEDUPE_TTL_S = 7 * 24 * 60 * 60;

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
 * Claims this delivery. True means "you are the first, carry on"; false means
 * "already handled, acknowledge and stop".
 *
 * FAILS OPEN on every error and when there is no Redis at all: a duplicated
 * reply is a smaller failure than a lost one.
 */
async function claimDelivery(id: string | null): Promise<boolean> {
  if (!id) return true;
  const redis = getUpstashClient();
  if (!redis) return true;

  try {
    const result = await redis.set(`inbound-seen:${id}`, '1', { ex: DEDUPE_TTL_S, nx: true });
    return result === 'OK';
  } catch {
    return true;
  }
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
  // Matches: reply+TOKEN@expertmatch.fit or "Name <reply+TOKEN@expertmatch.fit>"
  const match = toAddress.match(/reply\+([A-Za-z0-9._~-]+)@expertmatch\.fit/i);
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
  if (!(await claimDelivery(deliveryId(request, payload)))) {
    console.log('[inbound-email] duplicate delivery — already handled');
    return NextResponse.json({ ok: true, deduped: true });
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

  const token = extractReplyToken(toAddress);
  if (!token) {
    console.warn('[inbound-email] no reply token found in to address');
    return NextResponse.json({ ok: true }); // Ack to avoid Resend retries
  }

  // ── 7. Verify HMAC-signed token ───────────────────────────────────────────
  const verifyResult = verifyOutreachToken(token);
  if (!verifyResult.ok) {
    console.warn('[inbound-email] invalid outreach token:', verifyResult.reason);
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

  // ── 9. Sender check — only the address we mailed can move the thread ─────
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
    return NextResponse.json({ ok: true });
  }

  // ── 10. Body ──────────────────────────────────────────────────────────────
  const emailText = typeof payload.text === 'string' ? payload.text : '';
  if (!emailText.trim()) {
    console.warn('[inbound-email] empty email body');
    return NextResponse.json({ ok: true });
  }

  try {
    await handleReply({ project, pe, token, rawEmail: emailText });
  } catch (err) {
    console.error('[inbound-email] handling failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
  }

  return NextResponse.json({ ok: true });
}

// ─── The reply pipeline ───────────────────────────────────────────────────────

interface HandleReplyInput {
  project:  Project;
  pe:       ProjectExpert;
  token:    string;
  rawEmail: string;
}

async function handleReply({ project, pe, token, rawEmail }: HandleReplyInput): Promise<void> {
  const projectId = project.id;
  const expertId  = pe.expert.id;
  const now       = Date.now();

  const context = await loadThreadContext(project);
  const revealed = isIdentityRevealed(pe.status);

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
  });

  await emitEngagementEvent({
    projectId, expertId, orgId: context.orgId,
    type:    'reply_received',
    payload: {
      screenFindings: screenResult.findings.length,
      hoursSinceContact: pe.contactedAt ? Math.round((now - pe.contactedAt) / 3_600_000) : 0,
    },
  });

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
  });

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

  const email = buildFollowUpEmail({
    topic:           deriveTopic(project),
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

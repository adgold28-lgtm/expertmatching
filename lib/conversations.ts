// The thread — every message between one client and one expert.
//
// Matchy relays: the expert writes ordinary email, the client writes in the
// app, and neither ever sees the other's address. `conversation_messages` is
// where both halves live (migration 20260907000000_matchy_phase1.sql). This
// module is the only sanctioned way in and out of that table.
//
// WHAT IS STORED
//   body_raw    — inbound only, the email exactly as it arrived, AES-256-GCM
//                 ciphertext from lib/encryption.ts. Postgres never holds the
//                 plaintext and NOTHING in this module ever returns it to a
//                 caller. It exists for a support escalation with the key in
//                 hand, not for the product.
//   body_clean  — what the reader sees: quoted history and signature stripped
//                 by lib/emailClean.ts.
//   summary     — Matchy's one line (lib/matchyClassify.ts), already screened.
//   intent      — the classifier label, never free text.
//   screen_result — the lib/matchyScreen.ts verdict, PLUS one Matchy-owned
//                 flag; see PENDING APPROVAL below.
//
// PENDING APPROVAL (no new column — Phase 1 ships no second migration)
//   When a project is on "review first", Matchy still drafts the follow-up but
//   must not send it. The draft is stored as an ordinary outbound message with
//   `{ "pending": true }` set alongside `blocked` and `findings` inside the
//   `screen_result` jsonb. A message carrying that flag has NOT been sent;
//   POST .../messages/[messageId]/send clears the flag and sends it. The flag
//   lives in jsonb precisely so it costs no schema change — if a later phase
//   wants an approval audit trail, that is when the column earns its migration.
//
// HELD (same jsonb, same reason)
//   A project in walkthrough mode sends nothing (lib/walkthrough.ts). Matchy
//   still writes the message so the client can read exactly what would have
//   gone out, stored with `{ "held": "walkthrough" }`. A held message is NOT
//   pending: there is no approve button, because nothing can release it until
//   the owner switches the project live. The two flags are never both set.
//
// WRITES ARE SERVICE-ROLE ONLY. `conversation_messages` has an RLS read policy
// for project members and no write policy at all, so a browser session can
// never insert a message; every write goes through here, from a server route
// that has already checked access.
//
// Never logs: message bodies, summaries, expert names, expert addresses.

import { getServiceRoleClient } from './supabase/admin';
import { encrypt } from './encryption';
import type { ConversationMessageRow } from './supabase/database.types';
import {
  maskFindings,
  maskContactDetails,
  maskCurrency,
  type ScreenFinding,
  type ScreenResult,
} from './matchyScreen';
import { isIdentityRevealed } from './redactExpert';
import { toHeldReason, type HeldReason } from './walkthrough';
import type { ExpertStatus, ReplyIntent } from '../types';

// ─── Shapes ───────────────────────────────────────────────────────────────────

export type MessageDirection = 'inbound' | 'outbound';
export type MessageAuthor    = 'client' | 'expert' | 'matchy';

/**
 * What actually sits in the `screen_result` column: the screen's verdict plus
 * Matchy's review-first flag. `pending: true` means "drafted, not sent".
 */
export interface StoredScreenResult {
  blocked:  boolean;
  findings: ScreenFinding[];
  /** Review-first: this outbound message is a draft awaiting approval. */
  pending?: boolean;
  /**
   * The send was HELD and can never be released from this record: walkthrough
   * mode, or the environment kill switch (lib/walkthrough.ts). Distinct from
   * `pending`, which is a draft the client can approve — a held message has no
   * send button, because the project is not live. The two are never both set.
   */
  held?: HeldReason;
}

export interface AppendMessageInput {
  projectId: string;
  expertId:  string;
  direction: MessageDirection;
  author:    MessageAuthor;
  /** PLAINTEXT inbound email. Encrypted here — callers never encrypt. */
  bodyRaw?:        string | null;
  bodyClean?:      string | null;
  summary?:        string | null;
  intent?:         ReplyIntent | null;
  screenResult?:   ScreenResult | null;
  /** Review-first draft: stored, not sent. */
  pendingApproval?: boolean;
  /** Walkthrough (or DISABLE_EMAILS): stored, never sent, not approvable. */
  held?: HeldReason;
  resendMessageId?: string | null;
}

/** One message as a viewer is allowed to see it. Carries no address, ever. */
export interface ViewerMessage {
  id:        string;
  direction: MessageDirection;
  author:    MessageAuthor;
  /** The displayable body, masked for this viewer. Never the raw email. */
  body:      string;
  summary:   string | null;
  intent:    ReplyIntent | null;
  screenResult: StoredScreenResult | null;
  /** True when this is a drafted message that has not been sent. */
  pendingApproval: boolean;
  /** Why this message was never sent, or null when it went out normally. */
  held: HeldReason | null;
  createdAt: string;
}

export interface MessageViewer {
  role:   'admin' | 'user';
  /**
   * Whether identities are revealed on this engagement — the caller computes it
   * with lib/redactExpert.isIdentityRevealed(projectExpert), which needs the
   * server-written booking record, not just a status a client can write.
   */
  revealed: boolean;
  /**
   * The expert's real full name, when the caller has it. Pre-reveal it is
   * masked out of the body, which catches the commonest leak the screen does
   * not flag on an inbound message: the expert signing their own name.
   */
  expertFullName?: string;
  /**
   * The expert's employer, when the caller has it. Pre-reveal it is masked the
   * same way — "I ran ops at Acme for ten years" gives the person away as
   * surely as a surname does.
   */
  expertCompany?: string;
}

/** The one-line read the Matches / Conversations cards show. */
export interface ThreadSummary {
  summary:   string | null;
  intent:    ReplyIntent | null;
  direction: MessageDirection;
  createdAt: string;
}

const VALID_INTENTS: readonly ReplyIntent[] = [
  'interested', 'declined', 'counter_rate', 'conflict', 'unclear',
  'time_chosen', 'time_unavailable', 'reschedule',
];

function toIntent(value: string | null): ReplyIntent | null {
  return value && VALID_INTENTS.includes(value as ReplyIntent) ? (value as ReplyIntent) : null;
}

function toStoredScreenResult(value: unknown): StoredScreenResult | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const obj = value as Record<string, unknown>;
  const findings = Array.isArray(obj.findings) ? (obj.findings as ScreenFinding[]) : [];
  const held = toHeldReason(obj.held);
  return {
    blocked:  obj.blocked === true,
    findings,
    ...(obj.pending === true ? { pending: true } : {}),
    ...(held ? { held } : {}),
  };
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Append one message to a thread.
 *
 * Returns the stored row, or null when there is no service-role client (local
 * development on the in-memory project store) or the insert fails. A failed
 * write must never take down the send or the webhook that triggered it, so
 * this resolves rather than throwing and the caller decides what a null means.
 */
export async function appendMessage(
  input: AppendMessageInput,
): Promise<ConversationMessageRow | null> {
  const { projectId, expertId, direction, author } = input;
  if (!projectId || !expertId) return null;

  const db = getServiceRoleClient();
  if (!db) {
    console.warn('[conversations] no service-role client — message not stored',
      JSON.stringify({ direction, author }));
    return null;
  }

  // A held message is NOT pending: nothing can release it while the project is
  // in walkthrough, so it must never render an approve/send control.
  const held    = input.held ?? null;
  const pending = !held && input.pendingApproval === true;

  const screenResult: StoredScreenResult | null = input.screenResult
    ? {
        blocked:  input.screenResult.blocked,
        findings: input.screenResult.findings,
        ...(pending ? { pending: true } : {}),
        ...(held    ? { held }          : {}),
      }
    : (pending || held)
      ? { blocked: false, findings: [], ...(pending ? { pending: true } : {}), ...(held ? { held } : {}) }
      : null;

  try {
    const { data, error } = await db
      .from('conversation_messages')
      .insert({
        project_id: projectId,
        expert_id:  expertId,
        direction,
        author,
        // Plaintext in, ciphertext at rest. Outbound messages have no raw
        // email — we composed them, body_clean IS the message.
        body_raw:   input.bodyRaw ? encrypt(input.bodyRaw) : null,
        body_clean: input.bodyClean ?? null,
        summary:    input.summary ?? null,
        intent:     input.intent ?? null,
        screen_result: (screenResult ?? null) as never,
        resend_message_id: input.resendMessageId ?? null,
      })
      .select()
      .single();

    if (error) {
      console.warn('[conversations] insert failed',
        JSON.stringify({ direction, author, reason: error.message.slice(0, 120) }));
      return null;
    }
    return data as ConversationMessageRow;
  } catch (err) {
    console.warn('[conversations] append failed',
      JSON.stringify({ direction, author, reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown' }));
    return null;
  }
}

export interface UpdateMessageInput {
  summary?:      string | null;
  intent?:       ReplyIntent | null;
  screenResult?: StoredScreenResult | null;
  resendMessageId?: string | null;
}

/**
 * Patch a stored message — used for the two things that are only known after
 * the insert: the classifier's `intent` + `summary`, and clearing the
 * review-first `pending` flag once an approved draft has actually gone out.
 */
export async function updateMessage(
  messageId: string,
  patch: UpdateMessageInput,
): Promise<ConversationMessageRow | null> {
  const db = getServiceRoleClient();
  if (!db || !messageId) return null;

  const update: Record<string, unknown> = {};
  if (patch.summary !== undefined)      update.summary = patch.summary;
  if (patch.intent !== undefined)       update.intent = patch.intent;
  if (patch.screenResult !== undefined) update.screen_result = patch.screenResult;
  if (patch.resendMessageId !== undefined) update.resend_message_id = patch.resendMessageId;
  if (Object.keys(update).length === 0) return null;

  try {
    const { data, error } = await db
      .from('conversation_messages')
      .update(update as never)
      .eq('id', messageId)
      .select()
      .single();

    if (error) {
      console.warn('[conversations] update failed',
        JSON.stringify({ reason: error.message.slice(0, 120) }));
      return null;
    }
    return data as ConversationMessageRow;
  } catch (err) {
    console.warn('[conversations] update failed',
      JSON.stringify({ reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown' }));
    return null;
  }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/** Hard cap on a thread read — a relay thread never legitimately runs longer. */
export const MAX_THREAD_MESSAGES = 500;

/**
 * Every message on one thread, oldest first. Raw rows — the caller MUST pass
 * each one through `redactMessageForViewer` before it reaches a browser.
 */
export async function listThread(
  projectId: string,
  expertId: string,
): Promise<ConversationMessageRow[]> {
  const db = getServiceRoleClient();
  if (!db || !projectId || !expertId) return [];

  try {
    const { data, error } = await db
      .from('conversation_messages')
      .select('*')
      .eq('project_id', projectId)
      .eq('expert_id', expertId)
      .order('created_at', { ascending: true })
      .limit(MAX_THREAD_MESSAGES);

    if (error) {
      console.warn('[conversations] thread read failed',
        JSON.stringify({ reason: error.message.slice(0, 120) }));
      return [];
    }
    return (data ?? []) as ConversationMessageRow[];
  } catch (err) {
    console.warn('[conversations] thread read failed',
      JSON.stringify({ reason: err instanceof Error ? err.message.slice(0, 120) : 'unknown' }));
    return [];
  }
}

/** One message by id, scoped to its thread so an id from another project misses. */
export async function getMessage(
  projectId: string,
  expertId: string,
  messageId: string,
): Promise<ConversationMessageRow | null> {
  const db = getServiceRoleClient();
  if (!db || !projectId || !expertId || !messageId) return null;

  try {
    const { data, error } = await db
      .from('conversation_messages')
      .select('*')
      .eq('project_id', projectId)
      .eq('expert_id', expertId)
      .eq('id', messageId)
      .maybeSingle();

    if (error) return null;
    return (data ?? null) as ConversationMessageRow | null;
  } catch {
    return null;
  }
}

/**
 * The latest summarized message on a thread — what the Matches and
 * Conversations cards show under an expert's name ("Interested. Free Tue/Thu
 * afternoons ET."). Already screened when it was written, so it is safe to
 * render as-is; `redactMessageForViewer` masks it again anyway.
 */
export async function latestSummary(
  projectId: string,
  expertId: string,
): Promise<ThreadSummary | null> {
  const db = getServiceRoleClient();
  if (!db || !projectId || !expertId) return null;

  try {
    const { data, error } = await db
      .from('conversation_messages')
      .select('summary, intent, direction, created_at')
      .eq('project_id', projectId)
      .eq('expert_id', expertId)
      .not('summary', 'is', null)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error || !data) return null;

    const row = data as Pick<ConversationMessageRow, 'summary' | 'intent' | 'direction' | 'created_at'>;
    return {
      summary:   row.summary,
      intent:    toIntent(row.intent),
      direction: row.direction,
      createdAt: row.created_at,
    };
  } catch {
    return null;
  }
}

// ─── Redaction ────────────────────────────────────────────────────────────────

/**
 * The message as this viewer may see it.
 *
 * Rules, in order:
 *   1. `body_raw` is NEVER returned, to anybody. The displayable body is
 *      always `body_clean`; a message with no clean body shows as empty.
 *   2. Platform admins (staff) see the clean body untouched — they run the
 *      escalations and need what was actually written.
 *   3. A client reading an expert→client message BEFORE the identity reveal
 *      gets the body masked: every contact detail and name the screen found is
 *      replaced with `[removed]`, then a second context-free sweep removes any
 *      email, link or phone number the screen did not record, then the
 *      expert's own name (when the caller supplied it) goes the same way.
 *      Belt and braces — anonymization is the product.
 *   4. After the reveal, names may cross; contact details still may not, so
 *      the contact-detail sweep stays on.
 *   5. Matchy's own outbound messages quote the EXPERT-side rate, because they
 *      were written for the expert. Every dollar amount in them is masked for a
 *      client; staff see the real copy.
 *   6. The client's own outbound messages are returned as written — they wrote
 *      them, and a blocked one was never stored.
 *
 * Pure: no I/O, never throws.
 */
export function redactMessageForViewer(
  message: ConversationMessageRow,
  viewer: MessageViewer,
): ViewerMessage {
  const stored   = toStoredScreenResult(message.screen_result);
  const revealed = viewer.revealed;

  let body = message.body_clean ?? '';

  if (viewer.role !== 'admin' && body) {
    const fromExpert = message.direction === 'inbound' || message.author === 'expert';

    if (fromExpert) {
      // 1. Everything the screen already identified.
      if (stored?.findings?.length) body = maskFindings(body, stored.findings);
      // 2. Anything it did not — a signature line added after the screen ran,
      //    a link in a format the screen's host list does not know.
      body = maskContactDetails(body);
      // 3. The expert's own name and employer, while the identity is still
      //    anonymized.
      if (!revealed && viewer.expertFullName) body = maskName(body, viewer.expertFullName);
      if (!revealed && viewer.expertCompany)  body = maskCompany(body, viewer.expertCompany);
    } else if (message.author === 'matchy') {
      // Matchy's own outbound copy is written FOR THE EXPERT and quotes
      // `expertRate` (lib/matchyTemplates.buildFollowUpEmail). The client is
      // only ever shown client-side numbers, so the amounts come out on the
      // way to a client's screen. Their number is on the expert card as
      // `clientRate`.
      body = maskCurrency(body);
    }
  }

  let summary = message.summary;
  if (viewer.role !== 'admin' && summary) {
    summary = maskContactDetails(summary);
    if (!revealed && viewer.expertFullName) summary = maskName(summary, viewer.expertFullName);
    if (!revealed && viewer.expertCompany)  summary = maskCompany(summary, viewer.expertCompany);
  }

  return {
    id:        message.id,
    direction: message.direction,
    author:    message.author,
    body,
    summary:   summary ?? null,
    intent:    toIntent(message.intent),
    screenResult: stored,
    pendingApproval: stored?.pending === true && !stored?.held,
    held:      stored?.held ?? null,
    createdAt: message.created_at,
  };
}

/**
 * Replaces a person's full name and its identifying halves with `[removed]`.
 * The surname alone counts — the platform shows the client "Scott S.", so the
 * bare first name is not what gives the person away.
 */
function maskName(text: string, fullName: string): string {
  const parts = fullName.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return text;

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const first = parts[0];
  const last  = parts[parts.length - 1];

  const patterns: RegExp[] = [];
  if (parts.length >= 2) {
    patterns.push(new RegExp(`\\b${escape(first)}\\s+${escape(last)}\\b`, 'gi'));
    patterns.push(new RegExp(`\\b${escape(last)}\\s*,\\s*${escape(first)}\\b`, 'gi'));
  }
  if (last.length >= 3) patterns.push(new RegExp(`\\b${escape(last)}\\b`, 'gi'));

  let out = text;
  for (const pattern of patterns) out = out.replace(pattern, '[removed]');
  return out;
}

/**
 * Words too generic to identify an employer on their own. A company called
 * "Global Partners Group" is masked as a phrase, but the bare word "global" in
 * an unrelated sentence is left alone.
 */
const GENERIC_COMPANY_WORDS = new Set([
  'inc', 'llc', 'ltd', 'plc', 'corp', 'corporation', 'company', 'co', 'group', 'holdings',
  'partners', 'capital', 'ventures', 'labs', 'technologies', 'technology', 'systems',
  'solutions', 'services', 'international', 'global', 'national', 'american', 'european',
  'the', 'and', 'of', 'for', 'at', 'in', 'on', 'a', 'an', 'health', 'medical', 'consulting',
  'advisors', 'advisory', 'management', 'industries', 'enterprises', 'associates', 'limited',
]);

/**
 * Replaces the expert's employer with `[removed]`: the full name as written,
 * and any distinctive word of it (4+ letters, not a generic business word) on
 * its own, so "Acme" is caught when the expert writes "back when I was at
 * Acme". Pure; never throws.
 */
export function maskCompany(text: string, company: string): string {
  const clean = company.trim();
  if (!clean) return text;

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns: RegExp[] = [new RegExp(`\\b${escape(clean)}(?:'s)?\\b`, 'gi')];

  for (const word of clean.split(/[\s,&/-]+/)) {
    const bare = word.replace(/[^A-Za-z0-9]/g, '');
    if (bare.length < 4 || GENERIC_COMPANY_WORDS.has(bare.toLowerCase())) continue;
    patterns.push(new RegExp(`\\b${escape(bare)}(?:'s)?\\b`, 'gi'));
  }

  let out = text;
  for (const pattern of patterns) out = out.replace(pattern, '[removed]');
  return out;
}

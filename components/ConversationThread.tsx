'use client';

// One expert's thread: everything Matchy has relayed in either direction, the
// decisions waiting on the client, and the composer.
//
// What the client sees and does not see (docs/MATCHY_SPEC.md, "Pricing rule"):
//   • Every number on this screen is the CLIENT-side rate. `expertRate` and
//     `expertCounterRate` are never read here — the counter card renders the
//     client-side counter (`clientCounterRate`) when the API supplies it, and
//     the summary alone when it does not.
//   • No email addresses, no providers, no email numbering. An expert message
//     is Matchy's summary with the cleaned body beneath it.
//   • The Accept / Offer buttons send an ACTION, never text. They used to post
//     "Yes — $1,300/hr works." to the messages endpoint, which emails the body
//     verbatim — so the expert received the number that includes our fee. They
//     now post { action } to .../rate-decision, and the server writes the
//     outbound line from a template carrying only the expert-side figure. The
//     labels stay in client dollars, which is what the client is agreeing to.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectExpert } from '../types';
import {
  fetchThread,
  sendMessage,
  sendPendingMessage,
  approveOutreach,
  clientCounterRateOf,
  isPendingApproval,
  firstNameOf,
  formatRate,
  type ConversationMessage,
  type ProjectExpertWithCounter,
  type ScreenFinding,
} from '../lib/matchyClient';
import MatchyLine from './MatchyLine';
import ClientReadyCard from './ClientReadyCard';
import { CLIENT_STATUS_META } from './matchyStatus';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  projectId:      string;
  /** The expert as the project knows them — the list's source of truth. */
  projectExpert:  ProjectExpert;
  /** Owner or staff. Collaborators read the thread and cannot send. */
  canSend:        boolean;
  onExpertUpdate: (updated: ProjectExpert) => void;
  /** Reports the newest inbound timestamp so the list can clear its dot. */
  onInboundSeen:  (expertId: string, latestInboundMs: number) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Plain nouns for what the screen found. No rule names, no codes. */
const FINDING_NOUN: Record<string, string> = {
  phone:               'phone number',
  email:               'email address',
  url:                 'link',
  scheduling_link:     'scheduling link',
  client_firm_name:    'firm name',
  expert_real_name:    'name',
  client_real_name:    'name',
  off_platform_phrase: 'phrase',
  money:               'rate',
};

function findingNoun(kind: string): string {
  return FINDING_NOUN[kind] ?? kind.replace(/_/g, ' ');
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const COLLAPSE_AFTER_LINES = 6;

function isLong(body: string): boolean {
  return body.split('\n').length > COLLAPSE_AFTER_LINES;
}

function firstLines(body: string): string {
  return body.split('\n').slice(0, COLLAPSE_AFTER_LINES).join('\n');
}

/** The most recent message that came from the expert, if any. */
function latestInbound(messages: ConversationMessage[]): ConversationMessage | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].direction === 'inbound') return messages[i];
  }
  return null;
}

// ─── Message rows ─────────────────────────────────────────────────────────────

function ExpertMessage({ message, expertFirstName }: { message: ConversationMessage; expertFirstName: string }) {
  const [open, setOpen] = useState(false);
  const long = isLong(message.body);

  return (
    <div className="border border-frame bg-cream">
      <div className="px-3.5 py-2 border-b border-frame/70 flex items-center justify-between gap-3">
        <p className="text-[10px] uppercase tracking-widest text-navy font-semibold" style={{ letterSpacing: '0.14em' }}>
          {expertFirstName}
        </p>
        <p className="text-[10px] text-muted">{formatTime(message.createdAt)}</p>
      </div>

      {message.summary && (
        <div className="px-3.5 py-2.5 bg-surface border-b border-frame/70">
          <MatchyLine>{message.summary}</MatchyLine>
        </div>
      )}

      {message.body && (
        <div className="px-3.5 py-2.5">
          <p className="text-[12px] text-ink leading-relaxed whitespace-pre-wrap">
            {long && !open ? firstLines(message.body) : message.body}
          </p>
          {long && (
            <button
              type="button"
              onClick={() => setOpen(o => !o)}
              className="mt-1.5 text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
              style={{ letterSpacing: '0.12em' }}
            >
              {open ? 'Show less' : 'Show full message'}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MatchyMessage({
  message,
  onSend,
  sending,
  canSend,
}: {
  message: ConversationMessage;
  onSend:  (messageId: string) => void;
  sending: boolean;
  canSend: boolean;
}) {
  const pending = isPendingApproval(message);
  return (
    <div className="pl-1 space-y-1.5">
      <MatchyLine tone={pending ? 'default' : 'quiet'}>{message.body}</MatchyLine>
      <div className="flex items-center gap-3 pl-[52px]">
        <span className="text-[10px] text-muted/70">{formatTime(message.createdAt)}</span>
        {pending && (
          <>
            <span className="text-[10px] text-amber-700">Waiting on you</span>
            {canSend && (
              <button
                type="button"
                onClick={() => onSend(message.id)}
                disabled={sending}
                className="text-[10px] uppercase tracking-widest bg-navy text-cream px-2.5 py-1 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                style={{ letterSpacing: '0.1em' }}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function ClientMessage({ message }: { message: ConversationMessage }) {
  const pending = isPendingApproval(message);
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%]">
        <div className="border border-navy/20 bg-navy/5 px-3.5 py-2.5">
          <p className="text-[12px] text-ink leading-relaxed whitespace-pre-wrap">{message.body}</p>
        </div>
        <p className="text-[10px] text-muted/70 mt-1 text-right">
          {pending ? 'Held for review · ' : ''}{formatTime(message.createdAt)}
        </p>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ConversationThread({
  projectId,
  projectExpert,
  canSend,
  onExpertUpdate,
  onInboundSeen,
}: Props) {
  const expertId  = projectExpert.expert.id;
  const firstName = firstNameOf(projectExpert.expert.name);

  const [messages,  setMessages]  = useState<ConversationMessage[]>([]);
  const [threadPE,  setThreadPE]  = useState<ProjectExpertWithCounter | null>(null);
  const [loading,   setLoading]   = useState(true);
  const [loadError, setLoadError] = useState('');

  const [draft,     setDraft]     = useState('');
  const [sending,   setSending]   = useState(false);
  const [findings,  setFindings]  = useState<ScreenFinding[]>([]);
  const [sendError, setSendError] = useState('');
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  const [noteText,   setNoteText]   = useState(projectExpert.userNotes ?? '');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteSaved,  setNoteSaved]  = useState(false);
  const [marking,    setMarking]    = useState(false);

  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async (showSpinner: boolean) => {
    if (showSpinner) setLoading(true);
    const res = await fetchThread(projectId, expertId);
    if (showSpinner) setLoading(false);
    if (!res.ok) {
      // A thread that does not exist yet is not an error worth shouting about.
      if (res.status === 404) { setMessages([]); setLoadError(''); return; }
      setLoadError(res.message);
      return;
    }
    setLoadError('');
    setMessages(res.messages ?? []);
    if (res.projectExpert) setThreadPE(res.projectExpert);
    const inbound = latestInbound(res.messages ?? []);
    if (inbound) {
      const ms = new Date(inbound.createdAt).getTime();
      if (!Number.isNaN(ms)) onInboundSeen(expertId, ms);
    }
  }, [projectId, expertId, onInboundSeen]);

  // Reset per-expert state on switch, then load. Separate from the poll so a
  // background refresh never blanks the pane.
  useEffect(() => {
    setMessages([]);
    setThreadPE(null);
    setDraft('');
    setFindings([]);
    setSendError('');
    setNoteText(projectExpert.userNotes ?? '');
    setNoteSaved(false);
    void load(true);
    // projectExpert.userNotes is seeded once per expert on purpose — retyping
    // in the box must not be overwritten by a project refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expertId, load]);

  // A reply can land at any moment; the thread is the only place it shows.
  useEffect(() => {
    const interval = setInterval(() => { void load(false); }, 20_000);
    return () => clearInterval(interval);
  }, [load]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'nearest' });
  }, [messages.length]);

  const pe        = threadPE ?? (projectExpert as ProjectExpertWithCounter);
  const status    = pe.status;
  const statusPill = CLIENT_STATUS_META[status];

  // ── Sending ────────────────────────────────────────────────────────────────

  async function send(text: string, clearDraft: boolean) {
    const body = text.trim();
    if (!body || sending) return;
    setSending(true);
    setFindings([]);
    setSendError('');
    const res = await sendMessage(projectId, expertId, body);
    setSending(false);
    if (!res.ok) {
      if (res.error === 'message_blocked') { setFindings(res.findings ?? []); return; }
      setSendError(res.message);
      return;
    }
    if (clearDraft) setDraft('');
    await load(false);
  }

  /**
   * Accept the expert's counter, or hold at the standing rate.
   *
   * Nothing the client typed goes anywhere: the button sends the decision and
   * the server writes the expert-facing line from a template with the
   * expert-side number in it. 403 (a collaborator) and 409 (nothing to accept)
   * come back with a written message and land on the same error line a blocked
   * send uses.
   */
  async function decideRate(action: 'accept' | 'counter') {
    if (sending) return;
    setSending(true);
    setFindings([]);
    setSendError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/experts/${expertId}/rate-decision`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => null) as
        { message?: string; projectExpert?: ProjectExpertWithCounter } | null;

      if (!res.ok) {
        setSendError(data?.message ?? 'Something went wrong. Try again.');
        return;
      }
      if (data?.projectExpert) {
        setThreadPE(data.projectExpert);
        onExpertUpdate(data.projectExpert);
      }
      await load(false);
    } catch {
      setSendError("Couldn't reach the server. Try again.");
    } finally {
      setSending(false);
    }
  }

  /** Review-first: the intro is written and waiting on the client. */
  async function approveIntro() {
    setApproving(true);
    setSendError('');
    const res = await approveOutreach(projectId, expertId);
    setApproving(false);
    if (!res.ok) { setSendError(res.message); return; }
    setThreadPE(res.projectExpert);
    onExpertUpdate(res.projectExpert);
    await load(false);
  }

  async function releasePending(messageId: string) {
    setPendingId(messageId);
    const res = await sendPendingMessage(projectId, expertId, messageId);
    setPendingId(null);
    if (!res.ok) { setSendError(res.message); return; }
    await load(false);
  }

  // ── Post-call ──────────────────────────────────────────────────────────────

  async function saveNote() {
    const note = noteText.trim();
    if (note === (projectExpert.userNotes ?? '').trim()) return;
    setNoteSaving(true);
    setNoteSaved(false);
    try {
      const res = await fetch(`/api/projects/${projectId}/experts/${expertId}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ userNotes: note }),
      });
      if (res.ok) {
        const d = await res.json() as { project?: { experts: ProjectExpert[] } };
        const updated = d.project?.experts.find(e => e.expert.id === expertId);
        if (updated) onExpertUpdate(updated);
        setNoteSaved(true);
      }
    } catch {
      // Transient — the text is still in the box and the next blur retries.
    } finally {
      setNoteSaving(false);
    }
  }

  async function markReadyToBook() {
    setMarking(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/experts/${expertId}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ screeningStatus: 'client_ready' }),
      });
      if (res.ok) {
        const d = await res.json() as { project?: { experts: ProjectExpert[] } };
        const updated = d.project?.experts.find(e => e.expert.id === expertId);
        if (updated) onExpertUpdate(updated);
      }
    } catch {
      // Transient — the button stays available.
    } finally {
      setMarking(false);
    }
  }

  // ── Decision card ──────────────────────────────────────────────────────────

  const inbound          = latestInbound(messages);
  const hasPendingMatchy = messages.some(m => m.author === 'matchy' && isPendingApproval(m));
  const wantsDecision = inbound?.intent === 'counter_rate';
  const counterRate   = clientCounterRateOf(pe);
  const standingRate  = typeof pe.clientRate === 'number' ? pe.clientRate : null;
  const canCounter    = counterRate !== null && standingRate !== null && standingRate < counterRate;

  // ── Wrap-up numbers ────────────────────────────────────────────────────────

  // ── No address yet ─────────────────────────────────────────────────────────
  // A client never sees `contactEmail` (it is stripped by redactExpertForViewer),
  // so the status is the tell: bookmark only leaves an expert on 'bookmarked'
  // when it could not write to them — no address found, suppressed, or the
  // check was unavailable. An address moves them to contact_found /
  // outreach_drafted / contacted. There is nothing to reply to until then, and
  // the messages endpoint would answer `thread_not_started` anyway.
  const noAddressYet = status === 'bookmarked';

  const callMinutes = pe.actualDurationMin ?? pe.callDurationMin ?? null;
  const charged     = typeof pe.invoiceAmount === 'number' ? pe.invoiceAmount : null;
  const isCompleted = status === 'completed';
  const readyToBook = pe.screeningStatus === 'client_ready';

  return (
    <div className="border border-frame bg-surface flex flex-col min-h-[520px]">

      {/* ── Header ── */}
      <div className="px-4 py-3 border-b border-frame flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <p className="text-sm font-medium text-navy truncate">{projectExpert.expert.name}</p>
          <p className="text-[11px] text-muted leading-snug line-clamp-2">
            {projectExpert.expert.anonymizedDescriptor
              ?? [projectExpert.expert.title, projectExpert.expert.company].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {typeof pe.clientRate === 'number' && pe.clientRate > 0 && (
            <span className="text-[10px] text-muted">{formatRate(pe.clientRate)}/hr · includes ExpertMatch fee</span>
          )}
          <span className={`text-[10px] px-2 py-0.5 border font-medium uppercase tracking-wider ${statusPill.classes}`}>
            {statusPill.label}
          </span>
        </div>
      </div>

      {/* ── Call + billing strip ── */}
      {(pe.zoomJoinUrl || callMinutes != null || pe.paymentStatus) && (
        <div className="px-4 py-2 border-b border-frame bg-cream flex items-center gap-4 flex-wrap">
          {pe.zoomJoinUrl && (
            <a
              href={pe.zoomJoinUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[11px] text-navy font-medium hover:underline underline-offset-2"
            >
              Join the call →
            </a>
          )}
          {pe.paymentStatus === 'paid' && callMinutes != null && charged != null && (
            <span className="text-[11px] text-muted">
              Call ran {callMinutes} min → {formatRate(charged)} charged.
            </span>
          )}
          {pe.paymentStatus === 'failed' && (
            <span className="text-[11px] text-red-600">Card declined — update your card.</span>
          )}
          {(pe.paymentStatus === 'unpaid' || pe.paymentStatus === 'invoice_sent') && charged != null && (
            <span className="text-[11px] text-muted">Charging {formatRate(charged)}.</span>
          )}
        </div>
      )}

      {/* ── Messages ── */}
      <div className="flex-1 px-4 py-4 space-y-3.5 overflow-y-auto max-h-[540px]">
        {loading && (
          <div className="flex items-center gap-2 text-[11px] text-muted">
            <span className="inline-block w-3 h-3 border border-navy border-t-transparent rounded-full animate-spin" />
            Loading the thread…
          </div>
        )}

        {!loading && loadError && <p className="text-[11px] text-red-600">{loadError}</p>}

        {!loading && !loadError && messages.length === 0 && (
          <MatchyLine variant="card" tone="quiet">
            {status === 'bookmarked'
              ? `No address on file for ${firstName} yet. Bookmark again to retry, or pass.`
              : `Nothing from ${firstName} yet. I'll put their reply here.`}
          </MatchyLine>
        )}

        {messages.map(m => {
          if (m.author === 'expert') {
            return <ExpertMessage key={m.id} message={m} expertFirstName={firstName} />;
          }
          if (m.author === 'matchy') {
            return (
              <MatchyMessage
                key={m.id}
                message={m}
                onSend={releasePending}
                sending={pendingId === m.id}
                canSend={canSend}
              />
            );
          }
          return <ClientMessage key={m.id} message={m} />;
        })}

        {/* ── Review-first: the intro is written and waiting ── */}
        {status === 'outreach_drafted' && !hasPendingMatchy && (
          <div className="border border-sky-200 bg-sky-50 px-3.5 py-3 space-y-2">
            <MatchyLine>Intro drafted — review and send.</MatchyLine>
            {canSend && (
              <div className="pl-[52px]">
                <button
                  type="button"
                  onClick={() => { void approveIntro(); }}
                  disabled={approving}
                  className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                  style={{ letterSpacing: '0.1em' }}
                >
                  {approving ? 'Sending…' : 'Send the intro'}
                </button>
              </div>
            )}
          </div>
        )}

        {/* ── Rate decision ── */}
        {wantsDecision && counterRate !== null && (
          <div className="border border-amber-300 bg-amber-50 px-3.5 py-3 space-y-2.5">
            <MatchyLine>
              {firstName} wants {formatRate(counterRate)}/hr — that&apos;s what you&apos;d pay, ExpertMatch fee included.
            </MatchyLine>
            {canSend && (
              <div className="flex items-center gap-2 flex-wrap pl-[52px]">
                <button
                  type="button"
                  onClick={() => { void decideRate('accept'); }}
                  disabled={sending}
                  className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                  style={{ letterSpacing: '0.1em' }}
                >
                  Accept {formatRate(counterRate)}/hr
                </button>
                {canCounter && standingRate !== null && (
                  <button
                    type="button"
                    onClick={() => { void decideRate('counter'); }}
                    disabled={sending}
                    className="text-[10px] uppercase tracking-widest text-navy border border-navy/30 hover:border-navy px-3 py-1.5 disabled:opacity-40 transition-colors"
                    style={{ letterSpacing: '0.1em' }}
                  >
                    Offer {formatRate(standingRate)}
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ── After the call ── */}
      {isCompleted && (
        <div className="border-t border-frame px-4 py-3 space-y-2.5 bg-cream">
          <p className="text-[10px] uppercase tracking-widest text-navy font-semibold" style={{ letterSpacing: '0.16em' }}>
            After the call
          </p>
          <textarea
            value={noteText}
            onChange={e => { setNoteText(e.target.value); setNoteSaved(false); }}
            onBlur={() => { void saveNote(); }}
            rows={3}
            placeholder="What did you learn on this call? Key themes, surprises, hesitations…"
            className="w-full px-2.5 py-2 text-[12px] border border-frame bg-surface focus:outline-none focus:border-navy text-ink resize-none"
          />
          <div className="flex items-center gap-3 flex-wrap">
            {noteSaving && <span className="text-[10px] text-muted">Saving…</span>}
            {!noteSaving && noteSaved && <span className="text-[10px] text-green-700">Note saved</span>}
            {canSend && !readyToBook && (
              <button
                type="button"
                onClick={() => { void markReadyToBook(); }}
                disabled={marking}
                className="ml-auto text-[10px] uppercase tracking-widest text-navy border border-navy/30 hover:border-navy px-3 py-1.5 disabled:opacity-40 transition-colors"
                style={{ letterSpacing: '0.1em' }}
              >
                {marking ? 'Saving…' : 'Mark ready to book'}
              </button>
            )}
            {readyToBook && <span className="ml-auto text-[10px] uppercase tracking-widest text-green-700">Ready to book</span>}
          </div>
          {readyToBook && <ClientReadyCard projectExpert={pe} />}
        </div>
      )}

      {/* ── Composer ── */}
      <div className="border-t border-frame px-4 py-3 space-y-2">
        {!canSend ? (
          <p className="text-[11px] text-muted">Only the project owner can message experts.</p>
        ) : (
          <>
            <textarea
              value={draft}
              onChange={e => setDraft(e.target.value)}
              rows={3}
              placeholder={noAddressYet
                ? `Nothing to reply to yet.`
                : `Write to ${firstName} — I'll relay it.`}
              disabled={sending || noAddressYet}
              className="w-full px-2.5 py-2 text-[12px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink resize-none disabled:opacity-50"
            />

            {noAddressYet && (
              <p className="text-[11px] text-muted">
                No address on file yet — I&apos;ll open this up as soon as there is one.
              </p>
            )}

            {findings.length > 0 && (
              <div className="border border-amber-300 bg-amber-50 px-3 py-2 space-y-1">
                {findings.map((f, i) => (
                  <p key={`${f.kind}-${i}`} className="text-[11px] text-amber-800 leading-relaxed">
                    Remove: {findingNoun(f.kind)} &lsquo;{f.match}&rsquo; — {f.hint}
                  </p>
                ))}
              </div>
            )}

            {sendError && <p className="text-[11px] text-red-600">{sendError}</p>}

            <div className="flex items-center justify-between gap-3">
              <p className="text-[10px] text-muted/70">
                Identities and contact details stay off the thread until the call is booked.
              </p>
              <button
                type="button"
                onClick={() => { void send(draft, true); }}
                disabled={sending || noAddressYet || !draft.trim()}
                className="shrink-0 text-[10px] uppercase tracking-widest bg-navy text-cream px-4 py-2 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                style={{ letterSpacing: '0.12em' }}
              >
                {sending ? 'Sending…' : 'Send'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

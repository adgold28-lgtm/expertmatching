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
//   • WALKTHROUGH MODE (lib/walkthrough.ts): the thread is fully usable and
//     nothing leaves the building. Held messages carry a grey tag instead of a
//     send control, a follow-up drafted before the switch shows its Send button
//     disabled, and the composer stays open — practising the reply is the point.
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
  isHeld,
  firstNameOf,
  formatRate,
  proposeTimes,
  schedulingLine,
  proposedSlotsOf,
  formatSlot,
  viewerZoneLabel,
  bookingIcsUrl,
  PREFERENCES_MAX,
  type ConversationMessage,
  type MessageIntent,
  type ProjectExpertWithCounter,
  type ScreenFinding,
} from '../lib/matchyClient';
import MatchyLine from './MatchyLine';
import ClientReadyCard from './ClientReadyCard';
import { CLIENT_STATUS_META } from './matchyStatus';
import { WALKTHROUGH_HELD_SUMMARY } from '../lib/walkthrough';

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  projectId:      string;
  /** The expert as the project knows them — the list's source of truth. */
  projectExpert:  ProjectExpert;
  /** Owner or staff. Collaborators read the thread and cannot send. */
  canSend:        boolean;
  /**
   * Platform admin (role 'admin' from /api/auth/me). Gates the Staff panel —
   * the one place the retired Outreach / Screen / Deliver badges survive.
   */
  isAdmin:        boolean;
  /**
   * True while the project is in walkthrough mode: every send is held, so the
   * thread says so rather than pretending. See lib/walkthrough.ts.
   */
  walkthrough:    boolean;
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

/**
 * The scheduling intents get a tag next to the timestamp so a client can scan
 * the thread for the one message that moved the call. The negotiation intents
 * stay untagged: the rate decision card already says what they mean, and a
 * second label next to it would only repeat it.
 */
const INTENT_TAG: Partial<Record<MessageIntent, string>> = {
  time_chosen:      'Picked a time',
  time_unavailable: 'Needs other times',
  reschedule:       'Wants to move the call',
};

function intentTag(intent: MessageIntent | null): string | null {
  return intent ? INTENT_TAG[intent] ?? null : null;
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

// ─── Staff panel (platform admins only) ──────────────────────────────────────
//
// The Outreach, Screen and Deliver steps are gone. The status detail they
// carried — the address Matchy writes to, both sides of the rate, the call
// length, the payment state, the Zoom links, the expert's payout onboarding —
// still matters to whoever is running the desk, so it lives here: collapsed,
// read-only, and rendered ONLY for role 'admin'.
//
// Everything below reads the RAW record. lib/redactExpert.ts strips
// contactEmail, expertRate, expertCounterRate and expertOnboardingStatus for
// every non-admin viewer, so a client's payload has nothing here to show even
// if this panel somehow rendered.

/** "casey@acme.com" → "…@acme.com". The address itself is one click away. */
function maskAddress(email: string): string {
  const at = email.lastIndexOf('@');
  return at > 0 ? `…${email.slice(at)}` : '…';
}

function StaffRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-baseline gap-2">
      <span
        className="shrink-0 w-36 text-[9px] uppercase tracking-widest text-muted font-medium"
        style={{ letterSpacing: '0.14em' }}
      >
        {label}
      </span>
      <span className="text-[11px] text-ink break-all">{children}</span>
    </div>
  );
}

function StaffPanel({ pe }: { pe: ProjectExpertWithCounter }) {
  const [open,     setOpen]     = useState(false);
  const [showMail, setShowMail] = useState(false);

  const contactEmail   = pe.contactEmail ?? null;
  const expertRate     = typeof pe.expertRate === 'number' ? pe.expertRate : null;
  const clientRate     = typeof pe.clientRate === 'number' ? pe.clientRate : null;
  const expertCounter  = typeof pe.expertCounterRate === 'number' ? pe.expertCounterRate : null;
  const clientCounter  = clientCounterRateOf(pe);
  const durationMin    = pe.actualDurationMin ?? pe.callDurationMin ?? null;
  const invoiceAmount  = typeof pe.invoiceAmount === 'number' ? pe.invoiceAmount : null;
  const scheduledTime  = pe.scheduledTime ?? null;

  return (
    <div className="border-b border-frame bg-cream/60">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full px-4 py-1.5 flex items-center gap-2 text-left hover:bg-cream transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-gold"
      >
        <span
          className="text-[9px] uppercase tracking-widest text-muted font-semibold"
          style={{ letterSpacing: '0.18em' }}
        >
          Staff
        </span>
        <span className="text-[10px] text-muted/70">
          {open ? 'Hide' : 'Show'} the internal record
        </span>
        <span aria-hidden className="ml-auto text-[10px] text-muted/70">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1 space-y-1.5">
          <StaffRow label="Address">
            {contactEmail ? (
              <>
                {showMail ? contactEmail : maskAddress(contactEmail)}
                <button
                  type="button"
                  onClick={() => setShowMail(v => !v)}
                  className="ml-2 text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
                  style={{ letterSpacing: '0.12em' }}
                >
                  {showMail ? 'Hide' : 'Reveal'}
                </button>
              </>
            ) : (
              <span className="text-muted">none on file</span>
            )}
          </StaffRow>

          <StaffRow label="Expert rate">
            {expertRate !== null ? `${formatRate(expertRate)}/hr` : <span className="text-muted">not set</span>}
            {expertCounter !== null && ` · countered ${formatRate(expertCounter)}/hr`}
          </StaffRow>

          <StaffRow label="Client rate">
            {clientRate !== null ? `${formatRate(clientRate)}/hr` : <span className="text-muted">not set</span>}
            {clientCounter !== null && ` · counter reads ${formatRate(clientCounter)}/hr`}
          </StaffRow>

          <StaffRow label="Call">
            {durationMin !== null ? `${durationMin} min` : <span className="text-muted">not recorded</span>}
            {pe.zoomMeetingStarted && !pe.zoomMeetingEndedAt && ' · in progress'}
            {pe.zoomMeetingEndedAt && ` · ended ${formatTime(new Date(pe.zoomMeetingEndedAt).toISOString())}`}
          </StaffRow>

          <StaffRow label="Scheduling">
            {scheduledTime ?? (pe.calendarEventId ? 'calendar event booked' : <span className="text-muted">not booked</span>)}
            {pe.zoomJoinUrl && (
              <a
                href={pe.zoomJoinUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 text-navy hover:underline underline-offset-2"
              >
                Zoom link
              </a>
            )}
          </StaffRow>

          <StaffRow label="Payment">
            {pe.paymentStatus ?? <span className="text-muted">none</span>}
            {invoiceAmount !== null && ` · ${formatRate(invoiceAmount)}`}
            {pe.stripePaymentLinkUrl && (
              <a
                href={pe.stripePaymentLinkUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="ml-2 text-navy hover:underline underline-offset-2"
              >
                Invoice
              </a>
            )}
          </StaffRow>

          <StaffRow label="Expert payout">
            {pe.expertOnboardingStatus ?? <span className="text-muted">not started</span>}
            {pe.expertPaidAt != null && ` · paid ${formatTime(new Date(pe.expertPaidAt).toISOString())}`}
          </StaffRow>

          <StaffRow label="Pipeline status">{pe.status}</StaffRow>
        </div>
      )}
    </div>
  );
}

// ─── Message rows ─────────────────────────────────────────────────────────────

function ExpertMessage({ message, expertFirstName }: { message: ConversationMessage; expertFirstName: string }) {
  const [open, setOpen] = useState(false);
  const long = isLong(message.body);
  const tag  = intentTag(message.intent);

  return (
    <div className="border border-frame bg-cream">
      <div className="px-3.5 py-2 border-b border-frame/70 flex items-center justify-between gap-3">
        <p className="text-[10px] uppercase tracking-widest text-navy font-semibold" style={{ letterSpacing: '0.14em' }}>
          {expertFirstName}
        </p>
        <div className="flex items-center gap-2 shrink-0">
          {tag && (
            <span
              className="text-[9px] uppercase tracking-widest border border-frame text-muted px-1.5 py-0.5"
              style={{ letterSpacing: '0.12em' }}
            >
              {tag}
            </span>
          )}
          <p className="text-[10px] text-muted">{formatTime(message.createdAt)}</p>
        </div>
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

/** The one spinner every in-flight button wears, in the button's own colour. */
function Spinner() {
  return (
    <span
      aria-hidden
      className="inline-block w-3 h-3 border border-current border-t-transparent rounded-full animate-spin"
    />
  );
}

/** The grey tag a held message wears in place of any send control. */
function HeldTag() {
  return (
    <span
      className="inline-block text-[9px] uppercase tracking-widest border border-frame text-muted px-1.5 py-0.5"
      style={{ letterSpacing: '0.12em' }}
    >
      Held · walkthrough
    </span>
  );
}

function MatchyMessage({
  message,
  onSend,
  sending,
  canSend,
  walkthrough,
}: {
  message: ConversationMessage;
  onSend:  (messageId: string) => void;
  sending: boolean;
  canSend: boolean;
  walkthrough: boolean;
}) {
  const held    = isHeld(message);
  const pending = isPendingApproval(message);
  return (
    <div className="pl-1 space-y-1.5">
      <MatchyLine tone={pending ? 'default' : 'quiet'}>{message.body}</MatchyLine>
      <div className="flex items-center gap-3 flex-wrap pl-[52px]">
        <span className="text-[10px] text-muted/70">{formatTime(message.createdAt)}</span>
        {held && <HeldTag />}
        {pending && (
          <>
            {/* A follow-up drafted before the project went back to walkthrough:
                it is still pending, but nothing can release it until the project
                is live, so the button says why rather than failing on click. */}
            <span className="text-[10px] text-amber-700">
              {walkthrough ? 'Switch to live to send.' : 'Waiting on you'}
            </span>
            {canSend && (
              <button
                type="button"
                onClick={() => onSend(message.id)}
                disabled={sending || walkthrough}
                title={walkthrough ? 'Nothing is sent in walkthrough mode' : undefined}
                className="text-[10px] uppercase tracking-widest bg-navy text-cream px-2.5 py-1 hover:bg-navy/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
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
  const held    = isHeld(message);
  const pending = isPendingApproval(message);
  return (
    <div className="flex justify-end">
      <div className="max-w-[80%]">
        <div className="border border-navy/20 bg-navy/5 px-3.5 py-2.5">
          <p className="text-[12px] text-ink leading-relaxed whitespace-pre-wrap">{message.body}</p>
        </div>
        <div className="flex items-center gap-2 flex-wrap justify-end mt-1">
          {held && <HeldTag />}
          <p className="text-[10px] text-muted/70">
            {pending ? 'Held for review · ' : ''}{formatTime(message.createdAt)}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ConversationThread({
  projectId,
  projectExpert,
  canSend,
  isAdmin,
  walkthrough,
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
  // What the last rate decision did. In walkthrough it says the line was held.
  const [decisionNote, setDecisionNote] = useState('');

  // ── Scheduling ──
  // `proposeOpen` is the preferences box; it opens from either the first-time
  // control or "Propose different times", and both post the same request.
  const [proposing,        setProposing]        = useState(false);
  const [proposeOpen,      setProposeOpen]      = useState(false);
  const [preferences,      setPreferences]      = useState('');
  const [scheduleNote,     setScheduleNote]     = useState('');
  const [scheduleError,    setScheduleError]    = useState('');
  const [scheduleFindings, setScheduleFindings] = useState<ScreenFinding[]>([]);
  const [confirmMove,      setConfirmMove]      = useState(false);

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
    setDecisionNote('');
    setProposeOpen(false);
    setPreferences('');
    setScheduleNote('');
    setScheduleError('');
    setScheduleFindings([]);
    setConfirmMove(false);
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
    setDecisionNote('');
    try {
      const res = await fetch(`/api/projects/${projectId}/experts/${expertId}/rate-decision`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action }),
      });
      const data = await res.json().catch(() => null) as
        { message?: string; held?: boolean; projectExpert?: ProjectExpertWithCounter } | null;

      if (!res.ok) {
        setSendError(data?.message ?? 'Something went wrong. Try again.');
        return;
      }
      // The rate moved either way; in walkthrough the line to the expert did not
      // go, and saying so is the whole point of the mode.
      setDecisionNote(data?.held
        ? 'Recorded. The reply to them was held — nothing is sent in walkthrough mode.'
        : action === 'accept'
          ? 'Rate agreed. I have told them.'
          : 'Held at your rate. I have told them.');
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

  /**
   * Ask Matchy for times, or ask it to move a booked call.
   *
   * Like the rate decision, this sends an ACTION and never text: the
   * preferences line is a hint for the slot picker, screened server side, and
   * the email to the expert is written from a template. A 422 comes back with
   * findings on that line and is rendered exactly as the composer renders them.
   * In walkthrough the server answers `held` and nothing changed, so the note
   * says so rather than claiming a proposal went out.
   */
  async function runProposeTimes(reason: 'initial' | 'reschedule') {
    if (proposing) return;
    setProposing(true);
    setScheduleError('');
    setScheduleFindings([]);
    setScheduleNote('');

    const hint = preferences.trim();
    const res  = await proposeTimes(projectId, expertId, {
      reason,
      ...(reason === 'initial' && hint ? { preferences: hint } : {}),
    });
    setProposing(false);

    if (!res.ok) {
      if (res.error === 'message_blocked') { setScheduleFindings(res.findings ?? []); return; }
      setScheduleError(res.message);
      return;
    }

    setThreadPE(res.projectExpert);
    onExpertUpdate(res.projectExpert);
    setProposeOpen(false);
    setPreferences('');
    setConfirmMove(false);
    setScheduleNote(
      res.held
        ? WALKTHROUGH_HELD_SUMMARY
        : schedulingLine(res.projectExpert, firstName)?.text
          ?? `Working on times with ${firstName}.`,
    );
    await load(false);
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

  // ── Scheduling ─────────────────────────────────────────────────────────────
  // `scheduling.outcome` is the record of the last thing Matchy did about the
  // call; `booking` is the call itself. A booking outranks the outcome, so a
  // payload whose outcome lags behind the status still reads correctly.
  const scheduling    = pe.scheduling ?? null;
  const booking       = pe.booking ?? null;
  const outcome       = scheduling?.outcome ?? null;
  const proposals     = proposedSlotsOf(pe);
  const scheduleLine  = schedulingLine(pe, firstName);
  const zoneLabel     = viewerZoneLabel();

  const showBooked   = booking !== null && status === 'scheduled';
  const showProposed = !showBooked
    && (status === 'scheduling_sent' || outcome === 'times_proposed' || outcome === 'link_sent');
  // Terms are settled and nothing has been proposed yet — or the last attempt
  // came back with nowhere to go, which is exactly when asking again is the fix.
  const canOfferTimes = canSend
    && messages.length > 0
    && (status === 'replied' || status === 'followup_sent' || status === 'rate_negotiation')
    && (outcome === null || outcome === 'expert_declined_times' || outcome === 'no_client_availability');

  /** The preferences box plus its button. Shared by the two places that offer times. */
  function preferencesRow(buttonLabel: string) {
    return (
      <div className="space-y-1.5">
        <div className="flex flex-col sm:flex-row sm:items-center gap-2">
          <input
            type="text"
            value={preferences}
            onChange={e => setPreferences(e.target.value)}
            maxLength={PREFERENCES_MAX}
            disabled={proposing}
            placeholder="Preferences (optional): mornings only, not Fridays"
            aria-label="Preferences for the call time"
            className="flex-1 min-w-0 px-2.5 py-2 text-[12px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink disabled:opacity-50"
          />
          <button
            type="button"
            onClick={() => { void runProposeTimes('initial'); }}
            disabled={proposing}
            className="w-full sm:w-auto shrink-0 inline-flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-2 hover:bg-navy/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            style={{ letterSpacing: '0.1em' }}
          >
            {proposing && <Spinner />}
            {proposing ? 'Working…' : buttonLabel}
          </button>
        </div>
        {walkthrough && (
          <p className="text-[10px] text-muted">
            Walkthrough mode. I work out the times and send nothing.
          </p>
        )}
      </div>
    );
  }

  /** Findings and errors from the last scheduling attempt, in the composer's style. */
  function scheduleFeedback() {
    return (
      <>
        {scheduleFindings.length > 0 && (
          <div className="border border-amber-300 bg-amber-50 px-3 py-2 space-y-1">
            {scheduleFindings.map((f, i) => (
              <p key={`${f.kind}-${i}`} className="text-[11px] text-amber-800 leading-relaxed">
                Remove: {findingNoun(f.kind)} &lsquo;{f.match}&rsquo; &middot; {f.hint}
              </p>
            ))}
          </div>
        )}
        {scheduleError && <p className="text-[11px] text-red-600">{scheduleError}</p>}
      </>
    );
  }

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

      {/* ── Staff panel (admins only) ── */}
      {isAdmin && <StaffPanel pe={pe} />}

      {/* ── Call + billing strip ──
            The Zoom link lives in the booked card once there is one; the strip
            keeps it for every other state and keeps billing either way. */}
      {((pe.zoomJoinUrl && !showBooked) || callMinutes != null || pe.paymentStatus) && (
        <div className="px-4 py-2 border-b border-frame bg-cream flex items-center gap-4 flex-wrap">
          {pe.zoomJoinUrl && !showBooked && (
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
              ? walkthrough
                ? `Walkthrough mode. I would look up an address and send ${firstName} the intro here. Nothing was sent.`
                : `No address on file for ${firstName} yet. Bookmark again to retry, or pass.`
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
                walkthrough={walkthrough}
              />
            );
          }
          return <ClientMessage key={m.id} message={m} />;
        })}

        {/* ── Review-first: the intro is written and waiting ── */}
        {status === 'outreach_drafted' && !hasPendingMatchy && (
          <div className={`border px-3.5 py-3 space-y-2 ${walkthrough ? 'border-frame bg-cream' : 'border-sky-200 bg-sky-50'}`}>
            <MatchyLine tone={walkthrough ? 'quiet' : 'default'}>
              {walkthrough
                ? "Intro written. Nothing is sent in walkthrough mode — switch this project to live and it's yours to send."
                : 'Intro drafted — review and send.'}
            </MatchyLine>
            {canSend && (
              <div className="pl-[52px] flex items-center gap-2 flex-wrap">
                <button
                  type="button"
                  onClick={() => { void approveIntro(); }}
                  disabled={approving || walkthrough}
                  title={walkthrough ? 'Nothing is sent in walkthrough mode' : undefined}
                  className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  style={{ letterSpacing: '0.1em' }}
                >
                  {approving ? 'Sending…' : 'Send the intro'}
                </button>
                {walkthrough && <span className="text-[10px] text-muted">Switch to live to send.</span>}
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

        {/* ── Times: offer some ──
              Terms are settled and the call is the only thing left. The
              preference line is a hint for the picker, not a message: the
              server screens it and writes the email from a template. */}
        {canOfferTimes && (
          <div className="border border-frame bg-cream px-3.5 py-3 space-y-2">
            <MatchyLine tone="quiet">
              {outcome === 'expert_declined_times'
                ? `None of the last times worked for ${firstName}. I can offer different ones.`
                : outcome === 'no_client_availability'
                  ? 'I need your hours first. Connect a calendar or add weekly hours in Settings, then try again.'
                  : `Ready to book ${firstName}. I will offer up to three times from your calendar.`}
            </MatchyLine>
            {preferencesRow('Propose times')}
            {scheduleFeedback()}
          </div>
        )}

        {/* ── Times: proposed, waiting on the expert ── */}
        {showProposed && (
          <div className="border border-teal-300 bg-teal-50 px-3.5 py-3 space-y-2.5">
            <MatchyLine>
              {scheduleLine?.text ?? `Sent ${firstName} a link to pick a time.`}
            </MatchyLine>

            {proposals.length > 0 && (
              <ul className="pl-[52px] space-y-1">
                {proposals.map(slot => (
                  <li key={slot.startUtc} className="text-[12px] text-ink">
                    {formatSlot(slot.startUtc, slot.endUtc)}
                  </li>
                ))}
              </ul>
            )}

            <div className="pl-[52px] space-y-0.5">
              {proposals.length > 0 && zoneLabel && (
                <p className="text-[10px] text-muted">Times shown in {zoneLabel}.</p>
              )}
              <p className="text-[10px] text-muted">Waiting on {firstName}.</p>
            </div>

            {canSend && (
              <div className="pl-0 sm:pl-[52px] space-y-2">
                {!proposeOpen ? (
                  <button
                    type="button"
                    onClick={() => setProposeOpen(true)}
                    className="w-full sm:w-auto text-[10px] uppercase tracking-widest text-navy border border-navy/30 hover:border-navy px-3 py-2 transition-colors"
                    style={{ letterSpacing: '0.1em' }}
                  >
                    Propose different times
                  </button>
                ) : (
                  <>
                    {preferencesRow('Propose different times')}
                    <button
                      type="button"
                      onClick={() => { setProposeOpen(false); setScheduleError(''); setScheduleFindings([]); }}
                      disabled={proposing}
                      className="text-[10px] uppercase tracking-widest text-muted hover:text-navy disabled:opacity-40 transition-colors"
                      style={{ letterSpacing: '0.1em' }}
                    >
                      Cancel
                    </button>
                  </>
                )}
                {scheduleFeedback()}
              </div>
            )}
          </div>
        )}

        {/* ── The booked call ── */}
        {showBooked && booking && (
          <div className="border border-green-300 bg-green-50 px-3.5 py-3 space-y-2.5">
            <p
              className="text-[10px] uppercase tracking-widest text-green-800 font-semibold"
              style={{ letterSpacing: '0.16em' }}
            >
              Call booked
            </p>

            <p className="text-[13px] text-ink font-medium">
              {formatSlot(booking.startUtc, booking.endUtc)}
            </p>
            {zoneLabel && <p className="text-[10px] text-muted">Times shown in {zoneLabel}.</p>}
            {booking.rescheduledCount > 0 && (
              <p className="text-[10px] text-muted">
                Moved {booking.rescheduledCount} time{booking.rescheduledCount === 1 ? '' : 's'}.
              </p>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-4">
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
              <a
                href={bookingIcsUrl(projectId, expertId)}
                download
                className="text-[11px] text-navy font-medium hover:underline underline-offset-2"
              >
                Add to calendar
              </a>
            </div>

            {canSend && (
              <div className="space-y-2">
                {outcome === 'reschedule_requested' ? (
                  <MatchyLine tone="quiet">Finding a new time with {firstName}.</MatchyLine>
                ) : !confirmMove ? (
                  <button
                    type="button"
                    onClick={() => { setConfirmMove(true); setScheduleError(''); }}
                    className="w-full sm:w-auto text-[10px] uppercase tracking-widest text-navy border border-navy/30 hover:border-navy px-3 py-2 transition-colors"
                    style={{ letterSpacing: '0.1em' }}
                  >
                    Move the call
                  </button>
                ) : (
                  <div className="space-y-2">
                    <MatchyLine>
                      I will ask {firstName} for a new time and send an updated invite once they pick one.
                    </MatchyLine>
                    <div className="flex flex-col sm:flex-row gap-2 sm:pl-[52px]">
                      <button
                        type="button"
                        onClick={() => { void runProposeTimes('reschedule'); }}
                        disabled={proposing}
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-2 hover:bg-navy/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        style={{ letterSpacing: '0.1em' }}
                      >
                        {proposing && <Spinner />}
                        {proposing ? 'Working…' : 'Ask for a new time'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmMove(false)}
                        disabled={proposing}
                        className="w-full sm:w-auto text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame px-3 py-2 disabled:opacity-40 transition-colors"
                        style={{ letterSpacing: '0.1em' }}
                      >
                        Keep this time
                      </button>
                    </div>
                  </div>
                )}
                {scheduleFeedback()}
              </div>
            )}
          </div>
        )}

        {/* ── A scheduling line that belongs to no card: nothing was sent, or
              the owner has no hours on file for Matchy to work from. ── */}
        {!canOfferTimes && !showProposed && !showBooked && scheduleLine && (
          <MatchyLine variant="card" tone={scheduleLine.tone}>
            {scheduleLine.text}
          </MatchyLine>
        )}

        {/* The result of the last click. Suppressed when a card above already
            says the same thing, so a success is reported once, not twice. */}
        {scheduleNote && scheduleNote !== scheduleLine?.text && (
          <MatchyLine tone="quiet">{scheduleNote}</MatchyLine>
        )}

        {decisionNote && (
          <MatchyLine tone="quiet">{decisionNote}</MatchyLine>
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
                : walkthrough
                  ? 'Practice reply. Nothing is sent in walkthrough mode.'
                  : `Write to ${firstName} — I'll relay it.`}
              disabled={sending || noAddressYet}
              className="w-full px-2.5 py-2 text-[12px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink resize-none disabled:opacity-50"
            />

            {noAddressYet && (
              <p className="text-[11px] text-muted">
                No address on file yet — I&apos;ll open this up as soon as there is one.
              </p>
            )}

            {walkthrough && !noAddressYet && (
              <p className="text-[11px] text-muted">
                Walkthrough mode. Your message is screened and saved to the thread, and nothing is sent.
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

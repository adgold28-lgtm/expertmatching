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
//   • MATCHY 2.0: the composer has TWO EXITS. "Send to {first}" is the relay
//     below, unchanged. "Ask Matchy" runs lib/matchyIntent.askMatchy over the
//     redacted record already in this component and renders ONE card
//     (components/MatchyAskCard.tsx) above the buttons. Ask never sends; the
//     only network call it can make is POST …/messages/draft, whose answer
//     lands in the textarea behind "Use this" and leaves only through Send.
//     Expert messages render Matchy's summary only — the server sends no body
//     to a client (lib/conversations.redactMessageForViewer). The owner's rate
//     for this expert sits under the header and is editable until agreed.
//   • The Accept / Offer buttons send an ACTION, never text. They used to post
//     "Yes — $1,300/hr works." to the messages endpoint, which emails the body
//     verbatim — so the expert received the number that includes our fee. They
//     now post { action } to .../rate-decision, and the server writes the
//     outbound line from a template carrying only the expert-side figure. The
//     labels stay in client dollars, which is what the client is agreeing to.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Project, ProjectExpert } from '../types';
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
  setClientRate,
  passExpert,
  draftReply,
  approveOutreachWithLine,
  isValidClientRate,
  RATE_FLOOR,
  RATE_STEP,
  type ConversationMessage,
  type MessageIntent,
  type ProjectExpertWithCounter,
  type ScreenFinding,
} from '../lib/matchyClient';
import MatchyLine from './MatchyLine';
import ClientReadyCard from './ClientReadyCard';
import MatchyAskCard, { type AskActionPayload } from './MatchyAskCard';
import { CLIENT_STATUS_META, hasConversation } from './matchyStatus';
import { WALKTHROUGH_HELD_SUMMARY, heldLabel } from '../lib/walkthrough';
import { askMatchy, findingNoun, isRateLocked, type AskAction, type AskCard, type AskJump } from '../lib/matchyIntent';
import { rejectionLabel } from '../lib/rejectionReasons';

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
  /**
   * The project, for "Ask Matchy" questions that look across experts and for
   * the rate band. Optional so the thread still renders on its own.
   */
  project?:       Pick<Project, 'experts' | 'clientRateMin' | 'clientRateMax'>;
  /** "Open Priya" on a cross-project answer selects that thread. */
  onOpenExpert?:  (expertId: string) => void;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

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

      {message.summary ? (
        <div className="px-3.5 py-2.5 bg-surface border-b border-frame/70">
          <MatchyLine>{message.summary}</MatchyLine>
        </div>
      ) : !message.body ? (
        <div className="px-3.5 py-2.5 bg-surface">
          <MatchyLine tone="quiet">Reply received.</MatchyLine>
        </div>
      ) : null}

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
function HeldTag({ reason }: { reason?: string | null }) {
  return (
    <span
      className="inline-block text-[9px] uppercase tracking-widest border border-frame text-muted px-1.5 py-0.5"
      style={{ letterSpacing: '0.12em' }}
    >
      {heldLabel(reason)}
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
        {held && <HeldTag reason={message.held ?? message.screenResult?.held} />}
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
          {held && <HeldTag reason={message.held ?? message.screenResult?.held} />}
          <p className="text-[10px] text-muted/70">
            {pending ? 'Held for review · ' : ''}{formatTime(message.createdAt)}
          </p>
        </div>
      </div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * What GET .../booking/cancel answers: which side of the 24-hour line the call
 * is on, and what a late cancel would cost (lib/callPolicies.ts). Declared here
 * rather than imported because a route module may export nothing but handlers.
 */
interface CancelPreview {
  window: 'free' | 'late' | 'started';
  fee:    { clientCharge: number; expertPayout: number; minutes: number };
}

export default function ConversationThread({
  projectId,
  projectExpert,
  canSend,
  isAdmin,
  walkthrough,
  onExpertUpdate,
  onInboundSeen,
  project,
  onOpenExpert,
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

  // ── Cancelling the booked call (Wave 5) ──
  // Two steps, and the second one only opens after the server has told us what
  // the cancel costs: `cancelInfo` is the GET on the cancel route, so the
  // number on screen is the number that will be charged rather than one the
  // browser worked out for itself.
  const [cancelOpen,  setCancelOpen]  = useState(false);
  const [cancelInfo,  setCancelInfo]  = useState<CancelPreview | null>(null);
  const [cancelBusy,  setCancelBusy]  = useState(false);
  const [cancelError, setCancelError] = useState('');

  // ── Ask Matchy (Matchy 2.0) ──
  // One card at a time, never stored. `askDraft` is the draft route's answer,
  // shown behind "Use this". `askNote` is the one quiet line left behind after
  // a card's button did its work.
  const [askCard,  setAskCard]  = useState<AskCard | null>(null);
  const [askDraft, setAskDraft] = useState<string | null>(null);
  const [askBusy,  setAskBusy]  = useState(false);
  const [askNote,  setAskNote]  = useState('');
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // ── The owner's rate for this expert ──
  const [rateEditing, setRateEditing] = useState(false);
  const [rateInput,   setRateInput]   = useState('');
  const [rateError,   setRateError]   = useState('');
  const [rateSaving,  setRateSaving]  = useState(false);

  // ── Staff: the intro's personal line when Matchy could not write one ──
  const [whyThem,      setWhyThem]      = useState('');
  const [whyThemError, setWhyThemError] = useState('');

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
    setAskCard(null);
    setAskDraft(null);
    setAskNote('');
    setRateEditing(false);
    setRateError('');
    setWhyThem('');
    setWhyThemError('');
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
    setAskCard(null);
    setAskDraft(null);
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
        { message?: string; held?: string; projectExpert?: ProjectExpertWithCounter } | null;

      if (!res.ok) {
        setSendError(data?.message ?? 'Something went wrong. Try again.');
        return;
      }
      // The rate moved either way; the reply to the expert may have been held
      // for any reason the chokepoint recognizes (walkthrough, trial,
      // suppressed, disabled) — say which one rather than assuming walkthrough.
      setDecisionNote(data?.held
        ? `Recorded. Nothing was sent to them (${heldLabel(data.held)}).`
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
  async function runProposeTimes(reason: 'initial' | 'reschedule', preferencesOverride?: string) {
    if (proposing) return;
    setProposing(true);
    setScheduleError('');
    setScheduleFindings([]);
    setScheduleNote('');

    const hint = (preferencesOverride ?? preferences).trim();
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

  /**
   * Open the cancel confirm. The GET is what the dialog renders: "Free to
   * cancel" or the exact 15-minute charge. Nothing is cancelled here.
   */
  async function openCancel() {
    setCancelError('');
    setCancelInfo(null);
    setCancelBusy(true);
    try {
      const res  = await fetch(`/api/projects/${projectId}/experts/${expertId}/booking/cancel`, { cache: 'no-store' });
      const data = await res.json().catch(() => null) as CancelPreview | { error?: string } | null;
      if (!res.ok || !data || !('window' in data)) {
        setCancelError('We could not check that call. Please try again.');
        return;
      }
      setCancelInfo(data);
      setCancelOpen(true);
    } catch {
      setCancelError('We could not check that call. Please try again.');
    } finally {
      setCancelBusy(false);
    }
  }

  /**
   * Cancel it. `confirmLate` goes only when the preview said the cancel is
   * late, which is the same condition the server re-checks before charging.
   */
  async function runCancel() {
    if (cancelBusy) return;
    setCancelBusy(true);
    setCancelError('');
    try {
      const res = await fetch(`/api/projects/${projectId}/experts/${expertId}/booking/cancel`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ confirmLate: cancelInfo !== null && cancelInfo.window !== 'free' }),
      });
      const data = await res.json().catch(() => null) as
        { ok?: boolean; projectExpert?: ProjectExpertWithCounter; error?: string; fee?: CancelPreview['fee'] } | null;

      if (!res.ok || !data?.ok || !data.projectExpert) {
        if (data?.error === 'late_not_confirmed' && data.fee) {
          setCancelInfo({ window: 'late', fee: data.fee });
          return;
        }
        setCancelError('We could not cancel that call. Please try again.');
        return;
      }

      setThreadPE(data.projectExpert);
      onExpertUpdate(data.projectExpert);
      setCancelOpen(false);
      setConfirmMove(false);
      setScheduleNote('The call is cancelled and both invites have been withdrawn.');
      await load(false);
    } catch {
      setCancelError('We could not cancel that call. Please try again.');
    } finally {
      setCancelBusy(false);
    }
  }

  /** Review-first: the intro is written and waiting on the client. */
  async function approveIntro(line?: string) {
    setApproving(true);
    setSendError('');
    setWhyThemError('');
    const res = line
      ? await approveOutreachWithLine(projectId, expertId, line)
      : await approveOutreach(projectId, expertId);
    setApproving(false);
    if (!res.ok) { if (line) setWhyThemError(res.message); else setSendError(res.message); return; }
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

  // ── Ask Matchy ─────────────────────────────────────────────────────────────

  /** Scrolls the pane to a card or a message and flashes its edge once. */
  function jumpTo(jump: AskJump | undefined) {
    if (!jump) return;
    const id = jump.to === 'message' ? `msg-${jump.messageId}` : `ask-${jump.to}`;
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('ring-2', 'ring-gold');
    window.setTimeout(() => el.classList.remove('ring-2', 'ring-gold'), 900);
  }

  function clearAsk() {
    setAskCard(null);
    setAskDraft(null);
  }

  /**
   * The second exit. Routes the text through lib/matchyIntent (no network) and
   * renders the one card it returns. A draft request is the single case that
   * calls the server; its answer lands behind "Use this" and only ever leaves
   * through Send.
   */
  async function runAsk() {
    const text = draft.trim();
    if (!text || askBusy) return;
    setFindings([]);
    setSendError('');
    setAskNote('');
    setAskDraft(null);

    const card = askMatchy(text, {
      pe,
      messages,
      project:         project ?? null,
      canSend,
      walkthrough,
      statusLabelOf:   s => CLIENT_STATUS_META[s].label,
      hasConversation,
    });

    if (card.kind !== 'draft_request') {
      setAskCard(card);
      if (card.jump) jumpTo(card.jump);
      return;
    }

    setAskBusy(true);
    setAskCard({ kind: 'line', tone: 'quiet', tint: 'cream', line: 'Working…', buttons: [] });
    const res = await draftReply(projectId, expertId, card.instruction ?? text);
    setAskBusy(false);
    if (!res.ok) {
      if (res.error === 'message_blocked') {
        setAskCard({ kind: 'card', tone: 'default', tint: 'blocked', line: 'Nothing sent. Say it without the contact detail and I will write it.', findings: res.findings ?? [], buttons: [] });
        return;
      }
      setAskCard({ kind: 'line', tone: 'quiet', tint: 'cream', line: res.message, buttons: [] });
      return;
    }
    if (!res.text) {
      setAskCard({ kind: 'line', tone: 'quiet', tint: 'cream', line: res.message ?? "I could not write that one cleanly. Write it in your words and I'll screen it.", buttons: [] });
      return;
    }
    setAskDraft(res.text);
    setAskCard({
      kind: 'card', tone: 'default', tint: 'cream',
      line: `Here is a reply. Nothing sent; edit it, then press ${walkthrough ? 'Hold' : 'Send'} for ${firstName}.`,
      buttons: [{ action: 'use_draft', label: 'Use this', primary: true }, { action: 'dismiss', label: 'Dismiss' }],
    });
  }

  /** Every button on the card calls a handler this component already owns. */
  async function onAskAction(action: AskAction, payload?: AskActionPayload) {
    switch (action) {
      case 'dismiss':
        clearAsk();
        return;
      case 'jump':
        jumpTo(askCard?.jump);
        return;
      case 'use_draft':
        if (payload?.text) setDraft(payload.text);
        clearAsk();
        boxRef.current?.focus();
        return;
      case 'open_expert':
        if (payload?.expertId) onOpenExpert?.(payload.expertId);
        return;
      case 'switch_live':
        clearAsk();
        document.getElementById('matchy-settings')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
        return;
      case 'approve_intro':
        clearAsk();
        await approveIntro();
        return;
      case 'set_rate':
        if (typeof payload?.rate === 'number') await applyRate(payload.rate);
        return;
      case 'propose':
        clearAsk();
        setPreferences(payload?.preferences ?? '');
        await runProposeTimes('initial', payload?.preferences ?? '');
        return;
      case 'move':
        clearAsk();
        await runProposeTimes('reschedule');
        return;
      case 'pass': {
        if (!payload?.reason) return;
        setAskBusy(true);
        const res = await passExpert(projectId, expertId, payload.reason, payload.notes);
        setAskBusy(false);
        if (!res.ok) { setSendError(res.message); return; }
        const updated = res.project.experts.find(e => e.expert.id === expertId);
        if (updated) { setThreadPE(updated as ProjectExpertWithCounter); onExpertUpdate(updated); }
        clearAsk();
        setAskNote(`Passed: ${rejectionLabel(payload.reason).toLowerCase()}. Nothing more goes to ${firstName}.`);
        await load(false);
        return;
      }
    }
  }

  // ── The owner's rate for this expert ───────────────────────────────────────

  /**
   * Sets the client-side rate for this engagement. The server checks the $50
   * grid, the band and the lock, and derives the expert-side figure in the same
   * write; nothing is sent. With a counter open, the Offer button picks the new
   * number up; otherwise it goes out with the next message.
   */
  async function applyRate(n: number) {
    if (rateSaving) return;
    if (!isValidClientRate(n)) {
      setRateError(`Whole dollars, at least ${formatRate(RATE_FLOOR)}, in ${formatRate(RATE_STEP)} steps.`);
      setRateEditing(true);
      return;
    }
    setRateSaving(true);
    setRateError('');
    const res = await setClientRate(projectId, expertId, n);
    setRateSaving(false);
    if (!res.ok) { setRateError(res.message); setRateEditing(true); return; }
    const updated = res.project.experts.find(e => e.expert.id === expertId);
    if (updated) { setThreadPE(updated as ProjectExpertWithCounter); onExpertUpdate(updated); }
    setRateEditing(false);
    clearAsk();
    const decisionIsOpen = latestInbound(messages)?.intent === 'counter_rate' && clientCounterRateOf(pe) !== null;
    setAskNote(decisionIsOpen
      ? `Rate for ${firstName} set to ${formatRate(n)}/hr. Press Offer ${formatRate(n)} on the card to send it.`
      : `Rate for ${firstName} set to ${formatRate(n)}/hr. It goes out with the next message to them.`);
    if (decisionIsOpen) jumpTo({ to: 'decision' });
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

  // A cancelled booking is history, not a call: cancelCall moves the status to
  // 'rejected_after_outreach' as well, so this is belt and braces against a
  // payload that has one field and not the other.
  const showBooked   = booking !== null && !booking.cancelledAt && status === 'scheduled';
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

  const isTerminal  = status === 'completed' || status === 'rejected' || status === 'rejected_after_outreach';
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
          <span className={`text-[10px] px-2 py-0.5 border font-medium uppercase tracking-wider ${statusPill.classes}`}>
            {statusPill.label}
          </span>
        </div>
      </div>

      {/* ── Your rate for this expert (Matchy 2.0) ──
            The band in the settings strip is the default and the limit; this
            is the number for this engagement. Editable by the owner until the
            rate is agreed, then it reads "Agreed" and does not move. */}
      {typeof pe.clientRate === 'number' && pe.clientRate > 0 && !isTerminal && (
        <div className="px-4 py-2 border-b border-frame bg-cream flex items-center gap-3 flex-wrap text-[11px] text-muted">
          {isRateLocked(pe) ? (
            <span>Agreed <span className="text-ink font-medium">{formatRate(pe.clientRate)}/hr</span> all-in</span>
          ) : !rateEditing ? (
            <>
              <span>Your rate for {firstName} <span className="text-ink font-medium">{formatRate(pe.clientRate)}/hr</span> all-in</span>
              {canSend && (
                <button
                  type="button"
                  onClick={() => { setRateInput(String(pe.clientRate)); setRateError(''); setRateEditing(true); }}
                  className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
                  style={{ letterSpacing: '0.12em' }}
                >
                  Change
                </button>
              )}
            </>
          ) : (
            <>
              <span className="text-[10px] uppercase tracking-widest" style={{ letterSpacing: '0.12em' }}>Your rate for {firstName}</span>
              <span className="text-[12px] text-muted">$</span>
              <input
                type="number"
                inputMode="numeric"
                min={RATE_FLOOR}
                step={RATE_STEP}
                value={rateInput}
                autoFocus
                disabled={rateSaving}
                onChange={e => setRateInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') { e.preventDefault(); void applyRate(Number(rateInput)); }
                  if (e.key === 'Escape') { setRateEditing(false); setRateError(''); }
                }}
                aria-label="Your rate per hour for this expert"
                className="w-24 px-2 py-1 text-[12px] border border-frame bg-surface focus:outline-none focus:border-navy text-ink"
              />
              <span className="text-[12px] text-muted">/hr</span>
              <button
                type="button"
                onClick={() => { void applyRate(Number(rateInput)); }}
                disabled={rateSaving}
                className="text-[10px] uppercase tracking-widest bg-navy text-cream px-2.5 py-1 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                style={{ letterSpacing: '0.1em' }}
              >
                {rateSaving ? 'Saving…' : 'Save'}
              </button>
              <button
                type="button"
                onClick={() => { setRateEditing(false); setRateError(''); }}
                disabled={rateSaving}
                className="text-[10px] uppercase tracking-widest text-muted hover:text-navy disabled:opacity-40 transition-colors"
                style={{ letterSpacing: '0.1em' }}
              >
                Cancel
              </button>
              <span className="text-[10px] text-muted/80 basis-full sm:basis-auto">
                Inside your band, in {formatRate(RATE_STEP)} steps. {firstName} hears their side of the number only.
              </span>
              {rateError && <span className="text-[11px] text-red-600 basis-full">{rateError}</span>}
            </>
          )}
        </div>
      )}

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

        {messages.map(m => (
          <div key={m.id} id={`msg-${m.id}`} className="transition-shadow">
            {m.author === 'expert' ? (
              <ExpertMessage message={m} expertFirstName={firstName} />
            ) : m.author === 'matchy' ? (
              <MatchyMessage
                message={m}
                onSend={releasePending}
                sending={pendingId === m.id}
                canSend={canSend}
                walkthrough={walkthrough}
              />
            ) : (
              <ClientMessage message={m} />
            )}
          </div>
        ))}

        {/* ── Review-first: the intro is written and waiting ── */}
        {status === 'outreach_drafted' && !hasPendingMatchy && (
          <div id="ask-intro" className={`border px-3.5 py-3 space-y-2 transition-shadow ${walkthrough ? 'border-frame bg-cream' : 'border-sky-200 bg-sky-50'}`}>
            <MatchyLine tone={walkthrough ? 'quiet' : 'default'}>
              {pe.introNeedsWhyThem
                ? isAdmin
                  ? 'Intro drafted, but I could not write its first line from the evidence. Give me one fact only someone who read their background would know.'
                  : 'Matchy is finishing the intro. Staff add one line, then it goes.'
                : walkthrough
                  ? "Intro written. Nothing is sent in walkthrough mode. Switch this project to live and it's yours to send."
                  : 'Intro drafted. Review and send.'}
            </MatchyLine>
            {pe.introNeedsWhyThem && isAdmin && (
              <div className="pl-0 sm:pl-[52px] space-y-1.5">
                <input
                  type="text"
                  value={whyThem}
                  onChange={e => setWhyThem(e.target.value)}
                  maxLength={200}
                  disabled={approving}
                  placeholder="You ran distribution in the Southeast for Sysco for six years"
                  aria-label="The personal line of the intro"
                  className="w-full px-2.5 py-2 text-[12px] border border-frame bg-surface focus:outline-none focus:border-navy text-ink disabled:opacity-50"
                />
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    type="button"
                    onClick={() => { void approveIntro(whyThem.trim()); }}
                    disabled={approving || walkthrough || !whyThem.trim()}
                    title={walkthrough ? 'Nothing is sent in walkthrough mode' : undefined}
                    className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                    style={{ letterSpacing: '0.1em' }}
                  >
                    {approving ? 'Sending…' : 'Add the line and send'}
                  </button>
                  <span className="text-[10px] text-muted">Staff only. Screened like any message; the client never sees this line.</span>
                </div>
                {whyThemError && <p className="text-[11px] text-red-600">{whyThemError}</p>}
              </div>
            )}
            {canSend && !pe.introNeedsWhyThem && (
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
          <div id="ask-decision" className="border border-amber-300 bg-amber-50 px-3.5 py-3 space-y-2.5 transition-shadow">
            <MatchyLine>
              {firstName}&apos;s counter comes to {formatRate(counterRate)}/hr for you, fee included.
              {canCounter && standingRate !== null ? ` Accept, or hold at ${formatRate(standingRate)}?` : ''} Either way I reply with their side of the number only.
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
            <p className="pl-[52px] text-[10px] text-muted">
              Nothing is charged now. You pay after the call, by the minute, 15-minute minimum, at the rate you accept.
            </p>
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
          <div id="ask-times" className="border border-teal-300 bg-teal-50 px-3.5 py-3 space-y-2.5 transition-shadow">
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
          <div id="ask-booked" className="border border-green-300 bg-green-50 px-3.5 py-3 space-y-2.5 transition-shadow">
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
                ) : cancelOpen && cancelInfo ? (
                  <div className="space-y-2">
                    <MatchyLine>
                      {cancelInfo.window === 'free'
                        ? `Free to cancel. I will tell ${firstName} and withdraw both invites.`
                        : `Cancelling now charges $${cancelInfo.fee.clientCharge.toLocaleString('en-US')} (${cancelInfo.fee.minutes} minutes). Moving the call instead costs nothing.`}
                    </MatchyLine>
                    <div className="flex flex-col sm:flex-row gap-2 sm:pl-[52px]">
                      <button
                        type="button"
                        onClick={() => { void runCancel(); }}
                        disabled={cancelBusy}
                        className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-2 hover:bg-navy/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                        style={{ letterSpacing: '0.1em' }}
                      >
                        {cancelBusy && <Spinner />}
                        {cancelBusy ? 'Working…' : 'Cancel the call'}
                      </button>
                      <button
                        type="button"
                        onClick={() => { setCancelOpen(false); setCancelError(''); }}
                        disabled={cancelBusy}
                        className="w-full sm:w-auto text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame px-3 py-2 disabled:opacity-40 transition-colors"
                        style={{ letterSpacing: '0.1em' }}
                      >
                        Keep this call
                      </button>
                    </div>
                    {cancelError && (
                      <p role="alert" className="text-[11px] text-status-danger sm:pl-[52px]">{cancelError}</p>
                    )}
                  </div>
                ) : !confirmMove ? (
                  <div className="flex flex-col sm:flex-row gap-2">
                    <button
                      type="button"
                      onClick={() => { setConfirmMove(true); setScheduleError(''); }}
                      className="w-full sm:w-auto text-[10px] uppercase tracking-widest text-navy border border-navy/30 hover:border-navy px-3 py-2 transition-colors"
                      style={{ letterSpacing: '0.1em' }}
                    >
                      Move the call
                    </button>
                    <button
                      type="button"
                      onClick={() => { void openCancel(); }}
                      disabled={cancelBusy}
                      className="w-full sm:w-auto text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame px-3 py-2 disabled:opacity-40 transition-colors"
                      style={{ letterSpacing: '0.1em' }}
                    >
                      {cancelBusy ? 'Checking…' : 'Cancel the call'}
                    </button>
                    {cancelError && (
                      <p role="alert" className="text-[11px] text-status-danger">{cancelError}</p>
                    )}
                  </div>
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

      {/* ── Composer: one box, two exits (Matchy 2.0) ──
            "Send to {first}" is the relay, unchanged and owner-only. "Ask
            Matchy" never sends: it returns one card above the buttons. Neither
            has a keyboard shortcut, so nothing reaches the wire by inference. */}
      <div className="border-t border-frame px-4 py-3 space-y-2">
        <textarea
          ref={boxRef}
          value={draft}
          onChange={e => setDraft(e.target.value)}
          rows={3}
          placeholder={!canSend
            ? `Ask me about ${firstName}: what they said, where we are.`
            : noAddressYet
              ? 'Nothing to reply to yet. Ask me where we are.'
              : walkthrough
                ? 'Practice here. Nothing is sent in walkthrough mode.'
                : `Write to ${firstName}, or ask me what they said, where we are, or to write the reply for you.`}
          disabled={sending || askBusy}
          className="w-full px-2.5 py-2 text-[12px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink resize-none disabled:opacity-50"
        />

        {canSend && noAddressYet && (
          <p className="text-[11px] text-muted">
            No address on file yet. I&apos;ll open this up as soon as there is one.
          </p>
        )}

        {canSend && walkthrough && !noAddressYet && (
          <p className="text-[11px] text-muted">
            Walkthrough mode. Your message is screened and saved to the thread, and nothing is sent.
          </p>
        )}

        {findings.length > 0 && (
          <div className="border border-amber-300 bg-amber-50 px-3 py-2 space-y-1">
            {findings.map((f, i) => (
              <p key={`${f.kind}-${i}`} className="text-[11px] text-amber-800 leading-relaxed">
                Remove: {findingNoun(f.kind)} &lsquo;{f.match}&rsquo; &middot; {f.hint}
              </p>
            ))}
          </div>
        )}

        {sendError && <p className="text-[11px] text-red-600">{sendError}</p>}

        {askCard && (
          <MatchyAskCard
            card={askCard}
            canSend={canSend}
            busy={askBusy || sending || proposing || approving || rateSaving}
            draft={askDraft ?? undefined}
            onAction={(action, payload) => { void onAskAction(action, payload); }}
          />
        )}

        {askNote && !askCard && <MatchyLine tone="quiet">{askNote}</MatchyLine>}

        <div className="flex items-end justify-between gap-3 flex-wrap">
          <p className="text-[10px] text-muted/70 leading-relaxed">
            {canSend
              ? <>Ask Matchy answers here and sends nothing. {walkthrough ? `Hold for ${firstName} saves it to the thread.` : `Send to ${firstName} emails ${firstName}.`}<br /></>
              : <>Only the project owner can message experts. Ask Matchy answers here and sends nothing.<br /></>}
            Identities and contact details stay off the thread until the call is booked.
          </p>
          <div className="flex items-center gap-2 ml-auto w-full sm:w-auto">
            <button
              type="button"
              onClick={() => { void runAsk(); }}
              disabled={askBusy || sending || !draft.trim()}
              className="flex-1 sm:flex-none min-h-[40px] sm:min-h-0 inline-flex items-center justify-center gap-1.5 text-[10px] uppercase tracking-widest text-navy border border-navy/30 hover:border-navy px-4 py-2 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              style={{ letterSpacing: '0.12em' }}
            >
              {askBusy && <Spinner />}
              {askBusy ? 'Working…' : 'Ask Matchy'}
            </button>
            {canSend && (
              <button
                type="button"
                onClick={() => { void send(draft, true); }}
                disabled={sending || askBusy || noAddressYet || !draft.trim()}
                title={walkthrough ? 'Walkthrough: saved to the thread, not sent' : undefined}
                className="flex-1 sm:flex-none min-h-[40px] sm:min-h-0 text-[10px] uppercase tracking-widest bg-navy text-cream px-4 py-2 hover:bg-navy/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                style={{ letterSpacing: '0.12em' }}
              >
                {sending ? (walkthrough ? 'Saving…' : 'Sending…') : walkthrough ? `Hold for ${firstName}` : `Send to ${firstName}`}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

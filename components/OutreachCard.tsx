'use client';

import { useState } from 'react';
import type { ProjectExpert, ExpertStatus } from '../types';
import ContactSection from './ContactSection';
import EmailStatusBadge from './EmailStatusBadge';
import OutreachModal from './OutreachModal';
import { isLinkedInProfileUrl } from '../lib/domainSuggestions';

// ─── Constants ────────────────────────────────────────────────────────────────

const TIMEZONES = ['ET', 'CT', 'MT', 'PT', 'GMT'] as const;
type Timezone = (typeof TIMEZONES)[number];

const STATUS_PILL: Record<string, string> = {
  contact_found:            'text-sky-600   border-sky-200   bg-sky-50',
  outreach_drafted:         'text-sky-700   border-sky-300   bg-sky-50',
  contacted:                'text-amber-700 border-amber-300 bg-amber-50',
  email2_sent:              'text-amber-700 border-amber-300 bg-amber-50',
  replied:                  'text-amber-700 border-amber-400 bg-amber-50',
  scheduling_sent:          'text-teal-700  border-teal-300  bg-teal-50',
  scheduled:                'text-green-700 border-green-200 bg-green-50',
  completed:                'text-navy      border-navy/20   bg-navy/5',
  rate_negotiation:         'text-amber-700 border-amber-400 bg-amber-50',
  conflict_flagged:         'text-red-700   border-red-300   bg-red-50',
  rejected_after_outreach:  'text-slate-500 border-slate-200 bg-slate-50',
};

const STATUS_LABEL: Record<string, string> = {
  contact_found:            'Contact Found',
  outreach_drafted:         'Draft Ready',
  contacted:                'Email 1 Sent',
  email2_sent:              'Email 2 Sent',
  replied:                  'Replied',
  scheduling_sent:          'Scheduling Sent',
  scheduled:                'Scheduled',
  completed:                'Completed',
  rate_negotiation:         'Rate Negotiation',
  conflict_flagged:         'Conflict Flagged',
  rejected_after_outreach:  'Declined',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: number | undefined | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function formatDateShort(ts: number | undefined | null): string {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─── Sequence timeline entry ──────────────────────────────────────────────────

function TimelineEntry({
  done,
  active,
  label,
  timestamp,
  note,
}: {
  done:       boolean;
  active?:    boolean;
  label:      string;
  timestamp?: number | null;
  note?:      string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <div className={`mt-0.5 w-[14px] h-[14px] rounded-full shrink-0 flex items-center justify-center text-[7px] font-bold ${
        done
          ? 'bg-teal-600 text-white'
          : active
          ? 'bg-navy text-cream'
          : 'border border-slate-300 bg-cream'
      }`}>
        {done ? '✓' : ''}
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-[11px] leading-snug ${done ? 'text-ink' : active ? 'text-navy font-medium' : 'text-muted/60'}`}>
          {label}
          {timestamp ? (
            <span className="text-muted ml-1.5 font-normal">{formatDate(timestamp)}</span>
          ) : null}
        </p>
        {note && <p className="text-[10px] text-muted mt-0.5 italic">{note}</p>}
      </div>
    </div>
  );
}

// ─── Email row ────────────────────────────────────────────────────────────────

function EmailRow({
  pe,
  onCopy,
  copied,
}: {
  pe:     ProjectExpert;
  onCopy: () => void;
  copied: boolean;
}) {
  if (!pe.contactEmail) return null;
  const provLabel =
    pe.emailProvider === 'hunter' ? 'Hunter.io' :
    pe.emailProvider === 'snov'   ? 'Snov.io'   : '';
  const checkedStr = pe.emailCheckedAt
    ? `Checked ${new Date(pe.emailCheckedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
    : '';
  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 flex-wrap">
        <a
          href={`mailto:${pe.contactEmail}`}
          className="text-[11px] text-navy font-medium hover:underline underline-offset-2 font-mono"
        >
          {pe.contactEmail}
        </a>
        {pe.emailVerificationStatus && <EmailStatusBadge status={pe.emailVerificationStatus} />}
        <button
          onClick={onCopy}
          className="text-muted hover:text-navy transition-colors"
          title={copied ? 'Copied' : 'Copy email'}
          aria-label="Copy email"
        >
          {copied ? (
            <svg className="w-3 h-3 text-green-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
        </button>
      </div>
      {(provLabel || checkedStr) && (
        <p className="text-[10px] text-muted">
          {provLabel}{provLabel && checkedStr ? ' · ' : ''}{checkedStr}
        </p>
      )}
    </div>
  );
}

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  projectExpert:     ProjectExpert;
  projectId:         string;
  query:             string;
  onUpdate:          (updated: ProjectExpert) => void;
  onContactUpdated?: (updated: ProjectExpert) => void;
  onViewProfile?:    () => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function OutreachCard({
  projectExpert,
  projectId,
  query,
  onUpdate,
  onContactUpdated,
  onViewProfile,
}: Props) {
  const { expert } = projectExpert;

  const [saving,              setSaving]            = useState(false);
  const [showOutreach,        setShowOutreach]       = useState(false);
  const [showEmailLookup,     setShowEmailLookup]    = useState(false);
  const [showRecheck,         setShowRecheck]        = useState(false);
  const [copiedEmail,         setCopiedEmail]        = useState(false);
  // Rate setting
  const [rateInput,           setRateInput]          = useState(projectExpert.expertRate != null ? String(projectExpert.expertRate) : '');
  const [rateEditing,         setRateEditing]        = useState(projectExpert.expertRate == null);
  const [rateSaving,          setRateSaving]         = useState(false);
  const [rateError,           setRateError]          = useState('');
  // Sequence trigger (email1 send button)
  const [sequenceSending,     setSequenceSending]    = useState(false);
  const [sequenceError,       setSequenceError]      = useState('');
  // Rate negotiation approval
  const [approveRate,         setApproveRate]        = useState('');
  const [approveSaving,       setApproveSaving]      = useState(false);
  const [approveError,        setApproveError]       = useState('');
  // Scheduling fallback
  const [slotDate,            setSlotDate]           = useState('');
  const [slotTz,              setSlotTz]             = useState<Timezone>('ET');
  // Completion modal
  const [showCompleteModal,   setShowCompleteModal]  = useState(false);
  const [completeDuration,    setCompleteDuration]   = useState('');
  const [completeError,       setCompleteError]      = useState('');
  const [completeSubmitting,  setCompleteSubmitting] = useState(false);
  const [completeRateError,   setCompleteRateError]  = useState('');

  const status          = projectExpert.status as ExpertStatus;
  const statusPillClass = STATUS_PILL[status] ?? 'text-muted border-frame';

  const linkedInLinks = (expert.source_links ?? []).filter(
    l => l.type === 'LinkedIn' && isLinkedInProfileUrl(l.url),
  );

  // Sequence phase detection
  const hasEmail1  = !!projectExpert.email1SentAt;
  const hasReply   = !!projectExpert.replyDetectedAt;
  const hasEmail2  = !!projectExpert.email2SentAt;
  const hasEmail3  = !!projectExpert.email3SentAt;
  const isScheduled  = status === 'scheduled' || status === 'completed';
  const isCompleted  = status === 'completed';

  const inSequence = [
    'contacted', 'email2_sent', 'replied', 'scheduling_sent',
    'scheduled', 'completed', 'rate_negotiation', 'conflict_flagged',
    'rejected_after_outreach',
  ].includes(status);

  // ── API helpers ─────────────────────────────────────────────────────────────

  async function patch(fields: Record<string, unknown>) {
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/experts/${expert.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(fields),
      });
      const data = await res.json() as { project?: { experts: ProjectExpert[] } };
      if (!res.ok) return;
      const updated = data.project?.experts.find(e => e.expert.id === expert.id);
      if (updated) onUpdate(updated);
    } finally {
      setSaving(false);
    }
  }

  function handleContactUpdated(updated: ProjectExpert) {
    setShowEmailLookup(false);
    setShowRecheck(false);
    onUpdate(updated);
    onContactUpdated?.(updated);
  }

  function copyEmail() {
    if (!projectExpert.contactEmail) return;
    navigator.clipboard.writeText(projectExpert.contactEmail);
    setCopiedEmail(true);
    setTimeout(() => setCopiedEmail(false), 2000);
  }

  async function saveRate() {
    setRateError('');
    const parsed = parseFloat(rateInput);
    if (!rateInput.trim() || isNaN(parsed) || parsed < 1 || parsed > 9999) {
      setRateError('Rate must be between $1 and $9,999/hr');
      return;
    }
    setRateSaving(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/experts/${expert.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ expertRate: Math.round(parsed) }),
      });
      const data = await res.json() as { project?: { experts: ProjectExpert[] } };
      if (!res.ok) { setRateError('Failed to save rate. Please try again.'); return; }
      const updated = data.project?.experts.find(e => e.expert.id === expert.id);
      if (updated) onUpdate(updated);
      setRateEditing(false);
    } catch {
      setRateError('Network error. Please try again.');
    } finally {
      setRateSaving(false);
    }
  }

  // Trigger email1 directly (not via QStash — immediate local trigger)
  async function triggerEmail1() {
    if (!projectExpert.contactEmail) {
      setSequenceError('No email address on file — find the email first.');
      return;
    }
    if (!projectExpert.expertRate) {
      setSequenceError('Set expert rate before sending.');
      return;
    }
    setSequenceSending(true);
    setSequenceError('');
    try {
      const res = await fetch('/api/email-sequence/trigger', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          projectId,
          expertId: expert.id,
          step:     'email1',
          // Token is generated server-side for email1 if not yet assigned
          token:    projectExpert.outreachToken ?? '',
        }),
      });
      const data = await res.json() as { ok?: boolean; error?: string };
      if (!res.ok) {
        setSequenceError(data.error === 'no_email'
          ? 'No email address on file.'
          : data.error ?? 'Failed to send. Please try again.');
        return;
      }
      // Optimistically refresh
      const projectRes = await fetch(`/api/projects/${projectId}/experts/${expert.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email1SentAt: Date.now() }),
      });
      const projectData = await projectRes.json() as { project?: { experts: ProjectExpert[] } };
      if (projectRes.ok) {
        const updated = projectData.project?.experts.find(e => e.expert.id === expert.id);
        if (updated) onUpdate(updated);
      }
    } catch {
      setSequenceError('Network error. Please try again.');
    } finally {
      setSequenceSending(false);
    }
  }

  // Approve a counter-rate and send email2
  async function approveCounterRate() {
    setApproveError('');
    const parsed = parseFloat(approveRate);
    if (!approveRate.trim() || isNaN(parsed) || parsed < 1 || parsed > 9999) {
      setApproveError('Enter a valid rate between $1 and $9,999/hr');
      return;
    }
    setApproveSaving(true);
    try {
      // Update rate, then schedule email2
      await patch({ expertRate: Math.round(parsed), status: 'replied', replyIntent: 'interested' });
    } finally {
      setApproveSaving(false);
    }
  }

  async function submitComplete() {
    setCompleteError('');
    const dur = parseInt(completeDuration, 10);
    if (!completeDuration || isNaN(dur) || dur < 1 || dur > 480) {
      setCompleteError('Call duration must be between 1 and 480 minutes.');
      return;
    }
    const rate = projectExpert.expertRate;
    if (!rate) { setCompleteError('Expert rate is required.'); return; }
    const invoiceAmount = Math.round((rate * dur) / 60);
    setCompleteSubmitting(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/experts/${expert.id}/complete`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ callDurationMin: dur, invoiceAmount }),
      });
      const data = await res.json() as { success?: boolean; paymentLinkUrl?: string; error?: string };
      if (!res.ok) {
        setCompleteError(data.error === 'invoice_amount_mismatch'
          ? 'Invoice amount mismatch — please refresh and try again.'
          : data.error ?? 'Failed to complete engagement. Please try again.');
        return;
      }
      setShowCompleteModal(false);
      const optimistic: ProjectExpert = {
        ...projectExpert,
        status: 'completed',
        callDurationMin: dur,
        invoiceAmount,
        paymentStatus: 'invoice_sent',
        stripePaymentLinkUrl: data.paymentLinkUrl ?? null,
        updatedAt: Date.now(),
      };
      onUpdate(optimistic);
    } catch {
      setCompleteError('Network error. Please try again.');
    } finally {
      setCompleteSubmitting(false);
    }
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <div className="border border-frame bg-cream flex flex-col">

      {/* ── Header ── */}
      <div className="px-4 py-3 border-b border-frame bg-surface">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0 flex-1">
            {onViewProfile ? (
              <button
                onClick={onViewProfile}
                className="text-sm font-medium text-navy hover:underline underline-offset-2 text-left truncate w-full"
              >
                {expert.name}
              </button>
            ) : (
              <p className="text-sm font-medium text-ink truncate">{expert.name}</p>
            )}
            <p className="text-[11px] text-muted truncate mt-0.5">{expert.title} · {expert.company}</p>
          </div>
          <span
            className={`shrink-0 text-[9px] uppercase tracking-widest border font-medium px-2 py-0.5 ${statusPillClass}`}
            style={{ letterSpacing: '0.12em' }}
          >
            {STATUS_LABEL[status] ?? status}
          </span>
        </div>
      </div>

      <div className="px-4 py-3 flex-1 space-y-4">

        {/* ── Contact section — always visible when no email yet ── */}
        {!projectExpert.contactEmail && !inSequence && (
          <div className="space-y-2">
            <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
              Step 1 — Find Email
            </p>
            {!showEmailLookup ? (
              <button
                onClick={() => setShowEmailLookup(true)}
                className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 transition-colors"
                style={{ letterSpacing: '0.1em' }}
              >
                Find professional email
              </button>
            ) : (
              <div className="space-y-2">
                <button
                  onClick={() => setShowEmailLookup(false)}
                  className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
                >
                  Cancel ✕
                </button>
                <ContactSection
                  expert={expert}
                  query={query}
                  projectId={projectId}
                  expertId={expert.id}
                  initialState="confirming"
                  onContactUpdated={handleContactUpdated}
                />
              </div>
            )}
          </div>
        )}

        {/* ── Email + rate setup (pre-sequence) ── */}
        {projectExpert.contactEmail && !inSequence && (
          <div className="space-y-3">
            {/* Email row */}
            <div className="space-y-1">
              <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
                Contact
              </p>
              <EmailRow pe={projectExpert} onCopy={copyEmail} copied={copiedEmail} />
              <button
                onClick={() => setShowRecheck(r => !r)}
                className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
              >
                {showRecheck ? 'Close ✕' : 'Re-check email ↻'}
              </button>
              {showRecheck && (
                <ContactSection
                  expert={expert}
                  query={query}
                  projectId={projectId}
                  expertId={expert.id}
                  initialState="confirming"
                  onContactUpdated={handleContactUpdated}
                />
              )}
            </div>

            {/* Expert rate */}
            <div className="space-y-1.5">
              <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
                Expert Rate
              </p>
              {rateEditing ? (
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-muted">$</span>
                    <input
                      type="number"
                      min={1}
                      max={9999}
                      value={rateInput}
                      onChange={e => setRateInput(e.target.value)}
                      placeholder="e.g. 500"
                      className="w-24 px-2 py-1 text-[11px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink"
                    />
                    <span className="text-[11px] text-muted">/hr</span>
                    <button
                      onClick={saveRate}
                      disabled={rateSaving}
                      className="text-[10px] uppercase tracking-widest bg-navy text-cream px-2.5 py-1 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                      style={{ letterSpacing: '0.1em' }}
                    >
                      {rateSaving ? '…' : 'Save'}
                    </button>
                  </div>
                  {rateError && <p className="text-[10px] text-red-600">{rateError}</p>}
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <span className="text-[12px] text-ink font-medium">${projectExpert.expertRate}/hr</span>
                  <button
                    onClick={() => setRateEditing(true)}
                    className="text-[10px] text-muted hover:text-navy underline-offset-2 hover:underline transition-colors"
                  >
                    Edit
                  </button>
                </div>
              )}
            </div>

            {/* Legacy draft flow (if they have a draft already, keep access) */}
            {(projectExpert.outreachDraft || projectExpert.outreachSubject) && (
              <div className="space-y-1">
                <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
                  Manual Draft
                </p>
                {projectExpert.outreachSubject && (
                  <p className="text-[11px] font-medium text-navy truncate">{projectExpert.outreachSubject}</p>
                )}
                <button
                  onClick={() => setShowOutreach(true)}
                  className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
                >
                  View / Regenerate ↻
                </button>
              </div>
            )}

            {/* Send Email 1 button */}
            <div className="space-y-1.5 pt-1 border-t border-frame">
              <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
                Email Sequence
              </p>
              {sequenceError && <p className="text-[10px] text-red-600">{sequenceError}</p>}
              <button
                onClick={triggerEmail1}
                disabled={sequenceSending || saving || !projectExpert.expertRate}
                className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                style={{ letterSpacing: '0.1em' }}
                title={!projectExpert.expertRate ? 'Set expert rate first' : undefined}
              >
                {sequenceSending ? 'Sending…' : 'Send Email 1 →'}
              </button>
              {!projectExpert.expertRate && (
                <p className="text-[10px] text-muted/70 italic">Set a rate above before sending.</p>
              )}
            </div>
          </div>
        )}

        {/* ── Sequence status display (in-sequence statuses) ── */}
        {inSequence && (
          <div className="space-y-3">

            {/* Rate display (always visible in sequence) */}
            {projectExpert.expertRate && (
              <div className="flex items-center gap-2">
                <span className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>Rate:</span>
                <span className="text-[11px] text-ink font-medium">${projectExpert.expertRate}/hr</span>
                {!isCompleted && (
                  <button
                    onClick={() => setRateEditing(r => !r)}
                    className="text-[10px] text-muted hover:text-navy underline-offset-2 hover:underline transition-colors"
                  >
                    Edit
                  </button>
                )}
              </div>
            )}
            {rateEditing && !isCompleted && (
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[11px] text-muted">$</span>
                  <input
                    type="number" min={1} max={9999}
                    value={rateInput}
                    onChange={e => setRateInput(e.target.value)}
                    placeholder="e.g. 500"
                    className="w-24 px-2 py-1 text-[11px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink"
                  />
                  <span className="text-[11px] text-muted">/hr</span>
                  <button onClick={saveRate} disabled={rateSaving}
                    className="text-[10px] uppercase tracking-widest bg-navy text-cream px-2.5 py-1 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                  >
                    {rateSaving ? '…' : 'Save'}
                  </button>
                </div>
                {rateError && <p className="text-[10px] text-red-600">{rateError}</p>}
              </div>
            )}

            {/* Contact email row */}
            <EmailRow pe={projectExpert} onCopy={copyEmail} copied={copiedEmail} />

            {/* ── Timeline ── */}
            <div className="pt-2 border-t border-frame space-y-2">
              <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
                Email Sequence Status
              </p>

              <div className="space-y-2">
                {/* Email 1 */}
                <TimelineEntry
                  done={hasEmail1}
                  active={!hasEmail1}
                  label="Email 1 — Interest check"
                  timestamp={projectExpert.email1SentAt}
                />

                {/* Reply */}
                {hasEmail1 && (
                  <TimelineEntry
                    done={hasReply}
                    active={hasEmail1 && !hasReply}
                    label={hasReply
                      ? `Reply detected — ${projectExpert.replyIntent === 'interested' ? 'Interested' :
                          projectExpert.replyIntent === 'declined' ? 'Declined' :
                          projectExpert.replyIntent === 'counter_rate' ? 'Counter rate' :
                          projectExpert.replyIntent === 'conflict' ? 'Conflict flagged' : 'Unclear'}`
                      : 'Awaiting reply…'}
                    timestamp={projectExpert.replyDetectedAt}
                  />
                )}

                {/* Email 2 */}
                {(hasReply || hasEmail2) && status !== 'rejected_after_outreach' && (
                  <TimelineEntry
                    done={hasEmail2}
                    active={hasReply && !hasEmail2}
                    label="Email 2 — Conflict check + rate confirmation"
                    timestamp={projectExpert.email2SentAt}
                  />
                )}

                {/* Email 3 */}
                {(hasEmail2 || hasEmail3) && (
                  <TimelineEntry
                    done={hasEmail3}
                    active={hasEmail2 && !hasEmail3}
                    label="Email 3 — Scheduling link"
                    timestamp={projectExpert.email3SentAt}
                  />
                )}

                {/* Scheduled */}
                {(hasEmail3 || isScheduled) && (
                  <TimelineEntry
                    done={isScheduled}
                    active={hasEmail3 && !isScheduled}
                    label={isScheduled && projectExpert.scheduledTime
                      ? `Scheduled — ${projectExpert.scheduledTime}`
                      : 'Awaiting scheduling…'}
                  />
                )}

                {/* Completed */}
                {isScheduled && (
                  <TimelineEntry
                    done={isCompleted}
                    active={isScheduled && !isCompleted}
                    label="Completed"
                  />
                )}

                {/* Declined */}
                {status === 'rejected_after_outreach' && (
                  <TimelineEntry
                    done
                    label="Declined — no further action"
                  />
                )}
              </div>
            </div>

            {/* ── Rate negotiation panel ── */}
            {status === 'rate_negotiation' && (
              <div className="bg-amber-50 border border-amber-300 px-3 py-2.5 space-y-2">
                <p className="text-[9px] uppercase tracking-widest text-amber-700 font-medium" style={{ letterSpacing: '0.14em' }}>
                  Rate Negotiation
                </p>
                {projectExpert.counterRateProposed && (
                  <p className="text-[11px] text-ink">
                    Expert proposed: <strong>${projectExpert.counterRateProposed}/hr</strong>
                  </p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  {/* Approve counter rate */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-muted">$</span>
                    <input
                      type="number" min={1} max={9999}
                      value={approveRate || String(projectExpert.counterRateProposed ?? '')}
                      onChange={e => setApproveRate(e.target.value)}
                      placeholder="Approve rate"
                      className="w-20 px-2 py-1 text-[11px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink"
                    />
                    <span className="text-[10px] text-muted">/hr</span>
                    <button
                      onClick={approveCounterRate}
                      disabled={approveSaving || saving}
                      className="text-[10px] uppercase tracking-widest bg-navy text-cream px-2.5 py-1 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                    >
                      {approveSaving ? '…' : 'Approve'}
                    </button>
                  </div>
                  <button
                    onClick={() => patch({ status: 'rejected_after_outreach' })}
                    disabled={saving}
                    className="text-[10px] uppercase tracking-widest text-red-600 border border-red-200 hover:bg-red-50 px-2.5 py-1 transition-colors disabled:opacity-40"
                  >
                    Pass
                  </button>
                </div>
                {approveError && <p className="text-[10px] text-red-600">{approveError}</p>}
              </div>
            )}

            {/* ── Conflict flag panel ── */}
            {status === 'conflict_flagged' && (
              <div className="bg-red-50 border border-red-300 px-3 py-2.5 space-y-2">
                <p className="text-[9px] uppercase tracking-widest text-red-700 font-medium" style={{ letterSpacing: '0.14em' }}>
                  Conflict Flagged
                </p>
                {projectExpert.conflictNote && (
                  <p className="text-[11px] text-ink italic">{projectExpert.conflictNote}</p>
                )}
                <div className="flex items-center gap-2 flex-wrap">
                  <button
                    onClick={() => patch({ status: 'rejected_after_outreach' })}
                    disabled={saving}
                    className="text-[10px] uppercase tracking-widest text-red-700 border border-red-300 hover:bg-red-100 px-2.5 py-1 transition-colors disabled:opacity-40"
                  >
                    {saving ? '…' : 'Reject'}
                  </button>
                  <button
                    onClick={() => patch({ status: 'replied', replyIntent: 'interested', conflictNote: undefined })}
                    disabled={saving}
                    className="text-[10px] uppercase tracking-widest text-muted border border-frame hover:border-navy hover:text-navy px-2.5 py-1 transition-colors disabled:opacity-40"
                  >
                    Override — Continue
                  </button>
                </div>
              </div>
            )}

            {/* ── Scheduling panel (email3 sent, not yet scheduled) ── */}
            {status === 'scheduling_sent' && (
              <div className="space-y-2 pt-2 border-t border-frame">
                <p className="text-[10px] text-muted">Confirm slot manually if expert replies with a time:</p>
                <input
                  type="text"
                  value={slotDate}
                  onChange={e => setSlotDate(e.target.value)}
                  placeholder="e.g. Tue Jun 10, 2:00 pm"
                  className="w-full px-2.5 py-1.5 text-[11px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink placeholder:text-muted/60"
                />
                <select
                  value={slotTz}
                  onChange={e => setSlotTz(e.target.value as Timezone)}
                  className="text-[11px] border border-frame bg-cream text-ink px-2 py-1.5 focus:outline-none focus:border-navy"
                >
                  {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
                </select>
                <button
                  onClick={() => {
                    if (!slotDate.trim()) return;
                    patch({ scheduledTime: `${slotDate.trim()} ${slotTz}`, status: 'scheduled' });
                  }}
                  disabled={saving || !slotDate.trim()}
                  className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                  style={{ letterSpacing: '0.1em' }}
                >
                  {saving ? '…' : 'Confirm Slot →'}
                </button>
              </div>
            )}

            {/* ── Scheduled panel ── */}
            {status === 'scheduled' && (
              <div className="space-y-3 pt-2 border-t border-frame">
                {projectExpert.scheduledTime && (
                  <div className="bg-green-50 border border-green-200 px-3 py-2.5">
                    <p className="text-[9px] uppercase tracking-widest text-green-600 font-medium mb-1" style={{ letterSpacing: '0.14em' }}>
                      Confirmed Slot
                    </p>
                    <p className="text-sm font-medium text-green-800">{projectExpert.scheduledTime}</p>
                  </div>
                )}
                {completeRateError && <p className="text-[10px] text-red-600">{completeRateError}</p>}
                <button
                  onClick={() => {
                    if (!projectExpert.expertRate) {
                      setCompleteRateError('Set expert rate before marking complete.');
                      return;
                    }
                    setCompleteRateError('');
                    setCompleteDuration('');
                    setCompleteError('');
                    setShowCompleteModal(true);
                  }}
                  disabled={saving}
                  className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                  style={{ letterSpacing: '0.1em' }}
                >
                  Complete Engagement
                </button>
              </div>
            )}

            {/* ── Completed panel ── */}
            {isCompleted && (
              <div className="space-y-1 pt-2 border-t border-frame">
                <p className="text-[9px] uppercase tracking-widest font-medium text-teal-600" style={{ letterSpacing: '0.18em' }}>
                  ✓ Completed
                </p>
                {projectExpert.scheduledTime && (
                  <p className="text-[11px] text-muted">{projectExpert.scheduledTime}</p>
                )}
                {projectExpert.expertPaidAt && (
                  <p className="text-[11px] text-teal-600">Payout processed {formatDateShort(projectExpert.expertPaidAt)}</p>
                )}
                {projectExpert.expertOnboardingStatus === 'pending' && (
                  <p className="text-[11px] text-amber-600">Awaiting expert payout setup</p>
                )}
              </div>
            )}

          </div>
        )}

        {/* ── LinkedIn reference links ── */}
        {linkedInLinks.length > 0 && (
          <div className="pt-2 border-t border-frame flex flex-col gap-0.5">
            {linkedInLinks.map((l, i) => (
              <a
                key={i}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[10px] text-sky-700 hover:underline underline-offset-2"
                title="LinkedIn profile — reference only"
              >
                <span
                  className="inline-flex items-center justify-center w-3 h-3 rounded-sm bg-[#0077b5] text-white shrink-0"
                  style={{ fontSize: '6px', fontWeight: 700 }}
                >
                  in
                </span>
                {l.label || 'LinkedIn Profile'}
                <span className="text-muted/50">(reference)</span>
              </a>
            ))}
          </div>
        )}

      </div>

      {/* ── OutreachModal (for legacy draft) ── */}
      {showOutreach && (
        <OutreachModal
          expert={expert}
          query={query}
          prefillEmail={projectExpert.contactEmail}
          onClose={() => setShowOutreach(false)}
        />
      )}

      {/* ── Complete Engagement Modal ── */}
      {showCompleteModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(11,31,59,0.55)', backdropFilter: 'blur(2px)' }}
          onClick={e => { if (e.target === e.currentTarget) setShowCompleteModal(false); }}
        >
          <div
            className="bg-cream border border-frame w-full max-w-sm shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-label="Complete Engagement"
          >
            <div className="px-5 py-4 border-b border-frame flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-widest text-navy font-medium" style={{ letterSpacing: '0.16em' }}>
                Complete Engagement
              </p>
              <button
                onClick={() => setShowCompleteModal(false)}
                className="text-muted hover:text-navy transition-colors p-1"
                aria-label="Close"
              >
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            <div className="px-5 py-5 space-y-4">
              <div>
                <label className="block text-[10px] uppercase tracking-widest text-muted font-medium mb-1.5" style={{ letterSpacing: '0.18em' }}>
                  Call Duration (minutes)
                </label>
                <input
                  type="number"
                  min={1}
                  max={480}
                  value={completeDuration}
                  onChange={e => setCompleteDuration(e.target.value)}
                  placeholder="e.g. 60"
                  autoFocus
                  className="w-full px-2.5 py-1.5 text-[11px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink"
                />
              </div>

              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-1" style={{ letterSpacing: '0.18em' }}>
                  Expert Rate
                </p>
                <p className="text-[12px] text-ink">${projectExpert.expertRate}/hr</p>
              </div>

              <div className="bg-navy/5 border border-navy/15 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-widest text-navy/50 font-medium mb-0.5" style={{ letterSpacing: '0.16em' }}>
                  Invoice Amount
                </p>
                <p className="text-lg font-display font-semibold text-navy">
                  {(() => {
                    const dur  = parseInt(completeDuration, 10);
                    const rate = projectExpert.expertRate;
                    if (!rate || !dur || isNaN(dur) || dur < 1) return '—';
                    return `$${Math.round((rate * dur) / 60).toLocaleString()}`;
                  })()}
                </p>
                <p className="text-[10px] text-muted/60 mt-0.5">rate × duration / 60</p>
              </div>

              {completeError && <p className="text-[10px] text-red-600">{completeError}</p>}

              <div className="flex items-center gap-2 pt-1">
                <button
                  onClick={submitComplete}
                  disabled={completeSubmitting || !completeDuration}
                  className="flex-1 text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-2 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                  style={{ letterSpacing: '0.1em' }}
                >
                  {completeSubmitting ? 'Sending…' : 'Complete + Send Invoice'}
                </button>
                <button
                  onClick={() => setShowCompleteModal(false)}
                  className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-3 py-2 transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

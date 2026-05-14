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
  contact_found:    'text-sky-600   border-sky-200   bg-sky-50',
  outreach_drafted: 'text-sky-700   border-sky-300   bg-sky-50',
  contacted:        'text-amber-700 border-amber-300 bg-amber-50',
  replied:          'text-amber-700 border-amber-400 bg-amber-50',
  scheduled:        'text-green-700 border-green-200 bg-green-50',
  completed:        'text-navy      border-navy/20   bg-navy/5',
};

const STATUS_LABEL: Record<string, string> = {
  contact_found:    'Contact Found',
  outreach_drafted: 'Draft Ready',
  contacted:        'Contacted',
  replied:          'Replied',
  scheduled:        'Scheduled',
  completed:        'Completed',
};

const STEP_SHORT: Record<number, string> = {
  1: 'Email', 2: 'Draft', 3: 'Send', 4: 'Reply', 5: 'Slot', 6: 'Call', 7: 'Done',
};

// ─── Step derivation ──────────────────────────────────────────────────────────

type Step = 1 | 2 | 3 | 4 | 5 | 6 | 7;

function deriveStep(pe: ProjectExpert): Step {
  const s = pe.status as ExpertStatus;
  if (s === 'completed')        return 7;
  if (s === 'scheduled')        return 6;
  if (s === 'replied')          return 5;
  if (s === 'contacted')        return 4;
  if (s === 'outreach_drafted') return 3;
  if (pe.contactEmail)          return 2;   // contact_found + email known
  return 1;                                  // contact_found + no email yet
}

// ─── Step tracker ─────────────────────────────────────────────────────────────

function StepTracker({ current }: { current: Step }) {
  const steps = [1, 2, 3, 4, 5, 6, 7] as Step[];
  return (
    <div className="flex items-start">
      {steps.map((s, i) => {
        const done   = s < current;
        const active = s === current;
        return (
          <div key={s} className="flex items-center">
            <div className="flex flex-col items-center gap-0.5">
              <div className={`w-[18px] h-[18px] rounded-full flex items-center justify-center text-[7px] font-bold shrink-0 ${
                done   ? 'bg-teal-600 text-white' :
                active ? 'bg-navy text-cream' :
                         'bg-slate-100 text-slate-300 border border-slate-200'
              }`}>
                {done ? '✓' : s}
              </div>
              <span
                className={`text-[7px] text-center leading-none ${
                  active ? 'text-navy font-semibold' : done ? 'text-teal-600' : 'text-slate-300'
                }`}
                style={{ width: '26px' }}
              >
                {STEP_SHORT[s]}
              </span>
            </div>
            {i < steps.length - 1 && (
              <div className={`w-3 h-px self-start mt-[9px] shrink-0 ${s < current ? 'bg-teal-500' : 'bg-slate-200'}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Email row ────────────────────────────────────────────────────────────────

function EmailRow({
  pe,
  onCopy,
  copied,
}: {
  pe: ProjectExpert;
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

// ─── Draft preview ────────────────────────────────────────────────────────────

function DraftPreview({ pe }: { pe: ProjectExpert }) {
  if (!pe.outreachDraft) return null;
  return (
    <div className="bg-slate-50 border border-frame px-3 py-2 space-y-1">
      {pe.outreachSubject && (
        <p className="text-[11px] font-medium text-navy truncate">{pe.outreachSubject}</p>
      )}
      <p className="text-[10px] text-muted leading-relaxed line-clamp-2">{pe.outreachDraft}</p>
    </div>
  );
}

// ─── Calendar invite stub ─────────────────────────────────────────────────────

// TODO: wire to Google Calendar API next session
function createCalendarInviteStub(expertName: string, scheduledTime: string): void {
  console.log('[OutreachCard] Create Calendar Invite — stub, wire to Google Calendar:', { expertName, scheduledTime });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
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

  const [saving,          setSaving]         = useState(false);
  const [showOutreach,    setShowOutreach]    = useState(false);
  const [showEmailLookup, setShowEmailLookup] = useState(false);
  const [showRecheck,     setShowRecheck]     = useState(false);
  const [showDraftEditor, setShowDraftEditor] = useState(false);
  const [draftText,       setDraftText]       = useState(projectExpert.outreachDraft ?? '');
  const [subjectText,     setSubjectText]     = useState(projectExpert.outreachSubject ?? '');
  const [draftSaving,     setDraftSaving]     = useState(false);
  const [slotDate,        setSlotDate]        = useState('');
  const [slotTz,          setSlotTz]          = useState<Timezone>('ET');
  const [copiedEmail,     setCopiedEmail]     = useState(false);
  // Step 5: availability request
  const [availSending,    setAvailSending]    = useState(false);
  const [availError,      setAvailError]      = useState('');
  const [availSentAt,     setAvailSentAt]     = useState<number | null>(null);
  const [showManualSlot,  setShowManualSlot]  = useState(false);
  // Interview prep (collapsible — visible at steps 3 & 4)
  const [showPrep,        setShowPrep]        = useState(false);
  const [prepGenerating,  setPrepGenerating]  = useState(false);
  const [prepError,       setPrepError]       = useState('');
  const [prepQuestions,   setPrepQuestions]   = useState<string[]>(projectExpert.vettingQuestions ?? []);
  // Expert rate (step 2)
  const [rateInput,       setRateInput]       = useState(projectExpert.expertRate != null ? String(projectExpert.expertRate) : '');
  const [rateEditing,     setRateEditing]     = useState(projectExpert.expertRate == null);
  const [rateSaving,      setRateSaving]      = useState(false);
  const [rateError,       setRateError]       = useState('');
  // Completion modal (step 6)
  const [showCompleteModal,    setShowCompleteModal]    = useState(false);
  const [completeDuration,     setCompleteDuration]     = useState('');
  const [completeError,        setCompleteError]        = useState('');
  const [completeSubmitting,   setCompleteSubmitting]   = useState(false);
  const [completeRateError,    setCompleteRateError]    = useState('');

  const step            = deriveStep(projectExpert);
  const status          = projectExpert.status as ExpertStatus;
  const statusPillClass = STATUS_PILL[status] ?? 'text-muted border-frame';

  const linkedInLinks = (expert.source_links ?? []).filter(
    l => l.type === 'LinkedIn' && isLinkedInProfileUrl(l.url),
  );

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

  // saveDraft also advances status to outreach_drafted when called from step 2
  async function saveDraft() {
    setDraftSaving(true);
    try {
      const fields: Record<string, unknown> = {
        outreachDraft:   draftText.trim(),
        outreachSubject: subjectText.trim(),
      };
      if (status === 'contact_found') fields.status = 'outreach_drafted';
      const res = await fetch(`/api/projects/${projectId}/experts/${expert.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(fields),
      });
      const data = await res.json() as { project?: { experts: ProjectExpert[] } };
      if (res.ok) {
        const updated = data.project?.experts.find(e => e.expert.id === expert.id);
        if (updated) onUpdate(updated);
        setShowDraftEditor(false);
      }
    } finally {
      setDraftSaving(false);
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

  function openDraftEditor() {
    setDraftText(projectExpert.outreachDraft ?? '');
    setSubjectText(projectExpert.outreachSubject ?? '');
    setShowDraftEditor(true);
  }

  async function generatePrepQuestions() {
    setPrepGenerating(true);
    setPrepError('');
    try {
      const res  = await fetch(`/api/projects/${projectId}/vetting-questions`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ expertId: expert.id }),
      });
      const data = await res.json() as { questions?: string[]; source?: string; error?: string };
      if (!res.ok || !data.questions) {
        setPrepError('Failed to generate questions. Try again.');
        return;
      }
      setPrepQuestions(data.questions);
      // Persist to projectExpert so questions survive tab switches
      await patch({ vettingQuestions: data.questions });
    } catch {
      setPrepError('Network error. Try again.');
    } finally {
      setPrepGenerating(false);
    }
  }

  async function requestAvailability() {
    setAvailSending(true);
    setAvailError('');
    try {
      const res  = await fetch(`/api/projects/${projectId}/experts/${expert.id}/request-availability`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json() as { ok?: boolean; error?: string; expiresAt?: number };
      if (!res.ok) {
        if (res.status === 422) {
          setAvailError('No email address on file — find the expert\'s email first.');
        } else if (res.status === 429) {
          setAvailError('Too many requests. Try again in a few minutes.');
        } else {
          setAvailError(data.error ?? 'Failed to send request. Please try again.');
        }
        return;
      }
      setAvailSentAt(Date.now());
      // Optimistically reload the expert state (server also updated availabilityRequestedAt)
      const projectRes = await fetch(`/api/projects/${projectId}/experts/${expert.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ availabilityRequestedAt: Date.now() }),
      });
      const projectData = await projectRes.json() as { project?: { experts: import('../types').ProjectExpert[] } };
      if (projectRes.ok) {
        const updated = projectData.project?.experts.find(e => e.expert.id === expert.id);
        if (updated) onUpdate(updated);
      }
    } catch {
      setAvailError('Network error. Please try again.');
    } finally {
      setAvailSending(false);
    }
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
      // Optimistically update local state
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

  // ── Interview prep block (collapsible, steps 3 & 4) ────────────────────────
  // Defined at render time to avoid hook ordering issues.

  const effectivePrepQuestions = prepQuestions.length > 0
    ? prepQuestions
    : (projectExpert.vettingQuestions ?? []);

  const interviewPrepBlock = (
    <div className="pt-3 border-t border-frame space-y-2">
      <div className="flex items-center justify-between gap-2">
        <button
          onClick={() => setShowPrep(p => !p)}
          className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
          style={{ letterSpacing: '0.14em' }}
        >
          {showPrep ? 'Hide prep ↑' : effectivePrepQuestions.length > 0 ? 'Vetting call prep ↓' : '+ Vetting call prep'}
        </button>
        {showPrep && (
          <button
            onClick={generatePrepQuestions}
            disabled={prepGenerating || saving}
            className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2 py-1 transition-colors disabled:opacity-40"
          >
            {prepGenerating ? 'Generating…' : effectivePrepQuestions.length > 0 ? 'Regenerate' : 'Generate Questions'}
          </button>
        )}
      </div>

      {showPrep && (
        <div className="space-y-2">
          {prepError && <p className="text-[10px] text-red-600">{prepError}</p>}

          {effectivePrepQuestions.length > 0 ? (
            <ol className="space-y-1.5 list-none">
              {effectivePrepQuestions.map((q, i) => (
                <li key={i} className="flex gap-2 text-[11px] text-ink leading-snug">
                  <span className="shrink-0 font-medium text-navy">{i + 1}.</span>
                  {q}
                </li>
              ))}
            </ol>
          ) : !prepGenerating && (
            <p className="text-[10px] text-muted/60 italic">
              Generate AI-tailored questions to use on the vetting call.
            </p>
          )}

          {prepGenerating && (
            <div className="flex items-center gap-2 text-[11px] text-muted">
              <span className="inline-block w-3 h-3 border border-navy border-t-transparent rounded-full animate-spin shrink-0" />
              Generating…
            </div>
          )}
        </div>
      )}
    </div>
  );

  // ── Shared draft editor markup ───────────────────────────────────────────────
  // Defined as a render-time block (not a component) to avoid hook-ordering issues.

  const draftEditorBlock = (
    <div className="space-y-2">
      <input
        type="text"
        value={subjectText}
        onChange={e => setSubjectText(e.target.value)}
        placeholder="Subject line…"
        className="w-full px-2.5 py-1.5 text-[11px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink"
      />
      <textarea
        value={draftText}
        onChange={e => setDraftText(e.target.value)}
        placeholder="Outreach message body…"
        rows={5}
        className="w-full px-2.5 py-2 text-[11px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink resize-none"
        autoFocus
      />
      <div className="flex items-center gap-2">
        <button
          onClick={saveDraft}
          disabled={draftSaving}
          className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
        >
          {draftSaving ? 'Saving…' : 'Save draft'}
        </button>
        <button
          onClick={() => setShowDraftEditor(false)}
          className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );

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

        {/* ── Step tracker ── */}
        <StepTracker current={step} />

        {/* ── Active step panel ── */}
        <div className="border-t border-frame pt-3 space-y-3">

          {/* ─────────────────────────────────────────────────────────────
              Step 1 — Find Email
              ───────────────────────────────────────────────────────────── */}
          {step === 1 && (
            <>
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
            </>
          )}

          {/* ─────────────────────────────────────────────────────────────
              Step 2 — Draft Outreach
              ───────────────────────────────────────────────────────────── */}
          {step === 2 && (
            <>
              <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
                Step 2 — Draft Outreach
              </p>

              <EmailRow pe={projectExpert} onCopy={copyEmail} copied={copiedEmail} />

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

              {/* Re-check email toggle */}
              <div className="space-y-2">
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

              {/* Draft area */}
              {showDraftEditor ? draftEditorBlock : (
                <div className="space-y-2">
                  {projectExpert.outreachDraft ? (
                    <>
                      <DraftPreview pe={projectExpert} />
                      <div className="flex items-center gap-3">
                        <button
                          onClick={openDraftEditor}
                          className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
                        >
                          Edit draft
                        </button>
                        <button
                          onClick={() => setShowOutreach(true)}
                          className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
                        >
                          Regenerate ↻
                        </button>
                      </div>
                      <button
                        onClick={() => patch({ status: 'outreach_drafted' })}
                        disabled={saving}
                        className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                        style={{ letterSpacing: '0.1em' }}
                      >
                        {saving ? '…' : 'Draft Ready →'}
                      </button>
                    </>
                  ) : (
                    <div className="flex items-center gap-2 flex-wrap">
                      <button
                        onClick={() => setShowOutreach(true)}
                        className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 transition-colors"
                        style={{ letterSpacing: '0.1em' }}
                      >
                        Generate draft
                      </button>
                      <button
                        onClick={openDraftEditor}
                        className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2 py-1 transition-colors"
                      >
                        Write manually
                      </button>
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ─────────────────────────────────────────────────────────────
              Step 3 — Mark Sent
              ───────────────────────────────────────────────────────────── */}
          {step === 3 && (
            <>
              <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
                Step 3 — Mark Sent
              </p>

              <EmailRow pe={projectExpert} onCopy={copyEmail} copied={copiedEmail} />

              {showDraftEditor ? draftEditorBlock : (
                <div className="space-y-2">
                  <DraftPreview pe={projectExpert} />
                  <button
                    onClick={openDraftEditor}
                    className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
                  >
                    Edit draft
                  </button>
                  <button
                    onClick={() => patch({ status: 'contacted', contactedAt: Date.now() })}
                    disabled={saving}
                    className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                    style={{ letterSpacing: '0.1em' }}
                  >
                    {saving ? '…' : 'Mark Sent →'}
                  </button>
                </div>
              )}

              {/* Interview prep — generate vetting questions to use on the call */}
              {interviewPrepBlock}
            </>
          )}

          {/* ─────────────────────────────────────────────────────────────
              Step 4 — Awaiting Reply
              ───────────────────────────────────────────────────────────── */}
          {step === 4 && (
            <>
              <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
                Step 4 — Awaiting Reply
              </p>
              {projectExpert.contactedAt && (
                <p className="text-[11px] text-muted">📤 Sent {formatDate(projectExpert.contactedAt)}</p>
              )}
              <EmailRow pe={projectExpert} onCopy={copyEmail} copied={copiedEmail} />
              <button
                onClick={() => patch({ status: 'replied' })}
                disabled={saving}
                className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                style={{ letterSpacing: '0.1em' }}
              >
                {saving ? '…' : 'Mark Replied →'}
              </button>

              {/* Interview prep — available while waiting so analyst can prepare */}
              {interviewPrepBlock}
            </>
          )}

          {/* ─────────────────────────────────────────────────────────────
              Step 5 — Request Availability
              ───────────────────────────────────────────────────────────── */}
          {step === 5 && (
            <>
              <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
                Step 5 — Request Availability
              </p>

              {/* ── Already submitted via availability form ── */}
              {projectExpert.availabilitySubmitted ? (
                <div className="space-y-3">
                  <div className="bg-teal-50 border border-teal-200 px-3 py-2.5 space-y-2">
                    <p className="text-[9px] uppercase tracking-widest text-teal-600 font-medium" style={{ letterSpacing: '0.14em' }}>
                      Availability Received
                    </p>
                    {/* Calendly link */}
                    {projectExpert.calendarProvider === 'calendly' &&
                      projectExpert.availabilitySlots?.[0]?.startTime && (
                      <div>
                        <a
                          href={projectExpert.availabilitySlots[0].startTime}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[11px] text-sky-700 hover:underline underline-offset-2 break-all"
                        >
                          {projectExpert.availabilitySlots[0].startTime}
                        </a>
                        <span className="ml-1 text-[10px] text-muted">(Calendly)</span>
                      </div>
                    )}
                    {/* Parsed manual slots */}
                    {projectExpert.calendarProvider === 'manual' && (
                      <div className="space-y-1">
                        {(projectExpert.availabilitySlots ?? []).length > 0
                          ? projectExpert.availabilitySlots!.map((slot, i) => (
                            <p key={i} className="text-[11px] text-ink">
                              {slot.dayOfWeek ? `${slot.dayOfWeek} ` : ''}
                              {slot.date ? `${slot.date} ` : ''}
                              {slot.startTime}–{slot.endTime} {slot.timezone}
                            </p>
                          ))
                          : projectExpert.availabilityRaw && (
                            <p className="text-[11px] text-ink italic leading-relaxed">
                              {projectExpert.availabilityRaw}
                            </p>
                          )
                        }
                      </div>
                    )}
                  </div>

                  {/* Confirm slot inputs */}
                  <div className="space-y-2">
                    <p className="text-[10px] text-muted">Confirm the agreed slot:</p>
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
                  </div>
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
              ) : (
                /* ── Not yet submitted ── */
                <div className="space-y-3">
                  <p className="text-[11px] text-muted">
                    Expert replied. Send them a scheduling link to share their availability.
                  </p>

                  {/* Prior request timestamp */}
                  {(projectExpert.availabilityRequestedAt || availSentAt) && (
                    <p className="text-[10px] text-teal-600">
                      ✓ Request sent {formatDate(availSentAt ?? projectExpert.availabilityRequestedAt!)} — waiting for response.
                    </p>
                  )}

                  {availError && (
                    <p className="text-[10px] text-red-600">{availError}</p>
                  )}

                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={requestAvailability}
                      disabled={availSending || saving}
                      className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                      style={{ letterSpacing: '0.1em' }}
                    >
                      {availSending
                        ? 'Sending…'
                        : (projectExpert.availabilityRequestedAt || availSentAt)
                          ? 'Re-send Request'
                          : 'Send Availability Request'
                      }
                    </button>
                    <button
                      onClick={() => setShowManualSlot(s => !s)}
                      className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-2 py-1 transition-colors"
                    >
                      {showManualSlot ? 'Cancel' : 'Confirm Manually'}
                    </button>
                  </div>

                  {/* Manual slot fallback */}
                  {showManualSlot && (
                    <div className="space-y-2 pt-1 border-t border-frame">
                      <p className="text-[10px] text-muted">Enter the slot agreed via email or phone:</p>
                      <input
                        type="text"
                        value={slotDate}
                        onChange={e => setSlotDate(e.target.value)}
                        placeholder="e.g. Tue Jun 10, 2:00 pm"
                        className="w-full px-2.5 py-1.5 text-[11px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink placeholder:text-muted/60"
                        autoFocus
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
                </div>
              )}
            </>
          )}

          {/* ─────────────────────────────────────────────────────────────
              Step 6 — Scheduled
              ───────────────────────────────────────────────────────────── */}
          {step === 6 && (
            <>
              <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
                Step 6 — Scheduled
              </p>
              {projectExpert.scheduledTime && (
                <div className="bg-green-50 border border-green-200 px-3 py-2.5">
                  <p
                    className="text-[9px] uppercase tracking-widest text-green-600 font-medium mb-1"
                    style={{ letterSpacing: '0.14em' }}
                  >
                    Confirmed Slot
                  </p>
                  <p className="text-sm font-medium text-green-800">{projectExpert.scheduledTime}</p>
                </div>
              )}
              <div className="flex flex-col gap-2">
                <button
                  onClick={() => createCalendarInviteStub(expert.name, projectExpert.scheduledTime ?? '')}
                  className="text-[10px] uppercase tracking-widest border border-navy text-navy px-3 py-1.5 hover:bg-navy hover:text-cream transition-colors"
                  style={{ letterSpacing: '0.1em' }}
                >
                  Create Calendar Invite
                </button>
                {completeRateError && (
                  <p className="text-[10px] text-red-600">{completeRateError}</p>
                )}
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
            </>
          )}

          {/* ─────────────────────────────────────────────────────────────
              Step 7 — Completed
              ───────────────────────────────────────────────────────────── */}
          {step === 7 && (
            <>
              <p
                className="text-[9px] uppercase tracking-widest font-medium text-teal-600"
                style={{ letterSpacing: '0.18em' }}
              >
                ✓ Completed
              </p>
              {projectExpert.scheduledTime && (
                <p className="text-[11px] text-muted">📅 {projectExpert.scheduledTime}</p>
              )}
              {projectExpert.contactedAt && (
                <p className="text-[11px] text-muted">Contacted {formatDate(projectExpert.contactedAt)}</p>
              )}
            </>
          )}

        </div>

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

      {/* ── OutreachModal (step 2: generate/regenerate) ── */}
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
            {/* Modal header */}
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

            {/* Modal body */}
            <div className="px-5 py-5 space-y-4">
              {/* Call duration */}
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

              {/* Expert rate (read-only) */}
              <div>
                <p className="text-[10px] uppercase tracking-widest text-muted font-medium mb-1" style={{ letterSpacing: '0.18em' }}>
                  Expert Rate
                </p>
                <p className="text-[12px] text-ink">${projectExpert.expertRate}/hr</p>
              </div>

              {/* Invoice amount (live computed) */}
              <div className="bg-navy/5 border border-navy/15 px-3 py-2.5">
                <p className="text-[10px] uppercase tracking-widest text-navy/50 font-medium mb-0.5" style={{ letterSpacing: '0.16em' }}>
                  Invoice Amount
                </p>
                <p className="text-lg font-display font-semibold text-navy">
                  {(() => {
                    const dur = parseInt(completeDuration, 10);
                    const rate = projectExpert.expertRate;
                    if (!rate || !dur || isNaN(dur) || dur < 1) return '—';
                    return `$${Math.round((rate * dur) / 60).toLocaleString()}`;
                  })()}
                </p>
                <p className="text-[10px] text-muted/60 mt-0.5">rate × duration / 60</p>
              </div>

              {completeError && (
                <p className="text-[10px] text-red-600">{completeError}</p>
              )}

              {/* Actions */}
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

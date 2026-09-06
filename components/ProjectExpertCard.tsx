'use client';

import { useState } from 'react';
import type { ProjectExpert, ExpertStatus, RejectionReason } from '../types';
import { classifySeniority, RATE_DISCLAIMER, TIER_PRICING } from '../lib/seniorityClassifier';
import ExpertCard from './ExpertCard';
import { STATUS_META, EXPERT_STATUSES } from '../lib/expertPipeline';
import { CLIENT_STATUS_META, hasConversation } from './matchyStatus';
import MatchyLine from './MatchyLine';
import {
  bookmarkExpert,
  unbookmarkExpert,
  bookmarkLine,
  firstNameOf,
  formatRate,
} from '../lib/matchyClient';

const REJECTION_REASONS: Array<{ value: RejectionReason; label: string }> = [
  { value: 'too_generic',             label: 'Too Generic'              },
  { value: 'wrong_industry',          label: 'Wrong Industry'           },
  { value: 'wrong_geography',         label: 'Wrong Geography'          },
  { value: 'weak_evidence',           label: 'Weak Evidence'            },
  { value: 'no_contact_path',         label: "Couldn't reach them"      },
  { value: 'conflict_risk',           label: 'Conflict Risk'            },
  { value: 'not_senior_enough',       label: 'Not Senior Enough'        },
  { value: 'too_academic',            label: 'Too Academic'             },
  { value: 'vendor_biased',           label: 'Vendor Biased'            },
  { value: 'better_option_available', label: 'Better Option Available'  },
  { value: 'other',                   label: 'Other'                    },
];

// Reasons that warrant a follow-up notes field
const REASONS_WITH_NOTES = new Set<RejectionReason>(['other', 'better_option_available', 'conflict_risk']);

// Full status list, in pipeline order. Derived so the controlled <select> always
// contains the expert's current status — mid-pipeline states (email2_sent,
// scheduling_sent, rate_negotiation, …) were previously missing and rendered
// the select with no matching option.
const ALL_STATUSES: readonly ExpertStatus[] = EXPERT_STATUSES;

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  projectExpert: ProjectExpert;
  projectId: string;
  query: string;
  onUpdate: (updated: ProjectExpert) => void;
  onRemove: (expertId: string) => void;
  onInterviewGuide: (expertId: string) => void;
  /** Owner or staff. Collaborators browse Matches but cannot start outreach. */
  canBookmark?: boolean;
  /** Staff see the raw status machinery; clients see plain stages only. */
  isAdmin?: boolean;
  /** Jump to this expert's thread after a bookmark starts the engagement. */
  onOpenConversation?: (expertId: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProjectExpertCard({
  projectExpert,
  projectId,
  query,
  onUpdate,
  onRemove,
  onInterviewGuide,
  canBookmark = true,
  isAdmin = false,
  onOpenConversation,
}: Props) {
  const { expert, status, rejectionReason, rejectionNotes, userNotes, contactEmail } = projectExpert;
  // Prefer the tier persisted at sourcing time — lib/redactExpert.ts blanks
  // `title` for anonymized experts, so classifying from it would read them all
  // as Mid-Level.
  const tier    = expert.seniorityTier ?? classifySeniority(expert.title ?? '');
  const pricing = expert.tierPricing ?? TIER_PRICING[tier];
  const [saving,           setSaving]           = useState(false);
  const [removing,         setRemoving]         = useState(false);
  const [noteOpen,         setNoteOpen]         = useState(false);
  const [noteText,         setNoteText]         = useState('');
  const [rejNoteText,      setRejNoteText]      = useState(rejectionNotes ?? '');
  const [rejNoteSaving,    setRejNoteSaving]    = useState(false);
  // Matchy's one line about this expert — the outcome of the last thing it did.
  const [matchyNote, setMatchyNote] = useState<{ text: string; tone: 'default' | 'quiet' | 'alert' } | null>(null);
  const [bookmarking, setBookmarking] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);

  const firstName  = firstNameOf(expert.name);
  // What the client pays. Falls back to the tier's opening position until the
  // engagement seeds a number. `expertRate` is never read here.
  const clientRate = projectExpert.clientRate ?? pricing.callRate;

  // ── Bookmark: the one action that starts an engagement ─────────────────────

  async function handleBookmark() {
    if (bookmarking) return;
    setBookmarking(true);
    setMatchyNote(null);
    // Optimistic — the button should never look like it did nothing.
    const now = Date.now();
    onUpdate({ ...projectExpert, status: 'bookmarked', updatedAt: now });

    const res = await bookmarkExpert(projectId, expert.id);
    setBookmarking(false);

    if (!res.ok) {
      // Put the card back the way it was and say what happened.
      onUpdate({ ...projectExpert, updatedAt: now });
      setMatchyNote({ text: res.message, tone: 'alert' });
      return;
    }

    onUpdate(res.projectExpert);
    setMatchyNote({
      text: bookmarkLine(res.outcome, firstName),
      tone: res.outcome === 'intro_sent' || res.outcome === 'intro_drafted' ? 'default' : 'quiet',
    });
  }

  async function handleUnbookmark() {
    if (bookmarking) return;
    setBookmarking(true);
    const res = await unbookmarkExpert(projectId, expert.id);
    setBookmarking(false);

    if (!res.ok) {
      setMatchyNote({ text: res.message, tone: 'alert' });
      return;
    }
    setMatchyNote(null);
    if (res.projectExpert) onUpdate(res.projectExpert);
    else onUpdate({ ...projectExpert, status: 'shortlisted', updatedAt: Date.now() });
  }

  async function patchExpert(patch: Record<string, unknown>) {
    setSaving(true);
    try {
      const res  = await fetch(`/api/projects/${projectId}/experts/${expert.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      });
      const data = await res.json() as { project?: { experts: ProjectExpert[] } };
      if (!res.ok) return;
      const updated = data.project?.experts.find(e => e.expert.id === expert.id);
      if (updated) onUpdate(updated);
    } finally {
      setSaving(false);
    }
  }

  function handleStatusChange(next: ExpertStatus) {
    const now   = Date.now();
    const patch: Record<string, unknown> = { status: next };
    if (next === 'rejected') {
      patch.rejectedAt = now;
    } else {
      patch.rejectionReason = null;
      patch.rejectionNotes  = '';
    }
    // Record first contact timestamp when moving into 'contacted'
    if (next === 'contacted' && !projectExpert.contactedAt) {
      patch.contactedAt = now;
    }
    patchExpert(patch);
    // Optimistic local update
    onUpdate({
      ...projectExpert,
      status: next,
      updatedAt: now,
      ...(next === 'rejected' ? { rejectedAt: now } : { rejectionReason: undefined, rejectionNotes: undefined }),
      ...(next === 'contacted' && !projectExpert.contactedAt ? { contactedAt: now } : {}),
    });
  }

  async function saveRejectionNote() {
    const note = rejNoteText.trim();
    setRejNoteSaving(true);
    try {
      await patchExpert({ rejectionNotes: note });
      onUpdate({ ...projectExpert, rejectionNotes: note || undefined, updatedAt: Date.now() });
    } finally {
      setRejNoteSaving(false);
    }
  }

  async function handleAddNote() {
    const note = noteText.trim();
    if (!note) return;
    setNoteText('');
    setNoteOpen(false);
    await patchExpert({ note });
  }

  async function handleRemove() {
    setConfirmRemove(false);
    setRemoving(true);
    try {
      await fetch(`/api/projects/${projectId}/experts/${expert.id}`, { method: 'DELETE' });
      onRemove(expert.id);
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col">
      {/* Expert card — contact section suppressed in project context (managed by ScreeningCard/OutreachCard) */}
      <ExpertCard expert={expert} query={query} hideContact />

      {/* Project controls — strip below the card */}
      <div className="border border-t-0 border-frame bg-surface px-4 py-3 space-y-2.5">

        {/* Tier badge + agreed rate */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className={`text-[9px] uppercase tracking-widest font-semibold px-1.5 py-0.5 ${
            tier === 'executive' ? 'bg-amber-50 text-amber-700 border border-amber-200' :
            tier === 'senior'    ? 'bg-teal-50 text-teal-700 border border-teal-200' :
                                   'bg-slate-50 text-slate-500 border border-slate-200'
          }`} style={{ letterSpacing: '0.1em' }}>
            {pricing.label}
          </span>
          {status === 'bookmarked' || hasConversation(status) ? (
            <span className="text-[9px] text-muted">
              {formatRate(clientRate)}/hr · includes ExpertMatch fee
            </span>
          ) : (
            <span className="text-[9px] text-muted cursor-help" title={RATE_DISCLAIMER}>
              {formatRate(clientRate)}/hr
            </span>
          )}
          {projectExpert.agreedRate != null && (
            <span className="text-[9px] text-amber-700 font-medium">Agreed: {formatRate(projectExpert.agreedRate)}/hr</span>
          )}
        </div>

        {/* ── Primary actions: Bookmark / Pass ──
            Bookmarking is what starts the engagement: Matchy finds the address
            and sends the intro (docs/MATCHY_SPEC.md, "Workflow"). */}
        {status === 'discovered' || status === 'shortlisted' ? (
          <div className="flex gap-2">
            <button
              onClick={handleBookmark}
              disabled={saving || bookmarking || !canBookmark}
              className="flex-1 text-[11px] uppercase tracking-widest border-2 border-navy text-navy bg-navy/5 hover:bg-navy hover:text-cream py-2 font-medium transition-colors disabled:opacity-40"
              style={{ letterSpacing: '0.1em' }}
              title={canBookmark ? undefined : 'Only the project owner can start outreach.'}
            >
              {bookmarking ? 'Bookmarking…' : 'Bookmark'}
            </button>
            <button
              onClick={() => handleStatusChange('rejected')}
              disabled={saving || bookmarking}
              className="flex-1 text-[11px] uppercase tracking-widest border-2 border-frame text-muted hover:text-navy hover:border-navy py-2 font-medium transition-colors disabled:opacity-40"
              style={{ letterSpacing: '0.1em' }}
            >
              Pass
            </button>
          </div>
        ) : status === 'bookmarked' ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-center text-[11px] uppercase tracking-widest border-2 border-navy text-navy bg-navy/5 py-2 font-medium">
              Bookmarked
            </span>
            {canBookmark && (
              <button
                onClick={handleUnbookmark}
                disabled={bookmarking}
                className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame px-2.5 py-2 transition-colors disabled:opacity-40"
                title="Undo the bookmark"
              >
                Undo
              </button>
            )}
          </div>
        ) : status !== 'rejected' ? (
          <div className="flex items-center gap-2">
            <span className={`flex-1 text-center text-[11px] px-2 py-2 border font-medium uppercase tracking-wider ${CLIENT_STATUS_META[status].classes}`}>
              {CLIENT_STATUS_META[status].label}
            </span>
            {onOpenConversation && (
              <button
                onClick={() => onOpenConversation(expert.id)}
                className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame px-2.5 py-2 transition-colors"
              >
                Open
              </button>
            )}
          </div>
        ) : (
          /* rejected */
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-center text-[11px] uppercase tracking-widest border-2 border-slate-200 text-slate-500 bg-slate-50 py-2 font-medium">
                Passed
              </span>
              <button
                onClick={() => handleStatusChange('discovered')}
                disabled={saving}
                className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame px-2.5 py-2 transition-colors disabled:opacity-40"
                title="Put them back in Matches"
              >
                Undo
              </button>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-widest text-muted shrink-0">Reason:</span>
              <select
                value={rejectionReason ?? ''}
                onChange={e => patchExpert({ rejectionReason: e.target.value || null })}
                className="text-[10px] border border-frame bg-cream text-muted px-2 py-1 focus:outline-none focus:border-navy transition-colors flex-1"
              >
                <option value="">Select reason…</option>
                {REJECTION_REASONS.map(r => (
                  <option key={r.value} value={r.value}>{r.label}</option>
                ))}
              </select>
            </div>
            {/* Notes field — shown for reasons that warrant explanation */}
            {rejectionReason && REASONS_WITH_NOTES.has(rejectionReason) && (
              <div className="space-y-1.5">
                <textarea
                  value={rejNoteText}
                  onChange={e => setRejNoteText(e.target.value)}
                  onBlur={saveRejectionNote}
                  placeholder={
                    rejectionReason === 'conflict_risk'
                      ? 'Note the conflict (not shared externally)…'
                      : rejectionReason === 'better_option_available'
                      ? 'Who is the better option?'
                      : 'Why did you pass on them?'
                  }
                  rows={2}
                  disabled={rejNoteSaving}
                  className="w-full px-2.5 py-2 text-[11px] border border-frame bg-cream focus:outline-none focus:border-navy text-muted resize-none disabled:opacity-50"
                />
              </div>
            )}
          </div>
        )}

        {/* ── Matchy's line — the outcome of the last thing it did here ── */}
        {matchyNote && (
          <MatchyLine variant="card" tone={matchyNote.tone}>{matchyNote.text}</MatchyLine>
        )}

        {/* ── Status machinery — staff only. Clients get the plain stage pill
              above and the thread in Conversations. ── */}
        {isAdmin && status !== 'discovered' && status !== 'shortlisted' && status !== 'rejected' && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
            <span className={`text-[10px] px-2 py-0.5 border font-medium uppercase tracking-wider shrink-0 ${STATUS_META[status].classes}`}>
              {STATUS_META[status].label}
            </span>
            <select
              value={status}
              onChange={e => handleStatusChange(e.target.value as ExpertStatus)}
              disabled={saving}
              className="text-[10px] uppercase tracking-widest border border-frame bg-cream text-muted px-2 py-1 focus:outline-none focus:border-navy transition-colors disabled:opacity-50 flex-1"
            >
              {ALL_STATUSES.map(s => (
                <option key={s} value={s}>{STATUS_META[s].label}</option>
              ))}
            </select>
            </div>
            {/* Contacted timestamp */}
            {projectExpert.contactedAt && (
              <p className="text-[10px] text-muted/60 pl-0.5">
                Contacted {new Date(projectExpert.contactedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
              </p>
            )}
          </div>
        )}

        {/* ── Contact email badge — staff only. A client never sees an
              address (docs/MATCHY_SPEC.md); redaction already strips it, and
              this gate makes that visible at the render site. ── */}
        {isAdmin && contactEmail && (
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className="text-[9px] uppercase tracking-widest text-muted font-medium">Email:</span>
            <a
              href={`mailto:${contactEmail}`}
              className="text-[11px] text-navy font-medium font-mono hover:underline underline-offset-2 truncate"
            >
              {contactEmail}
            </a>
          </div>
        )}

        {/* ── Notes & secondary actions ── */}
        {userNotes && !noteOpen && (
          <p className="text-[11px] text-muted leading-relaxed line-clamp-2 italic">
            {userNotes}
          </p>
        )}

        <div className="flex items-center gap-3 flex-wrap">
          <button
            onClick={() => setNoteOpen(o => !o)}
            className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
          >
            {noteOpen ? 'Cancel' : userNotes ? 'Edit notes ↓' : '+ Add note'}
          </button>
          <button
            onClick={() => onInterviewGuide(expert.id)}
            className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors ml-auto"
          >
            Interview guide →
          </button>
          {confirmRemove ? (
            <span className="flex items-center gap-2">
              <span className="text-[10px] text-muted">Remove from this project?</span>
              <button
                onClick={handleRemove}
                disabled={removing}
                className="text-[10px] uppercase tracking-widest text-red-600 border border-red-200 hover:bg-red-50 px-2 py-0.5 transition-colors disabled:opacity-40"
              >
                {removing ? 'Removing…' : 'Remove'}
              </button>
              <button
                onClick={() => setConfirmRemove(false)}
                className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              onClick={() => setConfirmRemove(true)}
              disabled={removing}
              className="text-[10px] uppercase tracking-widest text-muted hover:text-red-500 transition-colors disabled:opacity-40"
              title="Remove from project"
            >
              Remove
            </button>
          )}
        </div>

        {noteOpen && (
          <div className="space-y-2">
            <textarea
              value={noteText}
              onChange={e => setNoteText(e.target.value)}
              placeholder="Add a note about this expert…"
              rows={3}
              className="w-full px-2.5 py-2 text-xs border border-frame bg-cream focus:outline-none focus:border-navy text-ink resize-none"
              autoFocus
            />
            <button
              onClick={handleAddNote}
              disabled={!noteText.trim() || saving}
              className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy-light disabled:opacity-40 transition-colors"
            >
              Save note
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

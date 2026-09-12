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
  firstNameOf,
  formatRate,
  formatSlot,
  schedulingLine,
} from '../lib/matchyClient';

// -----------------------------------------------------------------------------
// Matches-tab card for one expert inside a project. Owns bookmark/unbookmark
// (the action that starts a Matchy engagement), status changes, rejection
// reasons, and free-text notes — each a PUT/POST to
// /api/projects/:id/experts/:expertId (via lib/matchyClient.ts or a raw
// fetch in patchExpert()). `isAdmin` here is a UI convenience, not a security
// boundary: the contactEmail badge and status-machinery <select> it gates are
// only ever rendered for a viewer the caller has already determined is staff,
// and the server independently strips `contactEmail` for non-admins
// (lib/redactExpert.ts) and re-checks ownership/role on every write — this
// component must never be the only thing standing between a client and an
// expert's address.
// -----------------------------------------------------------------------------

// The reason list and the "needs a note" subset are shared with the thread's
// own Pass control (lib/rejectionReasons.ts), so both spell them the same way.
import { REJECTION_REASONS, REASONS_WITH_NOTES } from '../lib/rejectionReasons';

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
  const [noteOpen,         setNoteOpen]         = useState(false);
  const [noteText,         setNoteText]         = useState('');
  const [rejNoteText,      setRejNoteText]      = useState(rejectionNotes ?? '');
  const [rejNoteSaving,    setRejNoteSaving]    = useState(false);
  // Matchy's one line about this expert — the outcome of the last thing it did.
  const [matchyNote, setMatchyNote] = useState<{ text: string; tone: 'default' | 'quiet' | 'alert' } | null>(null);
  // After a poll or a fresh load the local note is empty; scheduling is the one
  // thing still worth a line here. The bookmark itself says nothing — the
  // filled/unfilled toggle is the whole feedback.
  const serverNote = schedulingLine(projectExpert, firstNameOf(expert.name));
  const shownNote  = matchyNote ?? serverNote;
  // The one fact a booked card carries in Matches. "Open" goes to the thread,
  // where the Zoom link and the calendar file live; there are no buttons here.
  const bookedWhen = projectExpert.booking && projectExpert.status === 'scheduled'
    ? formatSlot(projectExpert.booking.startUtc, projectExpert.booking.endUtc)
    : '';
  const [bookmarking, setBookmarking] = useState(false);

  // What the client pays. Falls back to the tier's opening position until the
  // engagement seeds a number. `expertRate` is never read here.
  const clientRate = projectExpert.clientRate ?? pricing.callRate;

  // ── Bookmark: the one action that starts an engagement ─────────────────────

  // Silent optimistic toggle: the icon state flips immediately and flips back
  // if the server says no. No retry affordance, no outcome line.
  async function handleBookmark() {
    if (bookmarking) return;
    setBookmarking(true);
    const before = projectExpert;
    onUpdate({ ...projectExpert, status: 'bookmarked', updatedAt: Date.now() });

    const res = await bookmarkExpert(projectId, expert.id);
    setBookmarking(false);

    if (!res.ok) {
      onUpdate(before);
      console.error('bookmark failed', res.message);
      return;
    }
    onUpdate(res.projectExpert);
  }

  async function handleUnbookmark() {
    if (bookmarking) return;
    setBookmarking(true);
    const before = projectExpert;
    onUpdate({ ...projectExpert, status: 'shortlisted', updatedAt: Date.now() });

    const res = await unbookmarkExpert(projectId, expert.id);
    setBookmarking(false);

    if (!res.ok) {
      onUpdate(before);
      console.error('unbookmark failed', res.message);
      return;
    }
    if (res.projectExpert) onUpdate(res.projectExpert);
  }

  /**
   * One PUT, one answer. A failed save is SAID, not swallowed: the card's
   * Matchy line turns into the server's message (or a plain "could not save"),
   * and callers get `false` so they can undo their optimistic update. A tester
   * must never believe something saved when it did not.
   */
  async function patchExpert(patch: Record<string, unknown>): Promise<boolean> {
    setSaving(true);
    try {
      const res  = await fetch(`/api/projects/${projectId}/experts/${expert.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(patch),
      });
      const data = await res.json().catch(() => ({})) as {
        project?: { experts: ProjectExpert[] }; message?: string; error?: string;
      };
      if (!res.ok) {
        setMatchyNote({
          text: data.message
            ?? (res.status === 403 ? 'Only the project owner can change this.' : "Couldn't save that change. Try again."),
          tone: 'alert',
        });
        return false;
      }
      const updated = data.project?.experts.find(e => e.expert.id === expert.id);
      if (updated) onUpdate(updated);
      return true;
    } catch {
      setMatchyNote({ text: "Couldn't reach ExpertMatch. Check your connection and try again.", tone: 'alert' });
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(next: ExpertStatus) {
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
    // Optimistic local update, rolled back if the server says no.
    const before = projectExpert;
    setMatchyNote(null);
    onUpdate({
      ...projectExpert,
      status: next,
      updatedAt: now,
      ...(next === 'rejected' ? { rejectedAt: now } : { rejectionReason: undefined, rejectionNotes: undefined }),
      ...(next === 'contacted' && !projectExpert.contactedAt ? { contactedAt: now } : {}),
    });
    const ok = await patchExpert(patch);
    if (!ok) onUpdate(before);
  }

  async function saveRejectionNote() {
    const note = rejNoteText.trim();
    setRejNoteSaving(true);
    try {
      // The server's copy is what the card shows afterwards (patchExpert calls
      // onUpdate with it); nothing is written locally on a failure.
      await patchExpert({ rejectionNotes: note });
    } finally {
      setRejNoteSaving(false);
    }
  }

  async function handleAddNote() {
    const note = noteText.trim();
    if (!note) return;
    // The textarea keeps its text until the server has the note.
    const ok = await patchExpert({ note });
    if (ok) {
      setNoteText('');
      setNoteOpen(false);
    }
  }

  return (
    <div className="flex flex-col">
      {/* Expert card — contact section suppressed in project context (managed by ScreeningCard/OutreachCard) */}
      {/* showRate={false}: the tier badge and the rate belong to the strip
          below, where the number is the engagement's clientRate rather than the
          tier's opening position — one rate per card, not two. */}
      <ExpertCard expert={expert} query={query} hideContact showRate={false} />

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
          {/* The only rate on this card. Before an engagement it is the tier's
              opening position (hence the disclaimer on hover); after a bookmark
              it is the engagement's own clientRate. */}
          <span
            className={`text-[9px] text-muted ${hasConversation(status) ? '' : 'cursor-help'}`}
            title={hasConversation(status) ? undefined : RATE_DISCLAIMER}
          >
            {formatRate(clientRate)}/hr all-in
          </span>
        </div>

        {/* ── The booked call, one line ── */}
        {bookedWhen && (
          <p className="text-[10px] text-green-700 font-medium">Call booked · {bookedWhen}</p>
        )}

        {/* ── Primary actions: Bookmark / Pass ──
            Bookmarking is what starts the engagement: Matchy finds the address
            and sends the intro (docs/MATCHY_SPEC.md, "Workflow"). */}
        {status === 'discovered' || status === 'shortlisted' ? (
          <div className="flex gap-2">
            <button
              onClick={handleBookmark}
              disabled={saving || bookmarking || !canBookmark}
              aria-pressed={false}
              aria-label="Bookmark this expert"
              className="flex-1 text-[11px] uppercase tracking-widest border-2 border-navy text-navy bg-navy/5 hover:bg-navy hover:text-cream py-2 font-medium transition-colors disabled:opacity-40"
              style={{ letterSpacing: '0.1em' }}
              title={canBookmark ? undefined : 'Only the project owner can start outreach.'}
            >
              ☆ Bookmark
            </button>
            {/* Passing is a decision about the engagement, so it rides the
                same permission as Bookmark — the server enforces it too. */}
            <button
              onClick={() => { void handleStatusChange('rejected'); }}
              disabled={saving || bookmarking || !canBookmark}
              className="flex-1 text-[11px] uppercase tracking-widest border-2 border-frame text-muted hover:text-navy hover:border-navy py-2 font-medium transition-colors disabled:opacity-40"
              style={{ letterSpacing: '0.1em' }}
              title={canBookmark ? undefined : 'Only the project owner can pass on an expert.'}
            >
              Pass
            </button>
          </div>
        ) : status === 'bookmarked' ? (
          <div className="flex items-center gap-2 flex-wrap">
            {/* The toggle in its filled state. Clicking it un-bookmarks. */}
            <button
              onClick={handleUnbookmark}
              disabled={bookmarking || !canBookmark}
              aria-pressed={true}
              aria-label="Bookmark this expert"
              className="flex-1 text-[11px] uppercase tracking-widest border-2 border-navy text-navy bg-navy/5 py-2 font-medium transition-colors disabled:opacity-40"
              style={{ letterSpacing: '0.1em' }}
            >
              ★ Bookmarked
            </button>
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
              {canBookmark && (
                <button
                  onClick={() => { void handleStatusChange('discovered'); }}
                  disabled={saving}
                  className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame px-2.5 py-2 transition-colors disabled:opacity-40"
                  title="Put them back in Matches"
                >
                  Undo
                </button>
              )}
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
        {shownNote && (
          <MatchyLine variant="card" tone={shownNote.tone}>{shownNote.text}</MatchyLine>
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
          {/* No "Remove": Pass covers it and keeps the expert (and the reason
              we passed) on the record. The DELETE route stays for staff. */}
          <button
            onClick={() => onInterviewGuide(expert.id)}
            className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors ml-auto"
          >
            Interview guide →
          </button>
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

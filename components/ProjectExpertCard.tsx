'use client';

import { useState } from 'react';
import type { ProjectExpert, ExpertStatus, RejectionReason } from '../types';
import ExpertCard from './ExpertCard';

// ─── Display metadata ─────────────────────────────────────────────────────────

const STATUS_LABEL: Record<ExpertStatus, string> = {
  discovered:       'Discovered',
  shortlisted:      'Shortlisted',
  rejected:         'Rejected',
  contact_found:    'Contact Found',
  outreach_drafted: 'Draft Ready',
  contacted:        'Contacted',
  replied:          'Replied',
  scheduled:        'Scheduled',
  completed:        'Completed',
};

const STATUS_CLASS: Record<ExpertStatus, string> = {
  discovered:       'text-muted border-frame',
  shortlisted:      'text-amber-700 border-amber-300 bg-amber-50',
  rejected:         'text-red-600 border-red-200 bg-red-50',
  contact_found:    'text-sky-600 border-sky-200 bg-sky-50',
  outreach_drafted: 'text-sky-600 border-sky-200 bg-sky-50',
  contacted:        'text-sky-700 border-sky-300 bg-sky-50',
  replied:          'text-green-700 border-green-200 bg-green-50',
  scheduled:        'text-green-700 border-green-200 bg-green-50',
  completed:        'text-navy border-navy/20 bg-navy/5',
};

const REJECTION_REASONS: Array<{ value: RejectionReason; label: string }> = [
  { value: 'too_generic',             label: 'Too Generic'              },
  { value: 'wrong_industry',          label: 'Wrong Industry'           },
  { value: 'wrong_geography',         label: 'Wrong Geography'          },
  { value: 'weak_evidence',           label: 'Weak Evidence'            },
  { value: 'no_contact_path',         label: 'No Contact Path'          },
  { value: 'conflict_risk',           label: 'Conflict Risk'            },
  { value: 'not_senior_enough',       label: 'Not Senior Enough'        },
  { value: 'too_academic',            label: 'Too Academic'             },
  { value: 'vendor_biased',           label: 'Vendor Biased'            },
  { value: 'better_option_available', label: 'Better Option Available'  },
  { value: 'other',                   label: 'Other'                    },
];

// Reasons that warrant a follow-up notes field
const REASONS_WITH_NOTES = new Set<RejectionReason>(['other', 'better_option_available', 'conflict_risk']);

const ALL_STATUSES: ExpertStatus[] = [
  'discovered', 'shortlisted', 'rejected', 'contact_found',
  'outreach_drafted', 'contacted', 'replied', 'scheduled', 'completed',
];

// ─── Props ────────────────────────────────────────────────────────────────────

interface Props {
  projectExpert: ProjectExpert;
  projectId: string;
  query: string;
  onUpdate: (updated: ProjectExpert) => void;
  onRemove: (expertId: string) => void;
  onInterviewGuide: (expertId: string) => void;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function ProjectExpertCard({ projectExpert, projectId, query, onUpdate, onRemove, onInterviewGuide }: Props) {
  const { expert, status, rejectionReason, rejectionNotes, userNotes, contactEmail } = projectExpert;
  const [saving,           setSaving]           = useState(false);
  const [removing,         setRemoving]         = useState(false);
  const [noteOpen,         setNoteOpen]         = useState(false);
  const [noteText,         setNoteText]         = useState('');
  const [rejNoteText,      setRejNoteText]      = useState(rejectionNotes ?? '');
  const [rejNoteSaving,    setRejNoteSaving]    = useState(false);

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
    if (!window.confirm('Remove this expert from the project?')) return;
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

        {/* ── Primary actions: Shortlist / Reject (prominent, top row) ── */}
        {status !== 'shortlisted' && status !== 'rejected' ? (
          <div className="flex gap-2">
            <button
              onClick={() => handleStatusChange('shortlisted')}
              disabled={saving}
              className="flex-1 text-[11px] uppercase tracking-widest border-2 border-amber-400 text-amber-700 bg-amber-50 hover:bg-amber-100 py-2 font-medium transition-colors disabled:opacity-40"
              style={{ letterSpacing: '0.1em' }}
            >
              ★ Shortlist
            </button>
            <button
              onClick={() => handleStatusChange('rejected')}
              disabled={saving}
              className="flex-1 text-[11px] uppercase tracking-widest border-2 border-red-300 text-red-600 bg-red-50 hover:bg-red-100 py-2 font-medium transition-colors disabled:opacity-40"
              style={{ letterSpacing: '0.1em' }}
            >
              ✗ Reject
            </button>
          </div>
        ) : status === 'shortlisted' ? (
          <div className="flex items-center gap-2">
            <span className="flex-1 text-center text-[11px] uppercase tracking-widest border-2 border-amber-400 text-amber-700 bg-amber-50 py-2 font-medium">
              ★ Shortlisted
            </span>
            <button
              onClick={() => handleStatusChange('discovered')}
              disabled={saving}
              className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame px-2.5 py-2 transition-colors disabled:opacity-40"
              title="Move back to discovered"
            >
              Undo
            </button>
          </div>
        ) : (
          /* rejected */
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="flex-1 text-center text-[11px] uppercase tracking-widest border-2 border-red-300 text-red-600 bg-red-50 py-2 font-medium">
                ✗ Rejected
              </span>
              <button
                onClick={() => handleStatusChange('discovered')}
                disabled={saving}
                className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame px-2.5 py-2 transition-colors disabled:opacity-40"
                title="Move back to discovered"
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
                      : 'Add a note on this rejection…'
                  }
                  rows={2}
                  disabled={rejNoteSaving}
                  className="w-full px-2.5 py-2 text-[11px] border border-frame bg-cream focus:outline-none focus:border-navy text-muted resize-none disabled:opacity-50"
                />
              </div>
            )}
          </div>
        )}

        {/* ── Status detail row (for post-shortlist statuses) ── */}
        {status !== 'discovered' && status !== 'shortlisted' && status !== 'rejected' && (
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
            <span className={`text-[10px] px-2 py-0.5 border font-medium uppercase tracking-wider shrink-0 ${STATUS_CLASS[status]}`}>
              {STATUS_LABEL[status]}
            </span>
            <select
              value={status}
              onChange={e => handleStatusChange(e.target.value as ExpertStatus)}
              disabled={saving}
              className="text-[10px] uppercase tracking-widest border border-frame bg-cream text-muted px-2 py-1 focus:outline-none focus:border-navy transition-colors disabled:opacity-50 flex-1"
            >
              {ALL_STATUSES.map(s => (
                <option key={s} value={s}>{STATUS_LABEL[s]}</option>
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

        {/* ── Contact email badge ── */}
        {contactEmail && (
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
          <button
            onClick={handleRemove}
            disabled={removing}
            className="text-[10px] uppercase tracking-widest text-muted hover:text-red-500 transition-colors disabled:opacity-40"
            title="Remove from project"
          >
            Remove
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

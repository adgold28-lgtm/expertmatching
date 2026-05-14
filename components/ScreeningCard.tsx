'use client';

// Post-vetting-call screening card.
// The vetting call has already happened. This card records the outcome.
//
// Verdict actions:
//   Pass    → status: 'contact_found', screeningStatus: 'screened', recommendToClient: true
//   Fail    → status: 'rejected'
//   No Show → status: 'replied'  (returns to Outreach for follow-up)

import { useState } from 'react';
import type { ProjectExpert } from '../types';

// ─── Helpers ───────────────────────────────────────────────────────────────────

const CONFLICT_RISK_CLASS: Record<string, string> = {
  low:     'text-green-700 border-green-200 bg-green-50',
  medium:  'text-amber-700 border-amber-300 bg-amber-50',
  high:    'text-red-600  border-red-200  bg-red-50',
  unknown: 'text-muted   border-frame    bg-cream',
};

type Verdict = 'pending' | 'pass' | 'fail' | 'no_show';

function currentVerdict(pe: ProjectExpert): Verdict {
  const s = pe.screeningStatus ?? 'not_screened';
  if (s === 'screened' || s === 'client_ready') return 'pass';
  if (s === 'rejected_after_screen')             return 'fail';
  // No-show: expert is back in 'replied' without a screened/rejected status
  if (pe.status === 'replied' && s === 'not_screened') return 'no_show';
  return 'pending';
}

// ─── Props ─────────────────────────────────────────────────────────────────────

interface Props {
  projectExpert:  ProjectExpert;
  projectId:      string;
  onUpdate:       (updated: ProjectExpert) => void;
  onViewProfile?: () => void;
}

// ─── Component ─────────────────────────────────────────────────────────────────

export default function ScreeningCard({
  projectExpert,
  projectId,
  onUpdate,
  onViewProfile,
}: Props) {
  const { expert } = projectExpert;

  const [saving,       setSaving]       = useState(false);
  const [notesOpen,    setNotesOpen]    = useState(false);
  const [notesText,    setNotesText]    = useState(projectExpert.screeningNotes ?? '');
  const [insightOpen,  setInsightOpen]  = useState(false);
  const [insights,     setInsights]     = useState<[string, string, string]>(
    (() => {
      // Store insights in screeningNotes as a structured prefix, or use empty defaults
      const existing = projectExpert.vettingQuestions ?? [];
      return [
        existing[0] ?? '',
        existing[1] ?? '',
        existing[2] ?? '',
      ] as [string, string, string];
    })(),
  );
  const [recommendOverride, setRecommendOverride] = useState<boolean | null>(null);

  // ── API helper ──────────────────────────────────────────────────────────────

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

  // ── Handlers ────────────────────────────────────────────────────────────────

  async function handleVerdict(verdict: Verdict) {
    if (verdict === 'pass') {
      const recommend = recommendOverride ?? true;
      await patch({
        screeningStatus:   'screened',
        recommendToClient: recommend,
        screenedAt:        Date.now(),
        status:            'contact_found',  // moves to Deliver (deliverExperts filter: recommendToClient === true)
      });
    } else if (verdict === 'fail') {
      await patch({
        screeningStatus:   'rejected_after_screen',
        recommendToClient: false,
        status:            'rejected',
      });
    } else if (verdict === 'no_show') {
      await patch({
        screeningStatus:   'not_screened',
        recommendToClient: false,
        status:            'replied',        // returns to Outreach for follow-up
      });
    } else {
      // Reset to pending
      await patch({ screeningStatus: 'not_screened' });
    }
  }

  async function handleSaveNotes() {
    await patch({ screeningNotes: notesText.trim() });
    setNotesOpen(false);
  }

  async function handleSaveInsights() {
    const filled = insights.filter(s => s.trim());
    await patch({ vettingQuestions: insights.map(s => s.trim()) });
    setInsightOpen(false);
    // Use vettingQuestions field to store insights (repurposed from old ScreeningCard)
    console.log('[ScreeningCard] insights saved:', filled.length);
  }

  // ── Derived state ────────────────────────────────────────────────────────────

  const verdict             = currentVerdict(projectExpert);
  const storedInsights      = projectExpert.vettingQuestions ?? [];
  const hasInsights         = storedInsights.some(s => s.trim());
  const effectiveRecommend  = recommendOverride ?? (projectExpert.recommendToClient ?? (verdict === 'pass'));

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
          {expert.relevance_score > 0 && (
            <span className={`shrink-0 font-display text-lg font-semibold leading-none ${
              expert.relevance_score >= 80 ? 'text-status-success' :
              expert.relevance_score >= 65 ? 'text-status-warning' : 'text-muted'
            }`}>
              {expert.relevance_score}
            </span>
          )}
        </div>
      </div>

      <div className="px-4 py-3 space-y-4">

        {/* ── Verdict ── */}
        <div className="space-y-2">
          <p className="text-[9px] uppercase tracking-widest text-muted font-medium" style={{ letterSpacing: '0.18em' }}>
            Vetting Call Outcome
          </p>
          <div className="flex gap-2">
            {(['pass', 'fail', 'no_show'] as const).map(v => {
              const isActive = verdict === v;
              const base     = 'flex-1 text-[10px] uppercase tracking-widest py-1.5 border transition-colors';
              const active =
                v === 'pass'    ? 'bg-green-700 text-cream border-green-700' :
                v === 'fail'    ? 'bg-red-600   text-cream border-red-600'   :
                                  'bg-amber-600  text-cream border-amber-600';
              const idle =
                v === 'pass'    ? 'text-green-700 border-green-200 hover:bg-green-50'   :
                v === 'fail'    ? 'text-red-600   border-red-200   hover:bg-red-50'      :
                                  'text-amber-700 border-amber-200 hover:bg-amber-50';
              const label = v === 'no_show' ? 'No Show' : v.charAt(0).toUpperCase() + v.slice(1);
              return (
                <button
                  key={v}
                  onClick={() => !isActive && handleVerdict(v)}
                  disabled={saving}
                  className={`${base} ${isActive ? active : idle} ${isActive ? 'cursor-default' : ''}`}
                  aria-pressed={isActive}
                >
                  {saving && isActive ? '…' : label}
                </button>
              );
            })}
          </div>

          {verdict === 'pass' && (
            <p className="text-[10px] text-green-700">Passed — moving to Deliver.</p>
          )}
          {verdict === 'fail' && (
            <p className="text-[10px] text-red-600">Failed — removed from pipeline.</p>
          )}
          {verdict === 'no_show' && (
            <p className="text-[10px] text-amber-700">No show — returned to Outreach for follow-up.</p>
          )}
          {projectExpert.conflictRisk === 'high' && verdict !== 'fail' && (
            <p className="text-[10px] text-red-600">⚠ High conflict risk — confirm before passing.</p>
          )}
        </div>

        {/* ── Call Notes ── */}
        <div className="pt-3 border-t border-frame space-y-2">
          <button
            onClick={() => { setNotesText(projectExpert.screeningNotes ?? ''); setNotesOpen(o => !o); }}
            className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
            style={{ letterSpacing: '0.14em' }}
          >
            {notesOpen
              ? 'Cancel'
              : projectExpert.screeningNotes
                ? 'Edit call notes ↓'
                : '+ Call notes'}
          </button>
          {!notesOpen && projectExpert.screeningNotes && (
            <p className="text-[11px] text-muted leading-relaxed line-clamp-3 italic">
              {projectExpert.screeningNotes}
            </p>
          )}
          {notesOpen && (
            <div className="space-y-2">
              <textarea
                value={notesText}
                onChange={e => setNotesText(e.target.value)}
                placeholder="What did you learn on this call? Key themes, surprises, hesitations…"
                rows={4}
                className="w-full px-2.5 py-2 text-xs border border-frame bg-cream focus:outline-none focus:border-navy text-ink resize-none"
                autoFocus
              />
              <button
                onClick={handleSaveNotes}
                disabled={saving}
                className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy-light disabled:opacity-40 transition-colors"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          )}
        </div>

        {/* ── Top 3 Insights ── */}
        <div className="pt-3 border-t border-frame space-y-2">
          <button
            onClick={() => setInsightOpen(o => !o)}
            className="text-[10px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
            style={{ letterSpacing: '0.14em' }}
          >
            {insightOpen
              ? 'Cancel'
              : hasInsights
                ? 'Edit insights ↓'
                : '+ Top 3 insights for client brief'}
          </button>

          {!insightOpen && hasInsights && (
            <ol className="space-y-1.5 list-none">
              {storedInsights.filter(s => s.trim()).map((ins, i) => (
                <li key={i} className="flex gap-2 text-[11px] text-ink leading-snug">
                  <span className="shrink-0 font-medium text-navy">{i + 1}.</span>
                  {ins}
                </li>
              ))}
            </ol>
          )}

          {insightOpen && (
            <div className="space-y-2">
              <p className="text-[10px] text-muted/70 italic leading-relaxed">
                3 bullet points to brief the client — what you learned that&apos;s most relevant.
              </p>
              {([0, 1, 2] as const).map(i => (
                <div key={i} className="flex gap-2 items-start">
                  <span className="shrink-0 text-[10px] text-navy font-medium mt-2">{i + 1}.</span>
                  <input
                    type="text"
                    value={insights[i]}
                    onChange={e => setInsights(prev => {
                      const next = [...prev] as [string, string, string];
                      next[i] = e.target.value;
                      return next;
                    })}
                    placeholder={
                      i === 0 ? 'Core expertise confirmed…' :
                      i === 1 ? 'Key nuance or caveat…' :
                                'Relevant risk or flag…'
                    }
                    className="flex-1 px-2.5 py-1.5 text-xs border border-frame bg-cream focus:outline-none focus:border-navy text-ink"
                  />
                </div>
              ))}
              <button
                onClick={handleSaveInsights}
                disabled={saving}
                className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy-light disabled:opacity-40 transition-colors"
              >
                {saving ? 'Saving…' : 'Save insights'}
              </button>
            </div>
          )}
        </div>

        {/* ── Conflict Risk ── */}
        <div className="flex items-center gap-2 flex-wrap pt-1">
          <span className="text-[9px] uppercase tracking-widest text-muted font-medium w-16 shrink-0" style={{ letterSpacing: '0.16em' }}>
            Conflict:
          </span>
          <div className="flex gap-1 flex-wrap">
            {(['unknown', 'low', 'medium', 'high'] as const).map(r => (
              <button
                key={r}
                onClick={() => patch({ conflictRisk: r })}
                disabled={saving}
                className={`text-[10px] px-2 py-0.5 border uppercase tracking-wider transition-colors disabled:opacity-40 ${
                  projectExpert.conflictRisk === r
                    ? CONFLICT_RISK_CLASS[r]
                    : 'text-muted border-frame bg-cream hover:border-navy hover:text-navy'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* ── Recommend to Client ── */}
        <div className="pt-3 border-t border-frame">
          <label className="flex items-center gap-2.5 cursor-pointer group">
            <input
              type="checkbox"
              checked={effectiveRecommend}
              onChange={e => {
                setRecommendOverride(e.target.checked);
                patch({ recommendToClient: e.target.checked });
              }}
              className="accent-navy w-3.5 h-3.5"
            />
            <span className="text-[11px] text-ink group-hover:text-navy transition-colors">
              Recommend to client
            </span>
            {verdict === 'pass' && !recommendOverride && (
              <span className="text-[10px] text-muted italic">(auto)</span>
            )}
          </label>
        </div>

      </div>
    </div>
  );
}

'use client';

// The two decisions a project owner makes once and Matchy then honors on every
// expert: whether intros go out on their own, and how far the rate may move.
//
// Owner (or staff) only — a collaborator can read the thread but cannot change
// what Matchy sends or what the firm pays (docs/MATCHY_SPEC.md, founder
// answer 5). Both fields PATCH /api/projects/:id and render the API's own
// validation message inline.

import { useState } from 'react';
import type { Project } from '../types';
import {
  updateMatchySettings,
  isValidClientRate,
  RATE_FLOOR,
  RATE_STEP,
  formatRate,
} from '../lib/matchyClient';

interface Props {
  projectId: string;
  project:   Project;
  onUpdate:  (project: Project) => void;
}

const RATE_RULE = `Whole dollars, at least ${formatRate(RATE_FLOOR)}, in ${formatRate(RATE_STEP)} steps.`;

export default function MatchySettingsStrip({ projectId, project, onUpdate }: Props) {
  const reviewFirst = project.reviewFirst === true;

  const [savingSwitch, setSavingSwitch] = useState(false);
  const [switchError,  setSwitchError]  = useState('');
  const [minInput,     setMinInput]     = useState(project.clientRateMin != null ? String(project.clientRateMin) : '');
  const [maxInput,     setMaxInput]     = useState(project.clientRateMax != null ? String(project.clientRateMax) : '');
  const [bandError,    setBandError]    = useState('');
  const [bandSaving,   setBandSaving]   = useState(false);
  const [bandSaved,    setBandSaved]    = useState(false);

  async function toggleReviewFirst() {
    const next = !reviewFirst;
    setSavingSwitch(true);
    setSwitchError('');
    const res = await updateMatchySettings(projectId, { reviewFirst: next });
    setSavingSwitch(false);
    if (!res.ok) { setSwitchError(res.message); return; }
    onUpdate(res.project);
  }

  /** Commits one end of the band. Empty clears it (no bound). */
  async function commitRate(field: 'clientRateMin' | 'clientRateMax', raw: string) {
    setBandSaved(false);
    const trimmed = raw.trim();
    const current = field === 'clientRateMin' ? project.clientRateMin ?? null : project.clientRateMax ?? null;

    let value: number | null;
    if (trimmed === '') {
      value = null;
    } else {
      const parsed = Number(trimmed);
      if (!Number.isFinite(parsed) || !isValidClientRate(parsed)) {
        setBandError(RATE_RULE);
        return;
      }
      value = parsed;
    }
    if (value === current) { setBandError(''); return; }

    // The band has to hold on both ends before the round trip, so the client
    // never sees the server reject something it could have caught.
    const min = field === 'clientRateMin' ? value : project.clientRateMin ?? null;
    const max = field === 'clientRateMax' ? value : project.clientRateMax ?? null;
    if (min !== null && max !== null && min > max) {
      setBandError('The lowest rate has to be at or below the highest.');
      return;
    }

    setBandSaving(true);
    setBandError('');
    const res = await updateMatchySettings(projectId, { [field]: value });
    setBandSaving(false);
    if (!res.ok) { setBandError(res.message); return; }
    onUpdate(res.project);
    setBandSaved(true);
  }

  const inputClass =
    'w-24 px-2 py-1.5 text-[12px] border border-frame bg-cream focus:outline-none focus:border-navy text-ink';

  return (
    <div className="border border-frame bg-surface px-4 py-3.5 space-y-3.5">

      {/* ── Review before sending ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0 max-w-md">
          <p className="text-[10px] uppercase tracking-widest text-navy font-semibold" style={{ letterSpacing: '0.16em' }}>
            Review before sending
          </p>
          <p className="text-[11px] text-muted leading-relaxed mt-1">
            Off: Matchy sends intros and follow-ups as soon as you bookmark. On: you approve each one.
          </p>
          {switchError && <p className="text-[11px] text-red-600 mt-1">{switchError}</p>}
        </div>
        <button
          type="button"
          onClick={toggleReviewFirst}
          disabled={savingSwitch}
          aria-pressed={reviewFirst}
          className={`shrink-0 flex items-center gap-2 text-[10px] uppercase tracking-widest border px-3 py-1.5 transition-colors disabled:opacity-40 ${
            reviewFirst
              ? 'border-navy bg-navy text-gold'
              : 'border-frame text-muted hover:border-navy hover:text-navy'
          }`}
          style={{ letterSpacing: '0.12em' }}
        >
          <span
            aria-hidden
            className={`inline-block w-2 h-2 rounded-full ${reviewFirst ? 'bg-gold' : 'bg-muted/40'}`}
          />
          {reviewFirst ? 'On' : 'Off'}
        </button>
      </div>

      <div className="rule-divider" />

      {/* ── Rate band ── */}
      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-widest text-navy font-semibold" style={{ letterSpacing: '0.16em' }}>
          What you&apos;ll pay per hour
        </p>
        <p className="text-[11px] text-muted leading-relaxed max-w-md">
          Matchy negotiates inside this band and never above it. Leave either end blank for no limit.
        </p>
        <div className="flex items-center gap-3 flex-wrap pt-1">
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.1em' }}>Lowest</span>
            <span className="text-[12px] text-muted">$</span>
            <input
              type="number"
              inputMode="numeric"
              min={RATE_FLOOR}
              step={RATE_STEP}
              value={minInput}
              disabled={bandSaving}
              onChange={e => setMinInput(e.target.value)}
              onBlur={() => { void commitRate('clientRateMin', minInput); }}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              placeholder="—"
              className={inputClass}
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.1em' }}>Highest</span>
            <span className="text-[12px] text-muted">$</span>
            <input
              type="number"
              inputMode="numeric"
              min={RATE_FLOOR}
              step={RATE_STEP}
              value={maxInput}
              disabled={bandSaving}
              onChange={e => setMaxInput(e.target.value)}
              onBlur={() => { void commitRate('clientRateMax', maxInput); }}
              onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              placeholder="—"
              className={inputClass}
            />
          </label>
          {bandSaving && <span className="text-[10px] text-muted">Saving…</span>}
          {!bandSaving && bandSaved && !bandError && <span className="text-[10px] text-green-700">Saved</span>}
        </div>
        {bandError
          ? <p className="text-[11px] text-red-600">{bandError}</p>
          : <p className="text-[10px] text-muted/70">{RATE_RULE} Includes the ExpertMatch fee.</p>}
      </div>
    </div>
  );
}

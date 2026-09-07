'use client';

// The decisions a project owner makes once and Matchy then honors on every
// expert: whether the project is live at all, whether intros go out on their
// own, and how far the rate may move.
//
// MODE is the top row and the hard one. A walkthrough project sends nothing —
// no email, no contact lookup (lib/walkthrough.ts). Going live is deliberately
// two steps: a button, then a confirm panel that says in plain words what
// changes. Coming back to walkthrough is one click, because that direction is
// always safe.
//
// Owner (or staff) only — a collaborator can read the thread but cannot change
// what Matchy sends or what the firm pays (docs/MATCHY_SPEC.md, founder
// answer 5). Every field PATCHes /api/projects/:id and renders the API's own
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
import { isWalkthrough } from '../lib/walkthrough';

interface Props {
  projectId: string;
  project:   Project;
  onUpdate:  (project: Project) => void;
}

const RATE_RULE = `Whole dollars, at least ${formatRate(RATE_FLOOR)}, in ${formatRate(RATE_STEP)} steps.`;

export default function MatchySettingsStrip({ projectId, project, onUpdate }: Props) {
  const reviewFirst = project.reviewFirst === true;
  const walkthrough = isWalkthrough(project);

  const [savingSwitch, setSavingSwitch] = useState(false);
  const [switchError,  setSwitchError]  = useState('');
  // Going live is two steps: the button opens this panel, the panel commits.
  const [confirmLive,  setConfirmLive]  = useState(false);
  const [liveReview,   setLiveReview]   = useState(true);
  const [savingMode,   setSavingMode]   = useState(false);
  const [modeError,    setModeError]    = useState('');
  const [minInput,     setMinInput]     = useState(project.clientRateMin != null ? String(project.clientRateMin) : '');
  const [maxInput,     setMaxInput]     = useState(project.clientRateMax != null ? String(project.clientRateMax) : '');
  const [bandError,    setBandError]    = useState('');
  const [bandSaving,   setBandSaving]   = useState(false);
  const [bandSaved,    setBandSaved]    = useState(false);

  /** Commits the confirm panel: live, plus whatever the checkbox says. */
  async function goLive() {
    setSavingMode(true);
    setModeError('');
    const res = await updateMatchySettings(projectId, { walkthrough: false, reviewFirst: liveReview });
    setSavingMode(false);
    if (!res.ok) { setModeError(res.message); return; }
    setConfirmLive(false);
    onUpdate(res.project);
  }

  /** Back to walkthrough. One click — this direction only ever sends less. */
  async function goWalkthrough() {
    setSavingMode(true);
    setModeError('');
    const res = await updateMatchySettings(projectId, { walkthrough: true });
    setSavingMode(false);
    if (!res.ok) { setModeError(res.message); return; }
    setConfirmLive(false);
    onUpdate(res.project);
  }

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

      {/* ── Mode: walkthrough or live ── */}
      <div className="space-y-2">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0 max-w-md">
            <p className="text-[10px] uppercase tracking-widest text-navy font-semibold" style={{ letterSpacing: '0.16em' }}>
              Mode
            </p>
            <p className="text-[11px] text-muted leading-relaxed mt-1">
              {walkthrough
                ? 'Walkthrough. Click through the whole flow and read every draft. Nothing reaches an expert.'
                : 'Live. Matchy writes to real experts from this project.'}
            </p>
          </div>
          <div className="shrink-0 flex items-center gap-2 flex-wrap justify-end">
            <span
              className={`text-[10px] uppercase tracking-widest border px-2.5 py-1 ${
                walkthrough ? 'border-gold text-gold bg-navy' : 'border-frame text-muted'
              }`}
              style={{ letterSpacing: '0.12em' }}
            >
              {walkthrough ? 'Walkthrough' : 'Live'}
            </span>
            {walkthrough ? (
              <button
                type="button"
                onClick={() => { setModeError(''); setLiveReview(true); setConfirmLive(v => !v); }}
                disabled={savingMode}
                aria-expanded={confirmLive}
                className="text-[10px] uppercase tracking-widest border border-navy bg-navy text-gold px-3 py-1.5 transition-colors hover:bg-navy/90 disabled:opacity-40"
                style={{ letterSpacing: '0.12em' }}
              >
                Go live
              </button>
            ) : (
              <button
                type="button"
                onClick={() => { void goWalkthrough(); }}
                disabled={savingMode}
                className="text-[10px] uppercase tracking-widest border border-frame text-muted hover:border-navy hover:text-navy px-3 py-1.5 transition-colors disabled:opacity-40"
                style={{ letterSpacing: '0.12em' }}
              >
                {savingMode ? 'Saving…' : 'Back to walkthrough'}
              </button>
            )}
          </div>
        </div>

        {confirmLive && walkthrough && (
          <div className="border border-gold/60 bg-cream px-3.5 py-3 space-y-2.5">
            <p className="text-[11px] text-ink leading-relaxed">
              Matchy will email real experts from this project. Emails you have already drafted stay
              drafted until you send them.
            </p>
            <label className="flex items-start gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={liveReview}
                onChange={e => setLiveReview(e.target.checked)}
                disabled={savingMode}
                className="mt-[2px] shrink-0 accent-navy"
              />
              <span className="text-[11px] text-ink leading-relaxed">
                Review each email before it goes out
              </span>
            </label>
            <div className="flex items-center gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => { void goLive(); }}
                disabled={savingMode}
                className="text-[10px] uppercase tracking-widest bg-navy text-cream px-3.5 py-1.5 hover:bg-navy/90 disabled:opacity-40 transition-colors"
                style={{ letterSpacing: '0.12em' }}
              >
                {savingMode ? 'Switching…' : 'Confirm'}
              </button>
              <button
                type="button"
                onClick={() => { setConfirmLive(false); setModeError(''); }}
                disabled={savingMode}
                className="text-[10px] uppercase tracking-widest text-muted hover:text-navy border border-frame hover:border-navy px-3.5 py-1.5 disabled:opacity-40 transition-colors"
                style={{ letterSpacing: '0.12em' }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {modeError && <p className="text-[11px] text-red-600">{modeError}</p>}
      </div>

      <div className="rule-divider" />

      {/* ── Review before sending ── */}
      <div className={`flex items-start justify-between gap-4 flex-wrap ${walkthrough ? 'opacity-60' : ''}`}>
        <div className="min-w-0 max-w-md">
          <p className="text-[10px] uppercase tracking-widest text-navy font-semibold" style={{ letterSpacing: '0.16em' }}>
            Review before sending
          </p>
          <p className="text-[11px] text-muted leading-relaxed mt-1">
            Off: Matchy sends intros and follow-ups as soon as you bookmark. On: you approve each one.
          </p>
          {walkthrough && (
            <p className="text-[11px] text-muted leading-relaxed mt-1">
              Not needed in walkthrough mode. Nothing is sent.
            </p>
          )}
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
          {savingSwitch ? 'Saving…' : reviewFirst ? 'On' : 'Off'}
        </button>
      </div>

      <div className="rule-divider" />

      {/* ── Rate band ── */}
      <div className="space-y-1.5">
        <p className="text-[10px] uppercase tracking-widest text-navy font-semibold" style={{ letterSpacing: '0.16em' }}>
          What you&apos;ll pay per hour
        </p>
        {/* Enforced server-side: the bookmark route seeds the opening offer
            inside the band (lib/pricing.clampClientRateToBand) and the
            rate-decision route refuses an accept above the ceiling with 409
            above_band. Rates already agreed are not revisited. */}
        <p className="text-[11px] text-muted leading-relaxed max-w-md">
          Matchy opens inside this band and won&apos;t agree to a rate above the top of it.
          Leave either end blank for no limit.
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

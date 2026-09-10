'use client';

// The one card "Ask Matchy" renders above the composer's buttons (Matchy 2.0).
//
// It is not a message and is never stored: one card at a time, replaced by the
// next ask, gone on Dismiss or a thread switch. Its shape is decided by
// lib/matchyIntent.ts; this component only draws it in the thread's own
// vocabulary — the MatchyLine mark, the composer's amber findings rows, the
// thread's button styles — and hands every press back to the thread, which
// owns the handlers (send, decideRate, runProposeTimes, approveIntro, …).
//
// No avatar, no bubble, no transcript. Money on this card is the client's own
// figure, formatted by the router; nothing here computes a number.

import { useState } from 'react';
import type { RejectionReason } from '../types';
import MatchyLine from './MatchyLine';
import { CLIENT_STATUS_META } from './matchyStatus';
import { REJECTION_REASONS, REASONS_WITH_NOTES } from '../lib/rejectionReasons';
import { PREFERENCES_MAX } from '../lib/matchyClient';
import { findingNoun, type AskAction, type AskCard } from '../lib/matchyIntent';

export interface AskActionPayload {
  rate?:        number;
  preferences?: string;
  reason?:      RejectionReason;
  notes?:       string;
  expertId?:    string;
  text?:        string;
}

interface Props {
  card:      AskCard;
  /** Owner or staff. Verb buttons never render for anyone else. */
  canSend:   boolean;
  /** True while a button's request is in flight. */
  busy:      boolean;
  /** The draft returned by the draft route, when the card carries one. */
  draft?:    string;
  onAction:  (action: AskAction, payload?: AskActionPayload) => void;
}

const TINT: Record<AskCard['tint'], string> = {
  cream:   'border-frame bg-cream',
  amber:   'border-amber-300 bg-amber-50',
  teal:    'border-teal-300 bg-teal-50',
  green:   'border-green-300 bg-green-50',
  sky:     'border-sky-200 bg-sky-50',
  blocked: 'border-amber-300 bg-amber-50',
};

const PRIMARY   = 'text-[10px] uppercase tracking-widest bg-navy text-cream px-3 py-1.5 hover:bg-navy/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
const SECONDARY = 'text-[10px] uppercase tracking-widest text-navy border border-navy/30 hover:border-navy px-3 py-1.5 disabled:opacity-40 disabled:cursor-not-allowed transition-colors';
const TRACK     = { letterSpacing: '0.1em' } as const;

export default function MatchyAskCard({ card, canSend, busy, draft, onAction }: Props) {
  const [preferences, setPreferences] = useState(card.preferences ?? '');
  const [reason,      setReason]      = useState<RejectionReason>(card.reason ?? 'other');
  const [notes,       setNotes]       = useState('');

  // A line with no buttons is the lightest thing Matchy says. It still gets a
  // Dismiss so the pane never holds a stale answer.
  const isLine = card.kind === 'line' && !card.quote && !card.rows && !card.findings;

  const buttons = card.buttons.filter(b => {
    // Verbs are the owner's. A read-only viewer may still jump, open a thread, or dismiss.
    if (canSend) return true;
    return b.action === 'jump' || b.action === 'open_expert' || b.action === 'dismiss';
  });

  const payloadFor = (action: AskAction, expertId?: string): AskActionPayload | undefined => {
    switch (action) {
      case 'set_rate':    return { rate: card.rate };
      case 'propose':     return { preferences: preferences.trim() };
      case 'pass':        return { reason, ...(REASONS_WITH_NOTES.has(reason) && notes.trim() ? { notes: notes.trim() } : {}) };
      case 'open_expert': return { expertId };
      case 'use_draft':   return { text: draft };
      default:            return undefined;
    }
  };

  const buttonRow = buttons.length > 0 && (
    <div className="flex items-center gap-2 flex-wrap">
      {buttons.map((b, i) => (
        <button
          key={`${b.action}-${b.label}-${i}`}
          type="button"
          onClick={() => onAction(b.action, payloadFor(b.action, b.expertId))}
          disabled={busy || b.disabled}
          title={b.title}
          className={b.primary ? PRIMARY : SECONDARY}
          style={TRACK}
        >
          {b.label}
        </button>
      ))}
    </div>
  );

  const dismiss = (
    <button
      type="button"
      onClick={() => onAction('dismiss')}
      className="absolute top-2 right-2.5 text-[9px] uppercase tracking-widest text-muted hover:text-navy transition-colors"
      style={{ letterSpacing: '0.12em' }}
      aria-label="Dismiss"
    >
      Dismiss
    </button>
  );

  if (isLine) {
    return (
      <div className="relative pr-14 space-y-2">
        <MatchyLine tone={card.tone}>{card.line}</MatchyLine>
        {buttonRow && <div className="pl-0 sm:pl-[52px]">{buttonRow}</div>}
        {dismiss}
      </div>
    );
  }

  return (
    <div className={`relative border px-3.5 py-3 pr-14 space-y-2.5 ${TINT[card.tint]}`}>
      {card.line && <MatchyLine tone={card.tone}>{card.line}</MatchyLine>}

      {/* The screen's findings, in the composer's own words. */}
      {card.findings && card.findings.length > 0 && (
        <div className="border border-amber-300 bg-amber-50 px-3 py-2 space-y-1">
          {card.findings.map((f, i) => (
            <p key={`${f.kind}-${i}`} className="text-[11px] text-amber-800 leading-relaxed">
              Remove: {findingNoun(f.kind)} &lsquo;{f.match}&rsquo; &middot; {f.hint}
            </p>
          ))}
        </div>
      )}

      {/* Matchy's stored summary of a reply. Never the email. */}
      {card.quote && (
        <blockquote className="ml-0 sm:ml-[52px] border-l-2 border-gold bg-surface px-3 py-2">
          <p className="text-[10px] uppercase tracking-widest text-muted mb-1" style={{ letterSpacing: '0.12em' }}>
            {card.quote.label} · {card.quote.when}
          </p>
          <p className="text-[12px] text-ink leading-relaxed">{card.quote.text}</p>
        </blockquote>
      )}

      {/* The draft, behind Use this. */}
      {draft && (
        <blockquote className="ml-0 sm:ml-[52px] border-l-2 border-gold bg-surface px-3 py-2">
          <p className="text-[12px] text-ink leading-relaxed whitespace-pre-wrap">{draft}</p>
        </blockquote>
      )}

      {/* Across the project: one row per expert, a stage pill and one fact. */}
      {card.rows && card.rows.length > 0 && (
        <ul className="ml-0 sm:ml-[52px] space-y-1">
          {card.rows.map(r => {
            const pill = CLIENT_STATUS_META[r.status];
            return (
              <li key={r.expertId} className="flex items-center gap-2 flex-wrap text-[11px] border border-frame bg-surface px-2.5 py-1.5">
                <span className="font-medium text-navy">{r.name}</span>
                <span className={`inline-block text-[9px] px-1.5 py-0.5 border font-medium uppercase tracking-wider ${pill.classes}`}>{pill.label}</span>
                <span className="text-muted">{r.fact}</span>
              </li>
            );
          })}
        </ul>
      )}

      {/* Teal: the preferences line the picker will read. */}
      {card.preferences !== undefined && canSend && (
        <label className="ml-0 sm:ml-[52px] flex items-center gap-2 text-[11px]">
          <span className="shrink-0 text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.12em' }}>Preferences</span>
          <input
            type="text"
            value={preferences}
            onChange={e => setPreferences(e.target.value)}
            maxLength={PREFERENCES_MAX}
            disabled={busy}
            placeholder="mornings only, not Fridays"
            aria-label="Preferences for the call time"
            className="flex-1 min-w-0 px-2.5 py-1.5 text-[12px] border border-frame bg-surface focus:outline-none focus:border-navy text-ink disabled:opacity-50"
          />
          <span className="text-[10px] text-muted tabular-nums">{preferences.length}/{PREFERENCES_MAX}</span>
        </label>
      )}

      {/* Amber pass: the same reasons the Matches card uses. */}
      {card.reason !== undefined && canSend && (
        <div className="ml-0 sm:ml-[52px] space-y-2">
          <label className="flex items-center gap-2 text-[11px]">
            <span className="shrink-0 text-[10px] uppercase tracking-widest text-muted" style={{ letterSpacing: '0.12em' }}>Reason</span>
            <select
              value={reason}
              onChange={e => setReason(e.target.value as RejectionReason)}
              disabled={busy}
              className="select-field flex-1 min-w-0 px-2.5 py-1.5 pr-7 text-[12px] border border-frame bg-surface focus:outline-none focus:border-navy text-ink"
            >
              {REJECTION_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
            </select>
          </label>
          {REASONS_WITH_NOTES.has(reason) && (
            <textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              rows={2}
              maxLength={2000}
              disabled={busy}
              placeholder="A note for your team. Never sent to the expert."
              className="w-full px-2.5 py-1.5 text-[12px] border border-frame bg-surface focus:outline-none focus:border-navy text-ink resize-none"
            />
          )}
        </div>
      )}

      {buttonRow && <div className="ml-0 sm:ml-[52px]">{buttonRow}</div>}

      {card.rate !== undefined && (
        <p className="ml-0 sm:ml-[52px] text-[10px] text-muted">
          Nothing is charged now. You pay after the call, by the minute, 15-minute minimum, at the rate you agree.
        </p>
      )}

      {dismiss}
    </div>
  );
}

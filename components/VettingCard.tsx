'use client';

// The vetting card: what public records say about an expert's role, and where
// the conflict and NDA questions stand, before the call is booked.
//
// Every value is a level, a type or a band IN WORDS (lib/vettingCard.ts): no
// year, no number, no company and no name, because identity stays hidden until
// the booking and a figure is a fingerprint. A field the record does not
// support reads "Not in public records" rather than a guess.
//
// Two variants:
//   full     the thread's card, collapsible, one summary line when closed
//   compact  one line for the Matches card (placed by the Matches owner)
//
// WHERE THE DATA COMES FROM. A client's payload carries `vetting`, derived on
// the server from the raw record (lib/redactExpert.ts): the browser cannot
// compute it, because the title and evidence it reads never reach a client.
// Staff payloads are the raw record itself, so for staff this card derives the
// same field with the same function.

import { useMemo, useState } from 'react';
import type { ExpertVetting, ProjectExpert, VettingSinceLeftBand } from '../types';
import {
  deriveVetting,
  conflictLine,
  sentenceCase,
  NOT_IN_PUBLIC_RECORDS,
} from '../lib/vettingCard';

interface Props {
  projectExpert: ProjectExpert;
  /** Platform admin: the payload is the raw record, so the card derives itself. */
  isAdmin?:      boolean;
  /** One line, no toggle: the Matches card. */
  compact?:      boolean;
  /** Full variant only: open on first render. */
  defaultOpen?:  boolean;
  className?:    string;
}

// ─── Words ────────────────────────────────────────────────────────────────────

const SINCE_LEFT_TEXT: Record<VettingSinceLeftBand, string> = {
  'still there':               'Still there',
  'left within the last year': 'Left within the last year',
  'one to three years ago':    'Left one to three years ago',
  'more than three years ago': 'Left more than three years ago',
};

const EMPLOYMENT_TEXT = { current: 'Current employee', former: 'Former employee' } as const;

function riskText(risk: ExpertVetting['conflict']['risk']): string | null {
  return risk ? `Conflict risk: ${risk}` : null;
}

/** The one line: compact variant, and the full card's closed state. */
function summaryLine(v: ExpertVetting): string {
  const parts = [
    v.roleLevel,
    v.employment ? (v.employment === 'current' ? 'Current' : 'Former') : null,
    v.tenure ? `${sentenceCase(v.tenure)} there` : null,
    v.sinceLeft && v.sinceLeft !== 'still there' ? SINCE_LEFT_TEXT[v.sinceLeft] : null,
    `Conflicts: ${conflictLine(v.conflict).toLowerCase()}`,
  ];
  return parts.filter((p): p is string => !!p).join(' · ');
}

function Row({ label, value, muted }: { label: string; value: React.ReactNode; muted?: boolean }) {
  return (
    <div className="grid grid-cols-1 sm:grid-cols-[9.5rem_1fr] gap-0.5 sm:gap-3 items-baseline">
      <dt
        className="text-[9px] uppercase tracking-widest text-muted font-medium"
        style={{ letterSpacing: '0.14em' }}
      >
        {label}
      </dt>
      <dd className={`text-[12px] leading-snug ${muted ? 'text-muted' : 'text-ink'}`}>{value}</dd>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function VettingCard({
  projectExpert,
  isAdmin = false,
  compact = false,
  defaultOpen = false,
  className = '',
}: Props) {
  const [open, setOpen] = useState(defaultOpen);

  // The server's field when there is one; staff derive it from the raw record.
  // A client payload without the field (an old cached response) shows the
  // empty state rather than a card worked out from blanks.
  const vetting = useMemo<ExpertVetting | null>(
    () => projectExpert.vetting ?? (isAdmin ? deriveVetting(projectExpert, Date.now()) : null),
    [projectExpert, isAdmin],
  );

  if (compact) {
    return (
      <p className={`text-[10px] text-muted leading-snug ${className}`}>
        {vetting ? summaryLine(vetting) : 'Vetting details are not ready yet.'}
      </p>
    );
  }

  const conflict = vetting?.conflict ?? null;
  const conflictTone = conflict?.flagged ? 'text-red-700' : 'text-ink';

  return (
    <div className={`border-b border-frame bg-surface ${className}`}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="w-full px-4 py-2 flex items-start gap-2 text-left hover:bg-cream/60 transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-gold"
      >
        <span
          className="shrink-0 mt-[2px] text-[9px] uppercase tracking-widest text-navy font-semibold"
          style={{ letterSpacing: '0.18em' }}
        >
          Vetting
        </span>
        <span className="min-w-0 flex-1 text-[11px] text-muted leading-snug line-clamp-2">
          {vetting
            ? open ? 'From public records and their answers to our questions.' : summaryLine(vetting)
            : 'Vetting details are not ready yet.'}
        </span>
        <span aria-hidden className="shrink-0 text-[10px] text-muted/70 mt-[1px]">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="px-4 pb-3 pt-1">
          {!vetting ? (
            <p className="text-[11px] text-muted">
              Vetting details are not ready yet. They appear here once the expert record loads.
            </p>
          ) : (
            <dl className="space-y-2">
              <Row label="Role level"    value={vetting.roleLevel ?? NOT_IN_PUBLIC_RECORDS}    muted={!vetting.roleLevel} />
              <Row label="Employer type" value={vetting.employerType ?? NOT_IN_PUBLIC_RECORDS} muted={!vetting.employerType} />
              <Row
                label="Status"
                value={vetting.employment ? EMPLOYMENT_TEXT[vetting.employment] : NOT_IN_PUBLIC_RECORDS}
                muted={!vetting.employment}
              />
              <Row
                label="Time there"
                value={vetting.tenure ? sentenceCase(vetting.tenure) : NOT_IN_PUBLIC_RECORDS}
                muted={!vetting.tenure}
              />
              <Row
                label="Since leaving"
                value={vetting.sinceLeft ? SINCE_LEFT_TEXT[vetting.sinceLeft] : NOT_IN_PUBLIC_RECORDS}
                muted={!vetting.sinceLeft}
              />
              {conflict && (
                <Row
                  label="Conflicts and NDAs"
                  value={
                    <span className="block space-y-0.5">
                      <span className={`block ${conflictTone}`}>{conflictLine(conflict)}</span>
                      {conflict.flagged && (
                        <span className="block text-[11px] text-muted">
                          {conflict.summary ?? 'The details are in their reply below.'}
                        </span>
                      )}
                      {riskText(conflict.risk) && (
                        <span className="block text-[11px] text-muted">{riskText(conflict.risk)}</span>
                      )}
                    </span>
                  }
                />
              )}
            </dl>
          )}
        </div>
      )}
    </div>
  );
}

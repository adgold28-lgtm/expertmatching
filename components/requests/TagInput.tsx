'use client';

// A chip field for the optional targeting block on /requests/new: target
// companies, companies to exclude, experts already used.
//
// WHY A CHIP FIELD AND NOT A COMMA-SEPARATED TEXT BOX. lib/screeningValidation
// SANITISES targeting rather than rejecting it — blanks dropped, entries
// trimmed and de-duplicated, the list cut to thirty — so a client who pastes a
// messy list never learns that four of their entries quietly vanished. Chips
// show exactly what will be sent, one visible token per entry, before they
// press anything.
//
// Keyboard first: Enter or a comma commits the draft, Backspace on an empty
// draft removes the last chip, every chip's × is a real focusable button with
// its own label, and leaving the field commits whatever was typed rather than
// throwing it away. Enter is swallowed (preventDefault) because this lives
// inside a form and "add a company" must never mean "create the request".
//
// De-duplication is case-insensitive and keeps the first spelling, matching
// what the server does, so the chips are what the request will actually hold.

import { useRef, useState } from 'react';

interface TagInputProps {
  /** Input id — the label's htmlFor and the helper's aria-describedby hang off it. */
  id:           string;
  label:        string;
  values:       string[];
  onChange:     (next: string[]) => void;
  placeholder?: string;
  helper?:      string;
  /** Most chips this field takes. Mirrors LIMITS.targetingListMax. */
  max?:         number;
  /** Longest one chip may be. Mirrors LIMITS.targetingEntry. */
  maxEntry?:    number;
}

export default function TagInput({
  id, label, values, onChange, placeholder, helper, max = 30, maxEntry = 120,
}: TagInputProps) {
  const [draft, setDraft] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const full      = values.length >= max;
  const helperId  = `${id}-helper`;
  const statusId  = `${id}-status`;

  /** Commits the draft (or a pasted comma-separated run of entries). */
  function commit(raw: string) {
    const parts = raw
      .split(',')
      .map(part => part.trim().slice(0, maxEntry))
      .filter(Boolean);
    if (parts.length === 0) { setDraft(''); return; }

    const next = [...values];
    const seen = new Set(next.map(value => value.toLowerCase()));
    for (const part of parts) {
      if (next.length >= max) break;
      const key = part.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      next.push(part);
    }
    setDraft('');
    if (next.length !== values.length) onChange(next);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Enter' || event.key === ',') {
      // Inside a form, Enter would submit. Adding a chip is not submitting.
      event.preventDefault();
      commit(draft);
      return;
    }
    if (event.key === 'Backspace' && draft === '' && values.length > 0) {
      event.preventDefault();
      onChange(values.slice(0, -1));
    }
  }

  function remove(index: number) {
    onChange(values.filter((_, i) => i !== index));
    inputRef.current?.focus();
  }

  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-[10px] font-medium uppercase tracking-widest text-muted"
        style={{ letterSpacing: '0.18em' }}
      >
        {label}
      </label>

      <div
        className="flex min-h-[44px] w-full flex-wrap items-center gap-1.5 border border-frame bg-cream px-2 py-1.5 focus-within:border-navy"
        onClick={() => inputRef.current?.focus()}
      >
        {values.map((value, index) => (
          <span
            key={`${value}-${index}`}
            className="inline-flex min-h-[28px] items-center gap-1 bg-white px-2 py-0.5 text-xs text-ink"
            style={{ border: '1px solid #DDE2E8' }}
          >
            <span className="max-w-[14rem] truncate">{value}</span>
            <button
              type="button"
              onClick={event => { event.stopPropagation(); remove(index); }}
              aria-label={`Remove ${value}`}
              className="flex h-6 w-6 shrink-0 items-center justify-center text-muted transition-colors hover:text-navy"
            >
              <span aria-hidden="true">×</span>
            </button>
          </span>
        ))}

        <input
          ref={inputRef}
          id={id}
          type="text"
          value={draft}
          disabled={full}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => commit(draft)}
          placeholder={full ? '' : (values.length === 0 ? placeholder : 'Add another…')}
          aria-describedby={`${helper ? `${helperId} ` : ''}${statusId}`}
          className="min-w-[8rem] flex-1 bg-transparent px-1.5 py-1.5 text-sm text-ink placeholder-[#9AABB8] focus:outline-none disabled:cursor-not-allowed"
          style={{ fontFamily: 'var(--font-libre-franklin)', fontWeight: 300 }}
        />
      </div>

      {helper && (
        <p id={helperId} className="mt-1 text-[11px] leading-relaxed text-muted" style={{ fontWeight: 300 }}>
          {helper}
        </p>
      )}
      <p id={statusId} role="status" className="mt-1 text-[11px] text-muted" style={{ fontWeight: 300 }}>
        {full
          ? `That is the maximum — ${max} entries.`
          : values.length === 0
            ? 'Press Enter or type a comma to add one.'
            : `${values.length} added. Press Enter or type a comma to add another.`}
      </p>
    </div>
  );
}

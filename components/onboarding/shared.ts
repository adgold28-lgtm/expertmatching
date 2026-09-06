// Shared palette constants and class strings for the /onboarding stepper.
//
// The onboarding surface predates the Tailwind token classes and styles its
// navy/gold accents inline, so the hex values live here rather than being
// re-typed in each step file. Anything expressible as a Tailwind class (frame
// borders, cream fields, muted labels) stays a class.

export const GOLD  = '#C6A75E';
export const NAVY  = '#0B1F3B';
export const MUTED = '#5A6B7A';
export const FAINT = '#8A9BAD';

/** Micro-label letter-spacing — wider than Tailwind's `tracking-widest`. */
export const MICRO_LS = { letterSpacing: '0.14em' } as const;

export const LABEL_CLASS =
  'block text-[10px] uppercase tracking-widest text-muted mb-1.5';

export const FIELD_CLASS =
  'w-full border border-frame bg-cream px-3 py-2.5 text-sm text-ink ' +
  'placeholder:text-muted/50 focus:outline-none focus:border-navy ' +
  'transition-colors disabled:opacity-40 disabled:cursor-not-allowed';

export const BUTTON_CLASS =
  'w-full py-3 text-[11px] uppercase font-medium transition-colors ' +
  'disabled:opacity-40 disabled:cursor-not-allowed';

/** Panel used for both the success ticks and the inline notices. */
export const NOTE_CLASS = 'flex items-start gap-3 p-4 border text-sm';

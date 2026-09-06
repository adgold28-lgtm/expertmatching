'use client';

// Matchy's mark. One small wordmark and one line of text — no avatar, no chat
// bubble, no greeting (docs/MATCHY_SPEC.md, "Principles" 2 and 4). Every place
// Matchy speaks to the client uses this, so the voice reads as one thing.

interface Props {
  children:   React.ReactNode;
  /** 'note' is the compact in-thread line; 'card' is the boxed status line. */
  variant?:   'note' | 'card';
  /** Muted styling for a line that reports a non-event ("no address yet"). */
  tone?:      'default' | 'quiet' | 'alert';
  className?: string;
}

export function MatchyMark({ className = '' }: { className?: string }) {
  return (
    <span
      className={`shrink-0 text-[9px] uppercase font-semibold text-gold/90 ${className}`}
      style={{ letterSpacing: '0.18em' }}
    >
      Matchy
    </span>
  );
}

export default function MatchyLine({ children, variant = 'note', tone = 'default', className = '' }: Props) {
  const textClass =
    tone === 'alert' ? 'text-red-700' :
    tone === 'quiet' ? 'text-muted'   :
                       'text-ink';

  if (variant === 'card') {
    return (
      <div className={`border border-frame bg-surface px-3 py-2 flex items-start gap-2 ${className}`}>
        <MatchyMark className="mt-[3px]" />
        <p className={`text-[11px] leading-relaxed ${textClass}`}>{children}</p>
      </div>
    );
  }

  return (
    <div className={`flex items-start gap-2 ${className}`}>
      <MatchyMark className="mt-[3px]" />
      <p className={`text-[11px] leading-relaxed ${textClass}`}>{children}</p>
    </div>
  );
}

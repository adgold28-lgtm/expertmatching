'use client';

// The micro-label every anonymized expert card carries, so a client always
// knows WHY they are looking at "Scott S." rather than a full profile — and
// what unlocks the rest.
//
// Rendered whenever an expert arrives with `anonymizedDescriptor` set and no
// sources (see lib/redactExpert.ts). House styling: 9px, uppercase, wide
// tracking, muted. The lock is an inline SVG — no icon dependency.

export function isAnonymized(expert: {
  anonymizedDescriptor?: string;
  source_links?:         unknown[];
  title?:                string;
}): boolean {
  return !!expert.anonymizedDescriptor?.trim()
    && !expert.title
    && (expert.source_links?.length ?? 0) === 0;
}

export default function IdentityProtectedLabel({ className = '' }: { className?: string }) {
  return (
    <p
      className={`flex items-center gap-1 text-[9px] uppercase tracking-widest text-muted ${className}`}
      style={{ letterSpacing: '0.14em' }}
    >
      <svg
        className="w-2.5 h-2.5 shrink-0"
        viewBox="0 0 12 12"
        fill="none"
        aria-hidden="true"
      >
        <rect x="2.5" y="5.25" width="7" height="5.25" rx="0.75" stroke="currentColor" strokeWidth="1" />
        <path d="M4.25 5.25V3.75a1.75 1.75 0 0 1 3.5 0v1.5" stroke="currentColor" strokeWidth="1" strokeLinecap="round" />
      </svg>
      Identity protected until a call is scheduled
    </p>
  );
}

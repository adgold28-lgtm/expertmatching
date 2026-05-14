'use client';

import { useEffect, RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Traps keyboard focus inside `ref` while the component is mounted.
 * Focuses the container on mount; closes on Escape.
 */
export function useFocusTrap(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void
) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    // Move focus into the dialog on mount
    el.focus();

    function trap(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.key !== 'Tab') return;

      const focusable = Array.from(el!.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey) {
        if (document.activeElement === first) {
          e.preventDefault();
          last.focus();
        }
      } else {
        if (document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', trap);
    return () => document.removeEventListener('keydown', trap);
  }, [ref, onClose]);
}

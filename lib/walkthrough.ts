// Walkthrough mode — the hard stop between a client clicking through the flow
// and a real email landing in a real expert's inbox.
//
// A project starts in walkthrough. The client can bookmark, read the drafts,
// settle a rate and write replies, and Matchy says exactly what it would say —
// but nothing leaves the building: no Resend send, no contact-discovery provider
// call (which spends Snov/Hunter credits). The owner flips the project to live
// deliberately, with a confirmation; the per-project "review before sending"
// switch (`reviewFirst`) is then the second, softer gate.
//
// THE FLAG LIVES IN `projects.brief` (lib/projectStore merges any unpromoted key
// into the brief jsonb and rowToProject spreads it back), so this ships with no
// migration.
//
// THE DEFAULT IS SAFE. `undefined` means walkthrough; only an explicit `false`
// is live. Every project that already exists therefore reads as walkthrough the
// moment this deploys, which is exactly what we want.
//
// ENFORCEMENT is in two layers:
//   1. lib/emailSequence.sendSequenceEmail — the one chokepoint every send goes
//      through, so no route, present or future, can leak an email.
//   2. every caller, explicitly — so the UI can show a "held" state instead of
//      pretending something was sent.

import type { Project } from '../types';

/** True unless the owner explicitly switched the project live. */
export function isWalkthrough(project: Pick<Project, 'walkthrough'>): boolean {
  return project.walkthrough !== false;
}

/** The one line Matchy uses wherever a send was held. */
export const WALKTHROUGH_HELD_SUMMARY = 'Held. Walkthrough mode sends nothing.';

/**
 * Why a send did not happen.
 *   'walkthrough' — the project has not been switched live
 *   'disabled'    — DISABLE_EMAILS=true, the environment-wide kill switch
 *   'trial'       — the organization has no card on file (lib/entitlements.ts):
 *                   a trial or not-yet-activated account may never reach an
 *                   expert, whatever the project's own mode says
 * Both mean "not sent"; they are distinguished so a caller can tell a product
 * state from an operational one.
 */
export type HeldReason = 'walkthrough' | 'disabled' | 'trial';

const HELD_REASONS: ReadonlySet<string> = new Set<HeldReason>(['walkthrough', 'disabled', 'trial']);

/** The short tag a held message wears in the thread. */
export function heldLabel(reason: HeldReason | string | null | undefined): string {
  switch (reason) {
    case 'trial':    return 'Held · activation required';
    case 'disabled': return 'Held · sending disabled';
    default:         return 'Held · walkthrough';
  }
}

/** Narrows an unknown stored value to a HeldReason. */
export function toHeldReason(value: unknown): HeldReason | null {
  return typeof value === 'string' && HELD_REASONS.has(value) ? (value as HeldReason) : null;
}

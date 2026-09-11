// lib/calendlyFlag.ts — the CALENDLY_ENABLED kill switch, as one pure function.
//
// Calendly does not work and never has: every unauthenticated call to
// api.calendly.com answers 401, so lib/fetchCalendlySlots.ts resolves every
// link to an empty slot list and a Calendly connection is indistinguishable
// from no connection at scheduling time (ARCHITECTURE.md 6.6, 8). Rather than
// delete the integration, Wave 5 hides it behind this flag: unset or anything
// other than the exact string 'true' means the product never offers Calendly,
// refuses a Calendly connect, and treats an existing Calendly row as NOT
// connected so the user is pushed to Google or to typing their hours.
// Setting CALENDLY_ENABLED=true restores the previous behaviour verbatim.
//
// Pure: no I/O, no module-level env read, so it can be unit-tested with an
// explicit env object (scripts/test-availability-windows.ts).

/** Just the slice of the environment this decision depends on. */
export interface CalendlyEnv {
  CALENDLY_ENABLED?: string | undefined;
}

/**
 * True ONLY for the exact string 'true'. '1', 'yes', 'TRUE' and an unset
 * variable are all off — a kill switch that guesses is a kill switch that
 * fails open by accident.
 *
 * The default argument reads the one variable by name rather than passing
 * `process.env` wholesale so that scripts/check-env-drift.ts can see the read
 * and the admin env-status console can account for it.
 */
export function calendlyEnabled(
  env: CalendlyEnv = { CALENDLY_ENABLED: process.env.CALENDLY_ENABLED },
): boolean {
  return env.CALENDLY_ENABLED === 'true';
}

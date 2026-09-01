// lib/pricing.ts — the single source of truth for money rules.
//
// Two independent things are priced here:
//
//   1. SEATS — what an organization pays ExpertMatch per month for its
//      accounts. Volume pricing: the active-seat count selects a tier and
//      EVERY seat is billed at that tier's unit price (not marginal/graduated).
//      Mirrored 1:1 onto a Stripe Price with billing_scheme='tiered' and
//      tiers_mode='volume' (see stripeVolumeTiers), so Stripe and the app can
//      never disagree about a total.
//
//   2. EXPERT CALLS — a completed call's gross amount is split: the expert
//      receives EXPERT_SHARE, ExpertMatch keeps PLATFORM_SHARE.
//
// Pure functions only — no I/O, no env reads — so scripts/test-pricing.ts can
// exercise every boundary without a database or Stripe.

// ─── Seat tiers ───────────────────────────────────────────────────────────────

export interface SeatTier {
  /** Inclusive lower bound of active seats for this tier. */
  minSeats:       number;
  /** Inclusive upper bound, or null for the open-ended top tier. */
  maxSeats:       number | null;
  /** Monthly price per seat, in whole USD cents. */
  unitPriceCents: number;
}

/**
 * Volume tiers, ordered ascending. Every seat in an organization is billed at
 * the unit price of the tier that the org's active-seat count falls into.
 */
export const SEAT_TIERS: readonly SeatTier[] = [
  { minSeats: 1,   maxSeats: 9,    unitPriceCents: 100_00 },
  { minSeats: 10,  maxSeats: 24,   unitPriceCents:  90_00 },
  { minSeats: 25,  maxSeats: 49,   unitPriceCents:  85_00 },
  { minSeats: 50,  maxSeats: 99,   unitPriceCents:  75_00 },
  { minSeats: 100, maxSeats: 149,  unitPriceCents:  70_00 },
  { minSeats: 150, maxSeats: null, unitPriceCents:  60_00 },
] as const;

/** Stable identifier of the Stripe Price that encodes SEAT_TIERS. Bump the
 *  suffix whenever the tiers change so a new Price is created and old
 *  subscriptions keep their contracted rate until migrated. */
export const SEAT_PRICE_LOOKUP_KEY = 'expertmatch_seat_monthly_v1';
export const SEAT_PRODUCT_NAME     = 'ExpertMatch Seat';
export const SEAT_CURRENCY         = 'usd';

/** Normalises any input to a whole, non-negative seat count. */
export function normalizeSeatCount(seats: number): number {
  if (!Number.isFinite(seats) || seats <= 0) return 0;
  return Math.floor(seats);
}

/** The tier a given active-seat count falls into (null for zero seats). */
export function seatTierFor(seats: number): SeatTier | null {
  const n = normalizeSeatCount(seats);
  if (n === 0) return null;
  for (const tier of SEAT_TIERS) {
    if (n >= tier.minSeats && (tier.maxSeats === null || n <= tier.maxSeats)) return tier;
  }
  // Unreachable while SEAT_TIERS is contiguous from 1 to infinity.
  return SEAT_TIERS[SEAT_TIERS.length - 1];
}

/** Per-seat monthly price (cents) at a given seat count. 0 for zero seats. */
export function seatUnitPriceCents(seats: number): number {
  return seatTierFor(seats)?.unitPriceCents ?? 0;
}

/** Total monthly seat charge (cents) for an organization. */
export function monthlySeatTotalCents(seats: number): number {
  const n = normalizeSeatCount(seats);
  return n * seatUnitPriceCents(n);
}

/**
 * The next tier boundary above the current count, if any — used by the team
 * page to show "add N more seats to drop to $X/seat".
 */
export function nextSeatTier(seats: number): SeatTier | null {
  const n = normalizeSeatCount(seats);
  return SEAT_TIERS.find(t => t.minSeats > n) ?? null;
}

/**
 * Stripe `tiers` array for a Price with billing_scheme='tiered',
 * tiers_mode='volume'. Stripe wants `up_to` as the inclusive upper bound of
 * each tier and the literal 'inf' for the last one.
 */
export function stripeVolumeTiers(): Array<{ up_to: number | 'inf'; unit_amount: number }> {
  return SEAT_TIERS.map(t => ({
    up_to:       t.maxSeats === null ? 'inf' : t.maxSeats,
    unit_amount: t.unitPriceCents,
  }));
}

// ─── Expert call split ────────────────────────────────────────────────────────

/** Share of a paid call that goes to the expert. */
export const EXPERT_SHARE   = 0.70;
/** Share of a paid call that ExpertMatch keeps. */
export const PLATFORM_SHARE = 0.30;

export interface CallSplitCents {
  grossCents:    number;
  expertCents:   number;
  platformCents: number;
}

/**
 * Splits a gross call amount (cents) between expert and platform. The expert
 * amount is rounded to the cent; the platform keeps the remainder so the two
 * parts always sum exactly to the gross.
 */
export function splitCallAmountCents(grossCents: number): CallSplitCents {
  const gross = Number.isFinite(grossCents) && grossCents > 0 ? Math.round(grossCents) : 0;
  const expertCents = Math.round(gross * EXPERT_SHARE);
  return { grossCents: gross, expertCents, platformCents: gross - expertCents };
}

// ─── Formatting ───────────────────────────────────────────────────────────────

/** "$1,234" / "$1,234.50" — whole dollars unless there are cents. */
export function formatUsdFromCents(cents: number): string {
  const dollars = cents / 100;
  const hasCents = Math.round(cents) % 100 !== 0;
  return dollars.toLocaleString('en-US', {
    style:                 'currency',
    currency:              'USD',
    minimumFractionDigits: hasCents ? 2 : 0,
    maximumFractionDigits: hasCents ? 2 : 0,
  });
}

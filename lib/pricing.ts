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
  /** Marketing shows "Talk to us" instead of a price; Stripe still bills
   *  unitPriceCents as the fallback until custom terms are agreed. */
  contactSales?:  boolean;
}

/**
 * Volume tiers, ordered ascending. Every seat in an organization is billed at
 * the unit price of the tier that the org's active-seat count falls into.
 */
export const SEAT_TIERS: readonly SeatTier[] = [
  { minSeats: 1,  maxSeats: 5,    unitPriceCents: 250_00 },
  { minSeats: 6,  maxSeats: 20,   unitPriceCents: 200_00 },
  { minSeats: 21, maxSeats: null, unitPriceCents: 200_00, contactSales: true },
] as const;

/** Seat count at and above which the site says "Talk to us". */
export const CONTACT_SALES_FROM_SEATS = 21;

/** Stable identifier of the Stripe Price that encodes SEAT_TIERS. Bump the
 *  suffix whenever the tiers change so a new Price is created and old
 *  subscriptions keep their contracted rate until migrated. */
export const SEAT_PRICE_LOOKUP_KEY = 'expertmatch_seat_monthly_v2';
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
export const EXPERT_SHARE   = 0.50;
/** Share of a paid call that ExpertMatch keeps. */
export const PLATFORM_SHARE = 0.50;
/** Calls shorter than this are billed as this many minutes. */
export const MIN_BILLABLE_MINUTES = 15;

/** Billable minutes for a call: at least MIN_BILLABLE_MINUTES, whole minutes. */
export function billableMinutes(durationMinutes: number): number {
  const m = Number.isFinite(durationMinutes) && durationMinutes > 0 ? Math.ceil(durationMinutes) : 0;
  return m === 0 ? 0 : Math.max(MIN_BILLABLE_MINUTES, m);
}

/** Rounding granularity for the client-facing hourly rate. */
export const CLIENT_RATE_ROUNDING_USD = 50;

/**
 * What the client pays per hour for an expert whose hourly offer is
 * `expertRate`: expertRate / EXPERT_SHARE, rounded UP to the next $50.
 * $400 → $800, $650 → $1,300, $800 → $1,600, $675 → $1,350.
 */
export function clientRateFor(expertRate: number): number {
  if (!Number.isFinite(expertRate) || expertRate <= 0) return 0;
  return Math.ceil(expertRate / EXPERT_SHARE / CLIENT_RATE_ROUNDING_USD) * CLIENT_RATE_ROUNDING_USD;
}

/**
 * The EXPERT-side number implied by a client-facing rate: the inverse of
 * `clientRateFor`, up to the $50 rounding that function applies.
 *
 * Used when the client offers their standing rate back to an expert who has
 * countered: the client sees `clientRate`, the expert must be told the number
 * we would actually pay them, and the two never share a message
 * (docs/MATCHY_SPEC.md, "Pricing rule"). Rounds DOWN, so the offer we quote is
 * never more than the split allows — `clientRateFor(expertRateFor(x)) <= x`
 * for every rate on the $50 grid.
 */
export function expertRateFor(clientRate: number): number {
  if (!Number.isFinite(clientRate) || clientRate <= 0) return 0;
  return Math.floor(clientRate * EXPERT_SHARE);
}

/** The lowest client-facing hourly rate the product accepts, in whole USD. */
export const CLIENT_RATE_FLOOR_USD = 100;

/**
 * True when a client-side rate sits on the product's grid: a whole number of
 * dollars, at least the floor, in $50 steps. The project band and the
 * per-expert rate (PUT …/experts/[id] { clientRate }) share this test so a
 * number the band accepts is a number an engagement accepts.
 */
export function isValidClientRateUsd(value: unknown): value is number {
  return typeof value === 'number'
    && Number.isInteger(value)
    && value >= CLIENT_RATE_FLOOR_USD
    && value % CLIENT_RATE_ROUNDING_USD === 0;
}

// ─── The client's rate band ───────────────────────────────────────────────────
//
// `clientRateMin` / `clientRateMax` are set per project in CLIENT-side dollars
// (docs/MATCHY_SPEC.md: "tiers are rough estimates, the band is the rule").
// Either end may be null for "no limit". Both helpers are pure so the routes
// that enforce the band share one definition of "inside".

export interface ClientRateBand {
  clientRateMin?: number | null;
  clientRateMax?: number | null;
}

/** A usable band end: a finite positive number. Anything else is "no limit". */
function bandEnd(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The client-side rate a converted number would exceed, or null when the rate
 * is inside the band. Only the ceiling can be exceeded: a rate BELOW the floor
 * is cheaper than the client said they would pay, which is never a reason to
 * refuse it.
 */
export function clientRateCeilingExceeded(clientRate: number, band: ClientRateBand): number | null {
  const max = bandEnd(band.clientRateMax);
  return max !== null && clientRate > max ? max : null;
}

/**
 * The opening offer, pulled inside the band. The tier's client rate is only an
 * estimate; when the client has said what they will pay, the first number
 * Matchy quotes sits inside it — never above the ceiling, never below the
 * floor. Returned in client-side dollars; convert with `expertRateFor` before
 * it reaches an expert. A band with min > max is treated as the ceiling alone.
 */
export function clampClientRateToBand(clientRate: number, band: ClientRateBand): number {
  const min = bandEnd(band.clientRateMin);
  const max = bandEnd(band.clientRateMax);
  let rate = clientRate;
  if (min !== null && rate < min) rate = min;
  if (max !== null && rate > max) rate = max;
  return rate;
}

/**
 * Whole-dollar amount charged to the client for a call: the client rate
 * pro-rated over the billable minutes (15-minute minimum).
 */
export function callChargeDollars(expertRate: number, durationMinutes: number): number {
  const minutes = billableMinutes(durationMinutes);
  if (minutes === 0) return 0;
  return Math.round((clientRateFor(expertRate) * minutes) / 60);
}

/**
 * Whole-dollar payout to the expert for a call: the rate the expert accepted,
 * pro-rated over the same billable minutes the client was charged for.
 */
export function expertPayoutDollars(expertRate: number, durationMinutes: number): number {
  const minutes = billableMinutes(durationMinutes);
  if (minutes === 0 || !Number.isFinite(expertRate) || expertRate <= 0) return 0;
  return Math.round((expertRate * minutes) / 60);
}

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

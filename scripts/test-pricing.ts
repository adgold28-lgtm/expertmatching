// scripts/test-pricing.ts — unit tests for lib/pricing.ts, the single source of
// truth for seat pricing and the expert/platform call split.
//
// Pure functions only: no Stripe, no database, no env vars needed.
//
//   npx tsx scripts/test-pricing.ts
//
// Exits non-zero on the first failing assertion set, so it can gate a deploy.

import {
  SEAT_TIERS,
  SEAT_PRICE_LOOKUP_KEY,
  SEAT_PRODUCT_NAME,
  SEAT_CURRENCY,
  EXPERT_SHARE,
  PLATFORM_SHARE,
  normalizeSeatCount,
  seatTierFor,
  seatUnitPriceCents,
  monthlySeatTotalCents,
  nextSeatTier,
  stripeVolumeTiers,
  splitCallAmountCents,
  formatUsdFromCents,
} from '../lib/pricing';

let failures = 0;
let checks   = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── Tier boundaries ──────────────────────────────────────────────────────────
// Volume pricing: EVERY seat is billed at the tier the total falls into.

section('seat unit price at every tier boundary');

const UNIT_PRICE_CASES: Array<[seats: number, cents: number]> = [
  [0,    0],       // no seats, no charge
  [1,    100_00],
  [9,    100_00],
  [10,    90_00],
  [24,    90_00],
  [25,    85_00],
  [49,    85_00],
  [50,    75_00],
  [99,    75_00],
  [100,   70_00],
  [149,   70_00],
  [150,   60_00],
  [151,   60_00],
  [1000,  60_00],
];

for (const [seats, cents] of UNIT_PRICE_CASES) {
  eq(`seatUnitPriceCents(${seats})`, seatUnitPriceCents(seats), cents);
}

// The tier object itself must agree with the unit price.
for (const [seats, cents] of UNIT_PRICE_CASES) {
  const tier = seatTierFor(seats);
  if (seats === 0) {
    eq('seatTierFor(0) is null', tier, null);
  } else {
    check(`seatTierFor(${seats}) matches unit price`, tier?.unitPriceCents === cents,
      `tier ${JSON.stringify(tier)}`);
    check(`seatTierFor(${seats}) contains ${seats}`,
      !!tier && seats >= tier.minSeats && (tier.maxSeats === null || seats <= tier.maxSeats));
  }
}

// ── Monthly totals ───────────────────────────────────────────────────────────

section('monthly totals (volume, not graduated)');

const TOTAL_CASES: Array<[seats: number, cents: number]> = [
  [0,      0],
  [1,      100_00],
  [9,      900_00],
  [10,     900_00],      // 10 × $90 — the same bill as 9 × $100
  [24,   2_160_00],
  [25,   2_125_00],      // crossing to $85 lowers the bill despite +1 seat
  [49,   4_165_00],
  [50,   3_750_00],
  [99,   7_425_00],
  [100,  7_000_00],
  [149, 10_430_00],
  [150,  9_000_00],
  [151,  9_060_00],
  [1000, 60_000_00],
];

for (const [seats, cents] of TOTAL_CASES) {
  eq(`monthlySeatTotalCents(${seats})`, monthlySeatTotalCents(seats), cents);
}

// Graduated pricing would charge more than volume at every boundary; assert the
// defining property directly: total === seats × unit price of the whole count.
for (const [seats] of TOTAL_CASES) {
  eq(`total(${seats}) === seats × unit(${seats})`,
    monthlySeatTotalCents(seats), seats * seatUnitPriceCents(seats));
}

// Adding a seat at each tier's first index must never raise the bill.
for (const tier of SEAT_TIERS) {
  if (tier.minSeats === 1) continue;
  const before = monthlySeatTotalCents(tier.minSeats - 1);
  const after  = monthlySeatTotalCents(tier.minSeats);
  check(`crossing into the ${tier.minSeats}+ tier never raises the bill`, after <= before,
    `${before} → ${after}`);
}

// ── normalizeSeatCount ───────────────────────────────────────────────────────

section('normalizeSeatCount');

eq('normalizeSeatCount(0)',        normalizeSeatCount(0),        0);
eq('normalizeSeatCount(-5)',       normalizeSeatCount(-5),       0);
eq('normalizeSeatCount(3.7)',      normalizeSeatCount(3.7),      3);
eq('normalizeSeatCount(NaN)',      normalizeSeatCount(Number.NaN), 0);
eq('normalizeSeatCount(Infinity)', normalizeSeatCount(Number.POSITIVE_INFINITY), 0);
eq('normalizeSeatCount(42)',       normalizeSeatCount(42),       42);

// ── nextSeatTier ─────────────────────────────────────────────────────────────

section('nextSeatTier');

eq('nextSeatTier(0).minSeats',   nextSeatTier(0)?.minSeats,   1);
eq('nextSeatTier(1).minSeats',   nextSeatTier(1)?.minSeats,   10);
eq('nextSeatTier(9).minSeats',   nextSeatTier(9)?.minSeats,   10);
eq('nextSeatTier(10).minSeats',  nextSeatTier(10)?.minSeats,  25);
eq('nextSeatTier(24).minSeats',  nextSeatTier(24)?.minSeats,  25);
eq('nextSeatTier(25).minSeats',  nextSeatTier(25)?.minSeats,  50);
eq('nextSeatTier(99).minSeats',  nextSeatTier(99)?.minSeats,  100);
eq('nextSeatTier(100).minSeats', nextSeatTier(100)?.minSeats, 150);
eq('nextSeatTier(149).minSeats', nextSeatTier(149)?.minSeats, 150);
eq('nextSeatTier(150) is null',  nextSeatTier(150),           null);
eq('nextSeatTier(1000) is null', nextSeatTier(1000),          null);

// The next tier must always be cheaper per seat than the current one.
for (const seats of [1, 9, 10, 24, 25, 49, 50, 99, 100, 149]) {
  const next = nextSeatTier(seats);
  check(`nextSeatTier(${seats}) is cheaper per seat`,
    !!next && next.unitPriceCents < seatUnitPriceCents(seats));
}

// ── stripeVolumeTiers ────────────────────────────────────────────────────────

section('stripeVolumeTiers (Stripe Price mirror)');

const tiers = stripeVolumeTiers();
eq('one Stripe tier per SEAT_TIERS entry', tiers.length, SEAT_TIERS.length);
eq('last tier is the open-ended fallback', tiers[tiers.length - 1]?.up_to, 'inf');

SEAT_TIERS.forEach((tier, i) => {
  const mapped = tiers[i];
  eq(`tier ${i} unit_amount`, mapped?.unit_amount, tier.unitPriceCents);
  eq(`tier ${i} up_to`, mapped?.up_to, tier.maxSeats === null ? 'inf' : tier.maxSeats);
});

// Bounds must ascend and every unit amount must be a positive whole number of
// cents — Stripe rejects fractional or negative amounts.
let previousUpTo = 0;
for (const [i, tier] of tiers.entries()) {
  check(`tier ${i} unit_amount is a positive integer`,
    Number.isInteger(tier.unit_amount) && tier.unit_amount > 0);
  if (tier.up_to === 'inf') {
    check(`tier ${i} 'inf' is last`, i === tiers.length - 1);
  } else {
    check(`tier ${i} up_to ascends`, tier.up_to > previousUpTo, `${previousUpTo} → ${tier.up_to}`);
    previousUpTo = tier.up_to;
  }
}

// Constants the Stripe Price is created with.
eq('SEAT_PRICE_LOOKUP_KEY', SEAT_PRICE_LOOKUP_KEY, 'expertmatch_seat_monthly_v1');
eq('SEAT_PRODUCT_NAME',     SEAT_PRODUCT_NAME,     'ExpertMatch Seat');
eq('SEAT_CURRENCY',         SEAT_CURRENCY,         'usd');

// ── splitCallAmountCents ─────────────────────────────────────────────────────

section('splitCallAmountCents (70/30, exact)');

eq('EXPERT_SHARE + PLATFORM_SHARE === 1', Math.round((EXPERT_SHARE + PLATFORM_SHARE) * 100), 100);

const SPLIT_CASES: Array<[gross: number, expert: number]> = [
  [0,        0],
  [1,        1],       // round(0.7) = 1; platform keeps 0
  [10,       7],
  [50,      35],
  [99,      69],       // round(69.3)
  [100,     70],
  [333,    233],       // round(233.1)
  [1_000,  700],
  [12_345, 8_642],     // round(8641.5) → 8642
  [100_00, 70_00],
  [750_00, 525_00],
];

for (const [gross, expert] of SPLIT_CASES) {
  const split = splitCallAmountCents(gross);
  eq(`split(${gross}).expertCents`, split.expertCents, expert);
  eq(`split(${gross}).grossCents`,  split.grossCents,  gross);
  eq(`split(${gross}) sums exactly`, split.expertCents + split.platformCents, gross);
}

// Exhaustive: the parts must sum to the gross for every amount up to $50, with
// no cent created or lost by rounding.
for (let cents = 0; cents <= 5_000; cents++) {
  const { expertCents, platformCents, grossCents } = splitCallAmountCents(cents);
  if (expertCents + platformCents !== cents || grossCents !== cents) {
    check(`split(${cents}) sums exactly`, false,
      `${expertCents} + ${platformCents} != ${cents}`);
    break;
  }
  if (expertCents < 0 || platformCents < 0) {
    check(`split(${cents}) has no negative part`, false);
    break;
  }
}
check('split sums exactly for 0…5000 cents', true);

// Junk input is treated as zero, never NaN.
eq('split(-100).grossCents',      splitCallAmountCents(-100).grossCents, 0);
eq('split(-100).expertCents',     splitCallAmountCents(-100).expertCents, 0);
eq('split(NaN).grossCents',       splitCallAmountCents(Number.NaN).grossCents, 0);
eq('split(NaN).platformCents',    splitCallAmountCents(Number.NaN).platformCents, 0);
eq('split(10.4) rounds the gross', splitCallAmountCents(10.4).grossCents, 10);

// ── formatUsdFromCents ───────────────────────────────────────────────────────

section('formatUsdFromCents');

eq('formatUsdFromCents(0)',        formatUsdFromCents(0),        '$0');
eq('formatUsdFromCents(100)',      formatUsdFromCents(100),      '$1');
eq('formatUsdFromCents(150)',      formatUsdFromCents(150),      '$1.50');
eq('formatUsdFromCents(10000)',    formatUsdFromCents(100_00),   '$100');
eq('formatUsdFromCents(123450)',   formatUsdFromCents(1_234_50), '$1,234.50');
eq('formatUsdFromCents(123400)',   formatUsdFromCents(1_234_00), '$1,234');
eq('formatUsdFromCents(6000)',     formatUsdFromCents(60_00),    '$60');
eq('formatUsdFromCents(6_000_000)', formatUsdFromCents(60_000_00), '$60,000');

// The seat prices as the onboarding step renders them.
eq('per-seat label at 1 seat',   formatUsdFromCents(seatUnitPriceCents(1)),   '$100');
eq('per-seat label at 150 seats', formatUsdFromCents(seatUnitPriceCents(150)), '$60');

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);

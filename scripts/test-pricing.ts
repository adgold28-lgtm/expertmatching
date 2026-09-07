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
  billableMinutes,
  clientRateFor,
  expertRateFor,
  CLIENT_RATE_ROUNDING_USD,
  callChargeDollars,
  expertPayoutDollars,
  splitCallAmountCents,
  formatUsdFromCents,
} from '../lib/pricing';
// The one non-pricing import: the helper that keeps the two rate columns in
// step. It is pure and does no I/O, even though its module talks to Postgres.
import { rateFieldsFor } from '../lib/projectStore';

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
  [1,    250_00],
  [5,    250_00],
  [6,    200_00],
  [20,   200_00],
  [21,   200_00],      // "talk to us" tier bills the fallback rate until custom terms
  [1000, 200_00],
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
  [1,        250_00],
  [5,      1_250_00],
  [6,      1_200_00],      // 6 × $200 — cheaper than 5 × $250
  [20,     4_000_00],
  [21,     4_200_00],
  [1000, 200_000_00],
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
  if (tier.minSeats === 1 || tier.contactSales) continue;
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
eq('nextSeatTier(1).minSeats',   nextSeatTier(1)?.minSeats,   6);
eq('nextSeatTier(5).minSeats',   nextSeatTier(5)?.minSeats,   6);
eq('nextSeatTier(6).minSeats',   nextSeatTier(6)?.minSeats,   21);
eq('nextSeatTier(20).minSeats',  nextSeatTier(20)?.minSeats,  21);
eq('nextSeatTier(21) is null',   nextSeatTier(21),            null);
eq('nextSeatTier(1000) is null', nextSeatTier(1000),          null);

// The next priced tier must be cheaper per seat than the current one.
for (const seats of [1, 5]) {
  const next = nextSeatTier(seats);
  check(`nextSeatTier(${seats}) is cheaper per seat`,
    !!next && next.unitPriceCents < seatUnitPriceCents(seats));
}
check('the top tier is the "talk to us" tier', SEAT_TIERS[SEAT_TIERS.length - 1]?.contactSales === true);

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
eq('SEAT_PRICE_LOOKUP_KEY', SEAT_PRICE_LOOKUP_KEY, 'expertmatch_seat_monthly_v2');
eq('SEAT_PRODUCT_NAME',     SEAT_PRODUCT_NAME,     'ExpertMatch Seat');
eq('SEAT_CURRENCY',         SEAT_CURRENCY,         'usd');

// ── splitCallAmountCents ─────────────────────────────────────────────────────

section('splitCallAmountCents (50/50, exact)');

eq('EXPERT_SHARE + PLATFORM_SHARE === 1', Math.round((EXPERT_SHARE + PLATFORM_SHARE) * 100), 100);

const SPLIT_CASES: Array<[gross: number, expert: number]> = [
  [0,        0],
  [1,        1],       // round(0.5) = 1; platform keeps 0
  [10,       5],
  [50,      25],
  [99,      50],       // round(49.5)
  [100,     50],
  [333,    167],       // round(166.5)
  [1_000,  500],
  [12_345, 6_173],     // round(6172.5) → 6173
  [100_00, 50_00],
  [750_00, 375_00],
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
eq('per-seat label at 1 seat',   formatUsdFromCents(seatUnitPriceCents(1)),   '$250');
eq('per-seat label at 20 seats', formatUsdFromCents(seatUnitPriceCents(20)),  '$200');

// ── billableMinutes ──────────────────────────────────────────────────────────

section('billableMinutes (15-minute minimum)');

eq('billableMinutes(0)',    billableMinutes(0),    0);
eq('billableMinutes(1)',    billableMinutes(1),    15);
eq('billableMinutes(14.2)', billableMinutes(14.2), 15);
eq('billableMinutes(15)',   billableMinutes(15),   15);
eq('billableMinutes(15.1)', billableMinutes(15.1), 16);
eq('billableMinutes(47)',   billableMinutes(47),   47);
eq('billableMinutes(NaN)',  billableMinutes(Number.NaN), 0);
eq('billableMinutes(-5)',   billableMinutes(-5),   0);

// ── clientRateFor / callChargeDollars / expertPayoutDollars ─────────────────

section('client rate (expert offer / 0.5, rounded up to $50)');

eq('clientRateFor(400)',  clientRateFor(400),  800);
eq('clientRateFor(650)',  clientRateFor(650),  1300);
eq('clientRateFor(800)',  clientRateFor(800),  1600);
eq('clientRateFor(675)',  clientRateFor(675),  1350);
eq('clientRateFor(660)',  clientRateFor(660),  1350);   // 1320 → up to 1350
eq('clientRateFor(0)',    clientRateFor(0),    0);
eq('clientRateFor(NaN)',  clientRateFor(Number.NaN), 0);

section('call charge and payout over billable minutes');

eq('callChargeDollars(650, 60)',   callChargeDollars(650, 60),   1300);
eq('callChargeDollars(650, 30)',   callChargeDollars(650, 30),   650);
eq('callChargeDollars(650, 10)',   callChargeDollars(650, 10),   325);   // billed as 15 min
eq('callChargeDollars(800, 47)',   callChargeDollars(800, 47),   1253);  // round(1600 × 47 / 60)
eq('callChargeDollars(400, 0)',    callChargeDollars(400, 0),    0);
eq('expertPayoutDollars(650, 60)', expertPayoutDollars(650, 60), 650);
eq('expertPayoutDollars(650, 10)', expertPayoutDollars(650, 10), 163);   // round(650 × 15 / 60)
eq('expertPayoutDollars(0, 60)',   expertPayoutDollars(0, 60),   0);
for (const [rate, min] of [[400, 60], [650, 47], [800, 10], [675, 90]] as const) {
  check(`charge(${rate}, ${min}) ≥ payout(${rate}, ${min})`,
    callChargeDollars(rate, min) >= expertPayoutDollars(rate, min));
}

// ── expertRateFor / rateFieldsFor ───────────────────────────────────────────

section('expert rate is the inverse of the client rate, up to the rounding');

eq('expertRateFor(800)',  expertRateFor(800),  400);
eq('expertRateFor(1300)', expertRateFor(1300), 650);
eq('expertRateFor(1600)', expertRateFor(1600), 800);
eq('expertRateFor(1350)', expertRateFor(1350), 675);
eq('expertRateFor(0)',    expertRateFor(0),    0);
eq('expertRateFor(NaN)',  expertRateFor(Number.NaN), 0);

// clientRateFor rounds the client number UP to the next $50, so a round trip
// can only lose what that rounding added: at most $50 of client money, which is
// CLIENT_RATE_ROUNDING_USD × EXPERT_SHARE of expert money.
const ROUND_TRIP_TOLERANCE = CLIENT_RATE_ROUNDING_USD * EXPERT_SHARE;
for (let x = 100; x <= 2000; x += 50) {
  const roundTrip = expertRateFor(clientRateFor(x));
  check(`expertRateFor(clientRateFor(${x})) within $${ROUND_TRIP_TOLERANCE} of ${x}`,
    Math.abs(roundTrip - x) <= ROUND_TRIP_TOLERANCE,
    `got ${roundTrip}`);
  check(`the round trip never quotes the expert MORE than ${x}`, roundTrip <= x, `got ${roundTrip}`);
}

section('rateFieldsFor writes both numbers or neither');

const seeded = rateFieldsFor(650);
eq('rateFieldsFor(650).expertRate', seeded.expertRate, 650);
eq('rateFieldsFor(650).clientRate', seeded.clientRate, 1300);
eq('rateFieldsFor(649.6) rounds the expert rate', rateFieldsFor(649.6).expertRate, 650);
eq('rateFieldsFor(649.6) derives from the rounded number', rateFieldsFor(649.6).clientRate, 1300);
for (const rate of [400, 650, 675, 800]) {
  const fields = rateFieldsFor(rate);
  check(`rateFieldsFor(${rate}).clientRate === clientRateFor(${rate})`,
    fields.clientRate === clientRateFor(rate), `got ${fields.clientRate}`);
}

// ── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);

/**
 * Provider-agnostic checkout pricing.
 *
 * Turns a CheckoutIntent into a fully-priced order — the single source of
 * truth for what each payment provider charges. Stripe and Square render the
 * `lines` and `extras` into their own line-item shapes; SumUp (which carries
 * no line items) just reads `total`. Centralising this keeps the three
 * providers in lock-step and gives later pricing features one place to plug in.
 */

import { sum, sumOf } from "#fp";
import { feeSubtotalFor, getBookingFeeAmount } from "#shared/booking-fee.ts";
import { largestRemainderAllocation } from "#shared/largest-remainder.ts";
import type {
  CheckoutIntent,
  CheckoutItem,
  ModifierSpec,
} from "#shared/payments.ts";
import { modifierDelta } from "#shared/price-modifier.ts";
import {
  allocateReservationDeposit,
  computeReservationDeposit,
} from "#shared/reservation-amount.ts";

/** One ticket line and the amount charged per unit (deposit- and
 * discount-aware). A single cart item can split into several lines when a
 * discount applies to only some of its units. */
export type PricedLine = {
  item: CheckoutItem;
  /** Per-unit charge in minor units. */
  chargedUnitAmount: number;
  /** How many units this line covers (<= the item's quantity). */
  quantity: number;
};

/** A non-ticket charge line (e.g. the booking fee). Amount is always >= 0. */
export type ExtraLine = {
  /** Stable identifier for the line ("fee", and "mod:<id>"). */
  key: string;
  name: string;
  amount: number;
  quantity: number;
};

/** The reporting amount a modifier actually changed the order by. */
export type ModifierUsageAmount = {
  modifierId: number;
  quantity: number;
  amountApplied: number;
};

/** A fully-priced checkout: ticket lines, extra lines, and the resulting total. */
export type PricedOrder = {
  lines: PricedLine[];
  extras: ExtraLine[];
  modifierUsages: ModifierUsageAmount[];
  /** Sum of all line and extra charges, in minor units. */
  total: number;
  /** The pre-extras item subtotal the booking fee is charged on. */
  fullSubtotal: number;
};

const lineCharge = (line: PricedLine): number =>
  line.chargedUnitAmount * line.quantity;

const extraCharge = (extra: ExtraLine): number => extra.amount * extra.quantity;

/** The booking-fee extra line for a subtotal, or [] when the fee is zero. */
const feeExtras = (fullSubtotal: number): ExtraLine[] => {
  const amount = getBookingFeeAmount(fullSubtotal);
  return amount > 0
    ? [{ amount, key: "fee", name: "Booking fee", quantity: 1 }]
    : [];
};

/** Allocate an amount across positive weights by largest remainder. */
const allocateByLargestRemainder = (
  weights: number[],
  amount: number,
): number[] => largestRemainderAllocation(weights, amount);

/**
 * Spread a discount across per-unit prices by largest remainder: each unit
 * loses its proportional share, and the leftover minor units (from rounding
 * down) go to the largest fractional remainders. Exactly min(amount, total)
 * minor units are removed — nothing is lost to rounding — and no unit drops
 * below zero.
 */
export const allocateDiscount = (units: number[], amount: number): number[] => {
  const total = sum(units);
  const discount = Math.min(Math.max(amount, 0), total);
  if (discount === 0) return units;
  const allocations = allocateByLargestRemainder(units, discount);
  return units.map((unit, index) => unit - allocations[index]!);
};

/** Allocate an amount across positive-weight units by largest remainder.
 * Unlike allocateDiscount, this can allocate more than the original unit
 * weights because reservation deposits may include separate add-on charges. */
const allocateAmount = (weights: number[], amount: number): number[] => {
  const positiveTotal = sum(weights);
  const effectiveWeights = positiveTotal > 0 ? weights : weights.map(() => 1);
  return allocateByLargestRemainder(effectiveWeights, amount);
};

/** The result of applying modifiers: the (possibly split/discounted) ticket
 * lines, the extra charge lines added, and the net total those modifiers
 * contribute (so the booking fee can be charged on the adjusted subtotal). */
type ModifierResult = {
  lines: PricedLine[];
  extras: ExtraLine[];
  modifierUsages: ModifierUsageAmount[];
  modifierTotal: number;
};

/** One charged ticket unit while modifiers are being applied. `orig` is the
 * pre-modifier price (so every modifier reads the original subtotal); `price`
 * is the running charged amount after discounts. */
type WorkUnit = {
  item: CheckoutItem;
  lineIdx: number;
  orig: number;
  price: number;
};

/** Explode priced lines into one work unit per ticket. */
const toUnits = (lines: PricedLine[]): WorkUnit[] =>
  lines.flatMap((line, lineIdx) =>
    Array.from({ length: line.quantity }, () => ({
      item: line.item,
      lineIdx,
      orig: line.chargedUnitAmount,
      price: line.chargedUnitAmount,
    })),
  );

/** Whether a modifier scoped to `listingIds` (null = whole order) covers a unit. */
const inScope = (spec: ModifierSpec, unit: WorkUnit): boolean =>
  spec.listingIds === null || spec.listingIds.includes(unit.item.listingId);

/** Regroup work units back into priced lines: one line per (item, price), in
 * cart order with the highest price first, so a discounted item splits into a
 * full-price line and a discounted line. */
const toLines = (units: WorkUnit[]): PricedLine[] => {
  const lineIdxs = [...new Set(units.map((u) => u.lineIdx))].sort(
    (a, b) => a - b,
  );
  return lineIdxs.flatMap((lineIdx) => {
    const group = units.filter((u) => u.lineIdx === lineIdx);
    const prices = [...new Set(group.map((u) => u.price))].sort(
      (a, b) => b - a,
    );
    return prices.map((price) => ({
      chargedUnitAmount: price,
      item: group[0]!.item,
      quantity: group.filter((u) => u.price === price).length,
    }));
  });
};

/** Convert a modified full-price order into the ticket lines charged up front
 * for a reservation. The configured deposit is calculated once from the final
 * modified subtotal, then allocated back over the booked listing rows so
 * listing_attendees.price_paid can reconcile to the actual upfront deposit. */
const reservationLines = (
  lines: PricedLine[],
  reservationAmount: string,
  fullSubtotal: number,
): PricedLine[] => {
  const units = toUnits(lines);
  const totalQuantity = units.length;
  const deposit = computeReservationDeposit(
    reservationAmount,
    fullSubtotal,
    totalQuantity,
  );
  const allocations = allocateAmount(
    units.map((u) => u.price),
    deposit,
  );
  return toLines(units.map((u, i) => ({ ...u, price: allocations[i]! })));
};

const unmodifiedReservationLines = (
  intent: CheckoutIntent,
  reservationAmount: string,
): PricedLine[] => {
  const allocation = allocateReservationDeposit(
    reservationAmount,
    intent.items,
  );
  return allocation.lines.map((line) => ({
    chargedUnitAmount: line.chargedUnitAmount,
    item: intent.items[line.itemIndex]!,
    quantity: line.quantity,
  }));
};

/** State threaded while applying modifiers one at a time. */
type ModifierPass = {
  units: WorkUnit[];
  extras: ExtraLine[];
  modifierUsages: ModifierUsageAmount[];
  discountTotal: number;
};

/** Apply one modifier: an additive delta becomes an extra line; a negative
 * delta is allocated across the in-scope units as a discount (clamped to what
 * those units can absorb). A zero delta is a no-op. */
const applyOne = (pass: ModifierPass, spec: ModifierSpec): ModifierPass => {
  const scoped = pass.units.filter((u) => inScope(spec, u));
  const delta = modifierDelta(
    sum(scoped.map((u) => u.orig)),
    spec.kind,
    spec.value,
  );
  const withUsage = (
    next: ModifierPass,
    amountApplied: number,
  ): ModifierPass => ({
    ...next,
    modifierUsages: [
      ...pass.modifierUsages,
      {
        amountApplied,
        modifierId: spec.id,
        quantity: spec.quantity,
      },
    ],
  });
  if (delta > 0) {
    return withUsage({
      ...pass,
      extras: [
        ...pass.extras,
        {
          amount: delta,
          key: `mod:${spec.id}`,
          name: spec.name,
          quantity: spec.quantity,
        },
      ],
    }, delta * spec.quantity);
  }
  if (delta === 0) return withUsage(pass, 0);

  const reduced = allocateDiscount(
    scoped.map((u) => u.price),
    -delta,
  );
  let next = 0;
  const units = pass.units.map((u) =>
    inScope(spec, u) ? { ...u, price: reduced[next++]! } : u,
  );
  const applied = sum(scoped.map((u) => u.price)) - sum(reduced);
  return withUsage(
    { ...pass, discountTotal: pass.discountTotal + applied, units },
    applied,
  );
};

/**
 * Apply resolved modifiers to a checkout's priced lines. Each modifier reads
 * the original (pre-modifier) in-scope subtotal, so modifiers never compound on
 * one another. Additive modifiers (surcharges, add-ons) become positive extra
 * lines; discounts reduce the charged ticket lines via exact per-unit
 * allocation, splitting a line when its units end up at different prices.
 */
export const applyModifiers = (
  lines: PricedLine[],
  specs: ModifierSpec[],
): ModifierResult => {
  const pass = specs.reduce(applyOne, {
    discountTotal: 0,
    extras: [],
    modifierUsages: [],
    units: toUnits(lines),
  });
  return {
    extras: pass.extras,
    lines: toLines(pass.units),
    modifierUsages: pass.modifierUsages,
    modifierTotal: sumOf(extraCharge)(pass.extras) - pass.discountTotal,
  };
};

/**
 * Price a checkout intent into provider-agnostic lines, extras, and total.
 * Applies resolved modifiers against the full order, then either charges the
 * full modified lines or, for reservations, allocates the configured deposit
 * across those lines. The booking-fee line is always calculated once from the
 * final modified full subtotal.
 */
export const priceCheckout = (intent: CheckoutIntent): PricedOrder => {
  const modifierSpecs = intent.modifiers ?? [];
  const baseLines: PricedLine[] = intent.items.map((item) => ({
    chargedUnitAmount: item.unitPrice,
    item,
    quantity: item.quantity,
  }));
  const modifiers = applyModifiers(baseLines, modifierSpecs);
  // The booking fee is charged on the full order plus any net modifier change.
  const fullSubtotal = feeSubtotalFor(intent) + modifiers.modifierTotal;
  const lines = intent.reservationAmount
    ? modifierSpecs.length === 0 && intent.feeSubtotal === undefined
      ? unmodifiedReservationLines(intent, intent.reservationAmount)
      : reservationLines(
          modifiers.lines,
          intent.reservationAmount,
          fullSubtotal,
        )
    : modifiers.lines;
  const extras = [
    ...(intent.reservationAmount ? [] : modifiers.extras),
    ...feeExtras(fullSubtotal),
  ];
  return {
    extras,
    fullSubtotal,
    lines,
    modifierUsages: modifiers.modifierUsages,
    total: sumOf(lineCharge)(lines) + sumOf(extraCharge)(extras),
  };
};

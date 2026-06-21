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

/** One modifier's exact contribution to a priced checkout. `amountApplied` is
 * the positive absolute impact for reporting/ledger compatibility; `delta` is
 * the signed net checkout change. */
export type ModifierApplication = {
  modifierId: number;
  quantity: number;
  amountApplied: number;
  delta: number;
  scopedSubtotal: number;
};

/** A fully-priced checkout: ticket lines, extra lines, and the resulting total. */
export type PricedOrder = {
  lines: PricedLine[];
  extras: ExtraLine[];
  modifierApplications: ModifierApplication[];
  /** Sum of all line and extra charges, in minor units. */
  total: number;
  /** The pre-extras item subtotal the booking fee is charged on. */
  fullSubtotal: number;
};

const lineCharge = (line: PricedLine): number =>
  line.chargedUnitAmount * line.quantity;

const extraCharge = (extra: ExtraLine): number => extra.amount * extra.quantity;

export const ticketLineTotal = (order: Pick<PricedOrder, "lines">): number =>
  sumOf(lineCharge)(order.lines);

/** Sum a per-line value, grouped by listing id. Pass {@link lineCharge} for the
 *  amount charged now, or {@link lineListPrice} for the gross list price. */
export const lineTotalsByListingId = (
  lines: PricedLine[],
  amountOf: (line: PricedLine) => number,
): Map<number, number> => {
  const totals = new Map<number, number>();
  for (const line of lines) {
    const id = line.item.listingId;
    totals.set(id, (totals.get(id) ?? 0) + amountOf(line));
  }
  return totals;
};

/** A line's full list price (`unitPrice × quantity`) — gross before modifiers
 *  and before any deposit reduction, for ledger revenue recognition. */
export const lineListPrice = (line: PricedLine): number =>
  line.item.unitPrice * line.quantity;

export const ticketLineTotalsByListingId = (
  order: Pick<PricedOrder, "lines">,
): Map<number, number> => lineTotalsByListingId(order.lines, lineCharge);

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
  applications: ModifierApplication[];
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
  applications: ModifierApplication[];
  discountTotal: number;
};

/** Apply one modifier: an additive delta becomes an extra line; a negative
 * delta is allocated across the in-scope units as a discount (clamped to what
 * those units can absorb). A zero delta still records an application so the
 * ledger and stock consumption stay aligned with the chosen quantity. */
const applyOne = (pass: ModifierPass, spec: ModifierSpec): ModifierPass => {
  const scoped = pass.units.filter((u) => inScope(spec, u));
  const scopedSubtotal = sum(scoped.map((u) => u.orig));
  const delta = modifierDelta(scopedSubtotal, spec.kind, spec.value);
  const appliedDelta = delta * spec.quantity;
  const withApplication = (
    next: ModifierPass,
    amountApplied: number,
    signedDelta: number,
  ): ModifierPass => ({
    ...next,
    applications: [
      ...pass.applications,
      {
        amountApplied,
        delta: signedDelta,
        modifierId: spec.id,
        quantity: spec.quantity,
        scopedSubtotal,
      },
    ],
  });
  if (delta > 0) {
    return withApplication(
      {
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
      },
      appliedDelta,
      appliedDelta,
    );
  }
  if (delta === 0) return withApplication(pass, 0, 0);

  const reduced = allocateDiscount(
    scoped.map((u) => u.price),
    -appliedDelta,
  );
  let next = 0;
  const units = pass.units.map((u) =>
    inScope(spec, u) ? { ...u, price: reduced[next++]! } : u,
  );
  const applied = sum(scoped.map((u) => u.price)) - sum(reduced);
  return withApplication(
    { ...pass, discountTotal: pass.discountTotal + applied, units },
    applied,
    -applied,
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
    applications: [],
    discountTotal: 0,
    extras: [],
    units: toUnits(lines),
  });
  return {
    applications: pass.applications,
    extras: pass.extras,
    lines: toLines(pass.units),
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
    modifierApplications: modifiers.applications,
    total: sumOf(lineCharge)(lines) + sumOf(extraCharge)(extras),
  };
};

export type TicketPaymentBreakdown = {
  paidByListingId: Map<number, number>;
  remainingBalance: number;
};

export const ticketPaymentBreakdown = (
  intent: CheckoutIntent,
): TicketPaymentBreakdown => {
  const paid = priceCheckout(intent);
  const paidByListingId = ticketLineTotalsByListingId(paid);
  if (!intent.reservationAmount) {
    return { paidByListingId, remainingBalance: 0 };
  }

  const remainingBalance = Math.max(
    0,
    paid.fullSubtotal - ticketLineTotal(paid),
  );
  return { paidByListingId, remainingBalance };
};

/**
 * Provider-agnostic checkout pricing.
 *
 * Turns a CheckoutIntent into a fully-priced order — the single source of
 * truth for what each payment provider charges. Stripe and Square render the
 * `lines` and `extras` into their own line-item shapes. SumUp (which carries
 * no line items) just reads `total`. Centralising this keeps the three
 * providers in lock-step and gives later pricing features one place to plug in.
 */

/* jscpd:ignore-start */
import { settings } from "#db/settings.ts";
import { sum, sumByKey, sumOf } from "#fp";
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
import { assessTax, taxBasisLines } from "#shared/tax/assessment.ts";
import type { TaxAssessment, TaxBasis, TaxPolicy } from "#shared/tax/types.ts";
/* jscpd:ignore-end */

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
  name: string;
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
  tax: TaxAssessment;
  /** Sum of all line and extra charges, in minor units. */
  total: number;
};

const lineCharge = (line: PricedLine): number =>
  line.chargedUnitAmount * line.quantity;

const extraCharge = (extra: ExtraLine): number => extra.amount * extra.quantity;

/** Sum a per-line value, grouped by listing id. Pass {@link lineCharge} for the
 *  amount charged now, or {@link lineListPrice} for the gross list price. */
export const lineTotalsByListingId = (
  lines: PricedLine[],
  amountOf: (line: PricedLine) => number,
): Map<number, number> =>
  sumByKey((line: PricedLine) => line.item.listingId, amountOf)(lines);

/** A line's full list price (`unitPrice × quantity`) — gross before modifiers
 *  and before any deposit reduction, for ledger revenue recognition. */
export const lineListPrice = (line: PricedLine): number =>
  line.item.unitPrice * line.quantity;

/** The listing fields a list-price order reads. The shape stays structural so
 *  the pricing module stays free of the heavy `ListingWithCount` import. */
type ListPriceListing = {
  id: number;
  name: string;
  slug: string;
  unit_price: number;
};

/** One bookable line a list-price order prices at the listing's list price. */
export type ListPriceLine = {
  listing: ListPriceListing;
  quantity: number;
  /** Per-unit charge override (a package deal, a free member). It defaults to
   *  the listing's own list price. A stored 0 is a deliberate free line. */
  unitPrice?: number;
};

/** The gross order for a booking an operator records directly. The manual-add
 *  form and the admin JSON API create share it. Every line is at the listing's
 *  list price (or the caller's override), with no extras and a zero total.
 *  `owedOrderForLedger` and `bookingFactsFromOrder` recognise each line's
 *  gross as a `sale` leg (income) with no `payment` or `fee` leg. The caller
 *  reconciles any already-paid portion on top. */
export const listPriceOrder = (
  lines: ListPriceLine[],
  taxPolicy: TaxPolicy = settings.tax,
): PricedOrder => ({
  extras: [],
  lines: lines.map((line): PricedLine => {
    const unitPrice = line.unitPrice ?? line.listing.unit_price;
    return {
      chargedUnitAmount: unitPrice,
      item: {
        listingId: line.listing.id,
        name: line.listing.name,
        quantity: line.quantity,
        slug: line.listing.slug,
        unitPrice,
      },
      quantity: line.quantity,
    };
  }),
  modifierApplications: [],
  tax: assessTax(
    {
      lines: taxBasisLines(
        sumByKey(
          (line: ListPriceLine) => line.listing.id,
          (line: ListPriceLine) =>
            (line.unitPrice ?? line.listing.unit_price) * line.quantity,
        )(lines),
      ),
      modifiers: [],
    },
    taxPolicy,
  ),
  total: 0,
});

/** The fixed basis an order is taxed against: what each listing sold and what
 * its modifiers changed, before any tax. Refunds and attendee saves reuse it,
 * so a re-assessment can never drift from the price the buyer was shown. */
export const taxBasisOfOrder = (
  order: Pick<PricedOrder, "lines" | "modifierApplications">,
): TaxBasis => ({
  lines: taxBasisLines(lineTotalsByListingId(order.lines, lineListPrice)),
  modifiers: order.modifierApplications.map(({ delta, modifierId }) => ({
    delta,
    modifierId,
  })),
});

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
        name: spec.name,
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
  const tax = assessTax(
    taxBasisOfOrder({
      lines: baseLines,
      modifierApplications: modifiers.applications,
    }),
    intent.taxPolicy ?? settings.tax,
  );
  // The booking fee is charged on the full order plus any net modifier change.
  const fullSubtotal = feeSubtotalFor(intent) + modifiers.modifierTotal;
  const lines = intent.reservationAmount
    ? modifierSpecs.length === 0 &&
      intent.feeSubtotal === undefined &&
      tax.policy.mode !== "add_to_total"
      ? unmodifiedReservationLines(intent, intent.reservationAmount)
      : reservationLines(
          modifiers.lines,
          intent.reservationAmount,
          // A percentage deposit follows the configured full-order subtotal
          // when the caller overrides it; otherwise it follows the charged,
          // tax-inclusive total.
          intent.feeSubtotal === undefined ? tax.total : fullSubtotal,
        )
    : modifiers.lines;
  const extras = [
    ...(intent.reservationAmount ? [] : modifiers.extras),
    ...(!intent.reservationAmount &&
    tax.policy.mode === "add_to_total" &&
    tax.taxAmount > 0
      ? [{ amount: tax.taxAmount, key: "vat", name: "VAT", quantity: 1 }]
      : []),
    ...feeExtras(fullSubtotal),
  ];
  return {
    extras,
    lines,
    modifierApplications: modifiers.applications,
    tax,
    total: sumOf(lineCharge)(lines) + sumOf(extraCharge)(extras),
  };
};

export type TicketPaymentBreakdown = {
  /** Each intent item's charged total, keyed by the item OBJECT — a listing
   * booked through two paths is two items, each with its own amount, so each
   * path's booking row records what its own line was charged. */
  paidByItem: Map<CheckoutItem, number>;
  remainingBalance: number;
};

export const ticketPaymentBreakdown = (
  intent: CheckoutIntent,
): TicketPaymentBreakdown => {
  const paid = priceCheckout(intent);
  const paidByItem = new Map<CheckoutItem, number>();
  for (const line of paid.lines) {
    paidByItem.set(
      line.item,
      (paidByItem.get(line.item) ?? 0) + lineCharge(line),
    );
  }
  if (!intent.reservationAmount) {
    return { paidByItem, remainingBalance: 0 };
  }

  const remainingBalance = Math.max(
    0,
    paid.tax.total -
      (paid.total -
        (paid.extras.find((extra) => extra.key === "fee")?.amount ?? 0)),
  );
  return { paidByItem, remainingBalance };
};

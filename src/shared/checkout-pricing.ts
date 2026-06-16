/**
 * Provider-agnostic checkout pricing.
 *
 * Turns a CheckoutIntent into a fully-priced order — the single source of
 * truth for what each payment provider charges. Stripe and Square render the
 * `lines` and `extras` into their own line-item shapes; SumUp (which carries
 * no line items) just reads `total`. Centralising this keeps the three
 * providers in lock-step and gives later pricing features one place to plug in.
 */

import { filter, mapNotNullish, sumOf } from "#fp";
import {
  chargeSubtotal,
  chargeUnitAmount,
  feeSubtotalFor,
  getBookingFeeAmount,
} from "#shared/booking-fee.ts";
import type {
  CheckoutIntent,
  CheckoutItem,
  ModifierSpec,
} from "#shared/payments.ts";
import { modifierDelta } from "#shared/price-modifier.ts";

/** One ticket line plus the amount actually charged per unit (deposit-aware). */
export type PricedLine = {
  item: CheckoutItem;
  /** Per-unit charge in minor units — the full price, or the reservation deposit. */
  chargedUnitAmount: number;
};

/** A non-ticket charge line (e.g. the booking fee). Amount is always >= 0. */
export type ExtraLine = {
  /** Stable identifier for the line ("fee", and later "mod:<id>"). */
  key: string;
  name: string;
  amount: number;
  quantity: number;
};

/** A fully-priced checkout: ticket lines, extra lines, and the resulting total. */
export type PricedOrder = {
  lines: PricedLine[];
  extras: ExtraLine[];
  /** Sum of all line and extra charges, in minor units. */
  total: number;
  /** The pre-extras item subtotal the booking fee is charged on. */
  fullSubtotal: number;
};

const extraCharge = (extra: ExtraLine): number => extra.amount * extra.quantity;

/** The booking-fee extra line for a subtotal, or [] when the fee is zero. */
const feeExtras = (fullSubtotal: number): ExtraLine[] => {
  const amount = getBookingFeeAmount(fullSubtotal);
  return amount > 0
    ? [{ amount, key: "fee", name: "Booking fee", quantity: 1 }]
    : [];
};

/** The result of applying modifiers: the extra lines they add, and the total
 * those lines contribute (so the booking fee can be charged on the higher
 * subtotal). */
type ModifierResult = { extras: ExtraLine[]; modifierTotal: number };

/** The full (pre-deposit) subtotal of the items a modifier is scoped to —
 * the whole order when `listingIds` is null, else just the matching lines. */
const inScopeSubtotal = (
  items: CheckoutItem[],
  listingIds: number[] | null,
): number => {
  const scoped =
    listingIds === null
      ? items
      : filter((i: CheckoutItem) => listingIds.includes(i.listingId))(items);
  return sumOf((i: CheckoutItem) => i.unitPrice * i.quantity)(scoped);
};

/** The extra line a modifier adds, or null when it is not additive (yet). */
const modifierExtra = (
  items: CheckoutItem[],
  spec: ModifierSpec,
): ExtraLine | null => {
  const delta = modifierDelta(
    inScopeSubtotal(items, spec.listingIds),
    spec.kind,
    spec.value,
  );
  return delta > 0
    ? {
        amount: delta,
        key: `mod:${spec.id}`,
        name: spec.name,
        quantity: spec.quantity,
      }
    : null;
};

/**
 * Apply resolved modifiers to a checkout's items, producing the extra charge
 * lines they add. Each modifier reads the original (pre-modifier) in-scope
 * subtotal, so modifiers never compound on one another.
 *
 * Additive modifiers (surcharges and add-ons) become positive extra lines, the
 * same shape as the booking fee. Discounts (a non-positive delta) are not
 * emitted here yet — reducing a charge requires allocating the discount across
 * the ticket lines, which is handled when discount modifiers are introduced.
 */
export const applyModifiers = (
  items: CheckoutItem[],
  specs: ModifierSpec[],
): ModifierResult => {
  const extras = mapNotNullish((spec: ModifierSpec) =>
    modifierExtra(items, spec),
  )(specs);
  return { extras, modifierTotal: sumOf(extraCharge)(extras) };
};

/**
 * Price a checkout intent into provider-agnostic lines, extras, and total.
 * Reproduces the per-line deposit charging (`chargeUnitAmount`) and the
 * booking-fee line that each provider previously built on its own.
 */
export const priceCheckout = (intent: CheckoutIntent): PricedOrder => {
  const lines: PricedLine[] = intent.items.map((item) => ({
    chargedUnitAmount: chargeUnitAmount(intent, item),
    item,
  }));
  const modifiers = applyModifiers(intent.items, intent.modifiers ?? []);
  // The booking fee is charged on the full order plus any surcharges/add-ons.
  const fullSubtotal = feeSubtotalFor(intent) + modifiers.modifierTotal;
  const extras = [...modifiers.extras, ...feeExtras(fullSubtotal)];
  return {
    extras,
    fullSubtotal,
    lines,
    total: chargeSubtotal(intent) + sumOf(extraCharge)(extras),
  };
};

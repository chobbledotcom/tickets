/**
 * Provider-agnostic checkout pricing.
 *
 * Turns a CheckoutIntent into a fully-priced order — the single source of
 * truth for what each payment provider charges. Stripe and Square render the
 * `lines` and `extras` into their own line-item shapes; SumUp (which carries
 * no line items) just reads `total`. Centralising this keeps the three
 * providers in lock-step and gives later pricing features one place to plug in.
 */

import { sumOf } from "#fp";
import {
  chargeSubtotal,
  chargeUnitAmount,
  feeSubtotalFor,
  getBookingFeeAmount,
} from "#shared/booking-fee.ts";
import type { CheckoutIntent, CheckoutItem } from "#shared/payments.ts";

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
  const fullSubtotal = feeSubtotalFor(intent);
  const extras = feeExtras(fullSubtotal);
  return {
    extras,
    fullSubtotal,
    lines,
    total: chargeSubtotal(intent) + sumOf(extraCharge)(extras),
  };
};

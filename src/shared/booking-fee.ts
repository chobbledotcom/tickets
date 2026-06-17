/**
 * Booking fee calculation utility.
 * Used by Stripe, Square, and webhook validation.
 */

import { sumOf } from "#fp";
import { getBookingFee } from "#shared/config.ts";
import { reservationDepositPerUnit } from "#shared/reservation-amount.ts";

/** Calculate the booking fee amount in minor units from a subtotal and percentage. */
export const calculateBookingFee = (
  subtotalMinorUnits: number,
  feePercent: number,
): number => {
  if (feePercent <= 0) return 0;
  return Math.round((subtotalMinorUnits * feePercent) / 100);
};

/** Look up the configured booking fee percentage and calculate the fee for a subtotal. */
export const getBookingFeeAmount = (subtotalMinorUnits: number): number =>
  calculateBookingFee(subtotalMinorUnits, getBookingFee());

/** Calculate cart subtotal from items with unitPrice and quantity. */
export const itemsSubtotal = (
  items: ReadonlyArray<{ unitPrice: number; quantity: number }>,
): number =>
  sumOf(
    (i: { unitPrice: number; quantity: number }) => i.unitPrice * i.quantity,
  )(items);

/**
 * The subtotal the booking fee is charged on: an explicit `feeSubtotal`
 * override (used by reservation deposits — fee on the full order — and balance
 * payments — no fee) or the item subtotal otherwise.
 */
export const feeSubtotalFor = (intent: {
  items: ReadonlyArray<{ unitPrice: number; quantity: number }>;
  feeSubtotal?: number;
}): number => intent.feeSubtotal ?? itemsSubtotal(intent.items);

/** Total quantity across all checkout items. */
const totalQuantity = (items: ReadonlyArray<{ quantity: number }>): number =>
  sumOf((i: { quantity: number }) => i.quantity)(items);

/** Shape a checkout intent must satisfy for deposit-aware charging. */
type ChargeableIntent = {
  items: ReadonlyArray<{ unitPrice: number; quantity: number }>;
  reservationAmount?: string;
};

/**
 * The unit price a checkout line is actually charged. For a reservation
 * (intent.reservationAmount set) this is the per-unit deposit; otherwise the
 * full unit price. Providers charge this so the customer pays only the deposit
 * up front while metadata still records the full price.
 */
export const chargeUnitAmount = (
  intent: ChargeableIntent,
  item: { unitPrice: number; quantity: number },
): number =>
  intent.reservationAmount
    ? reservationDepositPerUnit(
        intent.reservationAmount,
        item.unitPrice,
        totalQuantity(intent.items),
      )
    : item.unitPrice;

/**
 * Booking fee calculation utility.
 * Used by Stripe, Square, and webhook validation.
 */

import { sumOf } from "#fp";
import { getBookingFee } from "#shared/config.ts";

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

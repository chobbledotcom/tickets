/**
 * Booking fee calculation utility.
 * Used by Stripe, Square, and webhook validation.
 */

import { getBookingFee } from "#lib/config.ts";

/** Calculate the booking fee amount in minor units from a subtotal and percentage. */
export const calculateBookingFee = (
  subtotalMinorUnits: number,
  feePercent: number,
): number => {
  if (feePercent <= 0) return 0;
  return Math.round((subtotalMinorUnits * feePercent) / 100);
};

/** Look up the configured booking fee percentage and calculate the fee for a subtotal. */
export const getBookingFeeAmount = async (
  subtotalMinorUnits: number,
): Promise<number> =>
  calculateBookingFee(subtotalMinorUnits, await getBookingFee());

/** Calculate cart subtotal from items with unitPrice and quantity. */
export const itemsSubtotal = (
  items: ReadonlyArray<{ unitPrice: number; quantity: number }>,
): number => items.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);

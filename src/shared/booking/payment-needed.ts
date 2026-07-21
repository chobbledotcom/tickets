/** Whether a booking must open a payment checkout for its configured price. */
export const bookingNeedsPayment = (
  paymentsEnabled: boolean,
  unitPrice: number,
  customUnitPrice?: number,
): boolean =>
  paymentsEnabled &&
  (unitPrice > 0 || (customUnitPrice !== undefined && customUnitPrice > 0));

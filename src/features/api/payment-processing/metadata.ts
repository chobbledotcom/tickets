import type { BookingPayment } from "#routes/api/webhook-types.ts";

/** The provider's payment time, normalized at its read boundary. */
export const businessTime = (payment: BookingPayment): string =>
  payment.createdAt;

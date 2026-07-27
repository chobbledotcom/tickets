import type { BookingPayment } from "#routes/api/webhook-types.ts";
import type { BookingIntent, BookingItem } from "#shared/payments.ts";

export const bookingIntent = (
  items: BookingItem[],
  overrides: Partial<Omit<BookingIntent, "items">> = {},
): BookingIntent => ({
  address: "",
  date: null,
  email: "buyer@example.com",
  items,
  modifiers: [],
  name: "Buyer",
  phone: "",
  special_instructions: "",
  ...overrides,
});

export const paymentSession = (
  id: string,
  amountTotal: number,
): BookingPayment => ({
  amountTotal,
  createdAt: "2026-07-01T12:00:00.000Z",
  id,
  paymentReference: `pi_${id}`,
});

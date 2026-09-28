import { assert } from "@std/assert";
import { expect } from "@std/expect";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { stageCheckoutAnswers } from "#db/checkout-pending-answers.ts";
import { execute } from "#db/client.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import type { CreatedEntry } from "#routes/api/payment-processing/create.ts";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import type {
  PaymentResult,
  ValidatedSession,
} from "#routes/api/webhook-types.ts";
import type { BookingIntent, BookingItem } from "#shared/booking-intent.ts";
import type { ValidatedPaymentSession } from "#shared/payments.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { webhookMeta } from "#test-utils/factories.ts";
import { expectSessionFailed } from "#test-utils/processed-payments.ts";

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
  intent: BookingIntent,
): ValidatedPaymentSession => ({
  amountTotal,
  createdAt: "2026-07-01T12:00:00.000Z",
  currency: "GBP",
  id,
  metadata: webhookMeta({
    email: intent.email,
    items: JSON.stringify(intent.items),
    name: intent.name,
  }),
  paymentReference: `pi_${id}`,
  paymentStatus: "paid",
  provider: "stripe",
});

export const trustedPayment = (
  id: string,
  intent: BookingIntent,
  amountTotal: number,
): ValidatedSession => ({
  intent,
  session: paymentSession(id, amountTotal, intent),
  verdict: { agreed: amountTotal, verdict: "trusted" },
});

export const singleListingPayment = async (
  id: string,
  unitPrice: number,
  paidPrice = unitPrice,
): Promise<{
  data: ValidatedSession;
  listing: Awaited<ReturnType<typeof createTestListing>>;
}> => {
  const listing = await createTestListing({ maxAttendees: 5, unitPrice });
  // Every real checkout stages its marker row at creation; driving the paid
  // session directly must do the same or the tail refuses it.
  await stageCheckoutAnswers(id, undefined, [
    { answers: [], listingId: listing.id },
  ]);
  return {
    data: trustedPayment(
      id,
      bookingIntent([{ e: listing.id, p: paidPrice, q: 1 }]),
      paidPrice,
    ),
    listing,
  };
};

export const ledgeredPaymentWithoutReservation = async (
  id: string,
  unitPrice: number,
): Promise<
  Awaited<ReturnType<typeof singleListingPayment>> & {
    attendeeId: number;
  }
> => {
  const payment = await singleListingPayment(id, unitPrice);
  const first = await processPaymentSession(id, payment.data);
  assert(first.success, "Expected first payment to succeed");
  await execute("DELETE FROM processed_payments WHERE payment_session_id = ?", [
    id,
  ]);
  return { ...payment, attendeeId: first.attendee.id };
};

export const expectStoredRefund = async (
  result: PaymentResult,
  expected: { detail: string; listingId: number; sessionId: string },
  refund: { calls: unknown[] },
): Promise<void> => {
  expect(result.success).toBe(false);
  assert(!result.success, "Expected a stored refund");
  expect(result.detail).toBe(expected.detail);
  expect(result.refunded).toBe(true);
  expect((await getAttendeesRaw(expected.listingId))[0]?.quantity).toBe(0);
  expect(refund.calls).toHaveLength(1);
  await expectSessionFailed(expected.sessionId);
};

/** One booked line, as the code that writes the booking hands it on. */
export const bookedLine = async (
  name: string,
): Promise<{ attendeeId: number; entry: CreatedEntry; listingId: number }> => {
  const listing = await createTestListing({
    maxAttendees: 50,
    name,
    unitPrice: 1000,
  });
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    "Booked",
    `${listing.slug}@example.com`,
  );
  const loaded = await getListingWithCount(listing.id);
  return {
    attendeeId: attendee.id,
    entry: { attendee, listing: loaded! } as CreatedEntry,
    listingId: listing.id,
  };
};

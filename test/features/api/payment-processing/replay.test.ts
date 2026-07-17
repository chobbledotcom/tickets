import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleReservationConflict } from "#routes/api/payment-processing/replay.ts";
import type { BookingIntent } from "#routes/api/webhook-types.ts";
import type { ProcessedPayment } from "#shared/db/processed-payments.ts";

const intent = {
  items: [{ e: 17 }, { e: 18 }],
} as BookingIntent;

const payment = (attendeeId: number | null): ProcessedPayment => ({
  attendee_id: attendeeId,
  failure_data: "",
  payment_reference: "",
  payment_session_id: "session",
  processed_at: "2026-07-17T00:00:00.000Z",
  provider_refunded_at: "",
  ticket_tokens: "",
});

test("reservation conflict returns the first listing and existing attendee", async () => {
  expect(await handleReservationConflict(intent, payment(42))).toMatchObject({
    attendee: { id: 42 },
    listingId: 17,
    success: true,
  });
});

test("unresolved reservation conflict returns the retry message and status", async () => {
  expect(await handleReservationConflict(intent, payment(null))).toEqual({
    error: "Payment is being processed. Please wait a moment and refresh.",
    status: 409,
    success: false,
  });
});

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleReservationConflict } from "#routes/api/payment-processing/replay.ts";
import type { BookingIntent } from "#routes/api/webhook-types.ts";
import { encrypt } from "#shared/crypto/encryption.ts";
import type { ProcessedPayment } from "#shared/db/processed-payments.ts";
import { describeWithEnv } from "#test-utils/db.ts";

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

describeWithEnv("payment replay conflicts", { db: true }, () => {
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

  for (const [refunded, refundStatus] of [
    [true, "refunded"],
    [false, "failed"],
    [undefined, undefined],
  ] as const) {
    test(`replays the stored ${String(refunded)} refund state`, async () => {
      const existing = payment(null);
      existing.failure_data = await encrypt(
        JSON.stringify({ error: "Stored failure", refunded, status: 409 }),
      );
      expect(await handleReservationConflict(intent, existing)).toEqual({
        error: "Stored failure",
        refundStatus,
        status: 409,
        success: false,
      });
    });
  }
});

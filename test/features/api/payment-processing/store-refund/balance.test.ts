import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { settleBalanceSession } from "#routes/api/payment-processing/store-refund.ts";
import { reserveSession } from "#shared/db/processed-payments.ts";
import { stripePaymentProvider } from "#shared/stripe-provider.ts";
import { createReservedAttendee } from "#test-utils/balance.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { webhookMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";

const payment = (id: string, amountTotal: number) => ({
  amountTotal,
  createdAt: "2026-07-18T00:00:00.000Z",
  id,
  metadata: webhookMeta({ name: "Buyer" }),
  paymentReference: `payment-${id}`,
  paymentStatus: "paid" as const,
});

describeWithEnv("balance payment storage", { db: true }, () => {
  test("settles the exact signed balance", async () => {
    const { attendeeId, listingId } = await createReservedAttendee(1500);
    expect((await reserveSession("balance-success")).reserved).toBe(true);
    expect(
      await settleBalanceSession(
        "balance-success",
        payment("balance-success", 1500),
        {
          address: "",
          balanceAttendeeId: attendeeId,
          date: null,
          email: "buyer@example.com",
          items: [{ e: listingId, p: 1500, q: 1 }],
          modifiers: [],
          name: "Buyer",
          phone: "",
          special_instructions: "",
        },
      ),
    ).toEqual({
      attendee: { id: attendeeId },
      listingId,
      success: true,
      ticketTokens: [],
    });
  });

  test("refunds when the live balance differs from the signed amount", async () => {
    await setupStripe();
    const { attendeeId, listingId } = await createReservedAttendee(1500);
    using _refund = stub(stripePaymentProvider, "refundPayment", () =>
      Promise.resolve("refunded"),
    );
    const result = await settleBalanceSession(
      "balance-stale",
      payment("balance-stale", 1400),
      {
        address: "",
        balanceAttendeeId: attendeeId,
        date: null,
        email: "buyer@example.com",
        items: [{ e: listingId, p: 1400, q: 1 }],
        modifiers: [],
        name: "Buyer",
        phone: "",
        special_instructions: "",
      },
    );
    expect(result).toMatchObject({
      error:
        "The outstanding balance for this booking changed while you were paying.",
      refundStatus: "refunded",
      status: 409,
      success: false,
    });
  });
});

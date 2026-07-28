import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { encrypt } from "#shared/crypto/encryption.ts";
import {
  isTerminalLegacyPayment,
  legacyPaymentResult,
} from "#shared/payment-runtime/legacy-replay.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { legacyProcessedPayment, legacyReplay } from "./fixtures.ts";

/** An old payment carrying one "we already dealt with this" row. */
const dealtWith = (values: Parameters<typeof legacyProcessedPayment>[0]) =>
  legacyReplay({ processedPayment: legacyProcessedPayment(values) });

describeWithEnv("what an old payment says it already did", { db: true }, () => {
  test("says nothing was dealt with when there is no record of it", () => {
    expect(isTerminalLegacyPayment(legacyReplay())).toBe(false);
  });

  test("says nothing was dealt with when the record is blank", () => {
    // The row exists but names no booking, no failure and no refund, so the
    // payment was still in flight when the upgrade copied it across.
    expect(isTerminalLegacyPayment(dealtWith({}))).toBe(false);
  });

  // Any one of these three on its own settles the payment.
  for (const [what, build] of [
    ["a booking was made", () => ({ attendeeId: 42, listingId: 7 })],
    ["it failed", async () => ({ failureData: await encrypt("failed") })],
    [
      "it was refunded",
      () => ({
        paymentReference: "hyb:1:legacy-reference",
        providerRefundedAt: "2026-07-25T10:02:00.000Z",
      }),
    ],
  ] as const) {
    test(`says it was dealt with when ${what}`, async () => {
      expect(isTerminalLegacyPayment(dealtWith(await build()))).toBe(true);
    });
  }
});

describeWithEnv("replaying what an old payment ended as", { db: true }, () => {
  test("refuses a payment with no record of being dealt with", async () => {
    await expect(legacyPaymentResult(legacyReplay())).rejects.toThrow(
      "has no terminal result",
    );
  });

  test("refuses a payment whose record says nothing happened", async () => {
    await expect(legacyPaymentResult(dealtWith({}))).rejects.toThrow(
      "is not terminal",
    );
  });

  test("hands back the booking, with the tickets it was given", async () => {
    const payment = dealtWith({
      attendeeId: 42,
      listingId: 7,
      ticketTokens: await encrypt("ticket-one+ticket-two"),
    });

    expect(await legacyPaymentResult(payment)).toEqual({
      attendee: { id: 42 },
      listingId: 7,
      success: true,
      ticketTokens: ["ticket-one", "ticket-two"],
    });
  });

  test("hands back a booking with no tickets when none were kept", async () => {
    expect(
      await legacyPaymentResult(dealtWith({ attendeeId: 42, listingId: 7 })),
    ).toMatchObject({ ticketTokens: [] });
  });

  test("hands back no tickets when what was kept unlocks to nothing", async () => {
    // An empty run of tickets was still written down and locked away. It
    // unlocks to nothing, which means the booking has no tickets.
    const payment = dealtWith({
      attendeeId: 42,
      listingId: 7,
      ticketTokens: await encrypt(""),
    });

    expect(await legacyPaymentResult(payment)).toMatchObject({
      ticketTokens: [],
    });
  });

  test("falls back to the tickets held with the half-finished checkout", async () => {
    // The tickets were written against the checkout before the booking row
    // caught up, so that is where the replay has to read them from.
    const payment = legacyReplay({
      checkoutStage: {
        attendeeId: 42,
        createdAt: "2026-07-25T10:00:00.000Z",
        paymentSessionId: "legacy-session",
        provider: "stripe",
        state: "pending",
        ticketTokens: await encrypt("stage-ticket"),
      },
      processedPayment: legacyProcessedPayment({
        attendeeId: 42,
        listingId: 7,
      }),
    });

    expect(await legacyPaymentResult(payment)).toMatchObject({
      ticketTokens: ["stage-ticket"],
    });
  });

  test("hands back the failure the buyer was shown, with its code", async () => {
    const payment = dealtWith({
      failureData: await encrypt(
        JSON.stringify({ error: "The booking sold out.", status: 409 }),
      ),
    });

    expect(await legacyPaymentResult(payment)).toEqual({
      error: "The booking sold out.",
      status: 409,
      success: false,
    });
  });

  test("hands back a failure with no code when none was written down", async () => {
    const payment = dealtWith({
      failureData: await encrypt(JSON.stringify({ error: "Payment refused." })),
    });

    expect(await legacyPaymentResult(payment)).toEqual({
      error: "Payment refused.",
      success: false,
    });
  });

  test("says a refunded payment was refunded", async () => {
    expect(
      await legacyPaymentResult(
        dealtWith({
          paymentReference: "hyb:1:legacy-reference",
          providerRefundedAt: "2026-07-25T10:02:00.000Z",
        }),
      ),
    ).toEqual({
      error: "This payment has been refunded.",
      status: 200,
      success: false,
    });
  });
});

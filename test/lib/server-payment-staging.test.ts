import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { getDb } from "#shared/db/client.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { settings } from "#shared/db/settings.ts";
import { assembleCheckoutMetadata } from "#shared/payment-helpers.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { expectRedirect } from "#test-utils/assertions.ts";
import { stubCheckout } from "#test-utils/checkout.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";

const paidReturn = async (
  sessionId: string,
  intent: Parameters<typeof assembleCheckoutMetadata>[1],
  total: number,
): Promise<Response> => {
  using _retrieve = stubRetrieveCheckoutSession({
    amountTotal: total,
    metadata: await assembleCheckoutMetadata("stripe", intent, total),
    paymentIntent: `pi_${sessionId}`,
    sessionId,
  });
  return handleRequest(mockRequest(`/payment/success?session_id=${sessionId}`));
};

const stubSuccessfulRefund = (refundId: string) =>
  stub(stripeApi, "refundPayment", () =>
    Promise.resolve({ id: refundId } as unknown as Awaited<
      ReturnType<typeof stripeApi.refundPayment>
    >),
  );

const expectStage = async (
  sessionId: string,
  state: string,
  quantity: number,
): Promise<void> => {
  const result = await getDb().execute(
    `SELECT stage.state, booking.quantity
     FROM checkout_stages AS stage
     JOIN listing_attendees AS booking
       ON booking.attendee_id = stage.attendee_id
     WHERE stage.payment_session_id = ?`,
    [sessionId],
  );
  expect(result.rows.map((row) => [row.state, row.quantity])).toEqual([
    [state, quantity],
  ]);
};

describeWithEnv("paid checkout staging", { db: true }, () => {
  afterEach(() => resetStripeClient());

  test("claims the staged order only after Stripe confirms payment", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 2,
      maxQuantity: 2,
      unitPrice: 1000,
    });
    const { checkout, getCaptured } = stubCheckout("cs_staged_order");

    try {
      const response = await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "2",
        email: "stage@example.com",
        name: "Stage Buyer",
      });
      expectRedirect(response, "https://stripe.example/checkout");

      const rows = await getDb().execute({
        args: ["cs_staged_order"],
        sql: `SELECT stage.attendee_id, booking.quantity
              FROM checkout_stages AS stage
              JOIN listing_attendees AS booking
                ON booking.attendee_id = stage.attendee_id
              WHERE stage.payment_session_id = ?`,
      });
      expect(rows.rows.length).toBe(1);
      expect(Number(rows.rows[0]!.quantity)).toBe(0);
      const stagedAttendeeId = Number(rows.rows[0]!.attendee_id);

      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");
      const retrieve = stubRetrieveCheckoutSession({
        amountTotal: 2000,
        metadata: await assembleCheckoutMetadata("stripe", intent, 2000),
        paymentIntent: "pi_staged_order",
        sessionId: "cs_staged_order",
      });
      try {
        const paid = await handleRequest(
          mockRequest("/payment/success?session_id=cs_staged_order"),
        );
        expectRedirect(paid, /^\/payment\/success\?tokens=.+$/);

        const activated = await getDb().execute({
          args: ["cs_staged_order"],
          sql: `SELECT stage.attendee_id, stage.state, booking.quantity
                FROM checkout_stages AS stage
                JOIN listing_attendees AS booking
                  ON booking.attendee_id = stage.attendee_id
                WHERE stage.payment_session_id = ?`,
        });
        expect(
          activated.rows.map((row) => [
            row.attendee_id,
            row.state,
            row.quantity,
          ]),
        ).toEqual([[stagedAttendeeId, "booked", 2]]);
      } finally {
        retrieve.restore();
      }
    } finally {
      checkout.restore();
    }
  });

  test("keeps the same quantity-zero order when capacity is gone after payment", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 1000,
    });
    const { checkout, getCaptured } = stubCheckout("cs_staged_full");
    const refund = stubSuccessfulRefund("re_staged_full");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "late@example.com",
        name: "Late Buyer",
      });
      const staged = await getDb().execute(
        "SELECT attendee_id FROM checkout_stages WHERE payment_session_id = ?",
        ["cs_staged_full"],
      );
      const stagedAttendeeId = Number(staged.rows[0]!.attendee_id);
      const filler = await bookAttendee(listing, {
        email: "filler@example.com",
        name: "Filler",
      });
      if (!filler.success) throw new Error("Expected filler booking");

      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");
      const retrieve = stubRetrieveCheckoutSession({
        amountTotal: 1000,
        metadata: await assembleCheckoutMetadata("stripe", intent, 1000),
        paymentIntent: "pi_staged_full",
        sessionId: "cs_staged_full",
      });
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_staged_full"),
        );
        expect(await response.text()).toContain("automatically refunded");

        const retained = await getDb().execute({
          args: ["cs_staged_full"],
          sql: `SELECT stage.attendee_id, stage.state, booking.quantity
                FROM checkout_stages AS stage
                JOIN listing_attendees AS booking
                  ON booking.attendee_id = stage.attendee_id
                WHERE stage.payment_session_id = ?`,
        });
        expect(
          retained.rows.map((row) => [
            row.attendee_id,
            row.state,
            row.quantity,
          ]),
        ).toEqual([[stagedAttendeeId, "failed", 0]]);
        expect(refund.calls.length).toBe(1);
      } finally {
        retrieve.restore();
      }
    } finally {
      checkout.restore();
      refund.restore();
    }
  });

  test("keeps the staged order at zero when an extra sells out", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 2,
      unitPrice: 1000,
    });
    const modifier = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "charge",
      name: "Limited extra",
      stock: 1,
    });
    const { checkout, getCaptured } = stubCheckout("cs_staged_extra");
    const refund = stubSuccessfulRefund("re_staged_extra");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "extra@example.com",
        name: "Extra Buyer",
      });
      await getDb().execute({
        args: [modifier.id],
        sql: `INSERT INTO modifier_usages
                (modifier_id, attendee_id, quantity, amount_applied, created)
              VALUES (?, 999999, 1, 100, '2026-07-12T00:00:00.000Z')`,
      });
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");
      const total = priceCheckout(intent).total;
      const retrieve = stubRetrieveCheckoutSession({
        amountTotal: total,
        metadata: await assembleCheckoutMetadata("stripe", intent, total),
        paymentIntent: "pi_staged_extra",
        sessionId: "cs_staged_extra",
      });
      try {
        const response = await handleRequest(
          mockRequest("/payment/success?session_id=cs_staged_extra"),
        );
        expect(await response.text()).toContain("automatically refunded");
        await expectStage("cs_staged_extra", "failed", 0);
        expect(refund.calls.length).toBe(1);
      } finally {
        retrieve.restore();
      }
    } finally {
      checkout.restore();
      refund.restore();
    }
  });

  test("fails loudly when a staged row was activated outside payment", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_active");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "active@example.com",
        name: "Active Buyer",
      });
      await getDb().execute(
        `UPDATE listing_attendees SET quantity = 1
         WHERE attendee_id = (SELECT attendee_id FROM checkout_stages
                              WHERE payment_session_id = ?)`,
        ["cs_staged_active"],
      );
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

      const response = await paidReturn("cs_staged_active", intent, 1000);
      expect(response.status).toBe(400);
      await expectStage("cs_staged_active", "pending", 1);
    } finally {
      checkout.restore();
    }
  });

  test("fails loudly when the staged booking paths changed", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_changed");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "changed@example.com",
        name: "Changed Buyer",
      });
      await getDb().execute(
        `UPDATE listing_attendees SET package_group_id = 999999
         WHERE attendee_id = (SELECT attendee_id FROM checkout_stages
                              WHERE payment_session_id = ?)`,
        ["cs_staged_changed"],
      );
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

      const response = await paidReturn("cs_staged_changed", intent, 1000);
      expect(response.status).toBe(400);
      const stage = await getDb().execute(
        "SELECT state FROM checkout_stages WHERE payment_session_id = ?",
        ["cs_staged_changed"],
      );
      expect(stage.rows.map((row) => row.state)).toEqual(["pending"]);
    } finally {
      checkout.restore();
    }
  });

  test("rolls activation back when payment finalization is lost", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_finalize");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "finalize@example.com",
        name: "Finalize Buyer",
      });
      await getDb().execute(
        `CREATE TRIGGER lose_payment_finalize
         BEFORE UPDATE OF quantity ON listing_attendees
         BEGIN
           DELETE FROM processed_payments
           WHERE payment_session_id = 'cs_staged_finalize';
         END`,
      );
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

      const response = await paidReturn("cs_staged_finalize", intent, 1000);
      expect(response.status).toBe(400);
      await expectStage("cs_staged_finalize", "pending", 0);
    } finally {
      checkout.restore();
    }
  });

  test("fails loudly when staged attendee encryption is unavailable", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_encryption");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "encryption@example.com",
        name: "Encryption Buyer",
      });
      await getDb().execute("DELETE FROM settings WHERE key = ?", [
        CONFIG_KEYS.PUBLIC_KEY,
      ]);
      settings.invalidateCache();
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

      const response = await paidReturn("cs_staged_encryption", intent, 1000);
      expect(response.status).toBe(400);
      await expectStage("cs_staged_encryption", "pending", 0);
    } finally {
      checkout.restore();
    }
  });
});

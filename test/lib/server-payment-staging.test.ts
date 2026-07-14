// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { decryptAttendeeFields } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import { getCheckoutStageOrNull } from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { assembleCheckoutMetadata } from "#shared/payment-helpers.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { expectRedirect } from "#test-utils/assertions.ts";
import { stubCheckout } from "#test-utils/checkout.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";
import {
  expectNoStampedPayment,
  expectRefundRoundTripLegs,
  expectStage,
  fillListing,
  paidReturn,
  requireIntent,
  stubFailedRefund,
  stubSuccessfulRefund,
} from "./server-payment-staging-helpers.ts";

// jscpd:ignore-end

describeWithEnv("paid checkout staging", { db: true }, () => {
  // Spy console.error for the block's other tests; the dangling-stage test now
  // throws (asserted directly) rather than logging, so its return is unused.
  setupErrorSpy();
  afterEach(() => resetStripeClient());

  test("throws when a stage points at a deleted attendee", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_dangling");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "dangling@example.com",
        name: "Dangling Buyer",
      });
      // Bypass the delete cascade (which removes the stage) to manufacture the
      // impossible dangling stage: it now points at a dead id.
      await getDb().execute(
        `DELETE FROM attendees WHERE id =
           (SELECT attendee_id FROM checkout_stages WHERE payment_session_id = ?)`,
        ["cs_staged_dangling"],
      );
      const intent = requireIntent(getCaptured);

      // A pending stage must never outlive its attendee, so the paid session
      // surfaces the impossible state loudly instead of booking fresh around a
      // missed cascade.
      await expect(
        paidReturn("cs_staged_dangling", intent, 1000),
      ).rejects.toThrow("must never outlive its attendee");
    } finally {
      checkout.restore();
    }
  });

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

      const intent = requireIntent(getCaptured);
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
      await fillListing(listing);

      const intent = requireIntent(getCaptured);
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
        const failedAttendee = await getAttendeeRaw(stagedAttendeeId);
        if (!failedAttendee) throw new Error("Expected failed staged attendee");
        expect(
          (
            await decryptAttendeeFields(
              failedAttendee,
              await getTestPrivateKey(),
              true,
            )
          ).payment_id,
        ).toBe("pi_staged_full");
        expect(refund.calls.length).toBe(1);
      } finally {
        retrieve.restore();
      }
    } finally {
      checkout.restore();
      refund.restore();
    }
  });

  test("leaves a staged capacity-loss order refunding when the refund fails, then resolves on retry", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 1000,
    });
    const { checkout, getCaptured } = stubCheckout("cs_staged_retry");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "retry@example.com",
        name: "Retry Buyer",
      });
      // Consume the only spot, so activation can't honour the paid order.
      await fillListing(listing);
      const intent = requireIntent(getCaptured);

      // First delivery: the provider refund genuinely fails (and the payment
      // does not read as already refunded). The staged record must NOT go
      // terminal — posting the payment leg or resolving the stage now would make
      // the ledger preflight answer "already handled" and the refund would never
      // retry.
      {
        using _refund = stubFailedRefund();
        const response = await paidReturn("cs_staged_retry", intent, 1000);
        expect(await response.text()).toContain("saved your details");
      }
      // The stage stays refunding with NO ledger legs and no stamped reference, so
      // the released reservation's next delivery re-runs the whole refund path.
      await expectStage("cs_staged_retry", "refunding", 0);
      expect(
        (await getDb().execute("SELECT kind FROM transfers")).rows,
      ).toEqual([]);
      await expectNoStampedPayment("cs_staged_retry");

      // Second delivery: the provider refund now settles. The same reused staged
      // record resolves terminally with the full money round-trip.
      {
        using _refund = stubSuccessfulRefund("re_staged_retry");
        const response = await paidReturn("cs_staged_retry", intent, 1000);
        expect(await response.text()).toContain("automatically refunded");
        expect(_refund.calls.length).toBe(1);
      }
      await expectStage("cs_staged_retry", "failed", 0);
      await expectRefundRoundTripLegs();
    } finally {
      checkout.restore();
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
      const intent = requireIntent(getCaptured);
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

  test("holds the money for the operator when a staged row was activated outside payment", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_active");
    const refund = stubSuccessfulRefund("re_staged_active");

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
      const intent = requireIntent(getCaptured);

      // The rows may be a live booking, so the money must NOT move on its own:
      // no refund, no second activation — a terminal "the organiser must check
      // this" outcome the operator resolves.
      const response = await paidReturn("cs_staged_active", intent, 1000);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain(
        "needs to be confirmed by the organiser",
      );
      // The outcome is recorded and the stage resolves, so the operator can
      // now edit the record to act on the note (a pending stage blocks edits).
      await expectStage("cs_staged_active", "failed", 1);
      expect(refund.calls.length).toBe(0);

      // The staged attendee's record explains the conflict to the operator.
      const notes = await getDb().execute(
        `SELECT note.id FROM system_notes AS note
         JOIN checkout_stages AS stage ON stage.attendee_id = note.attendee_id
         WHERE stage.payment_session_id = ?`,
        ["cs_staged_active"],
      );
      expect(notes.rows.length).toBe(1);
      // The money we hold is on the record: the ledger shows the payment we
      // received — and nothing else, no sale and no refund — and the payment
      // reference is stamped so the operator can refund it in-app.
      const legs = await getDb().execute("SELECT kind FROM transfers");
      expect(legs.rows.map((row) => row.kind)).toEqual(["payment"]);
      const stage = await getCheckoutStageOrNull("cs_staged_active");
      if (!stage) throw new Error("Expected a stage for cs_staged_active");
      const held = await getAttendeeRaw(stage.attendeeId);
      if (!held) throw new Error("Expected the conflicted attendee to exist");
      expect(
        (await decryptAttendeeFields(held, await getTestPrivateKey(), true))
          .payment_id,
      ).toBe("pi_cs_staged_active");

      // A replay answers the same without touching the money or the rows.
      const replay = await paidReturn("cs_staged_active", intent, 1000);
      expect(replay.status).toBe(200);
      expect(await replay.text()).toContain(
        "needs to be confirmed by the organiser",
      );
      await expectStage("cs_staged_active", "failed", 1);
      expect(refund.calls.length).toBe(0);
      // The replay posted nothing: still exactly the one payment leg.
      const legsAfterReplay = await getDb().execute(
        "SELECT kind FROM transfers",
      );
      expect(legsAfterReplay.rows.map((row) => row.kind)).toEqual(["payment"]);
    } finally {
      checkout.restore();
      refund.restore();
    }
  });

  test("refunds and keeps the order when the staged booking paths changed", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_changed");
    const refund = stubSuccessfulRefund("re_staged_changed");

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
      const intent = requireIntent(getCaptured);

      // The staged rows are still all quantity 0, so nothing can be live:
      // refunding is safe, and the customer must never be crash-looped.
      const response = await paidReturn("cs_staged_changed", intent, 1000);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("automatically refunded");
      await expectStage("cs_staged_changed", "failed", 0);
      expect(refund.calls.length).toBe(1);

      // A replay returns the recorded outcome without refunding again.
      const replay = await paidReturn("cs_staged_changed", intent, 1000);
      expect(replay.status).toBe(200);
      expect(await replay.text()).toContain("automatically refunded");
      expect(refund.calls.length).toBe(1);
    } finally {
      checkout.restore();
      refund.restore();
    }
  });
});

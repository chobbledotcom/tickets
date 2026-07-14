// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { decryptAttendeeFields } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import {
  getCheckoutStageOrNull,
  markCheckoutStage,
} from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { getNotesForAttendee } from "#shared/db/system-notes.ts";
import { recordPlaceholderRefund } from "#shared/refund-ledger.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { stubCheckout } from "#test-utils/checkout.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import { postWebhookAndAssert } from "#test-utils/webhooks.ts";
import {
  ageReservation,
  blockSessionPaymentLeg,
  closeListingMidPayment,
  expectNoStampedPayment,
  expectRefundRoundTripLegs,
  expectStage,
  paidReturn,
  requireIntent,
  stubFailedRefund,
  stubSuccessfulRefund,
  unblockSessionPaymentLeg,
} from "./server-payment-staging-helpers.ts";

// jscpd:ignore-end

describeWithEnv("paid checkout staging — recovery", { db: true }, () => {
  setupErrorSpy();
  afterEach(() => resetStripeClient());
  test("discards the staged details when the checkout expires", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout } = stubCheckout("cs_staged_expired");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "expired@example.com",
        name: "Expired Buyer",
      });
      const staged = await getDb().execute(
        "SELECT attendee_id FROM checkout_stages WHERE payment_session_id = ?",
        ["cs_staged_expired"],
      );
      const stagedAttendeeId = Number(staged.rows[0]!.attendee_id);

      // Stripe reports the checkout expired unpaid: nothing can pay it any
      // more, so the staged details are removed right away instead of
      // waiting out the seven-day prune.
      const mockVerify = await stubWebhookVerify({
        data: { object: { id: "cs_staged_expired" } },
        id: "evt_staged_expired",
        type: "checkout.session.expired",
      });
      await postWebhookAndAssert(
        () => mockVerify.restore(),
        200,
        (json: { received: boolean }) => {
          expect(json.received).toBe(true);
        },
      );

      const stage = await getDb().execute(
        "SELECT 1 FROM checkout_stages WHERE payment_session_id = ?",
        ["cs_staged_expired"],
      );
      expect(stage.rows).toEqual([]);
      const attendee = await getDb().execute(
        "SELECT 1 FROM attendees WHERE id = ?",
        [stagedAttendeeId],
      );
      expect(attendee.rows).toEqual([]);
    } finally {
      checkout.restore();
    }
  });

  test("does not reactivate a resolved stage when its records are gone", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_resolved");
    const refund = stubSuccessfulRefund("re_staged_resolved");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "resolved@example.com",
        name: "Resolved Buyer",
      });
      // The stage resolved (its order was refunded), and the session's
      // idempotency row and ledger legs are gone — pruned, or the ledger post
      // was swallowed. A very late redelivery must not book a live ticket for
      // money that was already refunded.
      await markCheckoutStage("cs_staged_resolved", "failed");
      const intent = requireIntent(getCaptured);

      const response = await paidReturn("cs_staged_resolved", intent, 1000);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("already been processed");
      await expectStage("cs_staged_resolved", "failed", 0);
      expect(refund.calls.length).toBe(0);
    } finally {
      checkout.restore();
      refund.restore();
    }
  });

  test("keeps the stage refunding when the refund attempt dies mid-path", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 1000,
    });
    const { checkout, getCaptured } = stubCheckout("cs_staged_refund_down");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "down@example.com",
        name: "Down Buyer",
      });
      const filler = await bookAttendee(listing, {
        email: "filler-down@example.com",
        name: "Filler Down",
      });
      if (!filler.success) throw new Error("Expected filler booking");
      const intent = requireIntent(getCaptured);

      // The refund transport dies mid-path. The stage must stay pending:
      // resolving it before the money is recorded would make the retry answer
      // "already processed" with the customer still charged and nothing on
      // the record.
      {
        using _refund = stub(stripeApi, "refundPayment", () =>
          Promise.reject(new Error("refund transport down")),
        );
        await expect(
          paidReturn("cs_staged_refund_down", intent, 1000),
        ).rejects.toThrow("refund transport down");
      }
      await expectStage("cs_staged_refund_down", "refunding", 0);

      // The provider redelivers after the reservation goes stale, and this
      // time the refund lands: the booking is kept, refunded, and resolved.
      await ageReservation("cs_staged_refund_down");
      using refund = stubSuccessfulRefund("re_staged_refund_down");
      const retry = await paidReturn("cs_staged_refund_down", intent, 1000);
      expect(await retry.text()).toContain("automatically refunded");
      await expectStage("cs_staged_refund_down", "failed", 0);
      expect(refund.calls.length).toBe(1);
    } finally {
      checkout.restore();
    }
  });

  test("leaves the stage refunding when the closed-listing refund fails", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout(
      "cs_staged_closed_unrefunded",
    );

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "unrefunded@example.com",
        name: "Unrefunded Buyer",
      });
      await closeListingMidPayment(listing.id);
      const intent = requireIntent(getCaptured);

      // The provider cannot refund right now, and the payment does not read
      // as already refunded — the refund attempt genuinely failed.
      using _refund = stubFailedRefund();
      const response = await paidReturn(
        "cs_staged_closed_unrefunded",
        intent,
        1000,
      );
      expect(response.status).toBe(410);
      // The stage stays refunding so the released reservation's retry re-runs
      // the whole refund path — resolving it now would answer "already
      // processed" with the customer still charged.
      await expectStage("cs_staged_closed_unrefunded", "refunding", 0);
      // Nothing was ledgered or noted either; the retry re-runs everything.
      const legs = await getDb().execute("SELECT kind FROM transfers");
      expect(legs.rows).toEqual([]);
    } finally {
      checkout.restore();
    }
  });

  test("resolves a pending stage left behind when the ledger already holds the money", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_wedged");
    using refund = stubSuccessfulRefund("re_staged_wedged");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "wedged@example.com",
        name: "Wedged Buyer",
      });
      const stage = await getCheckoutStageOrNull("cs_staged_wedged");
      if (!stage) throw new Error("Expected a stage for cs_staged_wedged");
      // A crash left the money recorded but the stage unresolved: the ledger
      // round-trip landed, then the process died before the stage flip.
      await recordPlaceholderRefund(
        {
          amount: 1000,
          attendeeId: stage.attendeeId,
          eventId: "cs_staged_wedged",
          listingId: listing.id,
          occurredAt: new Date().toISOString(),
        },
        "listing_closed",
        true,
      );
      const intent = requireIntent(getCaptured);

      // The next delivery answers off the ledger — and heals the leftover
      // stage, so the kept record is editable and prunable again instead of
      // reading as mid-payment forever.
      const response = await paidReturn("cs_staged_wedged", intent, 1000);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("already been processed");
      await expectStage("cs_staged_wedged", "failed", 0);
      expect(refund.calls.length).toBe(0);
      // The heal also leaves the note the interrupted run never wrote, so the
      // operator can see why this record's money is already in the ledger.
      const notes = await getNotesForAttendee(
        stage.attendeeId,
        await getTestPrivateKey(),
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]!.note).toContain("pi_cs_staged_wedged");
      // The crash lost the payment-reference stamp (the money legs post before
      // stampStagedPaymentId), so the heal writes it back — without it the kept
      // record's payment panel and refund path stay hidden for real money.
      const kept = await getAttendeeRaw(stage.attendeeId);
      if (!kept) throw new Error("Expected the healed staged attendee");
      expect(
        (await decryptAttendeeFields(kept, await getTestPrivateKey(), true))
          .payment_id,
      ).toBe("pi_cs_staged_wedged");
    } finally {
      checkout.restore();
    }
  });

  test("retries the conflict when the held payment cannot be recorded", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_blocked");
    using refund = stubSuccessfulRefund("re_staged_blocked");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "blocked@example.com",
        name: "Blocked Buyer",
      });
      await getDb().execute(
        `UPDATE listing_attendees SET quantity = 1
         WHERE attendee_id = (SELECT attendee_id FROM checkout_stages
                              WHERE payment_session_id = ?)`,
        ["cs_staged_blocked"],
      );
      const intent = requireIntent(getCaptured);

      // Another event already owns the reference the held-payment leg needs,
      // so the ledger write fails. The conflict must NOT go terminal with the
      // money missing from the books: it throws, the stage stays pending, and
      // the provider's next delivery re-runs the whole path.
      await blockSessionPaymentLeg("cs_staged_blocked");
      await expect(
        paidReturn("cs_staged_blocked", intent, 1000),
      ).rejects.toThrow("money in the ledger");
      await expectStage("cs_staged_blocked", "pending", 1);
      expect(refund.calls.length).toBe(0);
      // The failed post threw BEFORE stamping the payment reference, so the
      // still-pending record exposes no charge for the Actions tab to offer an
      // in-app refund against while the money is unrecorded.
      await expectNoStampedPayment("cs_staged_blocked");

      // The colliding event is repaired and the provider redelivers after the
      // reservation goes stale: this time the held payment is recorded and
      // the conflict resolves for the operator.
      await unblockSessionPaymentLeg("cs_staged_blocked");
      await ageReservation("cs_staged_blocked");
      const retry = await paidReturn("cs_staged_blocked", intent, 1000);
      expect(retry.status).toBe(200);
      expect(await retry.text()).toContain(
        "needs to be confirmed by the organiser",
      );
      await expectStage("cs_staged_blocked", "failed", 1);
      const legs = await getDb().execute("SELECT kind FROM transfers");
      expect(legs.rows.map((row) => row.kind)).toEqual(["payment"]);
      expect(refund.calls.length).toBe(0);
    } finally {
      checkout.restore();
    }
  });

  test("retries a kept-and-refunded staged order when its ledger post fails", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 1000,
    });
    const { checkout, getCaptured } = stubCheckout("cs_staged_kept_blocked");
    using _refund = stubSuccessfulRefund("re_staged_kept_blocked");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "kept-blocked@example.com",
        name: "Kept Blocked Buyer",
      });
      // Fill the one seat so the paid activation fails on capacity and routes to
      // the keep-and-refund placeholder path (storeRefundedBooking).
      const filler = await bookAttendee(listing, {
        email: "kept-filler@example.com",
        name: "Kept Filler",
      });
      if (!filler.success) throw new Error("Expected filler booking");
      const intent = requireIntent(getCaptured);

      // The placeholder ledger post can't be written (its payment reference is
      // pre-claimed). A staged keep-and-refund must NOT go terminal with the
      // money missing from the books: it throws and the stage stays refunding.
      await blockSessionPaymentLeg("cs_staged_kept_blocked");
      await expect(
        paidReturn("cs_staged_kept_blocked", intent, 1000),
      ).rejects.toThrow("placeholder money in the ledger");
      await expectStage("cs_staged_kept_blocked", "refunding", 0);
      await expectNoStampedPayment("cs_staged_kept_blocked");

      // The collision is repaired and the provider redelivers: the money
      // round-trip is recorded and the order resolves at quantity 0.
      await unblockSessionPaymentLeg("cs_staged_kept_blocked");
      await ageReservation("cs_staged_kept_blocked");
      const retry = await paidReturn("cs_staged_kept_blocked", intent, 1000);
      expect(await retry.text()).toContain("automatically refunded");
      await expectStage("cs_staged_kept_blocked", "failed", 0);
      await expectRefundRoundTripLegs();
    } finally {
      checkout.restore();
    }
  });

  test("retries the closed-listing refund when its ledger write fails", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_closed_blocked");
    using _refund = stubSuccessfulRefund("re_staged_closed_blocked");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "closed-blocked@example.com",
        name: "Closed Blocked Buyer",
      });
      await closeListingMidPayment(listing.id);
      const intent = requireIntent(getCaptured);

      // The refund settles at the provider, but its ledger round-trip cannot
      // be written. The outcome must NOT go terminal with the money story
      // missing: it throws and the stage stays refunding for the redelivery.
      await blockSessionPaymentLeg("cs_staged_closed_blocked");
      await expect(
        paidReturn("cs_staged_closed_blocked", intent, 1000),
      ).rejects.toThrow("money in the ledger");
      await expectStage("cs_staged_closed_blocked", "refunding", 0);

      // The collision is repaired and the provider redelivers: the settled
      // refund reads back as refunded, the round-trip is recorded, and the
      // stage resolves.
      await unblockSessionPaymentLeg("cs_staged_closed_blocked");
      await ageReservation("cs_staged_closed_blocked");
      const retry = await paidReturn("cs_staged_closed_blocked", intent, 1000);
      expect(retry.status).toBe(200);
      await expectStage("cs_staged_closed_blocked", "failed", 0);
      await expectRefundRoundTripLegs();
    } finally {
      checkout.restore();
    }
  });

  test("marks the stage failed when registration closes mid-payment", async () => {
    await setupStripe();
    const listing = await createTestListing({ unitPrice: 1000 });
    const { checkout, getCaptured } = stubCheckout("cs_staged_closed");
    const refund = stubSuccessfulRefund("re_staged_closed");

    try {
      await submitTicketForm(listing.slug, {
        [`quantity_${listing.id}`]: "1",
        email: "closed@example.com",
        name: "Closed Buyer",
      });
      await closeListingMidPayment(listing.id);
      const intent = requireIntent(getCaptured);

      const response = await paidReturn("cs_staged_closed", intent, 1000);
      expect(response.status).toBe(410);
      expect(await response.text()).toContain("refunded");
      expect(refund.calls.length).toBe(1);
      // The stage resolves (no longer pending, so the retention promise
      // holds) and the staged record explains the refund to the operator.
      await expectStage("cs_staged_closed", "failed", 0);
      const stage = await getCheckoutStageOrNull("cs_staged_closed");
      if (!stage) throw new Error("Expected a stage for cs_staged_closed");
      const notes = await getNotesForAttendee(
        stage.attendeeId,
        await getTestPrivateKey(),
      );
      expect(notes).toHaveLength(1);
      expect(notes[0]!.note).toContain("stopped taking bookings");
      // The provider's payment reference is stamped into the stored details,
      // so the record's payment panel can find the charge and its refund.
      const kept = await getAttendeeRaw(stage.attendeeId);
      if (!kept) throw new Error("Expected the staged attendee to be kept");
      expect(
        (await decryptAttendeeFields(kept, await getTestPrivateKey(), true))
          .payment_id,
      ).toBe("pi_cs_staged_closed");
      await expectRefundRoundTripLegs();
    } finally {
      checkout.restore();
      refund.restore();
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
      const intent = requireIntent(getCaptured);

      // Losing the finalize row mid-transaction is a race with a replacement
      // reservation: the whole activation rolls back and the error propagates,
      // so the provider's next redelivery retries a clean slate.
      await expect(
        paidReturn("cs_staged_finalize", intent, 1000),
      ).rejects.toThrow("was not finalized");
      await expectStage("cs_staged_finalize", "pending", 0);
      // The trigger's delete rolled back with the transaction: the reservation
      // row is still there for the retry to claim.
      const reservation = await getDb().execute(
        "SELECT 1 FROM processed_payments WHERE payment_session_id = ?",
        ["cs_staged_finalize"],
      );
      expect(reservation.rows.length).toBe(1);
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
      const intent = requireIntent(getCaptured);

      // A missing encryption key means the whole system is down: the error
      // propagates (no refund, no terminal record) so the provider's
      // redelivery retries once the system is healthy again.
      await expect(
        paidReturn("cs_staged_encryption", intent, 1000),
      ).rejects.toThrow("Could not encrypt staged attendee");
      await expectStage("cs_staged_encryption", "pending", 0);
    } finally {
      checkout.restore();
    }
  });
});

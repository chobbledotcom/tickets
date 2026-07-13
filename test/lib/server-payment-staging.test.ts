import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { legReference } from "#shared/accounting/refs.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import { priceCheckout } from "#shared/checkout-pricing.ts";
import { decryptAttendeeFields } from "#shared/db/attendees/pii.ts";
import { getAttendeeRaw } from "#shared/db/attendees/queries.ts";
import {
  getCheckoutStageOrNull,
  markCheckoutStage,
} from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import { listingsTable } from "#shared/db/listings/records.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { STALE_RESERVATION_MS } from "#shared/db/processed-payments.ts";
import { settings } from "#shared/db/settings.ts";
import { getNotesForAttendee } from "#shared/db/system-notes.ts";
import { assembleCheckoutMetadata } from "#shared/payment-helpers.ts";
import { recordPlaceholderRefund } from "#shared/refund-ledger.ts";
import { CONFIG_KEYS } from "#shared/settings/keys.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { expectRedirect } from "#test-utils/assertions.ts";
import { stubCheckout } from "#test-utils/checkout.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe, stubWebhookVerify } from "#test-utils/settings.ts";
import {
  postWebhookAndAssert,
  stubRetrieveCheckoutSession,
} from "#test-utils/webhooks.ts";

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
  // `return await`, not `return`: the `using` stub is disposed when this scope
  // exits, so returning the bare promise would restore the real session
  // retrieval before the request runs and every call would 400 at classify.
  return await handleRequest(
    mockRequest(`/payment/success?session_id=${sessionId}`),
  );
};

/** Close the listing while the buyer is on the provider's page (written
 * through the table layer — closes_at is an encrypted column). */
const closeListingMidPayment = (listingId: number) =>
  listingsTable.update(listingId, {
    closesAt: new Date(Date.now() - 60000).toISOString().slice(0, 16),
  });

/** Pre-claim the reference the session's payment leg will need, so the
 * session's money cannot be written to the ledger until it is repaired. */
const blockSessionPaymentLeg = async (sessionId: string) =>
  postTransfers([
    {
      amount: 100,
      destination: attendeeAccount(999999),
      eventGroup: `blocker-${sessionId}`,
      kind: "payment",
      occurredAt: new Date().toISOString(),
      reference: await legReference(["booking", sessionId, "payment"]),
      source: WORLD,
    },
  ]);

/** Repair the collision so the session's money can be recorded on retry. */
const unblockSessionPaymentLeg = (sessionId: string) =>
  getDb().execute("DELETE FROM transfers WHERE event_group = ?", [
    `blocker-${sessionId}`,
  ]);

/** Age the session's reservation past the stale window, the state a provider
 * redelivery finds after a failed attempt. */
const ageReservation = (sessionId: string) =>
  getDb().execute(
    "UPDATE processed_payments SET processed_at = ? WHERE payment_session_id = ?",
    [
      new Date(Date.now() - STALE_RESERVATION_MS - 1000).toISOString(),
      sessionId,
    ],
  );

/** The ledger shows the charge we received and the refund returning it — and
 * nothing else: no sale leg, since the booking was never honoured. */
const expectRefundRoundTripLegs = async (): Promise<void> => {
  const legs = await getDb().execute("SELECT kind FROM transfers");
  expect(legs.rows.map((row) => row.kind).toSorted()).toEqual([
    "payment",
    "refund_cash",
  ]);
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

/** Assert a still-pending staged session's attendee carries no payment
 * reference — a failed money post threw before stamping one, so the Actions tab
 * has no charge to offer an in-app refund against while it stays unrecorded. */
const expectNoStampedPayment = async (sessionId: string): Promise<void> => {
  const stage = await getCheckoutStageOrNull(sessionId);
  if (!stage) throw new Error(`Expected a pending stage for ${sessionId}`);
  const attendee = await getAttendeeRaw(stage.attendeeId);
  if (!attendee)
    throw new Error(`Expected the staged attendee for ${sessionId}`);
  expect(
    (await decryptAttendeeFields(attendee, await getTestPrivateKey(), true))
      .payment_id,
  ).toBe("");
};

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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

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

  test("keeps the stage pending when the refund attempt dies mid-path", async () => {
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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

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
      await expectStage("cs_staged_refund_down", "pending", 0);

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

  test("leaves the stage pending when the closed-listing refund fails", async () => {
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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

      // The provider cannot refund right now, and the payment does not read
      // as already refunded — the refund attempt genuinely failed.
      using _refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve(null),
      );
      using _status = stub(stripeApi, "retrievePaymentIntent", () =>
        Promise.resolve(null),
      );
      const response = await paidReturn(
        "cs_staged_closed_unrefunded",
        intent,
        1000,
      );
      expect(response.status).toBe(410);
      // The stage stays pending so the released reservation's retry re-runs
      // the whole refund path — resolving it now would answer "already
      // processed" with the customer still charged.
      await expectStage("cs_staged_closed_unrefunded", "pending", 0);
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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

      // The placeholder ledger post can't be written (its payment reference is
      // pre-claimed). A staged keep-and-refund must NOT go terminal with the
      // money missing from the books: it throws and the stage stays pending.
      await blockSessionPaymentLeg("cs_staged_kept_blocked");
      await expect(
        paidReturn("cs_staged_kept_blocked", intent, 1000),
      ).rejects.toThrow("placeholder money in the ledger");
      await expectStage("cs_staged_kept_blocked", "pending", 0);
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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

      // The refund settles at the provider, but its ledger round-trip cannot
      // be written. The outcome must NOT go terminal with the money story
      // missing: it throws and the stage stays pending for the redelivery.
      await blockSessionPaymentLeg("cs_staged_closed_blocked");
      await expect(
        paidReturn("cs_staged_closed_blocked", intent, 1000),
      ).rejects.toThrow("money in the ledger");
      await expectStage("cs_staged_closed_blocked", "pending", 0);

      // The collision is repaired and the provider redelivers: the settled
      // refund reads back as refunded, the round-trip is recorded, and the
      // stage resolves.
      await unblockSessionPaymentLeg("cs_staged_closed_blocked");
      await ageReservation("cs_staged_closed_blocked");
      const retry = await paidReturn("cs_staged_closed_blocked", intent, 1000);
      expect(retry.status).toBe(410);
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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

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
      const intent = getCaptured();
      if (!intent) throw new Error("Expected captured checkout intent");

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

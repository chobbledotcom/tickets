/* jscpd:ignore-start */
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { getCheckoutStageOrNull } from "#shared/db/checkout-stages.ts";
import { getDb } from "#shared/db/client.ts";
import {
  markSessionFailed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import type { CheckoutIntent } from "#shared/payments.ts";
import { flushPendingWork } from "#shared/pending-work.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import { stubCheckout } from "#test-utils/checkout.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { finalizeTestPaymentSession } from "#test-utils/db-helpers/processed-payments.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  expectStage,
  paidReturn,
  requireIntent,
} from "./server-payment-staging-helpers.ts";

/* jscpd:ignore-end */

type RollbackCheckout = {
  intent: CheckoutIntent;
  listing: Awaited<ReturnType<typeof createTestListing>>;
  stagedAttendeeId: number;
};

const storedStageTokens = async (sessionId: string): Promise<string> => {
  const row = await getDb().execute(
    "SELECT ticket_tokens FROM checkout_stages WHERE payment_session_id = ?",
    [sessionId],
  );
  const tokens = row.rows[0]?.ticket_tokens;
  if (typeof tokens !== "string") {
    throw new Error(`Expected stored checkout stage tokens for ${sessionId}`);
  }
  return tokens;
};

const startRollbackCheckout = async (
  sessionId: string,
): Promise<RollbackCheckout> => {
  const listing = await createTestListing({ unitPrice: 1000 });
  const { checkout, getCaptured } = stubCheckout(sessionId);
  try {
    await submitTicketForm(listing.slug, {
      [`quantity_${listing.id}`]: "1",
      email: `${sessionId}@example.com`,
      name: "Staged buyer",
    });
    await flushPendingWork();
  } finally {
    checkout.restore();
  }
  const stage = await getCheckoutStageOrNull(sessionId);
  if (!stage) throw new Error(`Expected checkout stage ${sessionId}`);
  return {
    intent: requireIntent(getCaptured),
    listing,
    stagedAttendeeId: stage.attendeeId,
  };
};

const createRollbackOwner = async (
  sessionId: string,
  listing: RollbackCheckout["listing"],
): Promise<{ attendeeId: number; ticketToken: string }> => {
  const result = await bookAttendee(listing, {
    email: `rollback-${sessionId}@example.com`,
    name: "Rollback buyer",
    paymentId: `pi_${sessionId}`,
  });
  if (!result.success) throw new Error("Expected rollback booking");
  const attendeeId = result.attendees[0]!.id;
  await postListingSale({
    attendeeId,
    eventId: sessionId,
    gross: 1000,
    listingId: listing.id,
  });
  return { attendeeId, ticketToken: result.attendees[0]!.ticket_token };
};

const reopenHistoricalStage = async (sessionId: string): Promise<void> => {
  await getDb().execute(
    "UPDATE checkout_stages SET state = 'pending', ticket_tokens = ? WHERE payment_session_id = ?",
    [await storedStageTokens(sessionId), sessionId],
  );
};

const expectStageTokenScrubbed = async (sessionId: string): Promise<void> => {
  const row = await getDb().execute(
    "SELECT ticket_tokens FROM checkout_stages WHERE payment_session_id = ?",
    [sessionId],
  );
  expect(row.rows[0]!.ticket_tokens).toBe("");
};

describeWithEnv(
  "paid checkout staging — rollback recovery",
  { db: true },
  () => {
    afterEach(() => resetStripeClient());

    test("returns the rollback attendee and fails a different historical stage", async () => {
      await setupStripe();
      const sessionId = "cs_rollback_processed_owner";
      const checkout = await startRollbackCheckout(sessionId);
      const owner = await createRollbackOwner(sessionId, checkout.listing);
      const stagedTokens = await storedStageTokens(sessionId);
      await getDb().execute(
        "UPDATE checkout_stages SET state = 'failed', ticket_tokens = '' WHERE payment_session_id = ?",
        [sessionId],
      );
      await reserveSession(sessionId);
      await finalizeTestPaymentSession(
        sessionId,
        owner.attendeeId,
        [owner.ticketToken],
        "",
      );
      await getDb().execute(
        "UPDATE checkout_stages SET state = 'pending', ticket_tokens = ? WHERE payment_session_id = ?",
        [stagedTokens, sessionId],
      );
      const beforeTransfers = await getDb().execute(
        "SELECT COUNT(*) AS count FROM transfers",
      );
      using refund = stub(stripeApi, "refundPayment", () =>
        Promise.reject(new Error("must not refund historical payment")),
      );

      const response = await paidReturn(sessionId, checkout.intent, 1000);

      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toContain(owner.ticketToken);
      await expectStage(sessionId, "failed", 0);
      await expectStageTokenScrubbed(sessionId);
      const bookings = await getDb().execute(
        "SELECT attendee_id, quantity FROM listing_attendees ORDER BY attendee_id",
      );
      expect(
        bookings.rows.map((row) => [row.attendee_id, row.quantity]),
      ).toEqual([
        [checkout.stagedAttendeeId, 0],
        [owner.attendeeId, 1],
      ]);
      const afterTransfers = await getDb().execute(
        "SELECT COUNT(*) AS count FROM transfers",
      );
      expect(afterTransfers.rows[0]!.count).toBe(
        beforeTransfers.rows[0]!.count,
      );
      expect(refund.calls).toHaveLength(0);
    });

    test("heals a ledger owner before finalizing its recreated payment row", async () => {
      await setupStripe();
      const sessionId = "cs_rollback_ledger_owner";
      const checkout = await startRollbackCheckout(sessionId);
      const owner = await createRollbackOwner(sessionId, checkout.listing);

      const response = await paidReturn(sessionId, checkout.intent, 1000);

      expect(response.status).toBe(200);
      await expectStage(sessionId, "failed", 0);
      await expectStageTokenScrubbed(sessionId);
      const payment = await getDb().execute(
        "SELECT attendee_id FROM processed_payments WHERE payment_session_id = ?",
        [sessionId],
      );
      expect(payment.rows[0]!.attendee_id).toBe(owner.attendeeId);
    });

    test("books a historical open stage when the finalized owner is the same attendee", async () => {
      await setupStripe();
      const sessionId = "cs_rollback_same_owner";
      const checkout = await startRollbackCheckout(sessionId);
      await getDb().execute(
        "UPDATE checkout_stages SET state = 'failed' WHERE payment_session_id = ?",
        [sessionId],
      );
      await reserveSession(sessionId);
      await finalizeTestPaymentSession(
        sessionId,
        checkout.stagedAttendeeId,
        ["same-owner-token"],
        "",
      );
      await reopenHistoricalStage(sessionId);

      const response = await paidReturn(sessionId, checkout.intent, 1000);

      expect(response.status).toBe(302);
      await expectStage(sessionId, "booked", 0);
      await expectStageTokenScrubbed(sessionId);
    });

    test("resolves an open stage when replaying a terminal payment failure", async () => {
      await setupStripe();
      const sessionId = "cs_rollback_terminal_failure";
      const checkout = await startRollbackCheckout(sessionId);
      await reserveSession(sessionId);
      await markSessionFailed(sessionId, {
        error: "Payment failed",
        status: 410,
      });

      const response = await paidReturn(sessionId, checkout.intent, 1000);

      expect(response.status).toBe(410);
      await expectStage(sessionId, "failed", 0);
      await expectStageTokenScrubbed(sessionId);
    });

    test("keeps a fresh unresolved reservation pending", async () => {
      await setupStripe();
      const sessionId = "cs_rollback_fresh_reservation";
      const checkout = await startRollbackCheckout(sessionId);
      await reserveSession(sessionId);

      const response = await paidReturn(sessionId, checkout.intent, 1000);

      expect(response.status).toBe(409);
      await expectStage(sessionId, "pending", 0);
    });
  },
);

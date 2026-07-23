// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import {
  markSessionFailed,
  reserveSession,
} from "#shared/db/processed-payments.ts";
import { squarePaymentProvider } from "#shared/square-provider.ts";
import {
  activateSquare,
  refundedSquareSessionMocks,
} from "#test/lib/square/fixtures.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest, withMocks } from "#test-utils/mocks.ts";
import { finalizeProcessedPayment } from "#test-utils/processed-payments.ts";
import { stagePaymentCallback } from "#test-utils/staged-payments.ts";

// jscpd:ignore-end

describeWithEnv("Square terminal callback replay", { db: true }, () => {
  test("replays a stored refunded failure instead of rejecting provider state", async () => {
    await activateSquare();
    const listing = await createTestListing({ unitPrice: 1000 });
    const orderId = "square-terminal-failure";
    const metadata = signedMeta(
      {
        email: "square-failure@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Square failure",
      },
      1000,
    );
    await reserveSession(orderId);
    await markSessionFailed(orderId, {
      error: "Stored Square failure.",
      refunded: true,
      status: 200,
    });

    await withMocks(
      () =>
        refundedSquareSessionMocks(orderId, "square-payment-failure", metadata),
      async () => {
        const response = await handleRequest(
          mockRequest(`/payment/success?orderId=${orderId}`),
        );
        expect(response.status).toBe(200);
        const html = await response.text();
        expect(html).toContain("Stored Square failure.");
        expect(html).toContain("automatically refunded");
        expect(html).not.toContain("Payment verification failed");
      },
    );
  });

  test("does not activate a fresh checkout refunded outside the app", async () => {
    await activateSquare();
    const listing = await createTestListing({ unitPrice: 1000 });
    const orderId = "square-fresh-refund";
    const paymentId = "square-payment-fresh-refund";
    const metadata = signedMeta(
      {
        email: "square-fresh@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Square fresh",
      },
      1000,
    );
    await stagePaymentCallback({
      amountTotal: 1000,
      metadata,
      paymentReference: paymentId,
      provider: "square",
      sessionId: orderId,
    });

    await withMocks(
      () => refundedSquareSessionMocks(orderId, paymentId, metadata),
      async () => {
        const response = await handleRequest(
          mockRequest(`/payment/success?orderId=${orderId}`),
        );
        expect(response.status).toBe(400);
        expect(await response.text()).toContain("Payment verification failed");
        expect(await getAttendeesRaw(listing.id)).toEqual([]);
        expect(await loadCheckoutStageByPaymentSession(orderId)).toMatchObject({
          state: "pending",
        });
      },
    );
  });

  test("replays a stored success after Square reports its later refund", async () => {
    await activateSquare();
    const listing = await createTestListing({ unitPrice: 1000 });
    const attendee = await bookTestAttendee(
      [listing.id],
      "Square success",
      "square-success@example.com",
    );
    const orderId = "square-terminal-success";
    const paymentId = "square-payment-success";
    const metadata = signedMeta(
      {
        email: "square-success@example.com",
        items: singleItem(listing.id, 1, 1000),
        name: "Square success",
      },
      1000,
    );
    await finalizeProcessedPayment(
      orderId,
      attendee.id,
      attendee.ticket_token,
      paymentId,
    );

    await withMocks(
      () => refundedSquareSessionMocks(orderId, paymentId, metadata),
      async () => {
        const response = await handleRequest(
          mockRequest(`/payment/success?orderId=${orderId}`),
        );
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toContain(
          encodeURIComponent(attendee.ticket_token),
        );
        expect(await getAttendeesRaw(listing.id)).toHaveLength(1);
      },
    );
  });

  test("does not use terminal replay while scheduled recovery owns a stage", async () => {
    await activateSquare();
    const orderId = "square-recovery-refund";
    const paymentId = "square-recovery-payment";
    const metadata = signedMeta(
      {
        email: "square-recovery@example.com",
        items: singleItem(1, 1, 1000),
        name: "Square recovery",
      },
      1000,
    );
    await reserveSession(orderId);
    await markSessionFailed(orderId, { error: "Stored recovery result." });

    await withMocks(
      () => refundedSquareSessionMocks(orderId, paymentId, metadata),
      async () => {
        expect(
          await squarePaymentProvider.retrieveSession(orderId, "recovery"),
        ).toMatchObject({ paymentStatus: "unpaid" });
      },
    );
  });
});

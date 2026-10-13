/** Two paid-webhook outcomes around the create boundary: a concurrent
 *  redirect and webhook converge on one stable ticket without refund, and an
 *  ambiguous create result rethrows without refunding. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeesApi } from "#db/attendees/api.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import {
  decryptSessionTokens,
  releaseReservation,
} from "#db/processed-payments.ts";
import {
  redirectRequest,
  runWebhook,
  setupWithListing,
  signedMeta,
  webhookRequest,
} from "#test/integration/webhook-price-signature/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { getTestPrivateKey } from "#test-utils/crypto.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { singleItem } from "#test-utils/factories.ts";
import { getProcessedPayment } from "#test-utils/processed-payments.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks/stripe.ts";

describeWithEnv("paid webhook create boundary", { db: true }, () => {
  test("a concurrent redirect and webhook converge on one stable ticket without refund", async () => {
    const listing = await setupWithListing();
    const sessionId = "cs_redirect_webhook_race";
    const metadata = signedMeta(1000, {
      items: singleItem(listing.id, 1, 1000),
    });

    await runWebhook({ id: sessionId, metadata }, async (refund) => {
      const createBooking = attendeesApi.createBookingAtomic;
      const committedBooking = Promise.withResolvers<{
        attendeeId: number;
        ticketToken: string;
      }>();
      const releaseBooking = Promise.withResolvers<void>();
      const pauseBooking = stub(
        attendeesApi,
        "createBookingAtomic",
        async (...args) => {
          const result = await createBooking(...args);
          if (result === "sold-out" || !result.success) {
            throw new Error("Expected booking to commit");
          }
          const attendee = result.attendees[0]!;
          committedBooking.resolve({
            attendeeId: attendee.id,
            ticketToken: attendee.ticket_token,
          });
          await releaseBooking.promise;
          return result;
        },
      );
      const retrieve = stubRetrieveCheckoutSession({
        amountTotal: 1000,
        metadata,
        paymentIntent: `pi_${sessionId}`,
        sessionId,
      });
      try {
        const firstWebhook = webhookRequest();
        const committed = await committedBooking.promise;
        const competingRedirect = await redirectRequest(sessionId);
        expect(competingRedirect.status).toBe(302);
        expect(competingRedirect.headers.get("location")).toBe(
          `/payment/success?tokens=${encodeURIComponent(
            committed.ticketToken,
          )}`,
        );
        releaseBooking.resolve();
        await assertJson(firstWebhook, 200, (json) => {
          expect(json.processed).toBe(true);
        });
        await assertJson(webhookRequest(), 200, (json) => {
          expect(json.processed).toBe(true);
        });
        const redirect = await redirectRequest(sessionId);
        expect(redirect.status).toBe(200);
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees).toHaveLength(1);
        const attendee = attendees[0]!;
        const [decrypted] = await decryptAttendees(
          [attendee],
          await getTestPrivateKey(),
        );
        expect(decrypted!.id).toBe(committed.attendeeId);
        expect(decrypted!.ticket_token).toBe(committed.ticketToken);
        const processed = await getProcessedPayment(sessionId);
        expect(processed!.attendee_id).toBe(committed.attendeeId);
        expect(await decryptSessionTokens(processed!.ticket_tokens)).toBe("");
        const replayedRedirect = await redirectRequest(sessionId);
        expect(replayedRedirect.status).toBe(200);
        expect(await getAttendeesRaw(listing.id)).toEqual(attendees);
        expect(refund.calls.length).toBe(0);
      } finally {
        releaseBooking.resolve();
        pauseBooking.restore();
        retrieve.restore();
      }
    });
  });

  test("rethrows an ambiguous create without refunding", async () => {
    const listing = await setupWithListing();
    const sessionId = "cs_ambiguous_create";
    const ambiguous = stub(attendeesApi, "createBookingAtomic", async () => {
      await releaseReservation(sessionId);
      throw new Error("synthetic ambiguous result");
    });
    try {
      await runWebhook(
        {
          id: sessionId,
          metadata: signedMeta(1000, {
            items: singleItem(listing.id, 1, 1000),
          }),
        },
        async (refund) => {
          await expect(webhookRequest()).rejects.toThrow(
            "synthetic ambiguous result",
          );
          expect(refund.calls.length).toBe(0);
          expect(await getAttendeesRaw(listing.id)).toEqual([]);
        },
      );
    } finally {
      ambiguous.restore();
    }
  });
});

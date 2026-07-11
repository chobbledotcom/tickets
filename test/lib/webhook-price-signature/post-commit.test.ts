import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { releaseReservation } from "#shared/db/processed-payments.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  assertJson,
  expectRedirect,
  followRedirect,
} from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { singleItem } from "#test-utils/factories.ts";
import { stubRetrieveCheckoutSession } from "#test-utils/webhooks.ts";
import {
  redirectRequest,
  runWebhook,
  setupWithListing,
  signedMeta,
  webhookRequest,
} from "./helpers.ts";

describeWithEnv(
  "webhook signed price oracle - post-commit failures",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("recovers the ticket when post-commit processing throws", async () => {
      const listing = await setupWithListing();
      const sessionId = "cs_post_commit_failure";
      const metadata = signedMeta(1000, {
        items: singleItem(listing.id, 1, 1000),
      });
      const createBooking = attendeesApi.createBookingAtomic;
      const failAfterCommit = stub(
        attendeesApi,
        "createBookingAtomic",
        async (...args) => {
          const result = await createBooking(...args);
          if (result === "sold-out" || !result.success) {
            throw new Error("Expected the synthetic booking to commit");
          }

          const attendees = result.attendees;
          let reads = 0;
          Object.defineProperty(result, "attendees", {
            get: () => {
              reads += 1;
              if (reads > 1) {
                throw new Error("synthetic post-commit failure");
              }
              return attendees;
            },
          });
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
        await runWebhook({ id: sessionId, metadata }, async (refund) => {
          await assertJson(webhookRequest(), 200, (json) => {
            expect(json.processed).toBe(true);
          });
          expect(refund.calls.length).toBe(0);
          const attendees = await getAttendeesRaw(listing.id);
          expect(attendees.map(({ quantity }) => quantity)).toEqual([1]);

          const redirect = await redirectRequest(sessionId);
          expectRedirect(redirect, /^\/payment\/success\?tokens=.+$/);
          const page = await followRedirect(redirect, handleRequest);
          expect(await page.text()).toContain("Click here to view your ticket");
        });
      } finally {
        retrieve.restore();
        failAfterCommit.restore();
      }
    });

    test("does not refund when an unexpected failure loses its reservation", async () => {
      const listing = await setupWithListing();
      const sessionId = "cs_missing_reservation_failure";
      const failWithoutReservation = stub(
        attendeesApi,
        "createBookingAtomic",
        async () => {
          await releaseReservation(sessionId);
          throw new Error("synthetic ambiguous failure");
        },
      );

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
              "synthetic ambiguous failure",
            );
            expect(refund.calls.length).toBe(0);
            expect(await getAttendeesRaw(listing.id)).toEqual([]);
          },
        );
      } finally {
        failWithoutReservation.restore();
      }
    });
  },
);

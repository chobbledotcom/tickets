import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { singleItem } from "#test-utils/factories.ts";
import {
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

    test("never refunds a booking when post-commit processing throws", async () => {
      const listing = await setupWithListing();
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

      try {
        await runWebhook(
          {
            id: "cs_post_commit_failure",
            metadata: signedMeta(1000, {
              items: singleItem(listing.id, 1, 1000),
            }),
          },
          async (refund) => {
            await expect(webhookRequest()).rejects.toThrow(
              "synthetic post-commit failure",
            );
            expect(refund.calls.length).toBe(0);
            const attendees = await getAttendeesRaw(listing.id);
            expect(attendees.map(({ quantity }) => quantity)).toEqual([1]);
          },
        );
      } finally {
        failAfterCommit.restore();
      }
    });
  },
);

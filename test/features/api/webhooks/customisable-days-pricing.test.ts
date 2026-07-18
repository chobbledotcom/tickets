// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { resetStripeClient } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectStagedAttendeeRemovedAndRefunded,
  expectWebhookKeptAndRefunded,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

/** A daily listing offering a 1-day (£10) or 3-day (£25) price — every
 *  customisable-days test below books against one of these. */
const createCustomisableDaysListing = (extra: Record<string, unknown> = {}) =>
  createTestListing({
    customisableDays: true,
    dayPrices: { 1: 1000, 3: 2500 },
    durationDays: 3,
    listingType: "daily",
    maxAttendees: 50,
    ...extra,
  });

describeWithEnv(
  "server webhooks > customisable-days pricing",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("prices a customisable-days webhook booking by the chosen day count", async () => {
      await setupStripe();

      const listing = await createCustomisableDaysListing({
        maximumDaysAfter: 90,
        minimumDaysBefore: 0,
      });

      await expectWebhookProcessed(
        checkoutSessionEvent({
          // 3-day price (2500), not the 1-day unit price.
          amountTotal: 2500,
          eventId: "evt_customisable",
          metadata: signedMeta(
            {
              date: "2026-07-01",
              day_count: "3",
              email: "trip@example.com",
              items: singleItem(listing.id, 1, 2500),
              name: "Trip Buyer",
            },
            2500,
          ),
          paymentIntent: "pi_customisable",
          sessionId: "cs_customisable",
        }),
      );

      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      // Created at the day-count price and start date — proving the webhook
      // re-priced and dated the booking by the chosen span, not the listing's
      // flat unit price.
      expect(Number(attendees[0]?.price_paid)).toBe(2500);
      expect(attendees[0]?.date).toBe("2026-07-01");
    });

    test("defaults a customisable-days webhook with no day_count to a single day", async () => {
      await setupStripe();

      const listing = await createCustomisableDaysListing();

      await expectWebhookProcessed(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_no_daycount",
          // No day_count → the booking falls back to the 1-day price.
          metadata: signedMeta(
            {
              date: "2026-07-01",
              email: "trip@example.com",
              items: singleItem(listing.id, 1, 1000),
              name: "Trip Buyer",
            },
            1000,
          ),
          paymentIntent: "pi_no_daycount",
          sessionId: "cs_no_daycount",
        }),
      );
      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const attendees = await getAttendeesRaw(listing.id);
      expect(Number(attendees[0]?.price_paid)).toBe(1000);
    });

    test("removes and refunds a customisable-days webhook whose day count has no price", async () => {
      await setupStripe();

      const listing = await createCustomisableDaysListing();

      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 2500,
          eventId: "evt_bad_daycount",
          metadata: signedMeta(
            {
              date: "2026-07-01",
              // 9 isn't an offered count, so the expected price is 0 and
              // the charged amount can't be reconciled.
              day_count: "9",
              email: "trip@example.com",
              items: singleItem(listing.id, 1, 2500),
              name: "Trip Buyer",
            },
            2500,
          ),
          paymentIntent: "pi_bad_daycount",
          sessionId: "cs_bad_daycount",
        }),
      );
      // The staged attendee is removed and the payment is refunded once.
      await expectStagedAttendeeRemovedAndRefunded(
        listing.id,
        "cs_bad_daycount",
        mockRefund,
      );
    });
  },
);

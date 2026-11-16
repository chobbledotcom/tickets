import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { queryAll } from "#db/client.ts";
import { settings } from "#db/settings.ts";
import { sql } from "#db/sql.ts";
import { handleRequest } from "#routes";
import { followRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  latestAttendee,
  setPublicReservation,
} from "#test-utils/reservation/helpers.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { subscriptionItems } from "#test-utils/stripe/fixtures.ts";
import { withSubscriptionStarted } from "#test-utils/stripe/subscription-checkout.ts";

const INCLUDED_VAT = JSON.stringify({
  mode: "calculate_from_total",
  rateBasisPoints: 2000,
});

/** Complete a paid subscription checkout for two tickets of `listingId`
 * through the success redirect, with Stripe reporting the started plan. */
const completeSubscriptionCheckout = (
  listingId: number,
  paidToday = 2000,
  deposit: { reservation_amount?: string } = {},
) =>
  withSubscriptionStarted(
    {
      session: {
        amount_total: paidToday,
        id: "cs_sub_booking",
        metadata: signedMeta(
          {
            email: "member@example.com",
            items: singleItem(listingId, 2, 2000),
            name: "Member",
            tax_policy: INCLUDED_VAT,
            ...deposit,
          },
          paidToday,
        ),
      },
      subscription: {
        id: "sub_booking",
        items: subscriptionItems("month", 600, 2),
        metadata: { listing_id: String(listingId) },
      },
    },
    async () => {
      const redirect = await handleRequest(
        mockRequest("/payment/success?session_id=cs_sub_booking"),
      );
      expect(redirect.status).toBe(302);
      expect((await followRedirect(redirect, handleRequest)).status).toBe(200);
    },
  );

describeWithEnv("subscription booking", { db: true }, () => {
  test("takes a deposit for the first payment and keeps the full plan", async () => {
    await setupStripe();
    await settings.update.bookingFee("0");
    await setPublicReservation("10%");
    const listing = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 2,
      unitPrice: 1000,
    });

    await completeSubscriptionCheckout(listing.id, 200, {
      reservation_amount: "10%",
    });

    expect((await latestAttendee()).remainingBalance).toBe(1800);
    expect(
      await queryAll(
        sql`SELECT quantity, recurring_price, subscription_id
           FROM listing_attendees WHERE listing_id = ${listing.id}`,
      ),
    ).toEqual([
      { quantity: 2, recurring_price: 1200, subscription_id: "sub_booking" },
    ]);
  });

  test("keeps the plan Stripe started on the booking row", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 10,
      maxQuantity: 2,
      unitPrice: 1000,
    });

    await completeSubscriptionCheckout(listing.id);

    expect(
      await queryAll(
        sql`SELECT quantity, recurring_price, recurring_tax, recurring_interval,
                subscription_id, subscription_status
           FROM listing_attendees WHERE listing_id = ${listing.id}`,
      ),
    ).toEqual([
      {
        quantity: 2,
        recurring_interval: "month",
        recurring_price: 1200,
        recurring_tax: 200,
        subscription_id: "sub_booking",
        subscription_status: "trialing",
      },
    ]);
  });
});

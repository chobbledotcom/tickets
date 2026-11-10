import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { queryAll } from "#db/client.ts";
import { handleRequest } from "#routes";
import { stripeApi } from "#shared/stripe.ts";
import { followRedirect } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stripeSubscription } from "#test-utils/stripe/fixtures.ts";
import { stubCheckoutSession } from "#test-utils/stripe/responses.ts";

const INCLUDED_VAT = JSON.stringify({
  mode: "calculate_from_total",
  rateBasisPoints: 2000,
});

/** Complete a paid subscription checkout for two tickets of `listingId`
 * through the success redirect, with Stripe reporting the started plan. */
const completeSubscriptionCheckout = async (listingId: number) => {
  const retrieve = stub(stripeApi, "retrieveCheckoutSession", () =>
    Promise.resolve(
      stubCheckoutSession({
        amount_total: 2000,
        currency: "gbp",
        id: "cs_sub_booking",
        metadata: signedMeta(
          {
            email: "member@example.com",
            items: singleItem(listingId, 2, 2000),
            name: "Member",
            tax_policy: INCLUDED_VAT,
          },
          2000,
        ),
        mode: "subscription",
        payment_intent: null,
        payment_status: "paid",
        status: "complete",
        subscription: "sub_booking",
      }),
    ),
  );
  const read = stub(stripeApi, "readSubscription", () =>
    Promise.resolve({
      resource: stripeSubscription({
        id: "sub_booking",
        items: {
          data: [
            {
              price: { recurring: { interval: "month" }, unit_amount: 600 },
              quantity: 2,
            },
          ],
        },
        metadata: { listing_id: String(listingId) },
      }),
      status: "found" as const,
    }),
  );
  try {
    const redirect = await handleRequest(
      mockRequest("/payment/success?session_id=cs_sub_booking"),
    );
    expect(redirect.status).toBe(302);
    expect((await followRedirect(redirect, handleRequest)).status).toBe(200);
  } finally {
    retrieve.restore();
    read.restore();
  }
};

describeWithEnv("subscription booking", { db: true }, () => {
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
        `SELECT quantity, recurring_price, recurring_tax, recurring_interval,
                subscription_id, subscription_status
           FROM listing_attendees WHERE listing_id = ?`,
        [listing.id],
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

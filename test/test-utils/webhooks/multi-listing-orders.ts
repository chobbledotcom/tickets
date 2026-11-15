/**
 * A two-listing order the webhook refuses: both listings, the metadata that
 * names them, and the aftermath both multi-listing refund tests check. The
 * can_pay_more and price-mismatch webhook tests share the shape, so it lives
 * here once.
 */

import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta } from "#test-utils/factories.ts";
import { expectSessionFailed } from "#test-utils/processed-payments.ts";
import {
  expectWebhookKeptAndRefunded,
  type StripeRefundStub,
} from "#test-utils/webhooks/stripe.ts";
import {
  checkoutSessionEvent,
  expectMergedMultiListingAttendee,
} from "#test-utils/webhooks.ts";

/** One listing the order holds: the name the test reads, the listing's own
 *  unit price, the price the order's metadata names, and its quantity. */
type OrderListing = {
  name: string;
  price: number;
  quantity: number;
  unitPrice: number;
};

/** The two listings an order names, in the order its metadata names them. */
type OrderListings = readonly [OrderListing, OrderListing];

/** What the order's own details say, apart from the listings. */
type OrderDetails = {
  amountTotal: number;
  email: string;
  payer: string;
};

/**
 * Create the two listings the order names, send the order's webhook, and
 * assert it was kept as one quantity-0 placeholder across both listings,
 * refunded once, and its session marked failed. `id` names every Stripe id
 * the order carries: `evt_`, `pi_`, `cs_` and `re_` prefix it. The caller
 * adds the checks its reason earns.
 */
export const expectTwoListingOrderKeptAndRefunded = async (
  id: string,
  details: OrderDetails,
  listings: OrderListings,
): Promise<{ attendee: { id: number }; mockRefund: StripeRefundStub }> => {
  const listingIds: number[] = [];
  for (const { name, unitPrice } of listings) {
    const created = await createTestListing({
      maxAttendees: 50,
      maxQuantity: 5,
      name,
      unitPrice,
    });
    listingIds.push(created.id);
  }

  const { mockRefund } = await expectWebhookKeptAndRefunded(
    checkoutSessionEvent({
      amountTotal: details.amountTotal,
      eventId: `evt_${id}`,
      metadata: signedMeta(
        {
          email: details.email,
          items: JSON.stringify(
            listings.map((listing, index) => ({
              e: listingIds[index]!,
              p: listing.price,
              q: listing.quantity,
            })),
          ),
          name: details.payer,
        },
        details.amountTotal,
      ),
      paymentIntent: `pi_${id}`,
      sessionId: `cs_${id}`,
    }),
    `re_${id}`,
  );

  const attendee = await expectMergedMultiListingAttendee(
    listingIds[0]!,
    listingIds[1]!,
  );
  await expectSessionFailed(`cs_${id}`);
  return { attendee, mockRefund };
};

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { requirePublicDefaultStatus } from "#db/attendee-statuses.ts";
import { settings } from "#db/settings.ts";
import { bookFreeOrder } from "#test/integration/server/_shared-setup.ts";
import { stubWebhookFetch } from "#test/shared/webhook/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestListingOverrides } from "#test-utils/factories.ts";
import {
  modifierUsageAmount,
  modifierUsageCount,
} from "#test-utils/modifiers.ts";
import {
  createOptionalAddOn,
  latestAttendee,
  submitBuyerOrder,
} from "#test-utils/reservation/helpers.ts";
import type { ListingWithCount } from "#types";

/** A public listing a buyer can book with no payment provider set up. */
const bookingListing = (
  unitPrice: number,
  overrides: TestListingOverrides = {},
): Promise<ListingWithCount> =>
  createTestListing({
    maxAttendees: 10,
    thankYouUrl: "https://example.com",
    unitPrice,
    ...overrides,
  });

/** Submit the buyer's order for `listing` and return the redirect plus the
 *  attendee it created. */
const bookLatestAttendee = async (
  listing: ListingWithCount,
  fields: Record<string, string> = {},
) => {
  const response = await submitBuyerOrder(listing, fields);
  expect(response.status).toBe(302);
  return { attendee: await latestAttendee(), response };
};

/** Assert what a booking charged and what it still owes. */
const expectOwed = (
  attendee: { remainingBalance: number; pricePaid: number },
  pricePaid: number,
  remainingBalance: number,
): void => {
  expect(attendee.pricePaid).toBe(pricePaid);
  expect(attendee.remainingBalance).toBe(remainingBalance);
};

describeWithEnv(
  "server (booking without a payment provider)",
  { db: true },
  () => {
    const webhook = stubWebhookFetch();

    test("books a paid listing owing its full value when no provider is set up", async () => {
      // No setupStripe: payments are disabled. A booking fee is configured to
      // prove it is never folded into the amount owed when no payment is taken.
      await settings.update.bookingFee("10");
      // The seeded public-default status is the plain non-reservation
      // "Confirmed", so the full balance is owed regardless of any configured
      // reservation amount — exactly as a zero-deposit reservation behaves.
      const status = await requirePublicDefaultStatus();
      const listing = await bookingListing(1000, {
        maxQuantity: 5,
        webhookUrl: "https://example.com/hook",
      });

      // The order comes through just like a normal free reservation.
      const attendee = await bookFreeOrder(listing, {
        [`quantity${listing.id}`]: "2",
      });
      // Nothing collected up front; the full £20.00 (2 × £10.00) is owed, with
      // no booking fee added (no payment was processed). price_paid projects the
      // gross sale leg (£20 billed), not cash collected — the accepted gross-sale
      // divergence; the £20 owed is exact (no payment leg offsets the sale).
      expectOwed(attendee, 2000, 2000);
      expect(attendee.statusId).toBe(status!.id);
      const payload = webhook.firstBody();
      expect(payload.price_paid).toBe(0);
      expect(payload.amount_owed).toBe(2000);
    });

    test("a free listing still owes nothing without a provider", async () => {
      const listing = await bookingListing(0);

      const { attendee, response } = await bookLatestAttendee(listing);

      // A redirect is not an indexable page: only 2xx answers carry
      // index, follow.
      expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expectOwed(attendee, 0, 0);
    });

    test("folds add-on impact into the owed balance without a provider", async () => {
      const listing = await bookingListing(1000);
      const addOn = await createOptionalAddOn();

      const { attendee } = await bookLatestAttendee(listing, {
        [`addon${addOn.id}`]: "1",
      });

      // £10.00 ticket + £5.00 add-on = £15.00 owed, nothing collected up front.
      // price_paid projects the gross sale leg (£10 ticket list); the add-on is a
      // separate modifier leg, so it doesn't add to the sale. The £15 owed (ticket
      // + add-on) is exact.
      expectOwed(attendee, 1000, 1500);
      // The add-on impact and stock are recorded just as a zero-deposit
      // reservation's would be, even though no money changed hands.
      expect(await modifierUsageCount(addOn.id)).toBe(1);
      expect(await modifierUsageAmount(addOn.id)).toBe(500);
    });
  },
);

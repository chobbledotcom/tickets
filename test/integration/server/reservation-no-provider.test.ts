import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { requirePublicDefaultStatus } from "#shared/db/attendee-statuses.ts";
import { settings } from "#shared/db/settings.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { bookFreeOrder } from "#test/lib/server-reservation/_shared-setup.ts";
import {
  createOptionalAddOn,
  latestAttendee,
  submitBuyerOrder,
} from "#test/lib/server-reservation/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  modifierUsageAmount,
  modifierUsageCount,
} from "#test-utils/modifiers.ts";

describeWithEnv(
  "server (booking without a payment provider)",
  { db: true },
  () => {
    afterEach(() => resetStripeClient());

    test("books a paid listing owing its full value when no provider is set up", async () => {
      // No setupStripe: payments are disabled. A booking fee is configured to
      // prove it is never folded into the amount owed when no payment is taken.
      await settings.update.bookingFee("10");
      // The seeded public-default status is the plain non-reservation
      // "Confirmed", so the full balance is owed regardless of any configured
      // reservation amount — exactly as a zero-deposit reservation behaves.
      const status = await requirePublicDefaultStatus();
      const listing = await createTestListing({
        maxAttendees: 10,
        maxQuantity: 5,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });

      // The order comes through just like a normal free reservation.
      const attendee = await bookFreeOrder(listing, {
        [`quantity_${listing.id}`]: "2",
      });
      // Nothing collected up front; the full £20.00 (2 × £10.00) is owed, with
      // no booking fee added (no payment was processed). price_paid projects the
      // gross sale leg (£20 billed), not cash collected — the accepted gross-sale
      // divergence; the £20 owed is exact (no payment leg offsets the sale).
      expect(attendee.pricePaid).toBe(2000);
      expect(attendee.remainingBalance).toBe(2000);
      expect(attendee.statusId).toBe(status!.id);
    });

    test("a free listing still owes nothing without a provider", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 0,
      });

      const response = await submitBuyerOrder(listing);

      expect(response.status).toBe(302);
      const attendee = await latestAttendee();
      expect(attendee.pricePaid).toBe(0);
      expect(attendee.remainingBalance).toBe(0);
    });

    test("folds add-on impact into the owed balance without a provider", async () => {
      const listing = await createTestListing({
        maxAttendees: 10,
        thankYouUrl: "https://example.com",
        unitPrice: 1000,
      });
      const addOn = await createOptionalAddOn();

      const response = await submitBuyerOrder(listing, {
        [`addon_${addOn.id}`]: "1",
      });

      expect(response.status).toBe(302);
      const attendee = await latestAttendee();
      // £10.00 ticket + £5.00 add-on = £15.00 owed, nothing collected up front.
      // price_paid projects the gross sale leg (£10 ticket list); the add-on is a
      // separate modifier leg, so it doesn't add to the sale. The £15 owed (ticket
      // + add-on) is exact.
      expect(attendee.pricePaid).toBe(1000);
      expect(attendee.remainingBalance).toBe(1500);
      // The add-on impact and stock are recorded just as a zero-deposit
      // reservation's would be, even though no money changed hands.
      expect(await modifierUsageCount(addOn.id)).toBe(1);
      expect(await modifierUsageAmount(addOn.id)).toBe(500);
    });
  },
);

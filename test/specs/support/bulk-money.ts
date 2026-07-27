/**
 * The set-up the bulk-refund and pay-your-own-price stories share: several paid
 * places on one listing, the organiser's refund-everyone page, and a listing
 * whose customers may pay more than it asks.
 */

import { expect } from "@std/expect";
import type { Stub } from "@std/testing/mock";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import { runStripeSuccess } from "#test/specs/support/money-drivers.ts";
import { withRefundMock } from "#test-utils/refund-routes.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { singleItem } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** The payment the provider will turn down — the middle one, so the story
 * proves the refunds after it still run. */
const DECLINED_PAYMENT = "pi_bulk_2";

/** One listing, one paid place each for the named people. */
export const paidPlaceEach = async (
  world: TicketsWorld,
  name: string,
  price: string,
  people: string[],
): Promise<void> => {
  await setupStripe();
  const listing = await createTestListing({
    maxAttendees: 50,
    name,
    unitPrice: minorUnits(price),
  });
  world.listingIds.set(name, listing.id);
  world.listingId = listing.id;
  world.confirmName = name;
  world.attendeeIds = [];
  for (const [index, who] of people.entries()) {
    const attendee = await createPaidTestAttendee(
      listing.id,
      who,
      `${who.toLowerCase()}@example.com`,
      `pi_bulk_${index + 1}`,
      minorUnits(price),
    );
    world.attendeeIds.push(attendee.id);
  }
};

/** The organiser refunds everyone from the listing's own refund-everyone page,
 * typing the listing name it asks for. The provider turns one payment down. */
export const everyoneRefunded = async (world: TicketsWorld): Promise<void> => {
  const listingId = requiredWorldValue(world.listingId, "the listing");
  const browser = await adminBrowser(world);
  await withRefundMock(
    (paymentId: string) => Promise.resolve(paymentId !== DECLINED_PAYMENT),
    async (mockRefund: Stub) => {
      await browser.visit(`/admin/listing/${listingId}/refund-all`);
      // The page must ask for the listing's name before it will refund anyone,
      // and it is typed in exactly as the story named it.
      expect(browser.currentHtml).toContain('name="confirm_identifier"');
      await browser.submitForm(
        {
          confirm_identifier: requiredWorldValue(
            world.confirmName,
            "the listing name to type",
          ),
        },
        "Refund All Attendees",
      );
      world.bulkRefundMessage = browser.pageText;
      world.refundCalls = () => mockRefund.calls.length;
    },
  );
};

/** Who got their money back, and who the provider turned down. */
export const refundedPeople = (
  world: TicketsWorld,
): { refunded: number[]; turnedDown: number } => {
  const paid = requiredWorldValue(world.attendeeIds, "the people who paid");
  if (paid.length !== 3) {
    throw new Error(`Expected three people to have paid, found ${paid.length}`);
  }
  const [first, second, third] = paid as [number, number, number];
  return { refunded: [first, third], turnedDown: second };
};

/** A listing that asks one price but lets a customer pay more. */
export const payMoreListing = async (
  world: TicketsWorld,
  name: string,
  asks: string,
): Promise<void> => {
  await setupStripe();
  const listing = await createTestListing({
    canPayMore: true,
    maxAttendees: 50,
    maxPrice: minorUnits("100.00"),
    name,
    unitPrice: minorUnits(asks),
  });
  world.listingIds.set(name, listing.id);
  world.listingId = listing.id;
};

/** The customer pays the amount they chose, through the real payment return. */
export const payYourOwnPrice = async (
  world: TicketsWorld,
  chosen: string,
): Promise<void> => {
  const listingId = requiredWorldValue(world.listingId, "the listing");
  const paid = minorUnits(chosen);
  await runStripeSuccess({
    email: "generous@example.com",
    items: singleItem(listingId, 1, paid),
    name: "Generous",
    paymentIntent: "pi_pay_more",
    sessionId: "cs_pay_more",
    total: paid,
  });
  world.attendeeId = (await getAttendeesRaw(listingId))[0]!.id;
};

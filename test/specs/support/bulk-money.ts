/**
 * The set-up the bulk-refund and pay-your-own-price stories share: several paid
 * places on one listing, the organiser's refund-everyone page, and a listing
 * whose customers may pay more than it asks.
 */

// jscpd:ignore-start
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import { sellSomethingAt } from "#test/specs/support/listings.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  refundByTyping,
  runStripeSuccess,
} from "#test/specs/support/money-drivers.ts";
import {
  type ActOnSomeMoney,
  requiredWorldValue,
  type TicketsWorld,
  theListing,
} from "#test/specs/support/world.ts";
import { singleItem } from "#test-utils/factories.ts";
import {
  refundCompletes,
  refundIsRejected,
} from "#test-utils/refund-routes.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

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
  const listing = await sellSomethingAt(world, name, price);
  world.confirmName = name;
  world.attendeeIds = [];
  for (const [index, who] of people.entries()) {
    const number = index + 1;
    const paid = minorUnits(price);
    world.attendeeIds.push(
      await runStripeSuccess(world, {
        email: `${who.toLowerCase()}@example.com`,
        items: singleItem(listing.id, 1, paid),
        name: who,
        paymentIntent: `pi_bulk_${number}`,
        sessionId: `cs_bulk_${number}`,
        total: paid,
      }),
    );
  }
};

/** The organiser refunds everyone from the listing's own refund-everyone page,
 * typing the listing name it asks for. The provider turns one payment down. */
export const everyoneRefunded = async (world: TicketsWorld): Promise<void> => {
  const browser = await refundByTyping(
    world,
    {
      buttonText: "Refund All Attendees",
      page: `/admin/listing/${theListing(world)}/refund-all`,
      typed: requiredWorldValue(world.confirmName, "the listing name to type"),
    },
    (request) =>
      request.paymentReference === DECLINED_PAYMENT
        ? refundIsRejected(request)
        : refundCompletes(request),
  );
  world.bulkRefundMessage = browser.pageText;
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
  await sellSomethingAt(world, name, asks, { canPayMore: true });
};

/** The customer pays the amount they chose, through the real payment return. */
export const payYourOwnPrice: ActOnSomeMoney = async (world, chosen) => {
  const listingId = theListing(world);
  const paid = minorUnits(chosen);
  world.attendeeId = await runStripeSuccess(world, {
    email: "generous@example.com",
    items: singleItem(listingId, 1, paid),
    name: "Generous",
    paymentIntent: "pi_pay_more",
    sessionId: "cs_pay_more",
    total: paid,
  });
  // The statement that has to show what they chose rather than what was asked.
  leaveEvidencePage(
    world,
    ["paid-more-than-asked"],
    `/admin/ledger/revenue/${listingId}`,
  );
};

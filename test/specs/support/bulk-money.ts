/**
 * The set-up the bulk-refund and pay-your-own-price stories share: several paid
 * places on one listing, the organiser's refund-everyone page, and a listing
 * whose customers may pay more than it asks.
 */

// jscpd:ignore-start
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import { createRefundableTestAttendee } from "#test/features/admin/refunds-helpers.ts";
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
  const listing = await sellSomethingAt(world, name, price);
  world.confirmName = name;
  world.attendeeIds = [];
  for (const [index, who] of people.entries()) {
    // Who can be refunded is read from the payment record and the money on it,
    // so each place needs one behind it, not only a payment name on the row.
    // The site is left un-set-up for Stripe on purpose: the refund driver then
    // stands in the same account these payments were made on, and a refund only
    // goes out on its own account.
    const attendee = await createRefundableTestAttendee(
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
  const browser = await refundByTyping(
    world,
    {
      buttonText: "Refund All Attendees",
      page: `/admin/listing/${theListing(world)}/refund-all`,
      typed: requiredWorldValue(world.confirmName, "the listing name to type"),
    },
    (paymentId: string) => Promise.resolve(paymentId !== DECLINED_PAYMENT),
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
  await runStripeSuccess({
    email: "generous@example.com",
    items: singleItem(listingId, 1, paid),
    name: "Generous",
    paymentIntent: "pi_pay_more",
    sessionId: "cs_pay_more",
    total: paid,
  });
  world.attendeeId = (await getAttendeesRaw(listingId))[0]!.id;
  // The statement that has to show what they chose rather than what was asked.
  leaveEvidencePage(
    world,
    ["paid-more-than-asked"],
    `/admin/ledger/revenue/${listingId}`,
  );
};

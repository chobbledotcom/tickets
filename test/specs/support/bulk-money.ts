/**
 * The set-up the bulk-refund and pay-your-own-price stories share: several paid
 * places on one listing, the organiser's refund-everyone page, and a listing
 * whose customers may pay more than it asks.
 */

import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import {
  minorUnits,
  refundByTyping,
  sellSomethingAt,
} from "#test/specs/support/money.ts";
import { runStripeSuccess } from "#test/specs/support/money-drivers.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
  theListing,
} from "#test/specs/support/world.ts";
import { createPaidAttendeeWithoutLedger } from "#test-utils/db-helpers/attendee-payments.ts";
import { postPaymentLeg } from "#test-utils/db-helpers/payment-leg.ts";
import { singleItem } from "#test-utils/factories.ts";
import { createAggregatePayment } from "#test-utils/payment-aggregate.ts";
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
  const listing = await sellSomethingAt(world, name, price);
  world.confirmName = name;
  world.attendeeIds = [];
  for (const [index, who] of people.entries()) {
    const reference = `pi_bulk_${index + 1}`;
    const paymentId = `cs_bulk_${index + 1}`;
    const attendee = await createPaidAttendeeWithoutLedger(
      listing.id,
      who,
      `${who.toLowerCase()}@example.com`,
      reference,
      minorUnits(price),
    );
    // The refund-everyone page works from the payment the site recorded, and
    // gives the money back by reversing that payment's own ledger entries, so
    // the sale has to be filed under the payment rather than on its own.
    await postPaymentLeg(
      attendee.id,
      minorUnits(price),
      paymentId,
      listing.id,
      minorUnits(price),
    );
    await createAggregatePayment({
      attendeeId: attendee.id,
      charges: [{ amount: minorUnits(price), reference }],
      configuredAccount: true,
      paymentId,
    });
    world.attendeeIds.push(attendee.id);
  }
};

/** The organiser refunds everyone from the listing's own refund-everyone page,
 * typing the listing name it asks for. The provider turns one payment down. */
export const everyoneRefunded = async (world: TicketsWorld): Promise<void> => {
  const listingId = theListing(world);
  world.bulkRefundMessage = await refundByTyping(
    world,
    {
      button: "Refund All Attendees",
      path: `/admin/listing/${listingId}/refund-all`,
      typed: requiredWorldValue(world.confirmName, "the listing name to type"),
    },
    (paymentId: string) => Promise.resolve(paymentId !== DECLINED_PAYMENT),
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
  await sellSomethingAt(world, name, asks, { canPayMore: true });
};

/** The customer pays the amount they chose, through the real payment return. */
export const payYourOwnPrice = async (
  world: TicketsWorld,
  chosen: string,
): Promise<void> => {
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
};

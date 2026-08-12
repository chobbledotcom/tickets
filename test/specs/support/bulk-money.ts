/**
 * The set-up the bulk-refund and pay-your-own-price stories share: several paid
 * places on one listing, the organiser's refund-everyone page, and a listing
 * whose customers may pay more than it asks.
 */

// jscpd:ignore-start
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import { expect } from "@std/expect";
import { sellSomethingAt } from "#test/specs/support/listings.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  refundByTyping,
  runStripeSuccess,
} from "#test/specs/support/money-drivers.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import {
  type ActOnSomeMoney,
  requiredWorldValue,
  theListing,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { singleItem } from "#test-utils/factories.ts";
import {
  refundCompletes,
  refundIsRejected,
} from "#test-utils/refund-routes.ts";
import { chargeMoney, refundObservation } from "#test-utils/payment-state.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

/** The payment the provider will turn down — the middle one, so the story
 * proves the refunds after it still run. */
const DECLINED_PAYMENT = "pi_bulk_2";
const FIRST_PAYMENT = "pi_bulk_1";

type RefundAnswer = Parameters<typeof refundByTyping>[2];

const firstAttendeeId = (world: TicketsWorld): number => {
  const first = requiredWorldValue(world.attendeeIds, "the people who paid")[0];
  if (first === undefined) throw new Error("No first paid attendee");
  return first;
};

const firstProviderCharge = (world: TicketsWorld) => {
  const charge = world.providerCharges.get(FIRST_PAYMENT);
  if (charge === undefined) {
    throw new Error(`The provider has no charge ${FIRST_PAYMENT}`);
  }
  return charge;
};

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

/** Submit the listing's served Refund All form with one provider behaviour. */
const refundEveryone = async (
  world: TicketsWorld,
  answer: RefundAnswer,
): Promise<void> => {
  const browser = await refundByTyping(
    world,
    {
      buttonText: "Refund All Attendees",
      page: `/admin/listing/${theListing(world)}/refund-all`,
      typed: requiredWorldValue(world.confirmName, "the listing name to type"),
    },
    answer,
  );
  world.bulkRefundMessage = browser.pageText;
};

/** The provider turns down the middle payment while the others complete. */
export const everyoneRefunded = (world: TicketsWorld): Promise<void> =>
  refundEveryone(
    world,
    (request) =>
      request.paymentReference === DECLINED_PAYMENT
        ? refundIsRejected(request)
        : refundCompletes(request),
  );

/** Try Refund All with a provider that would return every payment it receives. */
export const tryToRefundEveryone = (world: TicketsWorld): Promise<void> =>
  refundEveryone(world, refundCompletes);

/** Give the first charge a provider report that cannot be true. */
export const contradictFirstPayment = (world: TicketsWorld): void => {
  const charge = firstProviderCharge(world);
  const returned = {
    amount: charge.captured.amount + 1,
    currency: charge.captured.currency,
  };
  world.providerCharges.set(FIRST_PAYMENT, {
    ...charge,
    confirmedRefunded: returned,
    refunds: [
      refundObservation({
        amount: returned,
        refund: {
          id: "re_bulk_contradiction",
          kind: "stripe_refund",
          parentId: FIRST_PAYMENT,
          provider: "stripe",
        },
      }),
    ],
  });
};

/** Use the real single-refund and review forms for the first paid attendee. */
export const acknowledgeFirstPaymentReview = async (
  world: TicketsWorld,
): Promise<void> => {
  const browser = await refundByTyping(
    world,
    {
      buttonText: "Refund Attendee",
      page: `/admin/attendees/${firstAttendeeId(world)}/refund`,
      typed: "One",
    },
    refundCompletes,
  );
  expect(requiredWorldValue(world.refundCalls, "first refund calls")()).toBe(0);
  await browser.clickLink("Mark payment reviewed");
  await fillInAndSend(
    browser,
    { confirm_identifier: "One" },
    "Mark payment reviewed",
  );
  expect(browser.containsText("Payment review acknowledged")).toBe(true);
};

/** Replace the contradictory report with an untouched charge. */
export const correctFirstPayment = (world: TicketsWorld): void => {
  const charge = firstProviderCharge(world);
  world.providerCharges.set(
    FIRST_PAYMENT,
    chargeMoney(charge.captured.amount, 0, charge.captured.currency),
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

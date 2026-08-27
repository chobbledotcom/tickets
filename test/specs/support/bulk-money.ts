/**
 * The set-up the bulk-refund and pay-your-own-price stories share: several paid
 * places on one listing, the organiser's refund-everyone page, and a listing
 * whose customers may pay more than it asks.
 */

import { expect } from "@std/expect";
import { execute } from "#db/client.ts";
import type { ChargeMoney } from "#payment/resources.ts";
// jscpd:ignore-start
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import {
  browserSeenBy,
  ORGANISER,
  openAdminPage,
} from "#test/specs/support/browser.ts";
import { usableInputsOfKind } from "#test/specs/support/form-controls/reading.ts";
import { sellSomethingAt } from "#test/specs/support/listings.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  refundByTyping,
  runStripeSuccess,
} from "#test/specs/support/money-drivers.ts";
import { openListedRefundCase } from "#test/specs/support/refund-safety/journeys.ts";
import {
  type ActOnSomeMoney,
  type ActOnTheStory,
  requiredWorldValue,
  type TicketsWorld,
  theListing,
} from "#test/specs/support/world.ts";
import { singleItem } from "#test-utils/factories.ts";
import { chargeMoney, refundObservation } from "#test-utils/payment-state.ts";
import {
  finalizeProcessedPayment,
  taggedPaymentReference,
} from "#test-utils/processed-payments.ts";
import { getCompleteRefundCandidatesForListing } from "#test-utils/refund-candidates.ts";
import {
  refundCompletes,
  refundIsRejected,
  withRefundMock,
} from "#test-utils/refund-routes.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

const FIRST_PAYMENT = "pi_bulk_1";

type RefundAnswer = Parameters<typeof refundByTyping>[2];
type RefundFormTarget = "attendee" | "listing";

const REFUND_FORM_BY_TARGET = {
  attendee: {
    buttonText: "Refund Attendee",
    page: (id: number) => `/admin/attendees/${id}/refund`,
  },
  listing: {
    buttonText: "Refund All Attendees",
    page: (id: number) => `/admin/listing/${id}/refund-all`,
  },
} satisfies Record<
  RefundFormTarget,
  { buttonText: string; page: (id: number) => string }
>;

const sendRefundForm = (
  world: TicketsWorld,
  target: RefundFormTarget,
  id: number,
  typed: string,
  answer: RefundAnswer,
) => {
  const form = REFUND_FORM_BY_TARGET[target];
  return refundByTyping(
    world,
    { buttonText: form.buttonText, page: form.page(id), typed },
    answer,
  );
};

const firstAttendeeId = (world: TicketsWorld): number => {
  const first = requiredWorldValue(world.attendeeIds, "the people who paid")[0];
  if (first === undefined) throw new Error("No first paid attendee");
  return first;
};

/** Reproduce an old PII-only deposit followed by one modern balance payment. */
export const leaveOnlyLaterIndexedPayment: ActOnTheStory = async (world) => {
  const attendeeId = firstAttendeeId(world);
  await execute("DELETE FROM processed_payments WHERE attendee_id = ?", [
    attendeeId,
  ]);
  await execute(
    "UPDATE attendees SET pii_payment_session_id = NULL WHERE id = ?",
    [attendeeId],
  );
  await finalizeProcessedPayment(
    `later-balance-${attendeeId}`,
    attendeeId,
    "",
    taggedPaymentReference("pi_later_indexed_balance"),
  );
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
  const browser = await sendRefundForm(
    world,
    "listing",
    theListing(world),
    requiredWorldValue(world.confirmName, "the listing name to type"),
    answer,
  );
  world.bulkRefundMessage = browser.pageText;
};

/** Refund All, with one provider behaviour behind it. */
const refundingEveryone =
  (answer: RefundAnswer) =>
  (world: TicketsWorld): Promise<void> =>
    refundEveryone(world, answer);

/** Submit one bounded Refund All step that the provider refuses. */
export const refuseNextRefund = refundingEveryone(refundIsRejected);

/** Try Refund All with a provider that would return every payment it receives. */
export const tryToRefundEveryone = refundingEveryone(refundCompletes);

/** Open the listing-wide refund page without reaching around a missing form. */
export const openRefundEveryone: ActOnTheStory = async (world) => {
  await withRefundMock(refundCompletes, async (mockRefund) => {
    const browser = await openAdminPage(
      world,
      REFUND_FORM_BY_TARGET.listing.page(theListing(world)),
    );
    world.bulkRefundMessage = browser.pageText;
    world.refundCalls = () => mockRefund.calls.length;
  });
};

/** The blocked page explains the state but cannot submit a refund. */
export const expectRefundEveryoneUnavailable = (world: TicketsWorld): void => {
  const html = browserSeenBy(world, ORGANISER).currentHtml;
  expect(html).not.toContain("Refund All Attendees");
  expect(html).not.toContain(
    `action="${REFUND_FORM_BY_TARGET.listing.page(theListing(world))}"`,
  );
};

/** Prove the reviewed payment is the final member of the complete command. */
export const firstPaymentIsLastRefundCandidate: ActOnTheStory = async (
  world,
) => {
  const candidates = await getCompleteRefundCandidatesForListing(
    theListing(world),
  );
  expect(candidates).toHaveLength(
    requiredWorldValue(world.attendeeIds, "the people who paid").length,
  );
  expect(candidates.at(-1)?.attendee.id).toBe(firstAttendeeId(world));
};

/** Replace what the provider says about the first charge, worked out from
 * what it says now. */
const reportFirstChargeAs = (
  world: TicketsWorld,
  report: (charge: ChargeMoney) => ChargeMoney,
): void => {
  world.providerCharges.set(FIRST_PAYMENT, report(firstProviderCharge(world)));
};

/** One step that changes what the provider says about the first charge. */
const reportingFirstChargeAs =
  (report: (charge: ChargeMoney) => ChargeMoney) =>
  (world: TicketsWorld): void => {
    reportFirstChargeAs(world, report);
  };

/** Give the first charge a provider report that cannot be true. */
export const contradictFirstPayment = reportingFirstChargeAs((charge) => {
  const returned = {
    amount: charge.captured.amount + 1,
    currency: charge.captured.currency,
  };
  return {
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
  };
});

/** Use the real single-refund form and leave its canonical owner case open. */
export const leaveFirstRefundCaseForOwner: ActOnTheStory = async (world) => {
  const browser = await sendRefundForm(
    world,
    "attendee",
    firstAttendeeId(world),
    "One",
    refundCompletes,
  );
  expect(requiredWorldValue(world.refundCalls, "first refund calls")()).toBe(0);
  await browser.clickLink("Settings");
  await browser.clickLink("Privacy");
  expect(browser.containsText("Refunds needing attention")).toBe(true);
  await openListedRefundCase(browser);
  expect(browser.pageText).toContain("Check the provider again");
  expect(browser.currentHtml).toContain(
    'name="choice" type="hidden" value="check_again"',
  );
  expect(usableInputsOfKind(browser.currentHtml, "radio")).toEqual([]);
};

/** Replace the contradictory report with an untouched charge. */
export const correctFirstPayment = reportingFirstChargeAs((charge) =>
  chargeMoney(charge.captured.amount, 0, charge.captured.currency),
);

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

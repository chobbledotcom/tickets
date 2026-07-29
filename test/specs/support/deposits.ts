/**
 * The set-up the part-payment stories share: a place someone owes for but has
 * not paid, a deposit against it, and settling the rest.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { signBalanceToken } from "#shared/balance-link.ts";
import { settleAttendeeBalance } from "#shared/db/attendees/balance.ts";
import { sellSomethingAt } from "#test/specs/support/listings.ts";
import { minorUnits } from "#test/specs/support/money.ts";
import {
  type ActOnSomeMoney,
  type TicketsWorld,
  theBooking,
  theListing,
} from "#test/specs/support/world.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { postListingSale } from "#test-utils/ledger.ts";
import { awaitTestRequest } from "#test-utils/mocks.ts";
// jscpd:ignore-end

/** A place taken but not paid for, so the whole price is owed. */
export const unpaidPlace = async (
  world: TicketsWorld,
  name: string,
  price: string,
): Promise<void> => {
  const listing = await sellSomethingAt(world, name, price);
  const email = `${name.toLowerCase().replaceAll(" ", "-")}@example.com`;
  const attendee = await createTestAttendee(
    listing.id,
    listing.slug,
    `${name} Payer`,
    email,
  );
  world.attendeeId = attendee.id;
  world.attendeeEmail = email;
  world.attendeeName = `${name} Payer`;
};

/** Part of what they owe, paid now. */
export const payDeposit: ActOnSomeMoney = async (world, amount) => {
  await postListingSale({
    amountPaid: minorUnits(amount),
    attendeeId: theBooking(world),
    // Nothing new is sold — this is only the money handed over.
    gross: 0,
    listingId: theListing(world),
  });
};

/**
 * The page a part-paid customer opens from their payment link.
 *
 * The token is kept on the world so an evidence capture can open the same
 * link the story just read: the page exists only at a signed URL, so a
 * screenshot of it cannot be taken from a path written by hand.
 */
export const balancePageHtml = async (world: TicketsWorld): Promise<string> => {
  const token = await signBalanceToken(theBooking(world));
  world.evidenceValues.set("balanceToken", token);
  const response = await awaitTestRequest(`/pay/${token}`);
  expect(response.status).toBe(200);
  return response.text();
};

/** The organiser settles what is left, the way the site settles it. */
export const settleTheRest: ActOnSomeMoney = async (world, amount) => {
  const result = await settleAttendeeBalance(
    theBooking(world),
    minorUnits(amount),
    { id: "settle-story", occurredAt: "2026-06-22T00:00:00.000Z" },
  );
  expect(result.settled).toBe(true);
};

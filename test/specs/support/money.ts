/**
 * The money set-up every payment story shares: sell a place, pay for it, and
 * hand the refund driver's call count to the World so a Then can check whether
 * the provider was asked.
 */

import { expect } from "@std/expect";
import type { Stub } from "@std/testing/mock";
import type { Listing } from "#shared/types.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { expectFlashRedirect } from "#test-utils/assertions.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  completePaidOrder,
  submitRefund,
  withRefundMock,
} from "#test-utils/money/drivers.ts";
import { setupStripe } from "#test-utils/settings.ts";

/** The id of a listing the story put on sale, by the name it used. */
export const listingIdFor = (world: TicketsWorld, name: string): number =>
  requiredWorldValue(world.listingIds.get(name), `${name} listing id`);

/** The booking the story is about. */
export const bookingId = (world: TicketsWorld): number =>
  requiredWorldValue(world.attendeeId, "attendee id");

/** Pounds as the minor units the ledger stores, so a story can say "45.00". */
export const minorUnits = (pounds: string): number =>
  Math.round(Number(pounds) * 100);

/** A listing that sells places at the given price, remembered by name. */
export const sellPlacesAt = async (
  world: TicketsWorld,
  name: string,
  pounds: string,
): Promise<Listing> => {
  const listing = await createTestListing({
    maxAttendees: 50,
    name,
    unitPrice: minorUnits(pounds),
  });
  world.listingIds.set(name, listing.id);
  return listing;
};

/** One customer pays in full for one place, through the real payment return. */
export const buyOnePlace = async (
  world: TicketsWorld,
  name: string,
  pounds: string,
  who: string,
): Promise<number> => {
  await setupStripe();
  const { id: listingId } = await sellPlacesAt(world, name, pounds);
  const attendeeId = await completePaidOrder(
    listingId,
    who,
    `${who.toLowerCase().replaceAll(" ", ".")}@example.com`,
    minorUnits(pounds),
    `cs_${name.toLowerCase().replaceAll(" ", "_")}`,
    `pi_${name.toLowerCase().replaceAll(" ", "_")}`,
  );
  world.attendeeId = attendeeId;
  world.attendeeName = who;
  return attendeeId;
};

/** Ask for a refund with the provider answering `succeeds`, keeping the reply
 * and how many times the provider was asked. */
export const askForRefund = async (
  world: TicketsWorld,
  succeeds: boolean,
): Promise<void> => {
  const attendeeId = requiredWorldValue(world.attendeeId, "attendee id");
  const who = requiredWorldValue(world.attendeeName, "attendee name");
  await withRefundMock(succeeds, async (mockRefund: Stub) => {
    world.refundResponse = await submitRefund(attendeeId, who);
    world.refundCalls = () => mockRefund.calls.length;
  });
};

/** How many times the provider was asked to hand money back. */
export const timesProviderWasAsked = (world: TicketsWorld): number =>
  requiredWorldValue(world.refundCalls, "refund calls")();

/** The message the organiser was shown after asking for a refund. */
export const expectRefundMessage = (
  world: TicketsWorld,
  path: string,
  message: string,
  succeeded: boolean,
): Promise<Response> =>
  expectFlashRedirect(
    path,
    expect.stringContaining(message),
    succeeded,
  )(requiredWorldValue(world.refundResponse, "refund response"));

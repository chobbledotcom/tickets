/**
 * The money set-up every payment story shares: sell a place, pay for it, and
 * hand the refund driver's call count to the World so a Then can check whether
 * the provider was asked.
 */

import { expect } from "@std/expect";
// jscpd:ignore-start
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import { WORLD } from "#shared/accounting/accounts.ts";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import type { Listing } from "#shared/types.ts";
import { scenarioBrowser } from "#test/specs/support/browser.ts";
import { correctOnPage } from "#test/specs/support/corrections.ts";
import { sellSomethingAt } from "#test/specs/support/listings.ts";
import {
  completePaidOrder,
  refundByTyping,
  runStripeSuccess,
} from "#test/specs/support/money-drivers.ts";
import { attendeeLegsOfKind } from "#test/specs/support/money-reads.ts";
import { visitorBooks } from "#test/specs/support/public-booking.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { setupStripe } from "#test-utils/settings.ts";
// jscpd:ignore-end

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
): Promise<Listing> =>
  sellSomethingAt(world, name, pounds, { keepThankYouPage: true });

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
    world,
    listingId,
    who,
    `${who.toLowerCase().replaceAll(" ", ".")}@example.com`,
    minorUnits(pounds),
    `cs_${name.toLowerCase().replaceAll(" ", "_")}`,
    `pi_${name.toLowerCase().replaceAll(" ", "_")}`,
  );
  world.attendeeId = attendeeId;
  world.attendeeName = who;
  // What the listing earned is read from its own ledger page, and what one
  // booking has paid from its own, which is where captures of each figure go.
  leaveEvidencePage(
    world,
    ["listing-ledger"],
    `/admin/ledger/revenue/${listingId}`,
  );
  leaveEvidencePage(
    world,
    ["refunded-booking"],
    `/admin/attendees/${attendeeId}/ledger`,
  );
  return attendeeId;
};

/** The one booking a checkout made on a listing. Fails loudly when there is
 * not exactly one, so a story can never carry on against an arbitrary row. */
export const soleBookingOn = async (listingId: number): Promise<number> => {
  const bookings = await getAttendeesRaw(listingId);
  if (bookings.length !== 1) {
    throw new Error(
      `Expected one booking on listing ${listingId}, found ${bookings.length}`,
    );
  }
  return bookings[0]!.id;
};

/** Sell one place with an extra charge on top and pay the whole amount, the way
 * a real checkout does: the signed total must match what the site re-derives. */
export const buyPlaceWithExtra = async (
  world: TicketsWorld,
  name: string,
  pounds: string,
  extraPounds: string,
  who: string,
  modifierId?: number,
): Promise<void> => {
  await setupStripe();
  // The story may already have put this listing on sale (with its extra charge
  // attached), so reuse it rather than selling a second one of the same name.
  const listingId =
    world.things.recall("listing", name)?.id ??
    (await sellPlacesAt(world, name, pounds)).id;
  const price = minorUnits(pounds);
  world.attendeeId = await runStripeSuccess(world, {
    email: `${who.toLowerCase().replaceAll(" ", ".")}@example.com`,
    items: JSON.stringify([{ e: listingId, p: price, q: 1 }]),
    ...(modifierId === undefined
      ? {}
      : { modifiers: [{ i: modifierId, q: 1 }] }),
    name: who,
    paymentIntent: `pi_${name.toLowerCase().replaceAll(" ", "_")}`,
    sessionId: `cs_${name.toLowerCase().replaceAll(" ", "_")}`,
    total: price + minorUnits(extraPounds),
  });
  world.attendeeName = who;
};

/** One of the booking's own admin pages. */
export const bookingPagePath = (world: TicketsWorld, page: string): string =>
  `/admin/attendees/${bookingId(world)}/${page}`;

/** Ask for a refund the way the organiser does: open the booking's refund page,
 * type the name it asks for into its own form, and submit that form. The
 * provider answers `succeeds`. Keeps how many times it was asked. */
export const askForRefund = async (
  world: TicketsWorld,
  succeeds: boolean,
): Promise<void> => {
  await refundByTyping(
    world,
    {
      buttonText: "Refund Attendee",
      page: bookingPagePath(world, "refund"),
      typed: requiredWorldValue(world.attendeeName, "attendee name"),
    },
    succeeds,
  );
};

/** Set a listing's income through the correction form on its own edit page, and
 * check the organiser is told it worked — a failed save redirects too, so a bare
 * redirect would not show the difference. */
export const correctIncomeTo = async (
  world: TicketsWorld,
  listingId: number,
  pounds: string,
): Promise<void> => {
  await correctOnPage(
    world,
    `/admin/listing/${listingId}/edit`,
    "income",
    pounds,
    "Listing income corrected.",
  );
};

/** A member of the public books one free place through the listing's own page. */
export const bookFreePlace = async (
  world: TicketsWorld,
  listing: Listing,
  who: string,
  email: string,
): Promise<void> => {
  await visitorBooks(world, listing, { email, who });
  world.attendeeId = await soleBookingOn(listing.id);
};

/** How many times the provider was asked to hand money back. */
export const timesProviderWasAsked = (world: TicketsWorld): number =>
  requiredWorldValue(world.refundCalls, "refund calls")();

/** The customer got their money back: one refund of the whole payment, returned
 * where it came from, with the provider asked exactly once. */
export const expectMoneyHandedBack = async (
  world: TicketsWorld,
  minor: number,
): Promise<void> => {
  expect(timesProviderWasAsked(world)).toBe(1);
  const handedBack = await attendeeLegsOfKind(bookingId(world), "refund_cash");
  expect(handedBack.length).toBe(1);
  expect(handedBack[0]!.amount).toBe(minor);
  expect(handedBack[0]!.destination).toEqual(WORLD);
};

/** Where the organiser landed after asking for a refund, and what they were
 * told there. */
export const expectRefundMessage = (
  world: TicketsWorld,
  path: string,
  message: string,
): void => {
  // Read the page the refund left behind — asking for an admin browser here
  // would navigate away from it first.
  const browser = scenarioBrowser(world);
  expect(browser.currentUrl).toBe(path);
  expect(browser.containsText(message)).toBe(true);
};

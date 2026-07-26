/**
 * The set-up the multi-day stay stories share. A "stay" is a booking on a
 * listing that is booked by the day and covers several days in a row, so these
 * helpers talk in days from today rather than fixed calendar dates — the days a
 * listing offers move with the calendar.
 */

import { expect } from "@std/expect";
import { getAttendeesRaw } from "#shared/db/attendees/queries.ts";
import type { Attendee, Listing } from "#shared/types.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";

/** Somebody new each time, so two stays are never taken for one person. */
export const guest = (order: number): { email: string; who: string } => ({
  email: `guest${order}@example.com`,
  who: `Guest ${order}`,
});

/** Every stay booked on a listing so far, newest last. */
export const staysOn = (
  world: TicketsWorld,
  name: string,
): Promise<Attendee[]> => getAttendeesRaw(stayListing(world, name).id);

/** The stay booked most recently on a listing. Fails loudly when nothing has
 * been booked, so a story never carries on with no stay to talk about. */
export const newestStayOn = async (
  world: TicketsWorld,
  name: string,
): Promise<number> => {
  const booked = await staysOn(world, name);
  const newest = booked.at(-1);
  if (!newest) throw new Error(`No stay has been booked on the ${name}`);
  return newest.id;
};

/** A day counted forward from today, written the way the site writes days. */
export const dayFromToday = (days: number): string => {
  const day = new Date();
  day.setUTCDate(day.getUTCDate() + days);
  return day.toISOString().slice(0, 10);
};

/** A listing booked by the day, where each booking covers `days` days and each
 * day has room for `placesADay` places. Remembered by the name the story uses. */
export const openStayListing = async (
  world: TicketsWorld,
  name: string,
  days: number,
  placesADay: number,
  options: { customerPicksDays?: boolean; groupId?: number } = {},
): Promise<Listing> => {
  const listing = await createDailyTestListing({
    durationDays: days,
    maxAttendees: placesADay,
    // Room to book several places at once, and the site's own thank-you page, so
    // a story reads what the customer is actually shown.
    maxQuantity: placesADay,
    name,
    thankYouUrl: "",
    ...(options.groupId === undefined ? {} : { groupId: options.groupId }),
    // A listing whose customers choose their own length needs a price for each
    // length they can pick.
    ...(options.customerPicksDays
      ? {
          customisableDays: true,
          dayPrices: Object.fromEntries(
            Array.from({ length: days }, (_, index) => [index + 1, 0]),
          ),
        }
      : {}),
  });
  return rememberStayListing(world, name, listing);
};

/** Keep a listing under the name the story calls it, so later steps can find
 * it however it was set up. */
export const rememberStayListing = (
  world: TicketsWorld,
  name: string,
  listing: Listing,
): Listing => {
  world.listingIds.set(name, listing.id);
  world.stayListings ??= new Map();
  world.stayListings.set(name, listing);
  return listing;
};

/** The listing a story set up under this name. */
export const stayListing = (world: TicketsWorld, name: string): Listing =>
  requiredWorldValue(world.stayListings?.get(name), `${name} stay listing`);

/** Change how many days each new stay covers, through the listing's own edit
 * form — so a page that stops offering the field fails the story. The organiser
 * is told it saved, because a refused save redirects just the same. */
export const changeStayLength = async (
  world: TicketsWorld,
  name: string,
  days: number,
): Promise<string> => {
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/listing/${stayListing(world, name).id}/edit`);
  expect(browser.currentHtml).toContain('name="duration_days"');
  await browser.submitForm({ duration_days: String(days) }, "Save Changes");
  expect(browser.containsText("Listing updated")).toBe(true);
  return browser.pageText;
};

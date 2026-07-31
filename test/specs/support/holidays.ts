/**
 * Holidays, as the organiser declares and deletes them. Both halves drive the
 * real admin forms; what a holiday does to a listing's days is read off the
 * listing's own booking page, the way a customer would meet it.
 */

import { openAdminPage } from "#test/specs/support/browser.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { rememberListing } from "#test/specs/support/listings.ts";
import { daysOfferedFor } from "#test/specs/support/public-booking.ts";
import { dayFromToday } from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import {
  createDailyTestListing,
  createTestListing,
} from "#test-utils/db-helpers/listings.ts";

/** Something bookable by the day, every day, so any day a story finds gone
 * can only be gone because of the holiday. */
export const sellsDayPlaces = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  rememberListing(world, name, await createDailyTestListing({ name }));
};

/** Something sold as plain places, with the site's own thank-you page kept
 * so a story can read that the booking went through. */
export const sellsPlainPlaces = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  rememberListing(
    world,
    name,
    await createTestListing({ name, thankYouUrl: "" }),
  );
};

/** The organiser adds a holiday through the real form. The number the site
 * files it under is kept by its name for the delete step. */
export const organiserAddsHoliday = async (
  world: TicketsWorld,
  name: string,
  firstDay: string,
  lastDay = firstDay,
): Promise<void> => {
  const browser = await openAdminPage(world, "/admin/holidays/new");
  await fillInAndSend(
    browser,
    { end_date: lastDay, name, start_date: firstDay },
    "Create holiday",
  );
  world.ownerTold = browser.pageText;
  const id = browser.currentUrl.match(/\/admin\/holidays\/(\d+)/)?.[1];
  if (!id) throw new Error(`No holiday page address after creating "${name}"`);
  world.things.remember("record", name, Number(id));
};

/** The organiser answers the type-the-name check on the holiday's delete
 * page with its exact name. */
export const organiserDeletesHoliday = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  const id = world.things.require("record", name);
  const browser = await openAdminPage(world, `/admin/holidays/${id}/delete`);
  await fillInAndSend(browser, { confirm_identifier: name }, "Delete holiday");
  world.ownerTold = browser.pageText;
};

/** Whether a listing's own booking page offers the day this many days from
 * now — read from the served date chooser, as a customer would see it. */
export const listingOffersDay = async (
  world: TicketsWorld,
  listingName: string,
  daysFromNow: number,
): Promise<boolean> => {
  const listing = world.things.require("listing", listingName);
  return (await daysOfferedFor(listing)).includes(
    dayFromToday(world, daysFromNow),
  );
};

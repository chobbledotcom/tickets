/**
 * Holidays, as the organiser declares and deletes them. Both halves drive the
 * real admin pages; what a holiday does to a listing's days is read off the
 * listing's own booking page, the way a customer would meet it.
 */

import {
  makesRecordThroughForm,
  type TakesOneThingDown,
  takesDownFromList,
} from "#test/specs/support/browser.ts";
import { rememberListing } from "#test/specs/support/listings.ts";
import { daysOfferedFor } from "#test/specs/support/public-booking.ts";
import { dayFromToday } from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";

/** Something bookable by the day, every day, so any day a story finds gone
 * can only be gone because of the holiday. */
export const sellsDayPlaces = async (
  world: TicketsWorld,
  name: string,
): Promise<void> => {
  rememberListing(world, name, await createDailyTestListing({ name }));
};

const addsHoliday = makesRecordThroughForm({
  button: "Create holiday",
  filedAt: /\/admin\/holidays\/(\d+)/,
  formPath: "/admin/holidays/new",
});

/** The organiser adds a holiday through the real form. */
export const organiserAddsHoliday = (
  world: TicketsWorld,
  name: string,
  firstDay: string,
  lastDay = firstDay,
): Promise<void> =>
  addsHoliday(world, name, { end_date: lastDay, name, start_date: firstDay });

/** The organiser answers the type-the-name check behind the holiday's
 * Actions tab with its exact name. */
export const organiserDeletesHoliday: TakesOneThingDown = takesDownFromList(
  (world, name) =>
    Promise.resolve(`/admin/holidays/${world.things.require("record", name)}`),
  {
    deleteLinkKey: "holidays.delete.heading",
    missing: (name) => `The site filed no holiday under "${name}"`,
    submitKey: "holidays.delete.submit",
  },
);

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

/**
 * The set-up the multi-day stay stories share. A "stay" is a booking on a
 * listing that is booked by the day and covers several days in a row, so these
 * helpers talk in days from today rather than fixed calendar dates — the days a
 * listing offers move with the calendar.
 */

import { getAttendeesRaw } from "#db/attendees/queries.ts";
// jscpd:ignore-start
import { addDays } from "#shared/dates.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import {
  listingIdNamed,
  organiserSavesFields,
  rememberListing,
} from "#test/specs/support/listings.ts";
import type {
  ReadAboutOneThing,
  TicketsWorld,
} from "#test/specs/support/world.ts";
import { createDailyTestListing } from "#test-utils/db-helpers/listings.ts";
import type { Attendee, Listing } from "#types";
// jscpd:ignore-end

/** Somebody new each time, so two stays are never taken for one person. */
export const guest = (order: number): { email: string; who: string } => ({
  email: `guest${order}@example.com`,
  who: `Guest ${order}`,
});

/** Every stay booked on a listing so far, newest first — the order the site
 * itself returns them in. Callers that want a particular one should pick it
 * out rather than trusting a position. */
export const staysOn: ReadAboutOneThing<Attendee[]> = (world, name) =>
  getAttendeesRaw(listingIdNamed(world, name));

/** The stay booked most recently on a listing — the highest id, so the answer
 * does not depend on the order the rows come back in. Fails loudly when nothing
 * has been booked, so a story never carries on with no stay to talk about. */
export const newestStayOn: ReadAboutOneThing<number> = async (world, name) => {
  const booked = await staysOn(world, name);
  if (booked.length === 0) {
    throw new Error(`No stay has been booked on the ${name}`);
  }
  return Math.max(...booked.map((stay) => stay.id));
};

/** A day counted forward from the Scenario's own first day, written the way the
 * site writes days. The first day is fixed the first time it is asked for, so a
 * Scenario running across midnight cannot set a stay up against one day and
 * then check it against the next. */
export const dayFromToday = (world: TicketsWorld, days: number): string => {
  world.firstDay ??= new Date().toISOString().slice(0, 10);
  return addDays(world.firstDay, days);
};

/** A listing booked by the day, where each booking covers `days` days and each
 * day has room for `placesADay` places. Remembered by the name the story uses. */
export const openStayListing = async (
  world: TicketsWorld,
  name: string,
  days: number,
  placesADay: number,
  options: {
    bookAheadDays?: number;
    customerPicksDays?: boolean;
    groupId?: number;
  } = {},
): Promise<Listing> => {
  const listing = await createDailyTestListing({
    durationDays: days,
    maxAttendees: placesADay,
    ...(options.bookAheadDays === undefined
      ? {}
      : { maximumDaysAfter: options.bookAheadDays }),
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
  return rememberListing(world, name, listing);
};

/** Set how many days each stay covers — the listing's length box, through its
 * own edit form, so a page that stops offering the field fails the story. On a
 * listing booked by the day that changes every new stay's length; on an
 * ordinary one it is just a number kept for later. The organiser is told it
 * saved, because a refused save redirects just the same. */
export const changeStayLength = async (
  world: TicketsWorld,
  name: string,
  days: number,
): Promise<string> => {
  const browser = await adminBrowser(world);
  await organiserSavesFields(world, name, { duration_days: String(days) });
  return browser.pageText;
};

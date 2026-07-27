/**
 * Changes an organiser makes to a listing after people have already booked.
 *
 * These go through the listing's own edit form, but not through the story
 * browser: clearing one of the bookable-day checkboxes is a change the browser
 * helper cannot express by merging values over the rendered form — it can tick
 * a box, not clear one.
 */

import { stayListing } from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { updateTestListing } from "#test-utils/db-helpers/listings.ts";

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** The name of the weekday a date falls on. */
export const weekdayOf = (day: string): string => {
  const name = WEEKDAYS[new Date(`${day}T00:00:00Z`).getUTCDay()];
  if (name === undefined) throw new Error(`Not a day: ${day}`);
  return name;
};

/** The organiser stops opening a listing on one day of the week. */
export const stopOpeningOn = async (
  world: TicketsWorld,
  name: string,
  weekday: string,
): Promise<void> => {
  await updateTestListing(stayListing(world, name).id, {
    bookableDays: WEEKDAYS.filter((day) => day !== weekday),
  });
};

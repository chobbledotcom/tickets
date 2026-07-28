/**
 * Changes an organiser makes to a listing after people have already booked,
 * driven through the listing's own edit page.
 */

import { expect } from "@std/expect";
import { DAY_NAMES } from "#shared/day-names.ts";
import { tickedCheckboxes } from "#test/specs/support/form-controls.ts";
import { organiserSavesListing } from "#test/specs/support/listings.ts";

import type { TicketsWorld } from "#test/specs/support/world.ts";

/** The name of the weekday a date falls on, in the words the site uses. */
export const weekdayOf = (day: string): string => {
  // DAY_NAMES runs Sunday first, the same order a date reports its weekday in.
  const name = DAY_NAMES[new Date(`${day}T00:00:00Z`).getUTCDay()];
  if (name === undefined) throw new Error(`Not a day: ${day}`);
  return name;
};

/** The organiser stops opening a listing on one day of the week, by unticking
 * that day on the listing's own edit form. The days that stay ticked are read
 * off the served page, so a page that stops offering them fails the story. */
export const stopOpeningOn = async (
  world: TicketsWorld,
  name: string,
  weekday: string,
): Promise<void> => {
  await organiserSavesListing(world, name, (served) => {
    // Only days carried by a real, usable checkbox count: a day rendered as a
    // fixed hidden box is one nobody could untick, so the story must fail
    // rather than post an edit no organiser could make.
    const ticked = tickedCheckboxes(served, "bookable_days");
    expect(ticked).toContain(weekday);
    return { bookable_days: ticked.filter((day) => day !== weekday) };
  });
};

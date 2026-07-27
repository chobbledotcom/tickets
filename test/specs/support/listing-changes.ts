/**
 * Changes an organiser makes to a listing after people have already booked,
 * driven through the listing's own edit page.
 */

import { expect } from "@std/expect";
import { DAY_NAMES } from "#shared/day-names.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import { stayListing } from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { extractFormEntries } from "#test-utils/test-browser.ts";

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
  const browser = await adminBrowser(world);
  await browser.visit(`/admin/listing/${stayListing(world, name).id}/edit`);
  const ticked = extractFormEntries(browser.currentHtml)
    .filter(([field]) => field === "bookable_days")
    .map(([, day]) => day);
  expect(ticked).toContain(weekday);
  await browser.submitForm(
    { bookable_days: ticked.filter((day) => day !== weekday) },
    "Save Changes",
  );
  expect(browser.containsText("Listing updated")).toBe(true);
};

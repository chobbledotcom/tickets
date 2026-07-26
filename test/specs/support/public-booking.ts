/**
 * How a visitor books, for every story that needs one. A visitor uses their own
 * browser and is never signed in as the organiser, and they can only send the
 * fields the served page actually offers — every field is checked against the
 * rendered form first, so a page that stops offering one fails the story
 * instead of quietly accepting a request no real visitor could make.
 */

import { expect } from "@std/expect";
import { bookingError } from "#shared/booking/form.ts";
import type { Listing } from "#shared/types.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { TestBrowser } from "#test-utils/test-browser.ts";

/** What a visitor fills in. The day and the number of days only apply to
 * listings booked by the day, so both are optional. */
export interface BookingChoices {
  day?: string;
  dayCount?: number;
  email: string;
  places?: number;
  who: string;
}

/** What the site said when the visitor pressed Continue: the page they landed
 * on, so a story can read either the thank-you or the reason it was refused. */
export interface BookingAttempt {
  browser: TestBrowser;
  wasBooked: boolean;
}

const THANK_YOU = "Thank you for your order";

/** Try to book through the listing's own public page. Returns what the visitor
 * was shown rather than throwing, so a story can prove a refusal as well as a
 * booking. */
export const visitorTriesToBook = async (
  listing: Listing,
  choices: BookingChoices,
): Promise<BookingAttempt> => {
  const browser = new TestBrowser();
  await browser.visit(`/ticket/${listing.slug}`);
  expect(browser.pageText).toContain(listing.name);
  const fields = {
    email: choices.email,
    name: choices.who,
    [`quantity_${listing.id}`]: String(choices.places ?? 1),
    ...(choices.day === undefined ? {} : { date: choices.day }),
    ...(choices.dayCount === undefined
      ? {}
      : { day_count: String(choices.dayCount) }),
  };
  // Only send what the page offers. A form that drops or renames a control
  // fails here rather than letting the story post something a visitor cannot.
  for (const field of Object.keys(fields)) {
    expect(browser.currentHtml).toContain(`name="${field}"`);
  }
  await browser.submitForm(fields, "Continue");
  return { browser, wasBooked: browser.pageText.includes(THANK_YOU) };
};

/** Book through the public page and insist it worked, for the setup and the
 * happy paths that are not themselves about being refused. */
export const visitorBooks = async (
  world: TicketsWorld,
  listing: Listing,
  choices: BookingChoices,
): Promise<TestBrowser> => {
  const { browser, wasBooked } = await visitorTriesToBook(listing, choices);
  expect(wasBooked).toBe(true);
  world.customerBrowser = browser;
  world.attendeeName = choices.who;
  return browser;
};

/** The visitor was turned away because the listing had no room — not because
 * of some other error. Any page without the thank-you text would otherwise
 * count as "refused", including a validation or server error. */
export const expectRefusedForWantOfRoom = (
  attempt: BookingAttempt,
  listingName: string,
): void => {
  expect(attempt.wasBooked).toBe(false);
  expect(attempt.browser.pageText).toContain(
    bookingError.withName(listingName),
  );
};

/** The days the page offers as a stay's first day. Read from the served date
 * chooser, so a day the site stops offering disappears from this list. */
export const daysOfferedFor = async (listing: Listing): Promise<string[]> => {
  const browser = new TestBrowser();
  await browser.visit(`/ticket/${listing.slug}`);
  const chooser = browser.currentHtml.match(
    /<select name="date"[\s\S]*?<\/select>/,
  );
  if (!chooser) {
    throw new Error(`The ${listing.name} page offers no day to choose`);
  }
  return [...chooser[0].matchAll(/value="(\d{4}-\d{2}-\d{2})"/g)].map(
    (option) => option[1]!,
  );
};

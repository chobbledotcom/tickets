/**
 * How a visitor books, for every story that needs one. A visitor uses their own
 * browser and is never signed in as the organiser, and they can only send what
 * the served page actually offers: every field is checked against the rendered
 * form, and every value chosen from a dropdown must be one the page lists. A
 * page that stops offering one fails the story instead of quietly accepting a
 * request no real visitor could make.
 *
 * One order can cover several listings — a group page offers a quantity per
 * listing — so the order is modelled as a list of lines throughout, and booking
 * a single listing is a list of one.
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

/** One listing in an order, and how many places on it. */
export interface OrderLine {
  listing: Listing;
  places?: number;
}

/** What the site said when the visitor pressed Continue: the page they landed
 * on, so a story can read either the thank-you or the reason it was refused. */
export interface BookingAttempt {
  browser: TestBrowser;
  wasBooked: boolean;
}

const THANK_YOU = "Thank you for your order";

/** The dropdown on the page for one field, or null when the field is not a
 * dropdown at all (a typed-in name or email). The name may sit anywhere among
 * the tag's attributes — an `id` often comes first — so the opening tag is
 * matched whole and its attributes read from it. */
const chooserFor = (html: string, field: string): string | null => {
  for (const chooser of html.matchAll(/<select\s([^>]*)>[\s\S]*?<\/select>/g)) {
    if (chooser[1]!.includes(`name="${field}"`)) return chooser[0];
  }
  return null;
};

/** The values a dropdown on the page offers. Throws when the page has no such
 * dropdown, so "the option is missing" and "the control is missing" stay
 * separate failures. */
export const optionsOffered = (html: string, field: string): string[] => {
  const chooser = chooserFor(html, field);
  if (!chooser) throw new Error(`The page offers no ${field} to choose`);
  return [...chooser.matchAll(/value="([^"]*)"/g)].map((option) => option[1]!);
};

/** Try to place an order through a page the site serves. Returns what the
 * visitor was shown rather than throwing, so a story can prove a refusal as
 * well as a booking. */
export const visitorTriesToOrder = async (
  path: string,
  lines: OrderLine[],
  choices: BookingChoices,
): Promise<BookingAttempt> => {
  const browser = new TestBrowser();
  await browser.visit(path);
  for (const { listing } of lines) {
    expect(browser.pageText).toContain(listing.name);
  }
  const quantities = Object.fromEntries(
    lines.map(({ listing, places }) => [
      `quantity_${listing.id}`,
      String(places ?? 1),
    ]),
  );
  const fields = {
    email: choices.email,
    name: choices.who,
    ...quantities,
    ...(choices.day === undefined ? {} : { date: choices.day }),
    ...(choices.dayCount === undefined
      ? {}
      : { day_count: String(choices.dayCount) }),
  };
  // Only send what the page offers: every control must be rendered, and any
  // value picked from a dropdown — a day, a stay length, a quantity — must be
  // one that dropdown lists. Checking by "is this field a dropdown?" rather
  // than by name covers each new field for free.
  for (const [field, chosen] of Object.entries(fields)) {
    expect(browser.currentHtml).toContain(`name="${field}"`);
    if (chooserFor(browser.currentHtml, field)) {
      expect(optionsOffered(browser.currentHtml, field)).toContain(chosen);
    }
  }
  await browser.submitForm(fields, "Continue");
  return { browser, wasBooked: browser.pageText.includes(THANK_YOU) };
};

/** Try to book one listing, on its own public page. */
export const visitorTriesToBook = (
  listing: Listing,
  choices: BookingChoices,
): Promise<BookingAttempt> =>
  visitorTriesToOrder(
    `/ticket/${listing.slug}`,
    [
      {
        listing,
        ...(choices.places === undefined ? {} : { places: choices.places }),
      },
    ],
    choices,
  );

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
  // The chooser carries an empty "pick a day" option; only real days count.
  return optionsOffered(browser.currentHtml, "date").filter(
    (day) => day !== "",
  );
};

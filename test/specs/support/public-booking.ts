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
// jscpd:ignore-start
import { openAsNewcomer } from "#test/specs/support/browser.ts";
import {
  optionsOffered,
  whyValueCannotBeSent,
} from "#test/specs/support/form-controls.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
// jscpd:ignore-end

/** What somebody fills in to book a place — a visitor on the public page, or
 * an organiser adding one by hand. The same details either way, so both use
 * this. The day and the number of days only apply to listings booked by the
 * day, so both are optional. */
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

/** A control a visitor could really use to send this value. */
const expectControlCanSend = (
  html: string,
  field: string,
  chosen: string,
): void => {
  expect(whyValueCannotBeSent(html, field, chosen)).toBeNull();
};

/** An order filled in and waiting on the visitor to press Continue. Splitting
 * the two lets a story hold several visitors at the form and release them
 * together, which is the only way to make a race a real race. */
export interface FilledOrder {
  press: () => Promise<BookingAttempt>;
}

/** Somebody works through an order on a page the site serves. What comes back
 * differs — the order still on screen, or what happened when it was sent — so
 * the result is the part each one names for itself. */
type FillsInOrder<Result> = (
  path: string,
  lines: OrderLine[],
  choices: BookingChoices,
) => Promise<Result>;

/** Open a page the site serves and fill the order in, checking as it goes that
 * a visitor could really send every value. Nothing is submitted yet. */
export const visitorFillsInOrder: FillsInOrder<FilledOrder> = async (
  path,
  lines,
  choices,
) => {
  const browser = await openAsNewcomer(path);
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
  // Only send what a visitor could send: every control must be rendered, usable,
  // and able to carry this value — a dropdown must list it, and a fixed hidden
  // box must already hold it. Asking what kind of control each field is, rather
  // than naming fields, covers each new one for free.
  for (const [field, chosen] of Object.entries(fields)) {
    expectControlCanSend(browser.currentHtml, field, chosen);
  }
  return {
    press: async () => {
      await browser.submitForm(fields, "Continue");
      return { browser, wasBooked: browser.pageText.includes(THANK_YOU) };
    },
  };
};

/** Fill the order in and press Continue straight away — what all but the race
 * stories want. */
export const visitorTriesToOrder: FillsInOrder<BookingAttempt> = async (
  path,
  lines,
  choices,
) => (await visitorFillsInOrder(path, lines, choices)).press();

/** The path and lines for one listing's own public page, so filling one in and
 * ordering from one both describe it the same way. */
export const oneListingOrder = (
  listing: Listing,
  choices: BookingChoices,
): [path: string, lines: OrderLine[]] => [
  `/ticket/${listing.slug}`,
  [
    {
      listing,
      ...(choices.places === undefined ? {} : { places: choices.places }),
    },
  ],
];

/** Fill in one listing's own page, ready to press Continue later. */
export const visitorFillsInBooking = (
  listing: Listing,
  choices: BookingChoices,
): Promise<FilledOrder> =>
  visitorFillsInOrder(...oneListingOrder(listing, choices), choices);

/** Try to book one listing, on its own public page. */
export const visitorTriesToBook = (
  listing: Listing,
  choices: BookingChoices,
): Promise<BookingAttempt> =>
  visitorTriesToOrder(...oneListingOrder(listing, choices), choices);

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

/** The page one listing is booked from, as a customer opening it fresh. */
export const openBookingPage = (listing: Listing): Promise<TestBrowser> =>
  openAsNewcomer(`/ticket/${listing.slug}`);

/** The days a served booking page offers as a stay's first day. Read from the
 * date chooser, so a day the site stops offering disappears from this list. */
export const daysOfferedOn = (html: string): string[] =>
  // The chooser carries an empty "pick a day" option; only real days count.
  optionsOffered(html, "date").filter((day) => day !== "");

/** The days a listing's own page offers as a stay's first day. */
export const daysOfferedFor = async (listing: Listing): Promise<string[]> =>
  daysOfferedOn((await openBookingPage(listing)).currentHtml);

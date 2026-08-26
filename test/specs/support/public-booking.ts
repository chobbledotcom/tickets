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
import { bookingError } from "#booking/form.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
// jscpd:ignore-start
import {
  CUSTOMER,
  openAsNewcomer,
  rememberBrowser,
} from "#test/specs/support/browser.ts";
import {
  checkboxValueOffered,
  optionsOffered,
} from "#test/specs/support/form-controls/reading.ts";
import { whyValueCannotBeSent } from "#test/specs/support/form-controls/rules.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
import type { Listing } from "#types";
// jscpd:ignore-end

/** What somebody fills in to book a place — a visitor on the public page, or
 * an organiser adding one by hand. The same details either way, so both use
 * this. The day and the number of days only apply to listings booked by the
 * day, so both are optional. */
export interface BookingChoices {
  /** Tick the terms box, for a page that renders one. */
  agreesToTerms?: boolean;
  /** The answer picked for a question the page asks: the field the question
   * sends under, and the choice picked from the ones it offers. */
  answer?: { choice: string; field: string };
  day?: string;
  dayCount?: number;
  email: string;
  /** Only for a listing that asks for one; a page that does not offer a phone
   * box fails the story rather than quietly dropping the number. */
  phone?: string;
  places?: number;
  who: string;
}

/** One listing in an order, and how many places on it. */
export interface OrderLine {
  listing: Listing;
  /** What is typed into the listing's own price box, for a listing that lets
   * a customer choose what to pay. */
  pays?: string;
  places?: number;
}

/** What the site said when the visitor pressed Continue: the page they landed
 * on, so a story can read either the thank-you or the reason it was refused. */
export interface BookingAttempt {
  browser: TestBrowser;
  wasBooked: boolean;
}

/** What the site says on the page a booking lands on. Shared with the steps
 * that read a booking's outcome back. */
export const THANK_YOU = "Thank you for your order";

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

/** An unsent order kept with what was typed into it, so a later step can
 * check the page hands the same choices back. */
export interface OrderInHand extends FilledOrder {
  choices: BookingChoices;
  lines: OrderLine[];
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
  const chosenPrices = Object.fromEntries(
    lines.flatMap(({ listing, pays }) =>
      pays === undefined ? [] : [[`custom_price_${listing.id}`, pays]],
    ),
  );
  const fields = {
    email: choices.email,
    name: choices.who,
    ...quantities,
    ...chosenPrices,
    ...(choices.phone === undefined ? {} : { phone: choices.phone }),
    ...(choices.day === undefined ? {} : { date: choices.day }),
    ...(choices.dayCount === undefined
      ? {}
      : { day_count: String(choices.dayCount) }),
    ...(choices.answer === undefined
      ? {}
      : { [choices.answer.field]: choices.answer.choice }),
    // Ticking the box sends the value the page's own box carries, so a form
    // whose box changes or disappears fails the story instead of being
    // papered over with a hard-coded value.
    ...(choices.agreesToTerms
      ? {
          agree_terms: checkboxValueOffered(browser.currentHtml, "agree_terms"),
        }
      : {}),
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
  rememberBrowser(world, CUSTOMER, browser);
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

/** The one number in a list, or a loud failure saying what was counted. A
 * story that carried on against an arbitrary row would report the site's
 * behaviour when its own setup is what went wrong. */
const theOnly = (ids: number[], counting: string): number => {
  const only = ids[0];
  if (ids.length !== 1 || !only) {
    throw new Error(`Expected one ${counting}, found ${ids.length}`);
  }
  return only;
};

const bookingIdsOn = async (listingId: number): Promise<number[]> =>
  (await getAttendeesRaw(listingId)).map((booking) => booking.id);

/** The one booking made on a listing. Fails loudly when there is not exactly
 * one, so a story can never carry on against an arbitrary row. */
export const soleBookingOn = async (listingId: number): Promise<number> =>
  theOnly(await bookingIdsOn(listingId), `booking on listing ${listingId}`);

/** The booking one person makes while something happens — the row that was
 * not on the listing before. Told apart by which id is new rather than by
 * which is newest, because two people booking in the same second tie on when
 * they booked. */
export const bookingMadeDuring = async (
  listingId: number,
  booking: () => Promise<unknown>,
): Promise<number> => {
  const before = new Set(await bookingIdsOn(listingId));
  await booking();
  return theOnly(
    (await bookingIdsOn(listingId)).filter((id) => !before.has(id)),
    `new booking on listing ${listingId}`,
  );
};

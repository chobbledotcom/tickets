/**
 * The ticket a customer ends up holding, and how they reach it.
 *
 * Every ticket is opened the way its holder opens theirs: by following the
 * link the site handed them when they booked, as somebody who is not signed
 * in. A booking that hands over no link, and a link that opens nothing, each
 * fail the story here.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import * as v from "valibot";
import { listingsTable } from "#db/listings/records.ts";
import { t } from "#i18n";
import {
  newcomerReading,
  openAsNewcomer,
  type PageRead,
} from "#test/specs/support/browser.ts";
import {
  listingNamed,
  putsOnSaleByTheDay,
  putsPlainThingOnSale,
} from "#test/specs/support/listings.ts";
import {
  type BookingChoices,
  visitorTriesToOrder,
} from "#test/specs/support/public-booking.ts";
import {
  type OrderOnAPage,
  ownPageOrder,
  togetherPageOrder,
} from "#test/specs/support/sales-pages.ts";
import { dayFromToday } from "#test/specs/support/stays.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { createPaidTestAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
import type { Listing } from "#types";
// jscpd:ignore-end

/** The code the site gave somebody, read off the link on the page their
 * booking landed on. A booking whose page offers no way back to a ticket is a
 * booking its holder can never look at again, so it stops the story here. */
export const codeOnTheLinkTheyWereGiven = (browser: TestBrowser): string => {
  const toTicket = browser.links.find(({ href }) => href.startsWith("/t/"));
  if (!toTicket) throw new Error("The booking gave them no link to a ticket");
  return toTicket.href.slice("/t/".length);
};

/** Keep the code somebody was given for each thing that order bought, and point
 * the link they are holding at it. The two happen together every time: the link
 * in their hand is always the one they were last given. */
export const keepsTicketFor = (
  world: TicketsWorld,
  things: string[],
  code: string,
): void => {
  for (const thing of things) world.things.remember("ticket", thing, code);
  world.ticketToken = code;
};

/** One made-up address per person, so two people in one story are never taken
 * for one. */
const emailFor = (who: string): string =>
  `${who.toLowerCase().replaceAll(" ", ".")}@example.com`;

/** The organiser attaches a file to something they sell. A file is uploaded on
 * its own rather than typed into the listing's form, so the story records what
 * an upload leaves behind: the name the buyer reads, and the stored file it
 * points at. */
export const attachFileTo = async (
  listingId: number,
  name: string,
): Promise<void> => {
  await listingsTable.update(listingId, {
    attachmentName: name,
    attachmentUrl: name.toLowerCase().replaceAll(" ", "-"),
  });
};

/** How many places somebody wants on one of the things the site sells. */
export interface PlacesWanted {
  name: string;
  places: number;
}

/** Somebody orders places on one or more of the things the site sells, through
 * the page that really sells them, and keeps the code the site hands back. One
 * order buys one code however many things it covers. */
export const customerOrders = (
  world: TicketsWorld,
  who: string,
  wanted: PlacesWanted[],
): Promise<void> =>
  ordersAndKeepsTheCode(
    world,
    wanted.map(({ name }) => name),
    togetherPageOrder(world, wanted),
    { email: emailFor(who), who },
  );

/** Somebody sends an order and keeps the code the site hands back under the
 * name of every thing it bought. Each booking here ends this way, whichever
 * page it started from, so an order that was refused stops the story at the
 * booking rather than several steps later. */
const ordersAndKeepsTheCode = async (
  world: TicketsWorld,
  things: string[],
  order: OrderOnAPage,
  choices: BookingChoices,
): Promise<void> => {
  const attempt = await visitorTriesToOrder(...order, choices);
  expect(attempt.wasBooked).toBe(true);
  keepsTicketFor(world, things, codeOnTheLinkTheyWereGiven(attempt.browser));
};

/** The day every day-booking Scenario here works against. Fixed once per story,
 * so a Scenario running across midnight cannot book one day and then read the
 * ticket against the next. */
export const theDayTheyPicked = (world: TicketsWorld): string =>
  dayFromToday(world, 10);

/** Somebody books the day they picked on a thing sold by the day. */
export const customerBooksTheirDay = (
  world: TicketsWorld,
  who: string,
  name: string,
): Promise<void> =>
  ordersAndKeepsTheCode(
    world,
    [name],
    ownPageOrder(world, name, { places: 1 }),
    { day: theDayTheyPicked(world), email: emailFor(who), who },
  );

/** What an organiser can fill in about a thing, in the words the story uses
 * for them. Reading the table through a schema means a Scenario that invents a
 * row, or answers "maybe" where only yes or no makes sense, fails by name
 * rather than quietly filling nothing in. */
const FilledInSchema = v.strictObject({
  "file to hand out": v.optional(v.string()),
  "may be passed on": v.optional(v.picklist(["yes", "no"])),
  "what it is": v.optional(v.string()),
  "when it is": v.optional(v.string()),
  "where it is": v.optional(v.string()),
});

/** Something on sale with the details the organiser filled in about it. */
export const sellsSomethingFilledIn = async (
  world: TicketsWorld,
  name: string,
  rows: Record<string, string>,
): Promise<Listing> => {
  const filledIn = v.parse(FilledInSchema, rows);
  const listing = await putsPlainThingOnSale(world, name, {
    date: filledIn["when it is"] ?? "",
    description: filledIn["what it is"] ?? "",
    location: filledIn["where it is"] ?? "",
    nonTransferable: filledIn["may be passed on"] === "no",
  });
  const handsOut = filledIn["file to hand out"];
  if (handsOut !== undefined) await attachFileTo(listing.id, handsOut);
  return listing;
};

/** Something sold a day at a time, bookable from today onwards. */
export const sellsSomethingByTheDay = (
  world: TicketsWorld,
  name: string,
): Promise<Listing> =>
  putsOnSaleByTheDay(world, name, {
    maxAttendees: 20,
    maxQuantity: 5,
    minimumDaysBefore: 0,
    thankYouUrl: "",
  });

/** Somebody pays for one place, and keeps the code that booking carries. What
 * a payment does to the money record is the payment stories' business; all this
 * one needs is a booking that really was paid for. */
export const customerPaysForOnePlace = async (
  world: TicketsWorld,
  who: string,
  name: string,
  pence: number,
): Promise<void> => {
  const attendee = await createPaidTestAttendee(
    listingNamed(world, name).id,
    who,
    emailFor(who),
    `pi_${name.toLowerCase()}`,
    pence,
  );
  keepsTicketFor(world, [name], attendee.ticket_token);
};

/** The link somebody is holding now: one code, or several joined the way the
 * site joins them when one person holds more than one ticket. */
const linkInTheirHand = (world: TicketsWorld): string =>
  requiredWorldValue(world.ticketToken, "the link they were given");

/** Point somebody's link at whatever codes this Scenario wants it to carry, for
 * the rules about a link asked for oddly. */
export const theirLinkCarries = (
  world: TicketsWorld,
  codes: string[],
): void => {
  world.ticketToken = codes.join("+");
};

/** Every code somebody has collected, in the order they got them. */
export const everyCodeCollected = (world: TicketsWorld): string[] =>
  world.things
    .names("ticket")
    .map((thing) => world.things.require("ticket", thing));

/** The ticket page as its holder sees it, opened fresh each time so the link is
 * proved to keep working rather than read once and kept. */
export const openTicket = (world: TicketsWorld): Promise<TestBrowser> =>
  openAsNewcomer(`/t/${linkInTheirHand(world)}`);

/** What their ticket says, in the words a reader sees. */
export const wordsOnTheirTicket = async (
  world: TicketsWorld,
): Promise<string> => (await openTicket(world)).pageText;

/** A code the site was never given. Long enough that it cannot collide with a
 * real one, and the same every time so the story reads the same each run. */
export const A_MADE_UP_CODE = "not-a-real-ticket-code";

/** What the site answers somebody trying a code it does not know, and the page
 * it serves them. Both come from the one ask, so a refusal can be told apart
 * from an error page or a redirect somewhere else. */
export const askForAMadeUpCode = (): Promise<PageRead> =>
  newcomerReading(`/t/${A_MADE_UP_CODE}`);

/** The heading a ticket page carries when it holds this many tickets, in the
 * site's own words rather than a copy of them. */
export const headingForTickets = (count: number): string =>
  t("tickets.count", { count });

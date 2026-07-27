/**
 * Checking people in at the door. The organiser works from the listing's
 * scanner page: it reads a ticket code and asks the site whether that person
 * may come in. Every check here goes through that page — the page is opened
 * first, and the code it carries for the request is the one the page itself
 * supplies, so a scanner page that stopped working would fail the story rather
 * than being stepped around.
 */

import { expect } from "@std/expect";
import { getAttendeesByTokens } from "#shared/db/attendees/tokens.ts";
import { adminBrowser } from "#test/specs/support/browser.ts";
import { rememberStayListing, stayListing } from "#test/specs/support/stays.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postAttendeeRefund } from "#test-utils/ledger.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";

/** What the site says about one person at the door. */
export interface DoorAnswer {
  listingName?: string;
  name?: string;
  quantity?: number;
  status: string;
}

/** A page belonging to one of the story's listings. */
const listingPath = (
  world: TicketsWorld,
  listing: string,
  page: string,
): string => `/admin/listing/${stayListing(world, listing).id}/${page}`;

/** Someone with a ticket for one of the story's listings. Both the listing and
 * the ticket are kept under the names the story uses for them. */
export const personWithTicket = async (
  world: TicketsWorld,
  who: string,
  listing: string,
  options: { needsIdChecked?: boolean; places?: number } = {},
): Promise<void> => {
  const { listing: created, token } = await createTestAttendeeWithToken(
    who,
    `${who.toLowerCase()}@example.com`,
    { name: listing, nonTransferable: options.needsIdChecked ?? false },
    options.places ?? 1,
  );
  rememberStayListing(world, listing, created);
  world.doorTickets ??= new Map();
  world.doorTickets.set(who, token);
};

/** Another listing running its own door, with nobody booked on it yet. */
export const otherListing = async (
  world: TicketsWorld,
  listing: string,
): Promise<void> => {
  rememberStayListing(
    world,
    listing,
    await createTestListing({ maxAttendees: 10, name: listing }),
  );
};

/** The ticket code the story gave this person. */
export const ticketOf = (world: TicketsWorld, who: string): string => {
  const token = world.doorTickets?.get(who);
  if (!token) throw new Error(`${who} was never given a ticket`);
  return token;
};

/** Their money is given back, so the ticket should no longer let them in. */
export const refundTicket = async (
  world: TicketsWorld,
  who: string,
  listing: string,
): Promise<void> => {
  const [attendee] = await getAttendeesByTokens([ticketOf(world, who)]);
  if (!attendee) throw new Error(`${who}'s ticket is not on any booking`);
  await postAttendeeRefund({
    attendeeId: attendee.id,
    listingId: stayListing(world, listing).id,
  });
};

/** The one-use code the scanner page carries for its own requests. Reading it
 * off the page is what the page's own script does, so a page that stopped
 * supplying it fails the story here rather than the story inventing one. */
const codeOnPage = (browser: TestBrowser): string => {
  const found = browser.currentHtml.match(
    /<meta[^>]*name="csrf-token"[^>]*content="([^"]*)"/,
  );
  if (!found?.[1]) throw new Error("The scanner page carries no code to send");
  return found[1];
};

/** The organiser opens a listing's door. */
export const openDoor = async (
  world: TicketsWorld,
  listing: string,
): Promise<TestBrowser> => {
  const browser = await adminBrowser(world);
  await browser.visit(listingPath(world, listing, "scanner"));
  return browser;
};

/** The organiser holds a ticket up to a listing's door and is told what to do
 * with the person in front of them. Letting someone in who belongs to another
 * listing is a deliberate second press, so it is asked for rather than assumed.
 */
export const showTicketAtDoor = async (
  world: TicketsWorld,
  listing: string,
  ticket: string,
  choices: { confirmedTheirId?: boolean; letInAnyway?: boolean } = {},
): Promise<DoorAnswer> => {
  const browser = await openDoor(world, listing);
  const { handleRequest } = await import("#routes");
  const cookies = [...browser.debugCookies()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");
  const response = await handleRequest(
    new Request(`http://localhost${listingPath(world, listing, "scan")}`, {
      body: JSON.stringify({
        token: ticket,
        ...(choices.letInAnyway === undefined
          ? {}
          : { force: choices.letInAnyway }),
        ...(choices.confirmedTheirId === undefined
          ? {}
          : { id_verified: choices.confirmedTheirId }),
      }),
      headers: {
        "content-type": "application/json",
        cookie: cookies,
        host: "localhost",
        "x-csrf-token": codeOnPage(browser),
      },
      method: "POST",
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()) as DoorAnswer;
};

/** The whole door page, for checks about what is not on it at all. */
export const doorPageHtml = async (
  world: TicketsWorld,
  listing: string,
): Promise<string> => (await openDoor(world, listing)).currentHtml;

/** The people the door offers when the organiser looks someone up by hand
 * instead of reading their ticket. Each one is read from the row the organiser
 * would click, so a name shown anywhere else on the page does not count as
 * being offered. */
export const peopleOfferedAtDoor = async (
  world: TicketsWorld,
  listing: string,
): Promise<Array<{ name: string; ticket: string }>> => {
  const html = await doorPageHtml(world, listing);
  return [...html.matchAll(/<div[^>]*role="option"[^>]*>/g)].map(([row]) => ({
    name: readOf(row, "name"),
    ticket: readOf(row, "token"),
  }));
};

/** One thing the door records about a person it is offering. A row missing it
 * is a broken page, not an empty answer. */
const readOf = (row: string, what: string): string => {
  const found = row.match(new RegExp(`data-${what}="([^"]*)"`));
  if (!found?.[1]) throw new Error(`A row at the door has no ${what}`);
  return found[1];
};

/** What the listing's own record of the day says happened. */
export const dayLog = async (
  world: TicketsWorld,
  listing: string,
): Promise<string> => {
  const browser = await adminBrowser(world);
  await browser.visit(listingPath(world, listing, "activity"));
  return browser.pageText;
};

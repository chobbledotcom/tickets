/**
 * Checking people in at the door. The organiser works from the listing's
 * scanner page: it reads a ticket code and asks the site whether that person
 * may come in. Every check here goes through that page — the page is opened
 * first, and the code it carries for the request is the one the page itself
 * supplies, so a scanner page that stopped working would fail the story rather
 * than being stepped around.
 */

import * as v from "valibot";
import { getAttendeesByTokens } from "#db/attendees/tokens.ts";
import { handleRequest } from "#routes";
import { leaveEvidencePage } from "#scripts/specs/evidence/pages.ts";
import { expectAccepted, openAdminPage } from "#test/specs/support/browser.ts";
import {
  listingIdNamed,
  listingNamed,
  rememberListing,
} from "#test/specs/support/listings.ts";
import {
  ticketTheirBookingHandsOver,
  visitorBooks,
} from "#test/specs/support/public-booking.ts";
import { dayFromToday, openStayListing } from "#test/specs/support/stays.ts";
import {
  type ActOnOnePersonAtOneThing,
  type ActOnOneThing,
  type ReadAboutOneThing,
  type ReadsWhatWasKept,
  type TicketsWorld,
  whatWasKeptFor,
} from "#test/specs/support/world.ts";
// jscpd:ignore-start
import {
  createTestAttendeeDirect,
  createTestAttendeeWithToken,
} from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { postAttendeeRefund } from "#test-utils/ledger.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
// jscpd:ignore-end

/** An admin page belonging to one record — its listing, or the group its
 * listings sit under. Shared by the listing door and the group door. */
export const recordPath = (
  kind: "listing" | "groups",
  id: number,
  page: string,
): string => `/admin/${kind}/${id}/${page}`;

/** A page belonging to one of the story's listings. */
export const listingPath = (
  world: TicketsWorld,
  listing: string,
  page: string,
): string => recordPath("listing", listingIdNamed(world, listing), page);

/** What the organiser decides about a ticket the door queried. A saved
 * check-in the door delivers after an outage carries no ticket: it travels
 * by the one-way code the door stored, and names the delivery it belongs
 * to, so a retry of the same delivery can never let a second person in. */
export type DoorChoice = {
  confirmedTheirId?: boolean;
  letInAnyway?: boolean;
  operationId?: string;
  savedCode?: string;
  tickets?: number;
};

/** One door's own pages: its scanner page, and the door that page answers. */
export type DoorPaths = { page: string; scan: string };

/** A door's own pages, found by the name the story calls the door. */
export type PathsOfDoor = (world: TicketsWorld, doorName: string) => DoorPaths;

/** One listing door's own pages, at the paths the listing's pages live at. */
export const listingDoorPaths = (
  world: TicketsWorld,
  listing: string,
): DoorPaths => ({
  page: listingPath(world, listing, "scanner"),
  scan: listingPath(world, listing, "scan"),
});

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
  rememberListing(world, listing, created);
  // The door this person belongs to, so a screenshot capture can open it.
  leaveEvidencePage(
    world,
    ["qr-code-check-in"],
    listingPath(world, listing, "scanner"),
  );
  rememberTicket(world, who, token);
};

/** Keep a ticket under the name the story calls its holder — the one place
 * both doors keep them. */
export const rememberTicket = (
  world: TicketsWorld,
  who: string,
  ticket: string,
): void => {
  world.things.remember("ticket", who, ticket);
};

/** A second person's ticket for a listing the story already made, booked
 * straight onto that listing instead of making the listing a second time. */
export const personWithTicketToo: ActOnOnePersonAtOneThing = async (
  world,
  who,
  listing,
) => {
  const { token } = await createTestAttendeeDirect(
    listingIdNamed(world, listing),
    who,
    `${who.toLowerCase()}@example.com`,
  );
  rememberTicket(world, who, token);
};

/** Someone who booked a stay of several days through the listing's own page.
 * The ticket they hold is the one the site hands them on the page their
 * booking lands on — nothing is invented for them. */
export const personWithStayTicket = async (
  world: TicketsWorld,
  who: string,
  listing: string,
  days: number,
): Promise<void> => {
  await openStayListing(world, listing, days, 5);
  const booking = await visitorBooks(world, listingNamed(world, listing), {
    day: dayFromToday(world, 10),
    email: `${who.toLowerCase()}@example.com`,
    who,
  });
  rememberTicket(world, who, ticketTheirBookingHandsOver(booking));
};

/** Another listing running its own door, with nobody booked on it yet. */
export const otherListing: ActOnOneThing = async (world, listing) => {
  rememberListing(
    world,
    listing,
    await createTestListing({ maxAttendees: 10, name: listing }),
  );
};

/** The ticket code the story gave this person. */
export const ticketOf: ReadsWhatWasKept<"ticket"> = whatWasKeptFor("ticket");

/** The attendee one person's ticket names. */
export const attendeeOf = async (world: TicketsWorld, who: string) => {
  const [attendee] = await getAttendeesByTokens([ticketOf(world, who)]);
  if (!attendee) throw new Error(`${who}'s ticket is not on any booking`);
  return attendee;
};

/** Their money is given back, so the ticket should no longer let them in. */
export const refundTicket: ActOnOnePersonAtOneThing = async (
  world,
  who,
  listing,
) => {
  await postAttendeeRefund({
    attendeeId: (await attendeeOf(world, who)).id,
    listingId: listingIdNamed(world, listing),
  });
};

/** The one-use code the scanner page carries for its own requests. Reading it
 * off the page is what the page's own script does, so a page that stopped
 * supplying it fails the story here rather than the story inventing one. */
export const codeOnPage = (browser: TestBrowser): string => {
  const found = browser.currentHtml.match(
    /<meta[^>]*name="csrf-token"[^>]*content="([^"]*)"/,
  );
  if (!found?.[1]) throw new Error("The scanner page carries no code to send");
  return found[1];
};

/** The browser's cookies as one header value — the request the page's own
 * script sends carries them. */
export const cookiesOf = (browser: TestBrowser): string =>
  [...browser.debugCookies()]
    .map(([name, value]) => `${name}=${value}`)
    .join("; ");

/** The door's answer body, checked at the boundary: whose ticket, what the
 * door decided, and the numbers it names. Every field but the decision is
 * optional, because a refusal names less. */
const doorAnswerBody = v.object({
  listingName: v.optional(v.string()),
  max: v.optional(v.number()),
  name: v.optional(v.string()),
  quantity: v.optional(v.number()),
  remaining: v.optional(v.number()),
  status: v.string(),
  total: v.optional(v.number()),
});

/** What the site says about one person at the door — the body above, as the
 * site sent it. */
export type DoorAnswer = v.InferOutput<typeof doorAnswerBody>;

/** One door scan request as the page's own script sends it: the body, the
 * browser's cookies, and the one-use code off that browser's page. Both the
 * strict sender and the saved-delivery sender build on it. */
export const doorScanRequest = (
  scanPath: string,
  browser: TestBrowser,
  body: Record<string, unknown>,
): Request =>
  new Request(`http://localhost${scanPath}`, {
    body: JSON.stringify(body),
    headers: {
      "content-type": "application/json",
      cookie: cookiesOf(browser),
      host: "localhost",
      "x-csrf-token": codeOnPage(browser),
    },
    method: "POST",
  });

/** Read the door's answer out of one response, whatever status it came
 * with. A check-in the site cannot match comes back as 404 with the same
 * JSON body, and the door reads the body either way. */
export const readDoorAnswer = async (response: Response): Promise<DoorAnswer> =>
  v.parse(doorAnswerBody, await response.json());

/** Send one scanned ticket to a door's JSON API, carrying one browser's own
 * cookies and the one-use code off that browser's page — the request the
 * door page's own script sends. Every door reader stands on this. */
export const sendDoorScan = async (
  scanPath: string,
  browser: TestBrowser,
  ticket: string,
  choices: DoorChoice = {},
): Promise<DoorAnswer> => {
  const response = await handleRequest(
    doorScanRequest(scanPath, browser, {
      ...(choices.savedCode === undefined
        ? { token: ticket }
        : {
            operation_id: choices.operationId,
            token_hash: choices.savedCode,
          }),
      ...(choices.letInAnyway === undefined
        ? {}
        : { force: choices.letInAnyway }),
      ...(choices.confirmedTheirId === undefined
        ? {}
        : { id_verified: choices.confirmedTheirId }),
      ...(choices.tickets === undefined ? {} : { quantity: choices.tickets }),
    }),
  );
  return readDoorAnswer(expectAccepted(response));
};

/** Post one scanned ticket to a scanner page's own JSON door, as the page's
 * own script would. The page is opened first so the code and cookies are its
 * own; both the listing door and the group door go through here. */
export const postScanAtPath = async (
  world: TicketsWorld,
  doorPaths: DoorPaths,
  ticket: string,
  choices: DoorChoice,
): Promise<DoorAnswer> =>
  sendDoorScan(
    doorPaths.scan,
    await openAdminPage(world, doorPaths.page),
    ticket,
    choices,
  );

/** What one door's scan gives a story: whose door, whose ticket, and what the
 * organiser decided when the door asked. */
export type ShowTicketAtDoor = (
  world: TicketsWorld,
  doorName: string,
  ticket: string,
  choices?: DoorChoice,
) => Promise<DoorAnswer>;

/** One door's scan, from the paths its own pages live at. Both the listing
 * door and the group door stand on this. */
export const scanAt =
  (pathsOf: PathsOfDoor): ShowTicketAtDoor =>
  async (world, doorName, ticket, choices = {}) =>
    postScanAtPath(world, pathsOf(world, doorName), ticket, choices);

/** The organiser holds a ticket up to a listing's door and is told what to do
 * with the person in front of them. Letting someone in who belongs to another
 * listing is a deliberate second press, so it is asked for rather than assumed.
 */
export const showTicketAtDoor: ShowTicketAtDoor = scanAt(listingDoorPaths);

/** The whole door page, for checks about what is not on it at all. */
export const doorPageHtml: ReadAboutOneThing = async (world, listing) =>
  (await openAdminPage(world, listingPath(world, listing, "scanner")))
    .currentHtml;

/** The people a scanner page's list offers when the organiser looks someone
 * up by hand instead of reading their ticket. Each one is read from the row
 * the organiser would click, so a name shown anywhere else on the page does
 * not count as being offered. */
export const readOfferedPeople = (html: string): Array<{ name: string }> =>
  [...html.matchAll(/<div[^>]*role="option"[^>]*>/g)].map(([row]) => ({
    name: readOf(row, "name"),
  }));

/** The people a door's own list offers, whatever door page the caller
 * names: the listing's door and the group's door both stand on this. */
export const offeredAt =
  (
    pageHtml: ReadAboutOneThing<string>,
  ): ReadAboutOneThing<Array<{ name: string }>> =>
  async (world, doorName) =>
    readOfferedPeople(await pageHtml(world, doorName));

/** One thing the door records about a person it is offering. A row missing it
 * is a broken page, not an empty answer. */
const readOf = (row: string, what: string): string => {
  const found = row.match(new RegExp(`data-${what}="([^"]*)"`));
  if (!found?.[1]) throw new Error(`A row at the door has no ${what}`);
  return found[1];
};

/** The people the listing's door offers when the organiser looks someone up by
 * hand instead of reading their ticket. */
export const peopleOfferedAtDoor = offeredAt(doorPageHtml);

/** How many tickets the listing's door offers one person for when the
 * organiser looks them up by hand: what their party still owes. */
export const ticketsOfferedAtDoor = async (
  world: TicketsWorld,
  listing: string,
  who: string,
): Promise<number> => {
  const rows = [
    ...(await doorPageHtml(world, listing)).matchAll(
      /<div[^>]*role="option"[^>]*>/g,
    ),
  ].map(([row]) => row);
  const row = rows.find((one) => readOf(one, "name") === who);
  if (!row) throw new Error(`The door does not offer ${who}`);
  return Number(readOf(row, "quantity"));
};

/** What the listing's own record of the day says happened. */
export const dayLog: ReadAboutOneThing = async (world, listing) => {
  // The listing whose own record of the day a capture of a check-in goes to.
  const path = listingPath(world, listing, "activity");
  leaveEvidencePage(world, ["checked-in-on-the-day"], path);
  const browser = await openAdminPage(world, path);
  return browser.pageText;
};

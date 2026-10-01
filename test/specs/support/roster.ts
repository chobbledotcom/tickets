/**
 * The listing's attendee list — the roster the organiser checks people in
 * from. The press is the click on the page: the served Check in form is read
 * and sent the way a browser sends it, and the page the organiser lands on is
 * what the story reads.
 */

/* jscpd:ignore-start -- imports */
import {
  adminPageHtmlAt,
  keepsWhatTheOrganiserSaw,
  organiserPressesOnPage,
  withAdminPage,
} from "#test/specs/support/browser.ts";
import { rosterPath } from "#test/specs/support/by-hand.ts";
import { fillInAndSend } from "#test/specs/support/form-controls.ts";
import { rememberListing } from "#test/specs/support/listings.ts";
import { emailFor } from "#test/specs/support/tickets.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createMultiBookingAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import type { TestBrowser } from "#test-utils/test-browser.ts";
/* jscpd:ignore-end */

/** The organiser presses one of the list's Check in / Check out controls, and
 * is left looking at whatever page the site brought them to. */
export const pressOnTheAttendeeList = async (
  world: TicketsWorld,
  listing: string,
  buttonText: string,
): Promise<void> => {
  await organiserPressesOnPage(world, rosterPath(world, listing), buttonText);
};

/** The attendee list of one listing, read fresh. */
export const attendeeListHtml = (
  world: TicketsWorld,
  listing: string,
): Promise<string> => adminPageHtmlAt(world, rosterPath(world, listing));

/** Somebody booked on one listing and then on a second one, in that order —
 * the second booking is never the first line their record carries. The
 * listings are created one after the other, so the first booking's listing
 * also carries the lower id. */
export const personWithTicketsForTwoListings = async (
  world: TicketsWorld,
  who: string,
  first: string,
  second: string,
): Promise<void> => {
  const homeListing = await createTestListing({
    maxAttendees: 10,
    name: first,
  });
  const otherListing = await createTestListing({
    maxAttendees: 10,
    name: second,
  });
  rememberListing(world, first, homeListing);
  rememberListing(world, second, otherListing);
  await createMultiBookingAttendee(who, emailFor(who), [
    { listingId: homeListing.id },
    { listingId: otherListing.id },
  ]);
};

/** The one booking row the list shows for a person, or a loud failure — a
 * story that read a neighbour's row would act on the wrong booking. */
export const rowOnTheAttendeeList = (html: string, who: string): string => {
  const rows = html.match(/<tr[\s>][\s\S]*?<\/tr>/g) ?? [];
  const row = rows.find((candidate) => candidate.includes(who));
  if (!row) {
    throw new Error(`The attendee list shows no row for ${who}`);
  }
  return row;
};

/** The words on the check-in control inside one booking row. */
export const checkinControlLabel = (row: string): string => {
  const label = row.match(/<button[^>]*>([^<]*)<\/button>/)?.[1]?.trim();
  if (!label) {
    throw new Error("The attendee row carries no check-in control");
  }
  return label;
};

/** The two ways a booking of several places moves: its Check in link admits,
 * its Check out link releases. Each link opens the page that asks how many. */
export type PartDirection = "Check in" | "Check out";

/** Open the listing's attendee list fresh and follow the booking link that
 * `pick` names from what the list shows. The link is followed, not built, so
 * a list that stopped offering it fails. */
const followOnTheList = (
  world: TicketsWorld,
  listing: string,
  pick: (html: string) => PartDirection,
): Promise<TestBrowser> =>
  withAdminPage(world, rosterPath(world, listing), async (browser) => {
    await browser.clickLink(pick(browser.currentHtml));
    return browser;
  });

/** The organiser follows one direction's link on the attendee list, picks how
 * many tickets on the page it opens, and presses that page's button. */
export const movesPartOfAParty = async (
  world: TicketsWorld,
  listing: string,
  direction: PartDirection,
  tickets: number,
): Promise<void> => {
  const browser = await followOnTheList(world, listing, () => direction);
  await fillInAndSend(browser, { quantity: String(tickets) }, direction);
  keepsWhatTheOrganiserSaw(world, browser);
};

/** What the page behind a booking's Check in or Check out link says about
 * how many of its tickets are in — the words the organiser reads there. A
 * booking still owing tickets links "Check in" (or "Check in/out" once some
 * are in); a full one links only "Check out". */
export const partCountOnTheList = async (
  world: TicketsWorld,
  listing: string,
): Promise<string> =>
  (
    await followOnTheList(world, listing, (html) =>
      html.includes(">Check in") ? "Check in" : "Check out",
    )
  ).pageText;

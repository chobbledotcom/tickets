/**
 * The listing's attendee list — the roster the organiser checks people in
 * from. The press is the click on the page: the served Check in form is read
 * and sent the way a browser sends it, and the page the organiser lands on is
 * what the story reads.
 */

import {
  adminPageHtmlAt,
  organiserPressesOnPage,
} from "#test/specs/support/browser.ts";
import { rosterPath } from "#test/specs/support/by-hand.ts";
import { rememberListing } from "#test/specs/support/listings.ts";
import { emailFor } from "#test/specs/support/tickets.ts";
import type { TicketsWorld } from "#test/specs/support/world.ts";
import { createMultiBookingAttendee } from "#test-utils/db-helpers/attendees.ts";
// jscpd:ignore-start
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
// jscpd:ignore-end

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

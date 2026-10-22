/**
 * The set-up and reads the unsent-notification stories share: bookings whose
 * sends never got accepted, the notice each booking carries, and the list
 * rows and merge sections those notices belong to.
 */

// jscpd:ignore-start
import { execute } from "#db/client.ts";
import { t } from "#i18n";
import { personBookedOnListing } from "#test/specs/support/booked-person.ts";
import { rowsOnList } from "#test/specs/support/form-controls/reading.ts";
import { listingNamed } from "#test/specs/support/listings.ts";
import {
  requiredWorldValue,
  type TicketsWorld,
} from "#test/specs/support/world.ts";
import { setPendingNotificationFlags } from "#test-utils/db-helpers/attendees.ts";
import { findAllLinks } from "#test-utils/test-browser/parsing.ts";
// jscpd:ignore-end

/** One person's booking on a listing, with the sends it still owes: 1 says
 * the send never got accepted, 0 says it went out or nothing was owed. The
 * booking goes through the site's own create, so the flags are the only
 * thing the story sets by hand. */
export const personWithTicketOwing = async (
  world: TicketsWorld,
  who: string,
  listing: string,
  email: number,
  webhooks: number,
): Promise<void> => {
  const { attendee } = await personBookedOnListing(world, who, listing);
  await setPendingNotificationFlags(attendee.id, email, webhooks);
};

/** A listing a story named stops collecting an email, so a booking on it
 * owes no email any more. The contact-fields setting has its own story; this
 * only sets the fact the notice rule reads. */
export const listingStopsCollectingAnEmail = async (
  world: TicketsWorld,
  listing: string,
): Promise<void> => {
  await execute("UPDATE listings SET fields = 'phone' WHERE id = ?", [
    listingNamed(world, listing).id,
  ]);
};

/** The pair the merge story set up owes different sends: the booking kept
 * owes an email, the duplicate owes its webhooks. So each side of the merge
 * screen has its own notice to show. */
export const pairOwesDifferentSends = async (
  world: TicketsWorld,
): Promise<void> => {
  await setPendingNotificationFlags(
    requiredWorldValue(world.attendeeId, "the booking being kept"),
    1,
    0,
  );
  await setPendingNotificationFlags(
    requiredWorldValue(world.duplicateId, "the duplicate booking"),
    0,
    1,
  );
};

/** The admin page a notification story last opened. A story that reads it
 * without having opened one is a broken story, not an empty page. */
export const pageSeen = (world: TicketsWorld): string =>
  requiredWorldValue(world.notificationsPage, "the page the story opened");

/** One attendee's row on the attendee list, found by the name that links
 * into their own page, so a notice reads beside the booking it belongs to
 * and never beside a neighbour's. */
export const attendeeRowOnList = (
  html: string,
  who: string,
): { row: string; wayIn: string } => {
  const found = rowsOnList(html, /\/admin\/attendees\/(\d+)$/).find(
    ({ name }) => name === who,
  );
  if (!found) {
    throw new Error(`The attendee list holds nobody called "${who}"`);
  }
  return { row: found.row, wayIn: found.wayIn };
};

/** The attendee-list link the dashboard count carries, read off the rendered
 * count so the story follows what the page really offers. */
export const countLinkOnDashboard = (html: string): string => {
  const href = html.match(
    /<a href="([^"]+)">[^<]*emails or webhooks that were not sent<\/a>/,
  )?.[1];
  if (!href) {
    throw new Error("The dashboard count carries no link to the attendee list");
  }
  return href;
};

/** The two sections of the merge screen, so a notice reads beside the
 * booking it belongs to: the kept booking's section ends where the
 * duplicate's preview begins. */
export const mergeSections = (
  html: string,
): { kept: string; duplicate: string } => {
  const at = html.indexOf(t("admin.attendees.merge_preview"));
  if (at === -1) {
    throw new Error("The merge screen shows no merge preview");
  }
  return { duplicate: html.slice(at), kept: html.slice(0, at) };
};

/** The address of the one link on a page whose words are exactly the label,
 * read off the rendered page so a story follows what the organiser clicks. A
 * page that offers no such link is a broken story, not a dead end. */
export const linkLabelled = (html: string, label: string): string => {
  const link = findAllLinks(html).find(({ text }) => text.trim() === label);
  if (!link) {
    throw new Error(`The page offers no "${label}" link`);
  }
  return link.href;
};

/** The attendee details block's name line on a confirmation page, so a
 * notice reads beside the booking's own name and never beside the page's
 * title or another booking's. */
export const confirmNameLine = (html: string, who: string): string => {
  const label = `<p><strong>${t("admin.attendees.name")}</strong>`;
  for (const rest of html.split(label).slice(1)) {
    const line = rest.slice(0, rest.indexOf("</p>"));
    if (line.includes(who)) {
      return line;
    }
  }
  throw new Error(`The details block holds no name line for "${who}"`);
};

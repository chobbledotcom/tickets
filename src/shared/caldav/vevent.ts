/**
 * Builds the calendar payload the mirror PUTs for one listing. Pure: it takes
 * the listing's public fields and a ready-made ticket URL (or null when the
 * public page would 404) and returns a complete iCalendar document.
 *
 * This deliberately does NOT reuse the attendee feed's `buildVEvent` — that one
 * keys its UID on an attendee and links to an admin page, which would leak
 * attendee data into the operator's calendar. The mirror carries only the
 * listing's own public fields.
 */

import { appendItemSchedule, escapeIcs, formatIcsDate } from "#shared/ics.ts";

/** The public listing fields a mirrored event is built from. Only dated
 * listings are mirrored, so `date` is always a real value here. */
export type MirrorListing = {
  readonly id: number;
  readonly name: string;
  readonly date: string;
  readonly description: string;
  readonly location: string;
};

export type BuildEventOptions = {
  readonly listing: MirrorListing;
  /** The stored per-destination namespace, so the UID is stable across
   * custom-domain changes and reconnects to the same calendar. */
  readonly namespace: string;
  /** The moment the push is made, as an ISO instant (for DTSTAMP). */
  readonly dtstamp: string;
  /** The listing's public `/ticket` URL, or null when the public gate rejects
   * it — an unbookable listing's event carries no link rather than a dead one. */
  readonly ticketUrl: string | null;
};

/** Build the complete iCalendar document (a VCALENDAR wrapping one VEVENT) that
 * the mirror PUTs for a dated listing. */
export const buildListingEvent = (options: BuildEventOptions): string => {
  const { dtstamp, listing, namespace, ticketUrl } = options;
  const event = [
    "BEGIN:VEVENT",
    `UID:listing-${listing.id}@${namespace}`,
    `DTSTAMP:${formatIcsDate(dtstamp)}`,
    `SUMMARY:${escapeIcs(listing.name)}`,
  ];
  if (listing.description) {
    event.push(`DESCRIPTION:${escapeIcs(listing.description)}`);
  }
  if (ticketUrl) event.push(`URL:${ticketUrl}`);
  appendItemSchedule(event, listing);
  event.push("END:VEVENT");
  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Chobble Tickets//EN",
    ...event,
    "END:VCALENDAR",
  ].join("\r\n");
};

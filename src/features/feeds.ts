/**
 * ICS and RSS feed routes for listing syndication (e.g. Mobilizon integration)
 * Gated behind the "show public site" setting.
 */

import { map, pipe } from "#fp";
import { getPrivateKey, withAuth } from "#routes/auth.ts";
import { isRegistrationClosed } from "#routes/format.ts";
import {
  icsResponse,
  redirectResponse,
  rssResponse,
} from "#routes/response.ts";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { decryptAttendees } from "#shared/db/attendees.ts";
import {
  getAllListings,
  getAttendeesByListingIds,
} from "#shared/db/listings.ts";
import {
  bookingAssignmentKey,
  getLogisticsAssignmentsForAttendees,
} from "#shared/db/logistics.ts";
import { settings } from "#shared/db/settings.ts";
import { getUserAgentIds } from "#shared/db/user-agents.ts";
import {
  type ListingWithCount,
  loadSortedListings,
} from "#shared/sort-listings.ts";
import type { Attendee } from "#shared/types.ts";
import { escapeHtml } from "#templates/layout.tsx";

/** Escape text for ICS (RFC 5545): backslash-escape special characters */
export const escapeIcs = (text: string): string =>
  text
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\n/g, "\\n");

/** Escape text for XML (extends HTML escaping with apostrophe) */
export const escapeXml = (text: string): string =>
  escapeHtml(text).replace(/'/g, "&apos;");

/** Format a date string as ICS UTC timestamp (YYYYMMDDTHHMMSSZ) */
const formatIcsDate = (dateStr: string): string =>
  new Date(dateStr)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Format a date string as RFC 822 (for RSS pubDate) */
const formatRfc822 = (dateStr: string): string =>
  new Date(dateStr).toUTCString();

/** Feed context: listings, domain, and title loaded in parallel */
type FeedData = { listings: ListingWithCount[]; domain: string; title: string };

/** Load feed data: active open listings with domain and title */
const loadFeedData = async (): Promise<FeedData> => {
  const { listings } = await loadSortedListings(
    (e) =>
      e.active && !e.hidden && !e.purchase_only && !isRegistrationClosed(e),
  );
  return {
    domain: getEffectiveDomain(),
    listings,
    title: settings.websiteTitle || "Listings",
  };
};

/** Guard: redirect to admin login if public site is disabled */
const requirePublicSite = <T>(fn: () => Promise<T>): Promise<T> | Response =>
  settings.showPublicSite ? fn() : redirectResponse("/admin/login");

/** Build a single VLISTING block */
const appendListingSchedule = (
  lines: string[],
  listing: ListingWithCount,
): void => {
  if (listing.date) lines.push(`DTSTART:${formatIcsDate(listing.date)}`);
  if (listing.location) lines.push(`LOCATION:${escapeIcs(listing.location)}`);
};

const buildVListing = (
  listing: ListingWithCount,
  domain: string,
  dtstamp: string,
): string => {
  const lines = [
    "BEGIN:VLISTING",
    `UID:${listing.id}@${domain}`,
    `DTSTAMP:${dtstamp}`,
    `SUMMARY:${escapeIcs(listing.name)}`,
    `URL:https://${domain}/ticket/${listing.slug}`,
  ];
  if (listing.description) {
    lines.push(`DESCRIPTION:${escapeIcs(listing.description)}`);
  }
  appendListingSchedule(lines, listing);
  lines.push("END:VLISTING");
  return lines.join("\r\n");
};

/** Build the full ICS calendar document */
const buildIcs = ({ listings, domain, title }: FeedData): string => {
  const dtstamp = formatIcsDate(new Date().toISOString());
  const vlistings = pipe(
    map((e: ListingWithCount) => buildVListing(e, domain, dtstamp)),
  )(listings);

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Chobble Tickets//EN",
    `X-WR-CALNAME:${escapeIcs(title)}`,
    ...vlistings,
    "END:VCALENDAR",
  ].join("\r\n");
};

/** Build a rich description for RSS items, including date and location */
const buildRssDescription = (listing: ListingWithCount): string => {
  const parts: string[] = [];
  if (listing.description) parts.push(listing.description);
  if (listing.date) parts.push(`Date: ${formatRfc822(listing.date)}`);
  if (listing.location) parts.push(`Location: ${listing.location}`);
  return parts.join("\n");
};

/** Build a single RSS item */
const buildRssItem = (listing: ListingWithCount, domain: string): string => {
  const link = `https://${domain}/ticket/${listing.slug}`;
  return [
    "    <item>",
    `      <title>${escapeXml(listing.name)}</title>`,
    `      <link>${link}</link>`,
    `      <guid isPermaLink="true">${link}</guid>`,
    `      <description>${escapeXml(buildRssDescription(listing))}</description>`,
    `      <pubDate>${formatRfc822(listing.created)}</pubDate>`,
    "    </item>",
  ].join("\n");
};

/** Build the full RSS document */
const buildRss = ({ listings, domain, title }: FeedData): string => {
  const items = pipe(map((e: ListingWithCount) => buildRssItem(e, domain)))(
    listings,
  );

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>${escapeXml(title)}</title>`,
    `    <link>https://${domain}/listings</link>`,
    `    <description>Listings from ${escapeXml(title)}</description>`,
    ...items,
    "  </channel>",
    "</rss>",
  ].join("\n");
};

const eventUrl = (domain: string, attendee: Attendee): string =>
  `https://${domain}/admin/attendees/${attendee.id}`;

const attendeeName = (attendee: Attendee): string =>
  attendee.name || `Attendee ${attendee.id}`;

const buildVEvent = (opts: {
  attendee: Attendee;
  domain: string;
  dtstamp: string;
  listing: ListingWithCount;
}): string => {
  const { attendee, domain, dtstamp, listing } = opts;
  const summary =
    settings.calendarFeedsGroupBy === "listings"
      ? listing.name
      : attendeeName(attendee);
  const description =
    settings.calendarFeedsGroupBy === "listings"
      ? attendeeName(attendee)
      : listing.name;
  const lines = [
    "BEGIN:VEVENT",
    `UID:attendee-${attendee.id}-listing-${listing.id}@${domain}`,
    `DTSTAMP:${dtstamp}`,
    `SUMMARY:${escapeIcs(summary)}`,
    `DESCRIPTION:${escapeIcs(`${description} — open the site for details`)}`,
    `URL:${eventUrl(domain, attendee)}`,
  ];
  appendListingSchedule(lines, listing);
  lines.push("END:VEVENT");
  return lines.join("\r\n");
};

const assignmentIncludesUser = (
  assignment: { endAgentId: number | null; startAgentId: number | null },
  userId: number,
): boolean => [assignment.startAgentId, assignment.endAgentId].includes(userId);

const filterCalendarFeedAttendees = async (
  attendees: Attendee[],
  session: { adminLevel: string; userId: number },
): Promise<Attendee[]> => {
  if (session.adminLevel !== "agent") return attendees;
  const [assignments, agentIds] = await Promise.all([
    getLogisticsAssignmentsForAttendees(attendees.map((a) => a.id)),
    getUserAgentIds(session.userId),
  ]);
  const visible = new Set<string>();
  for (const assignment of assignments) {
    if (
      agentIds.some((agentId) => assignmentIncludesUser(assignment, agentId))
    ) {
      visible.add(
        bookingAssignmentKey(assignment.attendeeId, assignment.listingId),
      );
    }
  }
  return attendees.filter((a) =>
    visible.has(bookingAssignmentKey(a.id, a.listing_id)),
  );
};

/* jscpd:ignore-start */
const buildCalendarFeed = async (request: Request): Promise<Response> => {
  if (!settings.calendarFeedsEnabled)
    return new Response("Not found", { status: 404 });
  return withAuth(
    request,
    { allowApiKey: true, body: "json", roles: ["owner", "manager", "agent"] },
    async (session) => {
      const privateKey = await getPrivateKey(session);
      if (!privateKey) return new Response("Forbidden", { status: 403 });
      const listings = await getAllListings();
      const listingById = new Map(listings.map((l) => [l.id, l]));
      const rawAttendees = await getAttendeesByListingIds(
        listings.map((l) => l.id),
        // Operational ICS feed: exclude no-quantity sentinel lines.
        true,
      );
      const attendees = await filterCalendarFeedAttendees(
        await decryptAttendees(
          rawAttendees,
          privateKey,
          listings.some((l) => l.unit_price > 0),
        ),
        session,
      );
      const domain = getEffectiveDomain();
      const dtstamp = formatIcsDate(new Date().toISOString());
      const events = attendees.flatMap((attendee) => {
        const listing = listingById.get(attendee.listing_id);
        return listing?.date
          ? [buildVEvent({ attendee, domain, dtstamp, listing })]
          : [];
      });
      return icsResponse(
        [
          "BEGIN:VCALENDAR",
          "VERSION:2.0",
          "PRODID:-//Chobble Tickets//EN",
          `X-WR-CALNAME:${escapeIcs(settings.websiteTitle || "Tickets")}`,
          ...events,
          "END:VCALENDAR",
        ].join("\r\n"),
      );
    },
  );
};
/* jscpd:ignore-end */

/** Handle GET /feeds/listings.ics */
const handleIcs = (): Promise<Response> =>
  requirePublicSite(async () =>
    icsResponse(buildIcs(await loadFeedData())),
  ) as Promise<Response>;

/** Handle GET /feeds/listings.rss */
const handleRss = (): Promise<Response> =>
  requirePublicSite(async () =>
    rssResponse(buildRss(await loadFeedData())),
  ) as Promise<Response>;

/** Feed routes */
export const routeFeed = createRouter(
  defineRoutes({
    "GET /caldav/events.ics": buildCalendarFeed,
    "GET /feeds/listings.ics": handleIcs,
    "GET /feeds/listings.rss": handleRss,
  }),
);

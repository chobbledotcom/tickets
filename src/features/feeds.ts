/**
 * ICS and RSS feed routes for listing syndication (e.g. Mobilizon integration)
 * Gated behind the "show public site" setting.
 */

import { map, pipe } from "#fp";
import { withAuth } from "#routes/auth.ts";
import { isRegistrationClosed } from "#routes/format.ts";
import {
  classifyForDiscovery,
  dropHiddenPackageMembers,
  loadPublicGroups,
} from "#routes/public/discovery.ts";
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
import { getRequestPrivateKey } from "#shared/session-private-key.ts";
import {
  type ListingWithCount,
  loadSortedListings,
} from "#shared/sort-listings.ts";
import type { Attendee, Group } from "#shared/types.ts";
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

/** One syndicated item — a standalone listing or a bookable package bundle,
 * both linking to their `/ticket/<slug>` page. `uid` keeps listing and package
 * ids from colliding in the ICS UID namespace. */
type FeedItem = {
  uid: string;
  name: string;
  slug: string;
  description: string;
  date: string | null;
  location: string;
  /** RSS pubDate source; null for packages (groups carry no created stamp),
   * which simply omit the optional pubDate element. */
  created: string | null;
};

const listingFeedItem = (listing: ListingWithCount): FeedItem => ({
  created: listing.created,
  date: listing.date || null,
  description: listing.description,
  location: listing.location,
  name: listing.name,
  slug: listing.slug,
  uid: `listing-${listing.id}`,
});

/** Feed context: items, domain, and title */
type FeedData = { items: FeedItem[]; domain: string; title: string };

/** Load feed data: active open listings plus bookable packages. Children are
 * never syndicated (a feed item is a standalone `/ticket/<slug>` link, which a
 * booking can't start from — invariant I3), and a parent with no bookable child
 * is omitted (it would publish a link the gate rejects as sold out — I6).
 * Packages are first-class products: the bundle itself is syndicated (booked
 * whole at `/ticket/<group-slug>`), so a hidden package stays discoverable even
 * though its member listings are dropped. */
const loadFeedData = async (): Promise<FeedData> => {
  const { listings: allListings } = await loadSortedListings(
    (e) =>
      e.active && !e.hidden && !e.purchase_only && !isRegistrationClosed(e),
  );
  // A hidden package's members are never syndicated standalone — only the
  // package name is public.
  const listings = await dropHiddenPackageMembers(allListings);
  const { childIds, soldOutParentIds } = await classifyForDiscovery(listings);
  const packages = (await loadPublicGroups())
    .filter((g) => g.is_package)
    .map(
      (g: Group): FeedItem => ({
        created: null,
        date: null,
        description: g.description,
        location: "",
        name: g.name,
        slug: g.slug,
        uid: `package-${g.id}`,
      }),
    );
  return {
    domain: getEffectiveDomain(),
    items: [
      ...listings
        .filter((e) => !childIds.has(e.id) && !soldOutParentIds.has(e.id))
        .map(listingFeedItem),
      ...packages,
    ],
    title: settings.websiteTitle || "Listings",
  };
};

/** Guard: redirect to admin login if public site is disabled */
const requirePublicSite = <T>(fn: () => Promise<T>): Promise<T> | Response =>
  settings.showPublicSite ? fn() : redirectResponse("/admin/login");

/** Append the shared DTSTART/LOCATION lines for anything carrying a date and
 * location — feed items and (via the admin calendar's VEVENTs) listings. */
const appendItemSchedule = (
  lines: string[],
  item: { date: string | null; location: string },
): void => {
  if (item.date) lines.push(`DTSTART:${formatIcsDate(item.date)}`);
  if (item.location) lines.push(`LOCATION:${escapeIcs(item.location)}`);
};

const buildVListing = (
  item: FeedItem,
  domain: string,
  dtstamp: string,
): string => {
  const lines = [
    "BEGIN:VLISTING",
    `UID:${item.uid}@${domain}`,
    `DTSTAMP:${dtstamp}`,
    `SUMMARY:${escapeIcs(item.name)}`,
    `URL:https://${domain}/ticket/${item.slug}`,
  ];
  if (item.description) {
    lines.push(`DESCRIPTION:${escapeIcs(item.description)}`);
  }
  appendItemSchedule(lines, item);
  lines.push("END:VLISTING");
  return lines.join("\r\n");
};

/** Build the full ICS calendar document */
const buildIcs = ({ items, domain, title }: FeedData): string => {
  const dtstamp = formatIcsDate(new Date().toISOString());
  const vlistings = pipe(
    map((e: FeedItem) => buildVListing(e, domain, dtstamp)),
  )(items);

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
const buildRssDescription = (item: FeedItem): string => {
  const parts: string[] = [];
  if (item.description) parts.push(item.description);
  if (item.date) parts.push(`Date: ${formatRfc822(item.date)}`);
  if (item.location) parts.push(`Location: ${item.location}`);
  return parts.join("\n");
};

/** Build a single RSS item */
const buildRssItem = (item: FeedItem, domain: string): string => {
  const link = `https://${domain}/ticket/${item.slug}`;
  return [
    "    <item>",
    `      <title>${escapeXml(item.name)}</title>`,
    `      <link>${link}</link>`,
    `      <guid isPermaLink="true">${link}</guid>`,
    `      <description>${escapeXml(buildRssDescription(item))}</description>`,
    ...(item.created
      ? [`      <pubDate>${formatRfc822(item.created)}</pubDate>`]
      : []),
    "    </item>",
  ].join("\n");
};

/** Build the full RSS document */
const buildRss = ({ items: feedItems, domain, title }: FeedData): string => {
  const items = pipe(map((e: FeedItem) => buildRssItem(e, domain)))(feedItems);

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
  appendItemSchedule(lines, listing);
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
      const privateKey = await getRequestPrivateKey();
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

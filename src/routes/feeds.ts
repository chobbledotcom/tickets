/**
 * ICS and RSS feed routes for event syndication (e.g. Mobilizon integration)
 * Gated behind the "show public site" setting.
 */

import { map, pipe } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { getAllEvents } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import { getShowPublicSiteFromDb, getWebsiteTitleFromDb } from "#lib/db/settings.ts";
import { sortEvents } from "#lib/sort-events.ts";
import type { EventWithCount } from "#lib/types.ts";
import { escapeHtml } from "#templates/layout.tsx";
import { createRouter, defineRoutes } from "#routes/router.ts";
import { icsResponse, isRegistrationClosed, redirect, rssResponse } from "#routes/utils.ts";

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
  new Date(dateStr).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

/** Format a date string as RFC 822 (for RSS pubDate) */
const formatRfc822 = (dateStr: string): string =>
  new Date(dateStr).toUTCString();

/** Feed context: events, domain, and title loaded in parallel */
type FeedData = { events: EventWithCount[]; domain: string; title: string };

/** Load feed data: active open events with domain and title */
const loadFeedData = async (): Promise<FeedData> => {
  const [allEvents, holidays, websiteTitle] = await Promise.all([
    getAllEvents(),
    getActiveHolidays(),
    getWebsiteTitleFromDb(),
  ]);
  const events = sortEvents(
    allEvents.filter((e) => e.active && !e.hidden && !isRegistrationClosed(e)),
    holidays,
  );
  return { events, domain: getAllowedDomain(), title: websiteTitle || "Events" };
};

/** Guard: redirect to admin if public site is disabled */
const requirePublicSite = async <T>(fn: () => Promise<T>): Promise<T | Response> =>
  await getShowPublicSiteFromDb() ? fn() : redirect("/admin/");

/** Build a single VEVENT block */
const buildVEvent = (event: EventWithCount, domain: string, dtstamp: string): string => {
  const lines = [
    "BEGIN:VEVENT",
    `UID:${event.id}@${domain}`,
    `DTSTAMP:${dtstamp}`,
    `SUMMARY:${escapeIcs(event.name)}`,
    `URL:https://${domain}/ticket/${event.slug}`,
  ];
  if (event.description) lines.push(`DESCRIPTION:${escapeIcs(event.description)}`);
  if (event.date) lines.push(`DTSTART:${formatIcsDate(event.date)}`);
  if (event.location) lines.push(`LOCATION:${escapeIcs(event.location)}`);
  lines.push("END:VEVENT");
  return lines.join("\r\n");
};

/** Build the full ICS calendar document */
const buildIcs = ({ events, domain, title }: FeedData): string => {
  const dtstamp = formatIcsDate(new Date().toISOString());
  const vevents = pipe(
    map((e: EventWithCount) => buildVEvent(e, domain, dtstamp)),
  )(events);

  return [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Chobble Tickets//EN",
    `X-WR-CALNAME:${escapeIcs(title)}`,
    ...vevents,
    "END:VCALENDAR",
  ].join("\r\n");
};

/** Build a single RSS item */
const buildRssItem = (event: EventWithCount, domain: string): string => {
  const link = `https://${domain}/ticket/${event.slug}`;
  return [
    "    <item>",
    `      <title>${escapeXml(event.name)}</title>`,
    `      <link>${link}</link>`,
    `      <guid isPermaLink="true">${link}</guid>`,
    `      <description>${escapeXml(event.description || "")}</description>`,
    `      <pubDate>${formatRfc822(event.created)}</pubDate>`,
    "    </item>",
  ].join("\n");
};

/** Build the full RSS document */
const buildRss = ({ events, domain, title }: FeedData): string => {
  const items = pipe(
    map((e: EventWithCount) => buildRssItem(e, domain)),
  )(events);

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<rss version="2.0">',
    "  <channel>",
    `    <title>${escapeXml(title)}</title>`,
    `    <link>https://${domain}/events</link>`,
    `    <description>Events from ${escapeXml(title)}</description>`,
    ...items,
    "  </channel>",
    "</rss>",
  ].join("\n");
};

/** Handle GET /feeds/events.ics */
const handleIcs = (): Promise<Response> =>
  requirePublicSite(async () =>
    icsResponse(buildIcs(await loadFeedData())),
  ) as Promise<Response>;

/** Handle GET /feeds/events.rss */
const handleRss = (): Promise<Response> =>
  requirePublicSite(async () =>
    rssResponse(buildRss(await loadFeedData())),
  ) as Promise<Response>;

/** Feed routes */
export const routeFeed = createRouter(defineRoutes({
  "GET /feeds/events.ics": handleIcs,
  "GET /feeds/events.rss": handleRss,
}));

/**
 * Tests for ICS and RSS feed endpoints
 */

import { expect } from "@std/expect";
import { afterEach, beforeEach, describe, it as test } from "@std/testing/bdd";
import { updateShowPublicSite, updateWebsiteTitle } from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import { escapeIcs, escapeXml } from "#routes/feeds.ts";
import {
  createTestDbWithSetup,
  createTestEvent,
  deactivateTestEvent,
  mockRequest,
  resetDb,
  resetTestSlugCounter,
} from "#test-utils";

/** Fetch a feed URL and return the body text */
const fetchFeedBody = async (feedPath: string): Promise<string> => {
  const response = await handleRequest(mockRequest(feedPath));
  return response.text();
};

/** Assert a deactivated event is excluded from a feed */
const expectExcludesInactive = async (feedPath: string, absentTag: string) => {
  await updateShowPublicSite(true);
  const event = await createTestEvent({ name: "Hidden", maxAttendees: 100 });
  await deactivateTestEvent(event.id);
  const body = await fetchFeedBody(feedPath);
  expect(body).not.toContain("Hidden");
  expect(body).not.toContain(absentTag);
};

/** Assert an event with closed registration is excluded from a feed */
const expectExcludesClosedRegistration = async (
  feedPath: string,
  absentTag: string,
) => {
  await updateShowPublicSite(true);
  const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
  await createTestEvent({
    name: "Closed Event",
    maxAttendees: 100,
    closesAt: pastDate,
  });
  const body = await fetchFeedBody(feedPath);
  expect(body).not.toContain("Closed Event");
  expect(body).not.toContain(absentTag);
};

describe("feeds", () => {
  beforeEach(async () => {
    resetTestSlugCounter();
    await createTestDbWithSetup();
  });

  afterEach(() => {
    resetDb();
  });

  describe("GET /feeds/events.ics", () => {
    test("redirects to admin when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
    });

    test("returns text/calendar content type", async () => {
      await updateShowPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/calendar; charset=utf-8",
      );
    });

    test("returns valid VCALENDAR wrapper with no events", async () => {
      await updateShowPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("BEGIN:VCALENDAR");
      expect(body).toContain("VERSION:2.0");
      expect(body).toContain("PRODID:-//Chobble Tickets//EN");
      expect(body).toContain("END:VCALENDAR");
      expect(body).not.toContain("BEGIN:VEVENT");
    });

    test("uses website title as calendar name", async () => {
      await updateShowPublicSite(true);
      await updateWebsiteTitle("My Events");
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("X-WR-CALNAME:My Events");
    });

    test("defaults calendar name to Events when no title set", async () => {
      await updateShowPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("X-WR-CALNAME:Events");
    });

    test("includes VEVENT for active events", async () => {
      await updateShowPublicSite(true);
      const event = await createTestEvent({
        name: "Concert",
        maxAttendees: 100,
      });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("BEGIN:VEVENT");
      expect(body).toContain("SUMMARY:Concert");
      expect(body).toContain(`/ticket/${event.slug}`);
      expect(body).toContain("END:VEVENT");
    });

    test("includes UID and DTSTAMP", async () => {
      await updateShowPublicSite(true);
      const event = await createTestEvent({ name: "Show", maxAttendees: 50 });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain(`UID:${event.id}@`);
      expect(body).toContain("DTSTAMP:");
    });

    test("includes DTSTART when event has a date", async () => {
      await updateShowPublicSite(true);
      await createTestEvent({
        name: "Dated Event",
        maxAttendees: 100,
        date: "2026-06-15T14:00",
      });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("DTSTART:20260615T140000Z");
    });

    test("includes DESCRIPTION when event has a description", async () => {
      await updateShowPublicSite(true);
      await createTestEvent({
        name: "Described",
        maxAttendees: 100,
        description: "A great event",
      });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("DESCRIPTION:A great event");
    });

    test("includes LOCATION when event has a location", async () => {
      await updateShowPublicSite(true);
      await createTestEvent({
        name: "Located",
        maxAttendees: 100,
        location: "Town Hall",
      });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("LOCATION:Town Hall");
    });

    test("excludes inactive events", async () => {
      await expectExcludesInactive("/feeds/events.ics", "BEGIN:VEVENT");
    });

    test("excludes events with closed registration", async () => {
      await expectExcludesClosedRegistration(
        "/feeds/events.ics",
        "BEGIN:VEVENT",
      );
    });

    test("excludes hidden events", async () => {
      await updateShowPublicSite(true);
      await createTestEvent({
        name: "Secret Event",
        maxAttendees: 100,
        hidden: true,
      });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).not.toContain("Secret Event");
      expect(body).not.toContain("BEGIN:VEVENT");
    });

    test("escapes special characters in event fields", async () => {
      await updateShowPublicSite(true);
      await createTestEvent({
        name: "Rock, Paper; Scissors",
        maxAttendees: 100,
        description: "Fun, games; and more",
        location: "Hall A, Floor 2",
      });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("SUMMARY:Rock\\, Paper\\; Scissors");
      expect(body).toContain("DESCRIPTION:Fun\\, games\\; and more");
      expect(body).toContain("LOCATION:Hall A\\, Floor 2");
    });
  });

  describe("GET /feeds/events.rss", () => {
    test("redirects to admin when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/");
    });

    test("returns application/rss+xml content type", async () => {
      await updateShowPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/rss+xml; charset=utf-8",
      );
    });

    test("returns valid RSS wrapper with no events", async () => {
      await updateShowPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain('<?xml version="1.0"');
      expect(body).toContain('<rss version="2.0">');
      expect(body).toContain("<channel>");
      expect(body).toContain("</channel>");
      expect(body).toContain("</rss>");
      expect(body).not.toContain("<item>");
    });

    test("uses website title in channel", async () => {
      await updateShowPublicSite(true);
      await updateWebsiteTitle("My Events");
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("<title>My Events</title>");
      expect(body).toContain(
        "<description>Events from My Events</description>",
      );
    });

    test("defaults title to Events when no title set", async () => {
      await updateShowPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("<title>Events</title>");
    });

    test("includes items for active events", async () => {
      await updateShowPublicSite(true);
      const event = await createTestEvent({
        name: "Concert",
        maxAttendees: 100,
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("<item>");
      expect(body).toContain("<title>Concert</title>");
      expect(body).toContain(`/ticket/${event.slug}`);
      expect(body).toContain("<pubDate>");
      expect(body).toContain("</item>");
    });

    test("includes guid as permalink", async () => {
      await updateShowPublicSite(true);
      const event = await createTestEvent({ name: "Show", maxAttendees: 50 });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain(`<guid isPermaLink="true">`);
      expect(body).toContain(`/ticket/${event.slug}</guid>`);
    });

    test("includes description when event has one", async () => {
      await updateShowPublicSite(true);
      await createTestEvent({
        name: "Described",
        maxAttendees: 100,
        description: "A great event",
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("A great event");
    });

    test("includes date in description when event has a date", async () => {
      await updateShowPublicSite(true);
      await createTestEvent({
        name: "Dated",
        maxAttendees: 100,
        date: "2026-06-15T14:00",
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("Date:");
      expect(body).toContain("15 Jun 2026");
    });

    test("includes location in description when event has a location", async () => {
      await updateShowPublicSite(true);
      await createTestEvent({
        name: "Located",
        maxAttendees: 100,
        location: "Town Hall",
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("Location: Town Hall");
    });

    test("includes description, date, and location together", async () => {
      await updateShowPublicSite(true);
      await createTestEvent({
        name: "Full Event",
        maxAttendees: 100,
        description: "A great event",
        date: "2026-06-15T14:00",
        location: "Town Hall",
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("A great event");
      expect(body).toContain("Date:");
      expect(body).toContain("Location: Town Hall");
    });

    test("excludes inactive events", async () => {
      await expectExcludesInactive("/feeds/events.rss", "<item>");
    });

    test("excludes events with closed registration", async () => {
      await expectExcludesClosedRegistration("/feeds/events.rss", "<item>");
    });

    test("excludes hidden events", async () => {
      await updateShowPublicSite(true);
      await createTestEvent({
        name: "Secret Event",
        maxAttendees: 100,
        hidden: true,
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).not.toContain("Secret Event");
      expect(body).not.toContain("<item>");
    });

    test("XML-escapes special characters", async () => {
      await updateShowPublicSite(true);
      await createTestEvent({
        name: "Rock & Roll <Live>",
        maxAttendees: 100,
        description: 'He said "hello" & goodbye',
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("<title>Rock &amp; Roll &lt;Live&gt;</title>");
      expect(body).toContain("He said &quot;hello&quot; &amp; goodbye");
    });
  });

  describe("escapeIcs", () => {
    test("escapes backslashes", () => {
      expect(escapeIcs("a\\b")).toBe("a\\\\b");
    });

    test("escapes semicolons", () => {
      expect(escapeIcs("a;b")).toBe("a\\;b");
    });

    test("escapes commas", () => {
      expect(escapeIcs("a,b")).toBe("a\\,b");
    });

    test("escapes newlines", () => {
      expect(escapeIcs("a\nb")).toBe("a\\nb");
    });

    test("handles multiple special characters", () => {
      expect(escapeIcs("a,b;c\\d\ne")).toBe("a\\,b\\;c\\\\d\\ne");
    });
  });

  describe("escapeXml", () => {
    test("escapes ampersands", () => {
      expect(escapeXml("a&b")).toBe("a&amp;b");
    });

    test("escapes angle brackets", () => {
      expect(escapeXml("<tag>")).toBe("&lt;tag&gt;");
    });

    test("escapes quotes", () => {
      expect(escapeXml("\"hello'")).toBe("&quot;hello&apos;");
    });

    test("handles multiple special characters", () => {
      expect(escapeXml("a&b<c>\"d'e")).toBe("a&amp;b&lt;c&gt;&quot;d&apos;e");
    });
  });
});

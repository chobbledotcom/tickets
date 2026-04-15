/**
 * Tests for ICS and RSS feed endpoints
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#lib/db/settings.ts";
import { handleRequest } from "#routes";
import { escapeIcs, escapeXml } from "#routes/feeds.ts";
import {
  createTestEvent,
  deactivateTestEvent,
  describeWithEnv,
  mockRequest,
} from "#test-utils";

/** Fetch a feed URL and return the body text */
const fetchFeedBody = async (feedPath: string): Promise<string> => {
  const response = await handleRequest(mockRequest(feedPath));
  return response.text();
};

/** Assert a deactivated event is excluded from a feed */
const expectExcludesInactive = async (feedPath: string, absentTag: string) => {
  await settings.update.showPublicSite(true);
  const event = await createTestEvent({ maxAttendees: 100, name: "Hidden" });
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
  await settings.update.showPublicSite(true);
  const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
  await createTestEvent({
    closesAt: pastDate,
    maxAttendees: 100,
    name: "Closed Event",
  });
  const body = await fetchFeedBody(feedPath);
  expect(body).not.toContain("Closed Event");
  expect(body).not.toContain(absentTag);
};

describeWithEnv("feeds", { db: true }, () => {
  describe("GET /feeds/events.ics", () => {
    test("redirects to admin when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/login");
    });

    test("returns text/calendar content type", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/calendar; charset=utf-8",
      );
    });

    test("returns valid VCALENDAR wrapper with no events", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("BEGIN:VCALENDAR");
      expect(body).toContain("VERSION:2.0");
      expect(body).toContain("PRODID:-//Chobble Tickets//EN");
      expect(body).toContain("END:VCALENDAR");
      expect(body).not.toContain("BEGIN:VEVENT");
    });

    test("uses website title as calendar name", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.websiteTitle("My Events");
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("X-WR-CALNAME:My Events");
    });

    test("defaults calendar name to Events when no title set", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("X-WR-CALNAME:Events");
    });

    test("includes VEVENT for active events", async () => {
      await settings.update.showPublicSite(true);
      const event = await createTestEvent({
        maxAttendees: 100,
        name: "Concert",
      });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("BEGIN:VEVENT");
      expect(body).toContain("SUMMARY:Concert");
      expect(body).toContain(`/ticket/${event.slug}`);
      expect(body).toContain("END:VEVENT");
    });

    test("includes UID and DTSTAMP", async () => {
      await settings.update.showPublicSite(true);
      const event = await createTestEvent({ maxAttendees: 50, name: "Show" });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain(`UID:${event.id}@`);
      expect(body).toContain("DTSTAMP:");
    });

    test("includes DTSTART when event has a date", async () => {
      await settings.update.showPublicSite(true);
      await createTestEvent({
        date: "2026-06-15T14:00",
        maxAttendees: 100,
        name: "Dated Event",
      });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("DTSTART:20260615T140000Z");
    });

    test("includes DESCRIPTION when event has a description", async () => {
      await settings.update.showPublicSite(true);
      await createTestEvent({
        description: "A great event",
        maxAttendees: 100,
        name: "Described",
      });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).toContain("DESCRIPTION:A great event");
    });

    test("includes LOCATION when event has a location", async () => {
      await settings.update.showPublicSite(true);
      await createTestEvent({
        location: "Town Hall",
        maxAttendees: 100,
        name: "Located",
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
      await settings.update.showPublicSite(true);
      await createTestEvent({
        hidden: true,
        maxAttendees: 100,
        name: "Secret Event",
      });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).not.toContain("Secret Event");
      expect(body).not.toContain("BEGIN:VEVENT");
    });

    test("excludes purchase_only events", async () => {
      await settings.update.showPublicSite(true);
      await createTestEvent({
        maxAttendees: 100,
        name: "Raffle Tickets",
        purchaseOnly: true,
      });
      const response = await handleRequest(mockRequest("/feeds/events.ics"));
      const body = await response.text();
      expect(body).not.toContain("Raffle Tickets");
      expect(body).not.toContain("BEGIN:VEVENT");
    });

    test("escapes special characters in event fields", async () => {
      await settings.update.showPublicSite(true);
      await createTestEvent({
        description: "Fun, games; and more",
        location: "Hall A, Floor 2",
        maxAttendees: 100,
        name: "Rock, Paper; Scissors",
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
      expect(response.headers.get("location")).toBe("/admin/login");
    });

    test("returns application/rss+xml content type", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/rss+xml; charset=utf-8",
      );
    });

    test("returns valid RSS wrapper with no events", async () => {
      await settings.update.showPublicSite(true);
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
      await settings.update.showPublicSite(true);
      await settings.update.websiteTitle("My Events");
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("<title>My Events</title>");
      expect(body).toContain(
        "<description>Events from My Events</description>",
      );
    });

    test("defaults title to Events when no title set", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("<title>Events</title>");
    });

    test("includes items for active events", async () => {
      await settings.update.showPublicSite(true);
      const event = await createTestEvent({
        maxAttendees: 100,
        name: "Concert",
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
      await settings.update.showPublicSite(true);
      const event = await createTestEvent({ maxAttendees: 50, name: "Show" });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain(`<guid isPermaLink="true">`);
      expect(body).toContain(`/ticket/${event.slug}</guid>`);
    });

    test("includes description when event has one", async () => {
      await settings.update.showPublicSite(true);
      await createTestEvent({
        description: "A great event",
        maxAttendees: 100,
        name: "Described",
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("A great event");
    });

    test("includes date in description when event has a date", async () => {
      await settings.update.showPublicSite(true);
      await createTestEvent({
        date: "2026-06-15T14:00",
        maxAttendees: 100,
        name: "Dated",
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("Date:");
      expect(body).toContain("15 Jun 2026");
    });

    test("includes location in description when event has a location", async () => {
      await settings.update.showPublicSite(true);
      await createTestEvent({
        location: "Town Hall",
        maxAttendees: 100,
        name: "Located",
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).toContain("Location: Town Hall");
    });

    test("includes description, date, and location together", async () => {
      await settings.update.showPublicSite(true);
      await createTestEvent({
        date: "2026-06-15T14:00",
        description: "A great event",
        location: "Town Hall",
        maxAttendees: 100,
        name: "Full Event",
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
      await settings.update.showPublicSite(true);
      await createTestEvent({
        hidden: true,
        maxAttendees: 100,
        name: "Secret Event",
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).not.toContain("Secret Event");
      expect(body).not.toContain("<item>");
    });

    test("excludes purchase_only events", async () => {
      await settings.update.showPublicSite(true);
      await createTestEvent({
        maxAttendees: 100,
        name: "Raffle Tickets",
        purchaseOnly: true,
      });
      const response = await handleRequest(mockRequest("/feeds/events.rss"));
      const body = await response.text();
      expect(body).not.toContain("Raffle Tickets");
      expect(body).not.toContain("<item>");
    });

    test("XML-escapes special characters", async () => {
      await settings.update.showPublicSite(true);
      await createTestEvent({
        description: 'He said "hello" & goodbye',
        maxAttendees: 100,
        name: "Rock & Roll <Live>",
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

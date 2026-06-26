/**
 * Tests for ICS and RSS feed endpoints
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { escapeIcs, escapeXml } from "#routes/feeds.ts";
import { settings } from "#shared/db/settings.ts";
import {
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  expectHtml,
  mockRequest,
} from "#test-utils";

/** Fetch a feed URL and return the body text */
const fetchFeedBody = async (feedPath: string): Promise<string> => {
  const response = await handleRequest(mockRequest(feedPath));
  return response.text();
};

/** Assert a deactivated listing is excluded from a feed */
const expectExcludesInactive = async (feedPath: string, absentTag: string) => {
  await settings.update.showPublicSite(true);
  const listing = await createTestListing({
    maxAttendees: 100,
    name: "Hidden",
  });
  await deactivateTestListing(listing.id);
  const body = await fetchFeedBody(feedPath);
  expect(body).not.toContain("Hidden");
  expect(body).not.toContain(absentTag);
};

/** Assert an listing with closed registration is excluded from a feed */
const expectExcludesClosedRegistration = async (
  feedPath: string,
  absentTag: string,
) => {
  await settings.update.showPublicSite(true);
  const pastDate = new Date(Date.now() - 60000).toISOString().slice(0, 16);
  await createTestListing({
    closesAt: pastDate,
    maxAttendees: 100,
    name: "Closed Listing",
  });
  const body = await fetchFeedBody(feedPath);
  expect(body).not.toContain("Closed Listing");
  expect(body).not.toContain(absentTag);
};

const expectCalendarFeed = async (
  request: Request,
  opts: { contains?: string[]; notContains?: string[] } = {},
): Promise<void> => {
  const response = await handleRequest(request);
  expect(response.headers.get("content-type")).toBe(
    "text/calendar; charset=utf-8",
  );
  await expectHtml(response, {
    contains: opts.contains,
    notContains: opts.notContains,
    status: 200,
  });
};

describeWithEnv("feeds", { db: true }, () => {
  describe("GET /feeds/listings.ics", () => {
    test("redirects to admin when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/login");
    });

    test("returns text/calendar content type", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/calendar; charset=utf-8",
      );
    });

    test("returns valid VCALENDAR wrapper with no listings", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      expect(body).toContain("BEGIN:VCALENDAR");
      expect(body).toContain("VERSION:2.0");
      expect(body).toContain("PRODID:-//Chobble Tickets//EN");
      expect(body).toContain("END:VCALENDAR");
      expect(body).not.toContain("BEGIN:VLISTING");
    });

    test("uses website title as calendar name", async () => {
      await settings.update.showPublicSite(true);
      await settings.update.websiteTitle("My Listings");
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      expect(body).toContain("X-WR-CALNAME:My Listings");
    });

    test("defaults calendar name to Listings when no title set", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      expect(body).toContain("X-WR-CALNAME:Listings");
    });

    test("includes VLISTING for active listings", async () => {
      await settings.update.showPublicSite(true);
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Concert",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      expect(body).toContain("BEGIN:VLISTING");
      expect(body).toContain("SUMMARY:Concert");
      expect(body).toContain(`/ticket/${listing.slug}`);
      expect(body).toContain("END:VLISTING");
    });

    test("includes UID and DTSTAMP", async () => {
      await settings.update.showPublicSite(true);
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Show",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      expect(body).toContain(`UID:${listing.id}@`);
      expect(body).toContain("DTSTAMP:");
    });

    test("includes DTSTART when listing has a date", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        date: "2026-06-15T14:00",
        maxAttendees: 100,
        name: "Dated Listing",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      expect(body).toContain("DTSTART:20260615T140000Z");
    });

    test("includes DESCRIPTION when listing has a description", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        description: "A great listing",
        maxAttendees: 100,
        name: "Described",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      expect(body).toContain("DESCRIPTION:A great listing");
    });

    test("includes LOCATION when listing has a location", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        location: "Town Hall",
        maxAttendees: 100,
        name: "Located",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      expect(body).toContain("LOCATION:Town Hall");
    });

    test("excludes inactive listings", async () => {
      await expectExcludesInactive("/feeds/listings.ics", "BEGIN:VLISTING");
    });

    test("excludes listings with closed registration", async () => {
      await expectExcludesClosedRegistration(
        "/feeds/listings.ics",
        "BEGIN:VLISTING",
      );
    });

    test("excludes hidden listings", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        hidden: true,
        maxAttendees: 100,
        name: "Secret Listing",
      });
      await expectHtml(
        await handleRequest(mockRequest("/feeds/listings.ics")),
        { notContains: ["Secret Listing", "BEGIN:VLISTING"] },
      );
    });

    test("excludes purchase_only listings", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        maxAttendees: 100,
        name: "Raffle Tickets",
        purchaseOnly: true,
      });
      await expectHtml(
        await handleRequest(mockRequest("/feeds/listings.ics")),
        { notContains: ["Raffle Tickets", "BEGIN:VLISTING"] },
      );
    });

    test("escapes special characters in listing fields", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        description: "Fun, games; and more",
        location: "Hall A, Floor 2",
        maxAttendees: 100,
        name: "Rock, Paper; Scissors",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      expect(body).toContain("SUMMARY:Rock\\, Paper\\; Scissors");
      expect(body).toContain("DESCRIPTION:Fun\\, games\\; and more");
      expect(body).toContain("LOCATION:Hall A\\, Floor 2");
    });
  });

  describe("GET /feeds/listings.rss", () => {
    test("redirects to admin when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/login");
    });

    test("returns application/rss+xml content type", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/rss+xml; charset=utf-8",
      );
    });

    test("returns valid RSS wrapper with no listings", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
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
      await settings.update.websiteTitle("My Listings");
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      expect(body).toContain("<title>My Listings</title>");
      expect(body).toContain(
        "<description>Listings from My Listings</description>",
      );
    });

    test("defaults title to Listings when no title set", async () => {
      await settings.update.showPublicSite(true);
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      expect(body).toContain("<title>Listings</title>");
    });

    test("includes items for active listings", async () => {
      await settings.update.showPublicSite(true);
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Concert",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      expect(body).toContain("<item>");
      expect(body).toContain("<title>Concert</title>");
      expect(body).toContain(`/ticket/${listing.slug}`);
      expect(body).toContain("<pubDate>");
      expect(body).toContain("</item>");
    });

    test("includes guid as permalink", async () => {
      await settings.update.showPublicSite(true);
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Show",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      expect(body).toContain(`<guid isPermaLink="true">`);
      expect(body).toContain(`/ticket/${listing.slug}</guid>`);
    });

    test("includes description when listing has one", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        description: "A great listing",
        maxAttendees: 100,
        name: "Described",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      expect(body).toContain("A great listing");
    });

    test("includes date in description when listing has a date", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        date: "2026-06-15T14:00",
        maxAttendees: 100,
        name: "Dated",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      expect(body).toContain("Date:");
      expect(body).toContain("15 Jun 2026");
    });

    test("includes location in description when listing has a location", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        location: "Town Hall",
        maxAttendees: 100,
        name: "Located",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      expect(body).toContain("Location: Town Hall");
    });

    test("includes description, date, and location together", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        date: "2026-06-15T14:00",
        description: "A great listing",
        location: "Town Hall",
        maxAttendees: 100,
        name: "Full Listing",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      expect(body).toContain("A great listing");
      expect(body).toContain("Date:");
      expect(body).toContain("Location: Town Hall");
    });

    test("excludes inactive listings", async () => {
      await expectExcludesInactive("/feeds/listings.rss", "<item>");
    });

    test("excludes listings with closed registration", async () => {
      await expectExcludesClosedRegistration("/feeds/listings.rss", "<item>");
    });

    test("excludes hidden listings", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        hidden: true,
        maxAttendees: 100,
        name: "Secret Listing",
      });
      await expectHtml(
        await handleRequest(mockRequest("/feeds/listings.rss")),
        { notContains: ["Secret Listing", "<item>"] },
      );
    });

    test("excludes purchase_only listings", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        maxAttendees: 100,
        name: "Raffle Tickets",
        purchaseOnly: true,
      });
      await expectHtml(
        await handleRequest(mockRequest("/feeds/listings.rss")),
        { notContains: ["Raffle Tickets", "<item>"] },
      );
    });

    test("XML-escapes special characters", async () => {
      await settings.update.showPublicSite(true);
      await createTestListing({
        description: 'He said "hello" & goodbye',
        maxAttendees: 100,
        name: "Rock & Roll <Live>",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
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

describeWithEnv("calendar attendee feeds", { db: true }, () => {
  test("returns not found when disabled", async () => {
    const response = await handleRequest(mockRequest("/caldav/events.ics"));
    expect(response.status).toBe(404);
  });

  test("rejects unauthenticated requests when enabled", async () => {
    await settings.update.calendarFeedsEnabled(true);
    const response = await handleRequest(mockRequest("/caldav/events.ics"));
    expect(response.status).toBe(401);
  });

  test("serves a cookie session without a CSRF header", async () => {
    const { getTestSession } = await import("#test-utils/session.ts");
    const { createTestAttendee } = await import("#test-utils/db-helpers.ts");
    await settings.update.calendarFeedsEnabled(true);
    await settings.update.calendarFeedsGroupBy("attendees");
    const listing = await createTestListing({
      date: "2026-08-01T09:30",
      maxAttendees: 10,
      name: "Cookie Show",
    });
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Cookie Person",
      "cookie@test.com",
    );

    // A calendar client subscribing to the feed sends its session cookie but
    // cannot attach an x-csrf-token header, so this safe GET must not demand
    // one — otherwise the feed is unusable from a browser/calendar session.
    const { cookie } = await getTestSession();
    await expectCalendarFeed(
      mockRequest("/caldav/events.ics", { headers: { cookie } }),
      { contains: ["SUMMARY:Cookie Person"] },
    );
  });

  test("returns attendee-grouped events for API keys", async () => {
    const { createTestApiKeyFull, requestAsApiKey } = await import(
      "#test-utils/session.ts"
    );
    const { createTestAttendee } = await import("#test-utils/db-helpers.ts");
    await settings.update.calendarFeedsEnabled(true);
    await settings.update.calendarFeedsGroupBy("attendees");
    const { apiKey } = await createTestApiKeyFull("Calendar");
    const listing = await createTestListing({
      date: "2026-08-01T09:30",
      location: "Main Hall",
      maxAttendees: 10,
      name: "Summer Show",
    });
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Alice Example",
      "a@test.com",
    );

    await expectCalendarFeed(requestAsApiKey("/caldav/events.ics", apiKey), {
      contains: [
        "BEGIN:VEVENT",
        "SUMMARY:Alice Example",
        "DESCRIPTION:Summer Show",
        "DTSTART:20260801T093000Z",
        "LOCATION:Main Hall",
        "/admin/attendees/",
      ],
    });
  });

  test("returns listing-grouped events for API keys", async () => {
    const { createTestApiKeyFull, requestAsApiKey } = await import(
      "#test-utils/session.ts"
    );
    const { createTestAttendee } = await import("#test-utils/db-helpers.ts");
    await settings.update.calendarFeedsEnabled(true);
    await settings.update.calendarFeedsGroupBy("listings");
    const { apiKey } = await createTestApiKeyFull("Calendar Listings");
    const listing = await createTestListing({
      date: "2026-09-02T10:00",
      maxAttendees: 10,
      name: "Autumn Show",
    });
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Bob Example",
      "b@test.com",
    );

    await expectCalendarFeed(requestAsApiKey("/caldav/events.ics", apiKey), {
      contains: ["SUMMARY:Autumn Show", "DESCRIPTION:Bob Example"],
    });
  });

  test("omits dateless bookings and falls back to attendee id for blank names", async () => {
    const { createTestApiKeyFull, requestAsApiKey } = await import(
      "#test-utils/session.ts"
    );
    const { createTestAttendeeDirect } = await import(
      "#test-utils/db-helpers.ts"
    );
    await settings.update.calendarFeedsEnabled(true);
    const { apiKey } = await createTestApiKeyFull("Calendar Blank");
    const dated = await createTestListing({
      date: "2026-11-04T12:00",
      maxAttendees: 10,
      name: "Dated Blank",
    });
    const dateless = await createTestListing({
      maxAttendees: 10,
      name: "Dateless",
    });
    const attendee = await createTestAttendeeDirect(
      dated.id,
      "",
      "blank@test.com",
    );
    await createTestAttendeeDirect(dateless.id, "No Date", "nodate@test.com");

    await expectCalendarFeed(requestAsApiKey("/caldav/events.ics", apiKey), {
      contains: ["SUMMARY:Attendee 1"],
      notContains: ["No Date"],
    });
  });

  test("forbids API keys when the private key cannot be derived", async () => {
    const { createTestApiKeyFull, requestAsApiKey } = await import(
      "#test-utils/session.ts"
    );
    await settings.update.calendarFeedsEnabled(true);
    const { apiKey } = await createTestApiKeyFull("Calendar Forbidden");
    settings.setForTest({ wrapped_private_key: "" });
    try {
      const response = await handleRequest(
        requestAsApiKey("/caldav/events.ics", apiKey),
      );
      expect(response.status).toBe(403);
    } finally {
      settings.clearTestOverride("wrapped_private_key");
    }
  });

  test("limits agent API keys to assigned attendees", async () => {
    const { createApiKey } = await import("#shared/db/api-keys.ts");
    const { createUser } = await import("#shared/db/users.ts");
    const { setLogisticsAssignments } = await import("#shared/db/logistics.ts");
    const { logisticsAgentsTable } = await import(
      "#shared/db/logistics-agents.ts"
    );
    const { setUserAgentIds } = await import("#shared/db/user-agents.ts");
    const { generateSecureToken } = await import("#shared/crypto/utils.ts");
    const { getTestDataKeyForApiKey, requestAsApiKey } = await import(
      "#test-utils/session.ts"
    );
    const { createTestAttendee } = await import("#test-utils/db-helpers.ts");
    await settings.update.calendarFeedsEnabled(true);
    const dataKey = await getTestDataKeyForApiKey();
    const user = await createUser("feed-agent", "", null, "agent");
    const agent = await logisticsAgentsTable.insert({ name: "Van 1" });
    await setUserAgentIds(user.id, [agent.id]);
    const { apiKey } = await createApiKey(
      user.id,
      "Agent Calendar",
      dataKey,
      generateSecureToken,
    );
    const listing = await createTestListing({
      date: "2026-10-03T11:00",
      maxAttendees: 10,
      name: "Delivery Show",
      usesLogistics: true,
    });
    const visible = await createTestAttendee(
      listing.id,
      listing.slug,
      "Visible Person",
      "v@test.com",
    );
    await setLogisticsAssignments(
      visible.id,
      false,
      new Map([
        [
          listing.id,
          {
            endAgentId: null,
            endTime: "",
            startAgentId: agent.id,
            startTime: "",
          },
        ],
      ]),
    );
    await createTestAttendee(
      listing.id,
      listing.slug,
      "Hidden Person",
      "h@test.com",
    );

    await expectCalendarFeed(requestAsApiKey("/caldav/events.ics", apiKey), {
      contains: ["Visible Person"],
      notContains: ["Hidden Person"],
    });
  });
});

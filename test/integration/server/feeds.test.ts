/**
 * Tests for ICS and RSS feed endpoints
 */

import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { escapeIcs } from "#routes/feeds.ts";
import { escapeXml } from "#shared/xml.ts";
import { expectHtml } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  createHiddenPackageGroup,
  createTestGroup,
} from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
  pastCloseTime,
} from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

/** Fetch a feed URL and return the body text */
const fetchFeedBody = async (feedPath: string): Promise<string> => {
  const response = await handleRequest(mockRequest(feedPath));
  return response.text();
};

/** Assert a deactivated listing is excluded from a feed */
const expectExcludesInactive = async (feedPath: string, absentTag: string) => {
  await enablePublicSite();
  const listing = await createTestListing({
    maxAttendees: 100,
    name: "Hidden",
  });
  await deactivateTestListing(listing.id);
  const body = await fetchFeedBody(feedPath);
  assert(!body.includes("Hidden"));
  assert(!body.includes(absentTag));
};

/** Assert an listing with closed registration is excluded from a feed */
const expectExcludesClosedRegistration = async (
  feedPath: string,
  absentTag: string,
) => {
  await enablePublicSite();
  await createTestListing({
    closesAt: pastCloseTime(),
    maxAttendees: 100,
    name: "Closed Listing",
  });
  const body = await fetchFeedBody(feedPath);
  assert(!body.includes("Closed Listing"));
  assert(!body.includes(absentTag));
};

const feedExclusionTests = (feedPath: string, emptyMarker: string) => {
  test("excludes hidden listings", async () => {
    await enablePublicSite();
    await createTestListing({
      hidden: true,
      maxAttendees: 100,
      name: "Secret Listing",
    });
    await expectHtml(await handleRequest(mockRequest(feedPath)), {
      notContains: ["Secret Listing", emptyMarker],
    });
  });

  test("excludes purchase_only listings", async () => {
    await enablePublicSite();
    await createTestListing({
      maxAttendees: 100,
      name: "Raffle Tickets",
      purchaseOnly: true,
    });
    await expectHtml(await handleRequest(mockRequest(feedPath)), {
      notContains: ["Raffle Tickets", emptyMarker],
    });
  });

  test("syndicates a package and its standalone member", async () => {
    await enablePublicSite();
    const group = await createHiddenPackageGroup("Bundle");
    await createTestListing({
      groupId: group.id,
      maxAttendees: 100,
      name: "Hidden Member",
    });
    await expectHtml(await handleRequest(mockRequest(feedPath)), {
      contains: ["Bundle", `/ticket/${group.slug}`, "Hidden Member"],
      notContains: [],
    });
  });

  test("omits an unbookable package from the feed", async () => {
    await enablePublicSite();
    const group = await createTestGroup({
      isPackage: true,
      name: "Gone Bundle",
    });
    const only = await createTestListing({
      groupId: group.id,
      maxAttendees: 100,
      name: "Last One",
    });
    await deactivateTestListing(only.id);
    // The bundle cannot sell (its member is inactive), so the feed is empty.
    await expectHtml(await handleRequest(mockRequest(feedPath)), {
      notContains: ["Gone Bundle", "Last One", emptyMarker],
    });
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
      await enablePublicSite();
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "text/calendar; charset=utf-8",
      );
    });

    test("returns valid VCALENDAR wrapper with no listings", async () => {
      await enablePublicSite();
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      assertStringIncludes(body, "BEGIN:VCALENDAR");
      assertStringIncludes(body, "VERSION:2.0");
      assertStringIncludes(body, "PRODID:-//Chobble Tickets//EN");
      assertStringIncludes(body, "END:VCALENDAR");
      assert(!body.includes("BEGIN:VLISTING"));
    });

    test("uses website title as calendar name", async () => {
      await enablePublicSite();
      await settings.update.websiteTitle("My Listings");
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      assertStringIncludes(body, "X-WR-CALNAME:My Listings");
    });

    test("defaults calendar name to Listings when no title set", async () => {
      await enablePublicSite();
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      assertStringIncludes(body, "X-WR-CALNAME:Listings");
    });

    test("includes VLISTING for active listings", async () => {
      await enablePublicSite();
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Concert",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      assertStringIncludes(body, "BEGIN:VLISTING");
      assertStringIncludes(body, "SUMMARY:Concert");
      assertStringIncludes(body, `/ticket/${listing.slug}`);
      assertStringIncludes(body, "END:VLISTING");
    });

    test("includes UID and DTSTAMP", async () => {
      await enablePublicSite();
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Show",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      assertStringIncludes(body, `UID:listing-${listing.id}@`);
      assertStringIncludes(body, "DTSTAMP:");
    });

    test("includes DTSTART when listing has a date", async () => {
      await enablePublicSite();
      await createTestListing({
        date: "2026-06-15T14:00",
        maxAttendees: 100,
        name: "Dated Listing",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      assertStringIncludes(body, "DTSTART:20260615T140000Z");
    });

    test("includes DESCRIPTION when listing has a description", async () => {
      await enablePublicSite();
      await createTestListing({
        description: "A great listing",
        maxAttendees: 100,
        name: "Described",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      assertStringIncludes(body, "DESCRIPTION:A great listing");
    });

    test("includes LOCATION when listing has a location", async () => {
      await enablePublicSite();
      await createTestListing({
        location: "Town Hall",
        maxAttendees: 100,
        name: "Located",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      assertStringIncludes(body, "LOCATION:Town Hall");
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

    feedExclusionTests("/feeds/listings.ics", "BEGIN:VLISTING");

    test("escapes special characters in listing fields", async () => {
      await enablePublicSite();
      await createTestListing({
        description: "Fun, games; and more",
        location: "Hall A, Floor 2",
        maxAttendees: 100,
        name: "Rock, Paper; Scissors",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.ics"));
      const body = await response.text();
      assertStringIncludes(body, "SUMMARY:Rock\\, Paper\\; Scissors");
      assertStringIncludes(body, "DESCRIPTION:Fun\\, games\\; and more");
      assertStringIncludes(body, "LOCATION:Hall A\\, Floor 2");
    });
  });

  describe("GET /feeds/listings.rss", () => {
    test("redirects to admin when public site is disabled", async () => {
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin/login");
    });

    test("returns application/rss+xml content type", async () => {
      await enablePublicSite();
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/rss+xml; charset=utf-8",
      );
    });

    test("returns valid RSS wrapper with no listings", async () => {
      await enablePublicSite();
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      assertStringIncludes(body, '<?xml version="1.0"');
      assertStringIncludes(body, '<rss version="2.0">');
      assertStringIncludes(body, "<channel>");
      assertStringIncludes(body, "</channel>");
      assertStringIncludes(body, "</rss>");
      assert(!body.includes("<item>"));
    });

    test("uses website title in channel", async () => {
      await enablePublicSite();
      await settings.update.websiteTitle("My Listings");
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      assertStringIncludes(body, "<title>My Listings</title>");
      assertStringIncludes(
        body,
        "<description>Listings from My Listings</description>",
      );
    });

    test("defaults title to Listings when no title set", async () => {
      await enablePublicSite();
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      assertStringIncludes(body, "<title>Listings</title>");
    });

    test("includes items for active listings", async () => {
      await enablePublicSite();
      const listing = await createTestListing({
        maxAttendees: 100,
        name: "Concert",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      assertStringIncludes(body, "<item>");
      assertStringIncludes(body, "<title>Concert</title>");
      assertStringIncludes(body, `/ticket/${listing.slug}`);
      assertStringIncludes(body, "<pubDate>");
      assertStringIncludes(body, "</item>");
    });

    test("includes guid as permalink", async () => {
      await enablePublicSite();
      const listing = await createTestListing({
        maxAttendees: 50,
        name: "Show",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      assertStringIncludes(body, `<guid isPermaLink="true">`);
      assertStringIncludes(body, `/ticket/${listing.slug}</guid>`);
    });

    test("includes description when listing has one", async () => {
      await enablePublicSite();
      await createTestListing({
        description: "A great listing",
        maxAttendees: 100,
        name: "Described",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      assertStringIncludes(body, "A great listing");
    });

    test("includes date in description when listing has a date", async () => {
      await enablePublicSite();
      await createTestListing({
        date: "2026-06-15T14:00",
        maxAttendees: 100,
        name: "Dated",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      assertStringIncludes(body, "Date:");
      assertStringIncludes(body, "15 Jun 2026");
    });

    test("includes location in description when listing has a location", async () => {
      await enablePublicSite();
      await createTestListing({
        location: "Town Hall",
        maxAttendees: 100,
        name: "Located",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      assertStringIncludes(body, "Location: Town Hall");
    });

    test("includes description, date, and location together", async () => {
      await enablePublicSite();
      await createTestListing({
        date: "2026-06-15T14:00",
        description: "A great listing",
        location: "Town Hall",
        maxAttendees: 100,
        name: "Full Listing",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      assertStringIncludes(body, "A great listing");
      assertStringIncludes(body, "Date:");
      assertStringIncludes(body, "Location: Town Hall");
    });

    test("excludes inactive listings", async () => {
      await expectExcludesInactive("/feeds/listings.rss", "<item>");
    });

    test("excludes listings with closed registration", async () => {
      await expectExcludesClosedRegistration("/feeds/listings.rss", "<item>");
    });

    feedExclusionTests("/feeds/listings.rss", "<item>");

    test("XML-escapes special characters", async () => {
      await enablePublicSite();
      await createTestListing({
        description: 'He said "hello" & goodbye',
        maxAttendees: 100,
        name: "Rock & Roll <Live>",
      });
      const response = await handleRequest(mockRequest("/feeds/listings.rss"));
      const body = await response.text();
      assertStringIncludes(body, "<title>Rock &amp; Roll &lt;Live&gt;</title>");
      assertStringIncludes(body, "He said &quot;hello&quot; &amp; goodbye");
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

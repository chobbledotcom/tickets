import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { listingChildren } from "#db/listing-parents.ts";
import { settings } from "#db/settings.ts";
import { handleRequest } from "#routes";
import { escapeIcs, escapeXml } from "#routes/feeds.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeDirect } from "#test-utils/db-helpers/attendees.ts";
import { createHiddenPackageGroup } from "#test-utils/db-helpers/groups.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { createTestApiKeyFull, requestAsApiKey } from "#test-utils/session.ts";
import { enablePublicSite } from "#test-utils/settings.ts";

describe("escapeIcs", () => {
  test("escapes each character iCalendar reserves", () => {
    expect(escapeIcs("a;b")).toBe("a\\;b");
    expect(escapeIcs("a,b")).toBe("a\\,b");
    expect(escapeIcs("a\nb")).toBe("a\\nb");
  });

  test("escapes the backslash first, so an escape is not escaped twice", () => {
    expect(escapeIcs("\\")).toBe("\\\\");
    expect(escapeIcs("\\;")).toBe("\\\\\\;");
  });

  test("escapes every occurrence, not only the first", () => {
    expect(escapeIcs("a;b;c")).toBe("a\\;b\\;c");
  });

  test("leaves text with nothing to escape as it was", () => {
    expect(escapeIcs("Summer party 2026")).toBe("Summer party 2026");
  });
});

describe("escapeXml", () => {
  test("escapes what HTML escaping covers", () => {
    expect(escapeXml("<a>&")).toBe("&lt;a&gt;&amp;");
  });

  test("escapes the apostrophe HTML escaping leaves alone", () => {
    expect(escapeXml("it's")).toBe("it&apos;s");
  });

  test("escapes the double quote too", () => {
    expect(escapeXml('say "hi"')).toBe("say &quot;hi&quot;");
  });
});

const feedBody = async (path: string): Promise<string> =>
  (await handleRequest(mockRequest(path))).text();

describeWithEnv("listing feed contracts", { db: true }, () => {
  test("keeps package entries separate and writes valid iCalendar lines", async () => {
    await enablePublicSite();
    const bundle = await createHiddenPackageGroup("Weekend bundle");
    await createTestListing({
      bookableAlone: true,
      groupId: bundle.id,
      location: "Member hall",
      name: "Named member",
    });
    const parent = await createTestListing({ name: "Parent listing" });
    const child = await createTestListing({ name: "Child listing" });
    await listingChildren.setIds(parent.id, [child.id]);

    const body = await feedBody("/feeds/listings.ics");
    expect(
      body.startsWith(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" +
          "PRODID:-//Chobble Tickets//EN\r\n",
      ),
    ).toBe(true);
    expect(body.endsWith("\r\nEND:VCALENDAR")).toBe(true);
    expect(body).not.toContain(`UID:listing-${child.id}@`);

    const packageEntry = body
      .split("BEGIN:VLISTING\r\n")
      .find((entry) => entry.includes(`UID:package-${bundle.id}@`));
    expect(packageEntry).toBeDefined();
    expect(packageEntry!.split("\r\nEND:VLISTING")[0]).toContain(
      "SUMMARY:Weekend bundle",
    );
    expect(packageEntry!.split("\r\nEND:VLISTING")[0]).not.toContain(
      "LOCATION:",
    );
    expect(packageEntry).toContain("\r\nEND:VLISTING");
  });

  test("uses newlines between RSS documents, items, and details", async () => {
    await enablePublicSite();
    await createTestListing({
      date: "2026-06-15T14:00",
      description: "A great listing",
      location: "Town Hall",
      name: "Full listing",
    });

    const body = await feedBody("/feeds/listings.rss");
    expect(
      body.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n' +
          '<rss version="2.0">\n  <channel>\n',
      ),
    ).toBe(true);
    expect(body).toContain("    <item>\n      <title>Full listing</title>\n");
    expect(body).toContain(
      "<description>A great listing\n" +
        "Date: Mon, 15 Jun 2026 14:00:00 GMT\n" +
        "Location: Town Hall</description>",
    );
    expect(body.endsWith("\n  </channel>\n</rss>")).toBe(true);
  });
});

describeWithEnv("news feed contracts", { db: true }, () => {
  test("uses News when the site has no title", async () => {
    await enablePublicSite();

    const body = await feedBody("/feeds/news.rss");
    expect(body).toContain("<title>News</title>");
    expect(body).toContain("<description>News from News</description>");
  });
});

describeWithEnv("calendar feed contracts", { db: true }, () => {
  test("returns the complete not-found response when feeds are disabled", async () => {
    const response = await handleRequest(mockRequest("/caldav/events.ics"));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("Not found");
  });

  test("writes framed events and excludes no-quantity bookings", async () => {
    await settings.update.calendarFeedsEnabled(true);
    await settings.update.calendarFeedsGroupBy("attendees");
    const { apiKey } = await createTestApiKeyFull("Calendar contract");
    const listing = await createTestListing({
      date: "2026-08-01T09:30",
      maxAttendees: 10,
      name: "Summer show",
    });
    await createTestAttendeeDirect(
      listing.id,
      "Real person",
      "real@example.com",
    );
    const { attendee: ghost } = await createTestAttendeeDirect(
      listing.id,
      "No quantity person",
      "ghost@example.com",
    );
    await getDb().execute({
      args: [ghost.id, listing.id],
      sql: "UPDATE listing_attendees SET quantity = 0 WHERE attendee_id = ? AND listing_id = ?",
    });

    const response = await handleRequest(
      requestAsApiKey("/caldav/events.ics", apiKey),
    );
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(
      body.startsWith(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\n" +
          "PRODID:-//Chobble Tickets//EN\r\n" +
          "X-WR-CALNAME:Tickets\r\nBEGIN:VEVENT\r\n",
      ),
    ).toBe(true);
    expect(body).toContain("SUMMARY:Real person");
    expect(body).not.toContain("No quantity person");
    expect(body.endsWith("\r\nEND:VEVENT\r\nEND:VCALENDAR")).toBe(true);
  });
});

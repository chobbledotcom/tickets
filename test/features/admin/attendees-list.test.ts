/**
 * The attendees browser and its CSV export: who may open them, how the query
 * string narrows the rows, and what the export leaves out.
 */

import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  handleAttendeesCsvExport,
  handleAttendeesListGet,
} from "#routes/admin/attendees-list.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { seedFillerAttendees } from "#test-utils/db-helpers/attendee-seeding.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import { testCookie, withTestSession } from "#test-utils/session.ts";

const authed = async (path: string): Promise<Request> =>
  mockRequest(path, { headers: { cookie: await testCookie() } });

// The handlers read the private key from the request scope, exactly as the
// server sets it up per request.
const listPage = async (query = ""): Promise<Response> => {
  const request = await authed(`/admin/attendees${query}`);
  return await withTestSession(
    async () => await handleAttendeesListGet(request, {}),
  );
};

const listHtml = async (query = ""): Promise<string> =>
  await (await listPage(query)).text();

const csvBody = async (query = ""): Promise<string> => {
  const request = await authed(`/admin/attendees/csv${query}`);
  const response = await withTestSession(
    async () => await handleAttendeesCsvExport(request, {}),
  );
  return await response.text();
};

/** Two listings, each with one attendee, so a filter has something to drop. */
const twoBookedListings = async (): Promise<{
  first: { id: number; name: string };
  second: { id: number; name: string };
}> => {
  const first = await createTestListing({ name: "Morning Show" });
  const second = await createTestListing({ name: "Evening Show" });
  await createTestAttendee(first.id, first.slug, "Ada", "ada@example.com");
  await createTestAttendee(second.id, second.slug, "Grace", "g@example.com");
  return { first, second };
};

describeWithEnv("the attendees browser", { db: true }, () => {
  describe("who may open it", () => {
    test("a request with no session is sent to the login page", async () => {
      const response = await handleAttendeesListGet(
        mockRequest("/admin/attendees"),
        {},
      );
      // The exact redirect, so a 500 could never pass for "turned away".
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });

    test("the export is sent there too, rather than handing out a file", async () => {
      const response = await handleAttendeesCsvExport(
        mockRequest("/admin/attendees/csv"),
        {},
      );
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("/admin");
    });
  });

  describe("the listing filter", () => {
    test("shows attendees from every listing when nothing is chosen", async () => {
      await twoBookedListings();
      const html = await listHtml();
      expect(html).toContain("Ada");
      expect(html).toContain("Grace");
    });

    test("keeps only the chosen listing's attendees", async () => {
      const { first } = await twoBookedListings();
      const html = await listHtml(`?listing=${first.id}`);
      expect(html).toContain("Ada");
      expect(html).not.toContain("Grace");
    });

    test("ignores a listing id that does not exist, rather than showing nothing", async () => {
      await twoBookedListings();
      const html = await listHtml("?listing=999999");
      expect(html).toContain("Ada");
      expect(html).toContain("Grace");
    });

    test("ignores a listing id that is not a number", async () => {
      await twoBookedListings();
      const html = await listHtml("?listing=abc");
      expect(html).toContain("Ada");
      expect(html).toContain("Grace");
    });
  });

  describe("the sort order", () => {
    test("shows the newest booking first by default", async () => {
      const { first, second } = await twoBookedListings();
      const html = await listHtml();
      expect(html.indexOf("Grace")).toBeLessThan(html.indexOf("Ada"));
      expect(second.id).toBeGreaterThan(first.id);
    });

    test("oldest first puts the earliest booking at the top", async () => {
      await twoBookedListings();
      const html = await listHtml("?sort=oldest");
      expect(html.indexOf("Ada")).toBeLessThan(html.indexOf("Grace"));
    });

    test("falls back to newest first when the sort is not one we know", async () => {
      await twoBookedListings();
      const html = await listHtml("?sort=sideways");
      expect(html.indexOf("Grace")).toBeLessThan(html.indexOf("Ada"));
    });
  });

  describe("paging", () => {
    test("a page beyond the last one has no attendees on it", async () => {
      await twoBookedListings();
      const html = await listHtml("?page=50");
      expect(html).not.toContain("Ada");
      expect(html).not.toContain("Grace");
    });

    test("a page number that is not a number is treated as the first page", async () => {
      await twoBookedListings();
      const html = await listHtml("?page=abc");
      expect(html).toContain("Ada");
    });
  });

  describe("the CSV export", () => {
    test("is offered as a file to download", async () => {
      await twoBookedListings();
      const request = await authed("/admin/attendees/csv");
      const response = await withTestSession(
        async () => await handleAttendeesCsvExport(request, {}),
      );
      expect(response.headers.get("content-disposition")).toContain(
        "attendees.csv",
      );
    });

    test("includes every attendee when no listing is chosen", async () => {
      await twoBookedListings();
      const body = await csvBody();
      expect(body).toContain("Ada");
      expect(body).toContain("Grace");
    });

    test("leaves out attendees of the listings that were filtered away", async () => {
      const { first } = await twoBookedListings();
      const body = await csvBody(`?listing=${first.id}`);
      expect(body).toContain("Ada");
      expect(body).not.toContain("Grace");
    });
  });

  describe("the CSV export across more than one page of attendees", () => {
    test("keeps reading pages until it has every booking", async () => {
      const { ATTENDEES_PAGE_SIZE } = await import(
        "#shared/db/attendees/queries.ts"
      );
      const listing = await createTestListing({
        maxAttendees: ATTENDEES_PAGE_SIZE * 3,
      });
      // One page's worth plus a few, so a export that stopped after the first
      // page — or walked backwards — would come back short.
      const total = ATTENDEES_PAGE_SIZE + 5;
      await seedFillerAttendees(listing.id, total);

      const body = await csvBody();
      const rows = body.trim().split("\n").length - 1;
      expect(rows).toBe(total);
    });
  });

  describe("the record of what was done", () => {
    test("notes that the attendee list was exported", async () => {
      await twoBookedListings();
      await csvBody();
      const { getAllActivityLog } = await import("#shared/db/activityLog.ts");
      const entries = await withTestSession(() => getAllActivityLog(20));
      expect(entries.map((entry) => entry.message)).toContain(
        "Attendees CSV exported",
      );
    });
  });
});

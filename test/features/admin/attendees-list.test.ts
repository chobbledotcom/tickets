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
  return await withTestSession(() => handleAttendeesListGet(request));
};

const listHtml = async (query = ""): Promise<string> =>
  await (await listPage(query)).text();

const csvBody = async (query = ""): Promise<string> => {
  const request = await authed(`/admin/attendees/csv${query}`);
  const response = await withTestSession(() =>
    handleAttendeesCsvExport(request),
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
    test("a request with no session is turned away", async () => {
      const response = await handleAttendeesListGet(
        mockRequest("/admin/attendees"),
      );
      expect(response.status).not.toBe(200);
    });

    test("the export is turned away too", async () => {
      const response = await handleAttendeesCsvExport(
        mockRequest("/admin/attendees/csv"),
      );
      expect(response.status).not.toBe(200);
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
      const response = await withTestSession(() =>
        handleAttendeesCsvExport(request),
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
});

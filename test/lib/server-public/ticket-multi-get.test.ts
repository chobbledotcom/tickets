// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  assertPublicHtml,
  bookAttendee,
  createTestListing,
  deactivateTestListing,
  describeWithEnv,
  extractInputValue,
  mockFormRequest,
  mockRequest,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server public > ticket multi-slug GET",
  { db: true, triggers: true },
  () => {
    describe("GET /ticket/:slug1+:slug2", () => {
      test("returns 404 when no valid listings", async () => {
        const response = await handleRequest(
          mockRequest("/ticket/nonexistent1+nonexistent2"),
        );
        expect(response.status).toBe(404);
      });

      test("shows ticket page for multiple existing listings", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Listing 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 100,
          name: "Multi Listing 2",
        });
        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Continue",
          "Multi Listing 1",
          "Multi Listing 2",
          "Select Tickets",
        );
      });

      test("shows description beneath each listing in ticket page", async () => {
        const listing1 = await createTestListing({
          description: "First listing info",
          maxAttendees: 50,
          name: "Multi Desc 1",
        });
        const listing2 = await createTestListing({
          description: "Second listing info",
          maxAttendees: 100,
          name: "Multi Desc 2",
        });
        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "First listing info",
          "Second listing info",
        );
      });

      test("omits description div in ticket when description is empty", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi No Desc",
        });
        const listing2 = await createTestListing({
          maxAttendees: 100,
          name: "Multi No Desc 2",
        });
        const html = await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Multi No Desc",
        );
        expect(html).not.toContain("margin: 0.25rem 0 0.5rem");
      });

      test("shows sold-out label for full listings", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Available",
        });
        const listing2 = await createTestListing({
          maxAttendees: 1,
          name: "Multi Full",
        });
        // Fill up listing2
        await bookAttendee(listing2, {
          email: "john@example.com",
          name: "John",
          quantity: 1,
        });

        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Sold Out",
        );
      });

      test("shows description for sold-out listing in ticket page", async () => {
        const listing1 = await createTestListing({
          description: "Available desc",
          maxAttendees: 50,
          name: "Multi Avail Desc",
        });
        const listing2 = await createTestListing({
          description: "Sold out desc",
          maxAttendees: 1,
          name: "Multi Full Desc",
        });
        await bookAttendee(listing2, {
          email: "jane@example.com",
          name: "Jane",
          quantity: 1,
        });

        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Available desc",
          "Sold out desc",
          "Sold Out",
        );
      });

      test("filters out inactive listings", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Active",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Inactive",
        });
        await deactivateTestListing(listing2.id);

        // The active listing should have a quantity selector
        const html = await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          `quantity_${listing1.id}`,
        );
        // The inactive listing should not have a quantity selector
        expect(html).not.toContain(`quantity_${listing2.id}`);
      });

      test("returns 404 when all listings are inactive", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "All Inactive 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "All Inactive 2",
        });
        await deactivateTestListing(listing1.id);
        await deactivateTestListing(listing2.id);

        const response = await handleRequest(
          mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
        );
        expect(response.status).toBe(404);
      });

      test("preserves slug order instead of sorting listings", async () => {
        const listing1 = await createTestListing({
          date: "2026-12-01",
          maxAttendees: 50,
          name: "Zebra Listing",
        });
        const listing2 = await createTestListing({
          date: "2026-01-01",
          maxAttendees: 50,
          name: "Alpha Listing",
        });
        // Request with Zebra first, Alpha second — opposite of sort order
        const response = await handleRequest(
          mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
        );
        const html = await response.text();
        const zebraPos = html.indexOf("Zebra Listing");
        const alphaPos = html.indexOf("Alpha Listing");
        expect(zebraPos).toBeGreaterThan(-1);
        expect(alphaPos).toBeGreaterThan(-1);
        expect(zebraPos).toBeLessThan(alphaPos);
      });

      /** Two plain listings, each purchasable — the shared fixture behind
       * every "does not set CSRF cookies" / iframe check below. */
      const createTwoListings = async (): Promise<
        [
          Awaited<ReturnType<typeof createTestListing>>,
          Awaited<ReturnType<typeof createTestListing>>,
        ]
      > => {
        const listing1 = await createTestListing({ maxAttendees: 50 });
        const listing2 = await createTestListing({ maxAttendees: 50 });
        return [listing1, listing2];
      };

      test("does not set CSRF cookies for ticket (uses signed tokens)", async () => {
        const [listing1, listing2] = await createTwoListings();
        const response = await handleRequest(
          mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
        );
        const cookie = response.headers.get("set-cookie") || "";
        expect(cookie).not.toContain("csrf_token=");
      });

      /** Creates two listings and GETs their combined ticket page with
       * `?iframe=true` — the shared setup behind the iframe form-action and
       * signed-CSRF-token checks below. */
      const getMultiTicketIframePage = async (): Promise<{
        listing1: Awaited<ReturnType<typeof createTestListing>>;
        listing2: Awaited<ReturnType<typeof createTestListing>>;
        html: string;
      }> => {
        const [listing1, listing2] = await createTwoListings();
        const response = await handleRequest(
          mockRequest(`/ticket/${listing1.slug}+${listing2.slug}?iframe=true`),
        );
        const html = await response.text();
        return { html, listing1, listing2 };
      };

      test("form action includes ?iframe=true in iframe mode", async () => {
        const { listing1, listing2, html } = await getMultiTicketIframePage();
        expect(html).toContain(
          `action="/ticket/${listing1.slug}+${listing2.slug}?iframe=true"`,
        );
      });

      test("ticket GET returns signed CSRF token in form", async () => {
        const { html } = await getMultiTicketIframePage();
        expect(extractInputValue(html, "csrf_token")).toMatch(/^s1\./);
      });

      test("ticket POST succeeds with signed token and no cookie", async () => {
        const listing1 = await createTestListing({ maxAttendees: 50 });
        const listing2 = await createTestListing({ maxAttendees: 50 });
        const path = `/ticket/${listing1.slug}+${listing2.slug}`;

        const getResponse = await handleRequest(
          mockRequest(`${path}?iframe=true`),
        );
        const html = await getResponse.text();
        const signedToken = extractInputValue(html, "csrf_token") ?? "";

        const response = await handleRequest(
          mockFormRequest(`${path}?iframe=true`, {
            email: "test@example.com",
            name: "Test User",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
            csrf_token: signedToken,
          }),
        );
        expect(response.status).toBe(302);
      });
    });
  },
);

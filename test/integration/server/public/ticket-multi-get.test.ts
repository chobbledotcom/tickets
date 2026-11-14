import { assert, assertStringIncludes } from "@std/assert";
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { assertPublicHtml } from "#test-utils/assertions.ts";
import { extractInputValue } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { bookAttendee } from "#test-utils/db-helpers/attendee-payments.ts";
import { createListingPair } from "#test-utils/db-helpers/listing-pair.ts";
import { deactivateTestListing } from "#test-utils/db-helpers/listings.ts";
import { mockFormRequest, mockRequest } from "#test-utils/mocks.ts";
import type { ListingWithCount } from "#types";

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
        const [listing1, listing2] = await createListingPair(
          { maxAttendees: 50, name: "Multi Listing 1" },
          { maxAttendees: 100, name: "Multi Listing 2" },
        );
        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Continue",
          "Multi Listing 1",
          "Multi Listing 2",
          "Select Tickets",
        );
      });

      test("shows description beneath each listing in ticket page", async () => {
        const [listing1, listing2] = await createListingPair(
          {
            description: "First listing info",
            maxAttendees: 50,
            name: "Multi Desc 1",
          },
          {
            description: "Second listing info",
            maxAttendees: 100,
            name: "Multi Desc 2",
          },
        );
        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "First listing info",
          "Second listing info",
        );
      });

      test("omits description div in ticket when description is empty", async () => {
        const [listing1, listing2] = await createListingPair(
          { maxAttendees: 50, name: "Multi No Desc" },
          { maxAttendees: 100, name: "Multi No Desc 2" },
        );
        const html = await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Multi No Desc",
        );
        assert(!html.includes("margin: 0.25rem 0 0.5rem"));
      });

      test("shows sold-out label for full listings", async () => {
        const [listing1, listing2] = await createListingPair(
          { maxAttendees: 50, name: "Multi Available" },
          { maxAttendees: 1, name: "Multi Full" },
        );
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
        const [listing1, listing2] = await createListingPair(
          {
            description: "Available desc",
            maxAttendees: 50,
            name: "Multi Avail Desc",
          },
          {
            description: "Sold out desc",
            maxAttendees: 1,
            name: "Multi Full Desc",
          },
        );
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
        const [listing1, listing2] = await createListingPair(
          { maxAttendees: 50, name: "Multi Active" },
          { maxAttendees: 50, name: "Multi Inactive" },
        );
        await deactivateTestListing(listing2.id);

        // The active listing should have a quantity selector
        const html = await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          `quantity_${listing1.id}`,
        );
        // The inactive listing should not have a quantity selector
        assert(!html.includes(`quantity_${listing2.id}`));
      });

      test("returns 404 when all listings are inactive", async () => {
        const [listing1, listing2] = await createListingPair(
          { maxAttendees: 50, name: "All Inactive 1" },
          { maxAttendees: 50, name: "All Inactive 2" },
        );
        await deactivateTestListing(listing1.id);
        await deactivateTestListing(listing2.id);

        const response = await handleRequest(
          mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
        );
        expect(response.status).toBe(404);
      });

      test("preserves slug order instead of sorting listings", async () => {
        const [listing1, listing2] = await createListingPair(
          { date: "2026-12-01", maxAttendees: 50, name: "Zebra Listing" },
          { date: "2026-01-01", maxAttendees: 50, name: "Alpha Listing" },
        );
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

      test("does not set CSRF cookies for ticket (uses signed tokens)", async () => {
        const [listing1, listing2] = await createListingPair({
          maxAttendees: 50,
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
        );
        const cookie = response.headers.get("set-cookie") || "";
        assert(!cookie.includes("csrf_token="));
      });

      /** Creates two listings and GETs their combined ticket page with
       * `?iframe=true` — the shared setup behind the iframe form-action and
       * signed-CSRF-token checks below. */
      const getMultiTicketIframePage = async (): Promise<{
        listing1: ListingWithCount;
        listing2: ListingWithCount;
        html: string;
      }> => {
        const [listing1, listing2] = await createListingPair({
          maxAttendees: 50,
        });
        const response = await handleRequest(
          mockRequest(`/ticket/${listing1.slug}+${listing2.slug}?iframe=true`),
        );
        const html = await response.text();
        return { html, listing1, listing2 };
      };

      test("form action includes ?iframe=true in iframe mode", async () => {
        const { listing1, listing2, html } = await getMultiTicketIframePage();
        assertStringIncludes(
          html,
          `action="/ticket/${listing1.slug}+${listing2.slug}?iframe=true"`,
        );
      });

      test("ticket GET returns signed CSRF token in form", async () => {
        const { html } = await getMultiTicketIframePage();
        expect(extractInputValue(html, "csrf_token")).toMatch(/^s1\./);
      });

      test("ticket POST succeeds with signed token and no cookie", async () => {
        const [listing1, listing2] = await createListingPair({
          maxAttendees: 50,
        });
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

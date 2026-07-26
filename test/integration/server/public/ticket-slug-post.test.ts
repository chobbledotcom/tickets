// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { twoListingsAttendees } from "#test/lib/attendee-read-helpers.ts";
import { expectBasicTicketBookingRedirectsToThanks } from "#test/lib/server-public/basic-ticket-booking.ts";
import {
  expectFlash,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";
import {
  expectMissingCsrfRejected,
  getTicketCsrfToken,
  submitTicketForm,
} from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestGroup } from "#test-utils/db-helpers/groups.ts";
import {
  createTestListing,
  deactivateTestListing,
} from "#test-utils/db-helpers/listings.ts";
import {
  awaitTestRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > ticket slug POST",
  { db: true, triggers: true },
  () => {
    describe("POST /ticket/:slug", () => {
      test("returns 404 for non-existent slug", async () => {
        const response = await handleRequest(
          mockFormRequest("/ticket/non-existent", {
            email: "john@example.com",
            name: "John",
          }),
        );
        expect(response.status).toBe(404);
      });

      test("processes registration for group slug", async () => {
        const group = await createTestGroup({
          name: "Post Group",
          slug: "post-group",
        });
        const listing1 = await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Post Group Listing 1",
        });
        const listing2 = await createTestListing({
          groupId: group.id,
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Post Group Listing 2",
        });

        const getResponse = await handleRequest(
          mockRequest(`/ticket/${group.slug}`),
        );
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

        const response = await handleRequest(
          mockFormRequest(
            `/ticket/${group.slug}`,
            {
              email: "group@example.com",
              name: "Group User",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "2",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );
        expectReservedRedirectWithTokens(response);

        const [attendees1, attendees2] = await twoListingsAttendees(
          listing1.id,
          listing2.id,
        );
        expect(attendees1.length).toBe(1);
        expect(attendees1[0]?.quantity).toBe(1);
        expect(attendees2.length).toBe(1);
        expect(attendees2[0]?.quantity).toBe(2);
      });

      test("rejects group registration when group capacity exceeded", async () => {
        const group = await createTestGroup({
          maxAttendees: 3,
          name: "Cap Group",
          slug: "cap-group",
        });
        const listing1 = await createTestListing({
          groupId: group.id,
          maxAttendees: 10,
          maxQuantity: 5,
          name: "Cap Listing 1",
        });
        const listing2 = await createTestListing({
          groupId: group.id,
          maxAttendees: 10,
          maxQuantity: 5,
          name: "Cap Listing 2",
        });

        // First booking: 2 on listing1 — should succeed (group: 2/3)
        const getResponse1 = await handleRequest(
          mockRequest(`/ticket/${group.slug}`),
        );
        const csrfToken1 = getTicketCsrfToken(await getResponse1.text());
        if (!csrfToken1) throw new Error("Failed to get CSRF token");
        const r1 = await handleRequest(
          mockFormRequest(
            `/ticket/${group.slug}`,
            {
              email: "first@example.com",
              name: "First User",
              [`quantity_${listing1.id}`]: "2",
              [`quantity_${listing2.id}`]: "0",
              csrf_token: csrfToken1,
            },
            `csrf_token=${csrfToken1}`,
          ),
        );
        expectReservedRedirectWithTokens(r1);

        // Second booking: 1 on listing1 + 1 on listing2 — should fail (group: 2+2=4 > 3)
        const getResponse2 = await handleRequest(
          mockRequest(`/ticket/${group.slug}`),
        );
        const csrfToken2 = getTicketCsrfToken(await getResponse2.text());
        if (!csrfToken2) throw new Error("Failed to get CSRF token");
        const r2 = await handleRequest(
          mockFormRequest(
            `/ticket/${group.slug}`,
            {
              email: "second@example.com",
              name: "Second User",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              csrf_token: csrfToken2,
            },
            `csrf_token=${csrfToken2}`,
          ),
        );
        // The first atomic insert (listing1 qty=1) succeeds (group: 3/3),
        // but the second (listing2 qty=1) fails because group is now full
        expect(r2.status).toBe(302);
        expectFlash(
          r2,
          expect.stringContaining("no longer has enough spots available"),
          false,
        );
      });

      test("returns 404 for inactive listing", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        // Deactivate the listing
        await deactivateTestListing(listing.id);
        const response = await handleRequest(
          mockFormRequest(`/ticket/${listing.slug}`, {
            email: "john@example.com",
            name: "John",
          }),
        );
        expect(response.status).toBe(404);
      });

      test("rejects request without CSRF token", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        await expectMissingCsrfRejected(`/ticket/${listing.slug}`, {
          email: "john@example.com",
          name: "John",
        });
      });

      test("preserves form data on CSRF failure", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        await expectMissingCsrfRejected(`/ticket/${listing.slug}`, {
          email: "john@example.com",
          name: "John Doe",
        });
      });

      test("does not leak saved form data into subsequent GET request", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        // First: POST with invalid CSRF to save form data
        await handleRequest(
          mockFormRequest(`/ticket/${listing.slug}`, {
            email: "stale@example.com",
            name: "Stale Name",
          }),
        );
        // Second: GET the same page — stale values must not appear
        const getResponse = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        const html = await getResponse.text();
        expect(html).not.toContain("Stale Name");
        expect(html).not.toContain("stale@example.com");
      });

      test("does not leak saved form data from validation error into next POST", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        // First: POST with missing name to trigger validation error
        await submitTicketForm(listing.slug, {
          email: "first@example.com",
          name: "",
        });
        // Second: POST with different data and its own validation error
        const response = await submitTicketForm(listing.slug, {
          email: "second@example.com",
          name: "",
        });
        // Now redirects with flash error
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Your Name is required"),
          false,
        );
      });

      test("validates required fields", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await submitTicketForm(listing.slug, {
          email: "",
          name: "",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Your Name is required"),
          false,
        );
      });

      test("validates name is required", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await submitTicketForm(listing.slug, {
          email: "john@example.com",
          name: "   ",
        });
        expect(response.status).toBe(302);
      });

      test("validates email is required", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await submitTicketForm(listing.slug, {
          email: "   ",
          name: "John",
        });
        expect(response.status).toBe(302);
      });

      test("creates attendee and redirects to thank you page", async () => {
        await expectBasicTicketBookingRedirectsToThanks();
      });

      test("shows order success for purchase_only listing", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          purchaseOnly: true,
          thankYouUrl: "",
        });
        const response = await submitTicketForm(listing.slug, {
          email: "jane@example.com",
          name: "Jane Doe",
        });
        expect(response.status).toBe(302);
        const location = response.headers.get("location") || "";
        expect(location).toContain("/ticket/reserved?tokens=");

        // Follow the redirect and check the success page
        const successResponse = await handleRequest(mockRequest(location));
        const html = await successResponse.text();
        expect(html).toContain("Thank you for your order");
      });

      test("rejects when listing is full", async () => {
        const listing = await createTestListing({
          maxAttendees: 1,
          thankYouUrl: "https://example.com",
        });
        await submitTicketForm(listing.slug, {
          email: "john@example.com",
          name: "John",
        });

        const response = await submitTicketForm(listing.slug, {
          email: "jane@example.com",
          name: "Jane",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("not enough spots available"),
          false,
        );
      });

      test("returns 404 for unsupported method on ticket route", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com",
        });
        const response = await awaitTestRequest(`/ticket/${listing.slug}`, {
          method: "PUT",
        });
        expect(response.status).toBe(404);
      });
    });
  },
);

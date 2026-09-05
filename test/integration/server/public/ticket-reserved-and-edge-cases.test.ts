// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { expectBothReservedAtTwoAndOne } from "#test/integration/server/public/_shared-multi.ts";
import {
  assertPublicHtml,
  expectCheckoutRedirect,
  expectFlash,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";
import {
  bookTwoListings,
  expectBookOneEachRejected,
  extractCsrfToken,
  submitMultiTicketForm,
  submitTicketForm,
} from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendeeWithToken } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  awaitTestRequest,
  mockFormRequest,
  mockRequest,
} from "#test-utils/mocks.ts";
import { setupStripe } from "#test-utils/settings.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > ticket reserved page and edge cases",
  { db: true, triggers: true },
  () => {
    describe("404 handling", () => {
      test("returns 404 for unknown routes", async () => {
        const response = await handleRequest(mockRequest("/unknown/path"));
        expect(response.status).toBe(404);
      });
    });

    describe("GET /ticket/reserved", () => {
      test("shows reservation success page", async () => {
        const html = await assertPublicHtml(
          "/ticket/reserved",
          "Thank you for your order",
        );
        expect(html).not.toContain("view your ticket");
      });

      test("shows ticket link when tokens are provided", async () => {
        // The page now resolves tokens and only shows the CTA for a real
        // (quantity > 0) line, so use a genuine attendee token.
        const { token } = await createTestAttendeeWithToken(
          "Resv",
          "resv@example.com",
        );
        await assertPublicHtml(
          `/ticket/reserved?tokens=${token}`,
          `href="/t/${token}"`,
          "View your ticket",
        );
      });

      test("includes iframe-resizer child script when iframe=true", async () => {
        await assertPublicHtml(
          "/ticket/reserved?tokens=abc123&iframe=true",
          "iframe-resizer-child.js",
          'class="iframe"',
        );
      });

      test("excludes iframe-resizer child script without iframe param", async () => {
        const html = await assertPublicHtml("/ticket/reserved?tokens=abc123");
        expect(html).not.toContain("iframe-resizer-child.js");
      });

      test("shows email notice when email sending is configured", async () => {
        // The email notice only appears alongside a real ticket CTA, so use a
        // genuine attendee token.
        const { token } = await createTestAttendeeWithToken(
          "Resv",
          "resv@example.com",
        );
        using _env = withEnv({
          HOST_EMAIL_API_KEY: "re_test123",
          HOST_EMAIL_FROM_ADDRESS: "tickets@mysite.com",
          HOST_EMAIL_PROVIDER: "resend",
        });
        await assertPublicHtml(
          `/ticket/reserved?tokens=${token}`,
          "Junk/Spam",
          "tickets@mysite.com",
        );
      });

      test("does not show email notice when email is not configured", async () => {
        const html = await assertPublicHtml(
          "/ticket/reserved?tokens=abc123",
          "Thank you for your order",
        );
        expect(html).not.toContain("Junk/Spam");
      });
    });

    describe("POST /ticket/:slug (free listing without thank_you_url)", () => {
      test("shows inline success page when no thank_you_url", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "", // No thank_you_url
        });

        const response = await submitTicketForm(listing.slug, {
          email: "john@example.com",
          name: "John Doe",
        });
        // Should redirect to success page
        expectReservedRedirectWithTokens(response);
      });

      test("propagates iframe=true in redirect to reserved page", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "",
        });

        const getResponse = await handleRequest(
          mockRequest(`/ticket/${listing.slug}?iframe=true`),
        );
        const csrfToken = extractCsrfToken(await getResponse.text());
        expect(csrfToken).not.toBe(null);

        const response = await handleRequest(
          mockFormRequest(`/ticket/${listing.slug}?iframe=true`, {
            email: "jane@example.com",
            name: "Jane Doe",
            [`quantity_${listing.id}`]: "1",
            csrf_token: csrfToken!,
          }),
        );
        expect(response.status).toBe(302);
        const location = response.headers.get("location") || "";
        expect(location).toContain("/ticket/reserved");
        expect(location).toContain("iframe=true");
      });
    });

    describe("ticket paid flow", () => {
      test("redirects to checkout for ticket paid listings", async () => {
        await setupStripe();

        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Paid 1",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Paid 2",
          unitPrice: 1000,
        });

        const response = await bookTwoListings(
          `${listing1.slug}+${listing2.slug}`,
          listing1.id,
          "1",
          listing2.id,
          "2",
        );

        // Should redirect to Stripe checkout
        expectCheckoutRedirect(response);
      });

      test("shows error when no tickets selected in ticket paid form", async () => {
        await setupStripe();

        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Nosel 1",
          unitPrice: 500,
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Nosel 2",
          unitPrice: 1000,
        });

        // Submit with all quantities at 0
        const response = await bookTwoListings(
          `${listing1.slug}+${listing2.slug}`,
          listing1.id,
          "0",
          listing2.id,
          "0",
        );

        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining("Please select at least one ticket"),
          false,
        );
      });
    });

    describe("ticket free flow (capacity exceeded)", () => {
      test("shows error when free ticket atomic create fails capacity", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Free Cap 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Free Cap 2",
        });

        // Mock atomic create to fail (simulates race condition / capacity exceeded)
        const { attendeesApi } = await import("#db/attendees/api.ts");
        // A free order with a ledger order goes through createBookingAtomic; a plain
        // one through createAttendeeAtomic. Fail both so the create-fails path is
        // exercised regardless of which the free reservation picks.
        const failure = () =>
          Promise.resolve({
            listingIds: [],
            reason: "capacity_exceeded" as const,
            success: false as const,
          });
        const mockCreate = stub(attendeesApi, "createAttendeeAtomic", failure);
        const mockBooking = stub(attendeesApi, "createBookingAtomic", failure);

        try {
          await expectBookOneEachRejected(
            `${listing1.slug}+${listing2.slug}`,
            listing1.id,
            listing2.id,
            "no longer has enough spots",
          );
        } finally {
          mockCreate.restore();
          mockBooking.restore();
        }
      });

      test("ticket free registration succeeds for both listings", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Free Ok 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          maxQuantity: 5,
          name: "Multi Free Ok 2",
        });

        const response = await submitMultiTicketForm(
          `${listing1.slug}+${listing2.slug}`,
          {
            email: "multifree@example.com",
            name: "Multi Free User",
            [`quantity_${listing1.id}`]: "2",
            [`quantity_${listing2.id}`]: "1",
          },
        );

        // Verify attendees created for both listings
        await expectBothReservedAtTwoAndOne(response, listing1, listing2);
      });
    });

    describe("POST /ticket/:slug1+:slug2 (unsupported method)", () => {
      test("returns 404 for PUT on ticket route", async () => {
        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Put 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "Multi Put 2",
        });
        const response = await awaitTestRequest(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          { method: "PUT" },
        );
        expect(response.status).toBe(404);
      });
    });
  },
);

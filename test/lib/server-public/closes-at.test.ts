// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import {
  assertPublicHtml,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectHtmlResponse,
  getTicketCsrfToken,
  mockFormRequest,
  mockRequest,
  updateTestListing,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server public > closes_at",
  { db: true, triggers: true },
  () => {
    describe("closes_at (single ticket)", () => {
      test("shows 'Registration closed.' when closes_at is in the past", async () => {
        const pastDate = new Date(Date.now() - 60000)
          .toISOString()
          .slice(0, 16);
        const listing = await createTestListing({ closesAt: pastDate });

        const response = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        const html = await expectHtmlResponse(
          response,
          200,
          "Registration closed.",
        );
        expect(html).not.toContain("Continue");
      });

      test("shows form when closes_at is in the future", async () => {
        const futureDate = new Date(Date.now() + 3600000)
          .toISOString()
          .slice(0, 16);
        const listing = await createTestListing({ closesAt: futureDate });

        const html = await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "Continue",
        );
        expect(html).not.toContain("Registration closed.");
      });

      test("shows form when closes_at is null", async () => {
        const listing = await createTestListing();

        const html = await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "Continue",
        );
        expect(html).not.toContain("Registration closed.");
      });

      test("shows 'registration closed while you were submitting' on POST when closes_at is past", async () => {
        // Create listing with future closes_at so we can get CSRF token
        const futureDate = new Date(Date.now() + 3600000)
          .toISOString()
          .slice(0, 16);
        const listing = await createTestListing({ closesAt: futureDate });

        // Get CSRF token from the ticket page
        const getResponse = await handleRequest(
          mockRequest(`/ticket/${listing.slug}`),
        );
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("No CSRF token");

        // Now set closes_at to past
        const pastDate = new Date(Date.now() - 60000)
          .toISOString()
          .slice(0, 16);
        await updateTestListing(listing.id, { closesAt: pastDate });

        const response = await handleRequest(
          mockFormRequest(
            `/ticket/${listing.slug}`,
            {
              email: "test@example.com",
              name: "Test User",
              [`quantity_${listing.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining(
            "Sorry, registration closed while you were submitting.",
          ),
          false,
        );
      });
    });

    describe("closes_at (ticket)", () => {
      test("shows 'Registration closed.' when all listings are closed", async () => {
        const pastDate = new Date(Date.now() - 60000)
          .toISOString()
          .slice(0, 16);
        const listing1 = await createTestListing({ closesAt: pastDate });
        const listing2 = await createTestListing({ closesAt: pastDate });

        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Registration closed.",
        );
      });

      test("shows 'Registration Closed' label for individual closed listing in ticket", async () => {
        const pastDate = new Date(Date.now() - 60000)
          .toISOString()
          .slice(0, 16);
        const listing1 = await createTestListing({ closesAt: pastDate });
        const listing2 = await createTestListing();

        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "Registration Closed",
          listing2.name, // open listing shows form
        );
      });

      test("shows error on POST when listing closes during submission", async () => {
        // Create two listings, one will close during submission
        const futureDate = new Date(Date.now() + 3600000)
          .toISOString()
          .slice(0, 16);
        const listing1 = await createTestListing({ closesAt: futureDate });
        const listing2 = await createTestListing();

        // Get CSRF token
        const getResponse = await handleRequest(
          mockRequest(`/ticket/${listing1.slug}+${listing2.slug}`),
        );
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("No CSRF token");

        // Close listing1
        const pastDate = new Date(Date.now() - 60000)
          .toISOString()
          .slice(0, 16);
        await updateTestListing(listing1.id, { closesAt: pastDate });

        const response = await handleRequest(
          mockFormRequest(
            `/ticket/${listing1.slug}+${listing2.slug}`,
            {
              email: "test@example.com",
              name: "Test User",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining(
            "Sorry, registration closed while you were submitting.",
          ),
          false,
        );
      });
    });
  },
);

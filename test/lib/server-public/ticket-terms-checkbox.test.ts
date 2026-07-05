// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { settings } from "#shared/db/settings.ts";
import {
  assertPublicHtml,
  createTestListing,
  describeWithEnv,
  expectFlash,
  expectRedirect,
  expectReservedRedirectWithTokens,
  getTicketCsrfToken,
  mockFormRequest,
  mockRequest,
  submitTicketForm,
} from "#test-utils";

// jscpd:ignore-end

describeWithEnv(
  "server public > ticket terms checkbox",
  { db: true, triggers: true },
  () => {
    describe("terms and conditions (single ticket)", () => {
      test("shows terms checkbox when terms are configured", async () => {
        await settings.update.terms("I agree to the listing rules.");

        const listing = await createTestListing({ maxAttendees: 50 });
        await assertPublicHtml(
          `/ticket/${listing.slug}`,
          "agree_terms",
          "I agree to the listing rules.",
          "I agree to the terms above",
        );
      });

      test("does not show terms checkbox when no terms configured", async () => {
        const listing = await createTestListing({ maxAttendees: 50 });
        const html = await assertPublicHtml(`/ticket/${listing.slug}`);
        expect(html).not.toContain("agree_terms");
      });

      test("rejects submission without agreeing to terms", async () => {
        await settings.update.terms("You must accept the rules.");

        const listing = await createTestListing({ maxAttendees: 50 });
        const response = await submitTicketForm(listing.slug, {
          email: "john@example.com",
          name: "John Doe",
        });
        expect(response.status).toBe(302);
        expectFlash(
          response,
          expect.stringContaining(
            "You must agree to the terms and conditions",
          ),
          false,
        );
      });

      test("accepts submission when terms are agreed to", async () => {
        await settings.update.terms("You must accept the rules.");

        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com/thanks",
        });
        const response = await submitTicketForm(listing.slug, {
          agree_terms: "1",
          email: "john@example.com",
          name: "John Doe",
        });
        expectRedirect(response, "https://example.com/thanks");
      });

      test("succeeds without checkbox when no terms configured", async () => {
        const listing = await createTestListing({
          maxAttendees: 50,
          thankYouUrl: "https://example.com/thanks",
        });
        const response = await submitTicketForm(listing.slug, {
          email: "john@example.com",
          name: "John Doe",
        });
        expectRedirect(response, "https://example.com/thanks");
      });
    });

    describe("terms and conditions (ticket)", () => {
      test("shows terms checkbox on ticket page when configured", async () => {
        await settings.update.terms("Multi-listing terms apply.");

        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "TC Multi 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "TC Multi 2",
        });
        await assertPublicHtml(
          `/ticket/${listing1.slug}+${listing2.slug}`,
          "agree_terms",
          "Multi-listing terms apply.",
        );
      });

      test("rejects ticket submission without agreeing to terms", async () => {
        await settings.update.terms("Must agree to policy.");

        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "TC Multi Rej 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "TC Multi Rej 2",
        });

        const path = `/ticket/${listing1.slug}+${listing2.slug}`;
        const getResponse = await handleRequest(mockRequest(path));
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
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
            "You must agree to the terms and conditions",
          ),
          false,
        );
      });

      test("accepts ticket submission when terms are agreed to", async () => {
        await settings.update.terms("Must agree to policy.");

        const listing1 = await createTestListing({
          maxAttendees: 50,
          name: "TC Multi Ok 1",
        });
        const listing2 = await createTestListing({
          maxAttendees: 50,
          name: "TC Multi Ok 2",
        });

        const path = `/ticket/${listing1.slug}+${listing2.slug}`;
        const getResponse = await handleRequest(mockRequest(path));
        const csrfToken = getTicketCsrfToken(await getResponse.text());
        if (!csrfToken) throw new Error("Failed to get CSRF token");

        const response = await handleRequest(
          mockFormRequest(
            path,
            {
              email: "john@example.com",
              name: "John Doe",
              [`quantity_${listing1.id}`]: "1",
              [`quantity_${listing2.id}`]: "1",
              agree_terms: "1",
              csrf_token: csrfToken,
            },
            `csrf_token=${csrfToken}`,
          ),
        );
        expectReservedRedirectWithTokens(response);
      });
    });
  },
);

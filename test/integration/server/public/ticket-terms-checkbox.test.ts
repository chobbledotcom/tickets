// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#shared/db/settings.ts";
import { expectBasicTicketBookingRedirectsToThanks } from "#test/lib/server-public/basic-ticket-booking.ts";
import {
  assertPublicHtml,
  expectFlash,
  expectRedirect,
  expectReservedRedirectWithTokens,
} from "#test-utils/assertions.ts";
import {
  expectBookOneEachRejected,
  submitMultiTicketForm,
  submitTicketForm,
} from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

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
          expect.stringContaining("You must agree to the terms and conditions"),
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
        await expectBasicTicketBookingRedirectsToThanks();
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

        await expectBookOneEachRejected(
          `${listing1.slug}+${listing2.slug}`,
          listing1.id,
          listing2.id,
          "You must agree to the terms and conditions",
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

        const response = await submitMultiTicketForm(
          `${listing1.slug}+${listing2.slug}`,
          {
            agree_terms: "1",
            email: "john@example.com",
            name: "John Doe",
            [`quantity_${listing1.id}`]: "1",
            [`quantity_${listing2.id}`]: "1",
          },
        );
        expectReservedRedirectWithTokens(response);
      });
    });
  },
);

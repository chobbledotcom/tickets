/**
 * Tests for the terms-agreement submit branches on the public ticket pages
 * POST /ticket/:slug(+…) — refusal and acceptance with terms configured
 *
 * Sits beside the story `@story:bookings.agreeing-to-the-terms-before-booking`:
 * the story owns the customer's journey (the box shown, the refusal named,
 * the order through), and the checkbox render branches are owned by the
 * template unit tests (reservations/form.test.ts, ticket-page). These own
 * the parse branch in src/features/public/ticket-submit/parse.ts — a
 * configured-terms order refused without the agreement, and booked with it.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { settings } from "#db/settings.ts";
import { expectFlash, expectRedirect } from "#test-utils/assertions.ts";
import { submitTicketForm } from "#test-utils/csrf.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";

// jscpd:ignore-end

describeWithEnv(
  "server public > ticket terms checkbox",
  { db: true, triggers: true },
  () => {
    describe("terms and conditions (single ticket)", () => {
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
    });
  },
);

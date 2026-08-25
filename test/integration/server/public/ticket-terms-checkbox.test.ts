/**
 * Tests for the terms-agreement branches on the public ticket pages
 * POST /ticket/:slug(+…) — server-side refusal and acceptance with terms
 *
 * Sits beside the story `@story:bookings.agreeing-to-the-terms-before-booking`:
 * the story owns what a real browser experiences — the checkbox render is
 * owned by the template unit tests (reservations/form.test.ts, ticket-page),
 * and the page's insistence on the ticked box is the story's. These own the
 * server guard in src/features/public/ticket-submit/parse.ts: an order that
 * arrives without the agreement is refused for that reason and books
 * nothing. The page's own checkbox is required, so no browser can send
 * these — only a crafted POST can.
 */

// jscpd:ignore-start
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { settings } from "#db/settings.ts";
import { expectFlash, expectRedirect } from "#test-utils/assertions.ts";
import {
  expectBookOneEachRejected,
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
      test("rejects a submission without agreeing, and books nothing", async () => {
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
        expect((await getAttendeesRaw(listing.id)).length).toBe(0);
      });

      test("accepts a submission when terms are agreed to", async () => {
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

    describe("terms and conditions (ticket)", () => {
      test("rejects a joint submission without agreeing, and books nothing", async () => {
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
        // The refusal leaves nothing behind on either part of the order.
        expect((await getAttendeesRaw(listing1.id)).length).toBe(0);
        expect((await getAttendeesRaw(listing2.id)).length).toBe(0);
      });
    });
  },
);

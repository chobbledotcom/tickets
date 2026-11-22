import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  expectManualAddWebhook,
  stubWebhookFetch,
} from "#test/shared/webhook/helpers.ts";
import { assertJson } from "#test-utils/assertions.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createBooking } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { apiRequest } from "#test-utils/session.ts";

const HOOK = "https://hooks.example.test/import";

/** A listing that collects email and has a webhook. */
const hookedListing = () =>
  createTestListing({
    fields: "email",
    maxAttendees: 10,
    name: "Import Fair",
    unitPrice: 500,
    webhookUrl: HOOK,
  });

/** The stored flags a create answers with. */
type Flags = {
  email_owed: number;
  email_pending: number;
  webhooks_pending: number;
};

const flagsOf = (attendee: Flags): Flags => ({
  email_owed: attendee.email_owed,
  email_pending: attendee.email_pending,
  webhooks_pending: attendee.webhooks_pending,
});

describeWithEnv(
  "Admin API - POST /api/admin/attendees notifications option",
  { db: true },
  () => {
    const fetchSpy = stubWebhookFetch();

    describe("a booking that owes its notifications", () => {
      for (const extra of [{}, { notifications: true }]) {
        test(`owes its email and fires the listing webhook: ${JSON.stringify(extra)}`, async () => {
          const listing = await hookedListing();
          const created = await assertJson(
            createBooking(listing.id, { email: "buyer@example.com", ...extra }),
            201,
          );
          expect(flagsOf(created.attendee)).toEqual({
            email_owed: 1,
            email_pending: 2,
            webhooks_pending: 0,
          });
          expectManualAddWebhook(fetchSpy, {
            amountOwed: 500,
            contact: { email: "buyer@example.com", name: "Ada Lovelace" },
            listing,
            quantity: 1,
            unitPrice: 500,
            url: HOOK,
          });
        });
      }
    });

    describe("an imported booking, notifications: false", () => {
      test("owes no email and fires no webhook", async () => {
        const listing = await hookedListing();
        const created = await assertJson(
          createBooking(listing.id, { notifications: false }),
          201,
        );
        expect(flagsOf(created.attendee)).toEqual({
          email_owed: 0,
          email_pending: 0,
          webhooks_pending: 0,
        });
        expect(fetchSpy.calls.length).toBe(0);
      });

      test("a retry with the same ticketToken stays silent and unchanged", async () => {
        const listing = await hookedListing();
        const body = {
          lines: [{ listingId: listing.id, quantity: 1 }],
          name: "Silent Retry",
          notifications: false,
          ticketToken: "silent-token-1",
        };
        const post = () =>
          apiRequest("/api/admin/attendees", { body, method: "POST" });
        const first = await assertJson(post(), 201);
        const retried = await assertJson(post(), 200);
        expect(retried.attendee.id).toBe(first.attendee.id);
        expect(retried.attendee.email_pending).toBe(0);
        expect(fetchSpy.calls.length).toBe(0);
      });
    });

    describe("a notifications value that is not true or false", () => {
      for (const value of ["no", 0, null, []]) {
        test(`is refused: ${JSON.stringify(value)}`, async () => {
          const listing = await hookedListing();
          await assertJson(
            createBooking(listing.id, { notifications: value }),
            400,
            (body) =>
              expect(body.error).toBe("notifications must be true or false"),
          );
          expect(fetchSpy.calls.length).toBe(0);
        });
      }
    });
  },
);

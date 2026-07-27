// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { webhookMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookIgnored,
} from "#test-utils/webhooks.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > item metadata validation",
  { db: true },
  () => {
    test("corrupt booking item in metadata throws (missing p)", async () => {
      await setupStripe();

      const listing1 = await createTestListing({
        maxAttendees: 50,
        name: "No Price Multi",
        unitPrice: 500,
      });

      // Items without a p field can't carry a valid price proof, so the session
      // has no proof and classifies as "ignore": acknowledged (200) without
      // processing or refunding, never a throw.
      await expectWebhookIgnored(
        checkoutSessionEvent({
          amountTotal: 500,
          eventId: "evt_no_price",
          metadata: webhookMeta({
            email: "noprice@example.com",
            items: JSON.stringify([{ e: listing1.id, q: 1 }]),
            name: "No Price User",
          }),
          paymentIntent: "pi_no_price",
          sessionId: "cs_no_price",
        }),
      );
      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      expect((await getAttendeesRaw(listing1.id)).length).toBe(0);
    });

    test("webhook returns error for invalid multi-ticket items", async () => {
      await setupStripe();

      await expectWebhookIgnored(
        checkoutSessionEvent({
          amountTotal: 0,
          eventId: "evt_bad_multi",
          metadata: webhookMeta({
            email: "bad@example.com",
            items: "not-valid-json{",
            name: "Bad Multi",
          }),
          paymentIntent: "pi_bad",
          sessionId: "cs_bad_multi",
        }),
      );
    });

    test("webhook with non-array items in multi-ticket returns null", async () => {
      await setupStripe();

      await expectWebhookIgnored(
        checkoutSessionEvent({
          amountTotal: 0,
          eventId: "evt_non_array",
          metadata: webhookMeta({
            email: "test@example.com",
            items: '{"not":"an-array"}', // Valid JSON but not an array
            name: "Test",
          }),
          paymentIntent: "pi_non_array",
          sessionId: "cs_non_array",
        }),
      );
    });

    test("webhook with missing items in multi-ticket metadata acknowledges without processing", async () => {
      await setupStripe();

      // Returns 200 to prevent provider retries
      await expectWebhookIgnored(
        checkoutSessionEvent({
          amountTotal: 0,
          eventId: "evt_no_items",
          metadata: webhookMeta({
            email: "test@example.com",
            items: "", // empty items: hasRequiredSessionMetadata rejects (no items)
            name: "Test",
          }),
          paymentIntent: "pi_no_items",
          sessionId: "cs_no_items",
        }),
      );
    });

    test("corrupt booking item in metadata throws (non-integer p)", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await expectWebhookIgnored(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_bad_p",
          metadata: webhookMeta({
            email: "bad@example.com",
            items: JSON.stringify([{ e: listing.id, p: 10.5, q: 1 }]),
            name: "Bad Metadata",
          }),
          paymentIntent: "pi_bad_p",
          sessionId: "cs_bad_p",
        }),
      );
      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });

    test("corrupt booking item in metadata throws (non-object item)", async () => {
      await setupStripe();

      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });

      await expectWebhookIgnored(
        checkoutSessionEvent({
          amountTotal: 1000,
          eventId: "evt_bad_item",
          metadata: webhookMeta({
            email: "bad@example.com",
            items: JSON.stringify([42, { e: listing.id, p: 1000, q: 1 }]),
            name: "Bad Item",
          }),
          paymentIntent: "pi_bad_item",
          sessionId: "cs_bad_item",
        }),
      );
      const { getAttendeesRaw } = await import(
        "#shared/db/attendees/queries.ts"
      );
      expect((await getAttendeesRaw(listing.id)).length).toBe(0);
    });
  },
);

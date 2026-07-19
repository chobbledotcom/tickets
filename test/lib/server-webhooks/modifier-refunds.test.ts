// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { singleModifierMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectKeptAsQuantityZeroAndRefunded,
  expectWebhookKeptAndRefunded,
} from "#test-utils/webhooks.ts";
import { createServiceChargeScenario } from "./service-charge-scenario.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > modifier price-mismatch refunds",
  { db: true },
  () => {
    test("refunds a webhook whose total omits an applied modifier", async () => {
      await setupStripe();
      const { listing, modifier } = await createServiceChargeScenario();

      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          // Paid only the ticket, not the surcharge the metadata records.
          amountTotal: 1000,
          eventId: "evt_modifier_mismatch",
          metadata: singleModifierMeta({
            amountTotal: 1000,
            listingId: listing.id,
            modifierId: modifier.id,
            unitPrice: 1000,
          }),
          paymentIntent: "pi_modifier_mismatch",
          sessionId: "cs_modifier_mismatch",
        }),
        "re_modifier",
      );
      // Signed by us → the booking is kept as a quantity-0 placeholder (not
      // dropped) and refunded once, with a system note recording the reason.
      // The session is recorded as a terminal failure (placeholder kept, no
      // ticket attendee): attendee_id stays null and failure_data is set.
      await expectKeptAsQuantityZeroAndRefunded(
        listing.id,
        "cs_modifier_mismatch",
        mockRefund,
      );
    });

    test("keeps and refunds an add-on-only paid session whose total no longer matches", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 0,
      });
      const modifier = await modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Workshop kit",
      });

      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          // Expected total is the £5 add-on; simulate a stale £4 session.
          amountTotal: 400,
          eventId: "evt_addon_only_mismatch",
          metadata: singleModifierMeta({
            amountTotal: 400,
            listingId: listing.id,
            modifierId: modifier.id,
            unitPrice: 0,
          }),
          paymentIntent: "pi_addon_only_mismatch",
          sessionId: "cs_addon_only_mismatch",
        }),
        "re_addon_only",
      );
      // Signed by us → the booking is kept as a quantity-0 placeholder (not
      // dropped) and refunded once, with a system note recording the reason.
      await expectKeptAsQuantityZeroAndRefunded(
        listing.id,
        "cs_addon_only_mismatch",
        mockRefund,
      );
    });

    test("keeps and refunds when a modifier sold out before the webhook finalized", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const modifier = await modifiersTable.insert({
        calcKind: "percent",
        calcValue: 10,
        direction: "charge",
        name: "Last one",
        stock: 1,
      });
      // Exhaust the single unit before the webhook arrives.
      const { insertModifierUsage } = await import("#test-utils/modifiers.ts");
      await insertModifierUsage(modifier.id, 999, 1, 100);

      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 1100,
          eventId: "evt_modifier_soldout",
          metadata: singleModifierMeta({
            amountTotal: 1100,
            listingId: listing.id,
            modifierId: modifier.id,
            unitPrice: 1000,
          }),
          paymentIntent: "pi_modifier_soldout",
          sessionId: "cs_modifier_soldout",
        }),
        "re_soldout",
      );
      // Signed by us → the booking is kept as a quantity-0 placeholder (not
      // dropped) and refunded once, with a system note recording the reason.
      await expectKeptAsQuantityZeroAndRefunded(
        listing.id,
        "cs_modifier_soldout",
        mockRefund,
      );
      // The greedy create's visit + booking are reversed, and the quantity-0
      // placeholder records neither, so the refunded order leaves no phantom
      // history on the buyer's contact.
      const { getContactRecord, getVisits, hashEmail } = await import(
        "#shared/db/contact-preferences.ts"
      );
      const { getTestPrivateKey } = await import("#test-utils/crypto.ts");
      const buyerHash = await hashEmail("mod@example.com");
      expect(await getVisits(buyerHash)).toBe(0);
      expect(
        (await getContactRecord(buyerHash, await getTestPrivateKey()))
          .publicBookingCount,
      ).toBe(0);
    });
  },
);

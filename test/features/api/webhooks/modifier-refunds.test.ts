// jscpd:ignore-start
import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { singleModifierMeta } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectStagedAttendeeRemovedAndRefunded,
  expectWebhookKeptAndRefunded,
} from "#test-utils/webhooks.ts";
import { createServiceChargeScenario } from "./service-charge-scenario.ts";

// jscpd:ignore-end

describeWithEnv(
  "server webhooks > modifier price-mismatch refunds",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

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
      // The staged attendee is removed and refunded once. The session keeps a
      // terminal failure for replay, with no ticket attendee.
      await expectStagedAttendeeRemovedAndRefunded(
        listing.id,
        "cs_modifier_mismatch",
        mockRefund,
      );
    });

    test("removes and refunds an add-on-only paid session whose total no longer matches", async () => {
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
      // The staged attendee is removed and the payment is refunded once.
      await expectStagedAttendeeRemovedAndRefunded(
        listing.id,
        "cs_addon_only_mismatch",
        mockRefund,
      );
    });

    test("removes and refunds when a modifier sold out before the webhook finalized", async () => {
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
      // The staged attendee is removed and the payment is refunded once.
      await expectStagedAttendeeRemovedAndRefunded(
        listing.id,
        "cs_modifier_soldout",
        mockRefund,
      );
      // Deleting the staged attendee leaves no booking or visit history on the
      // buyer's contact.
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

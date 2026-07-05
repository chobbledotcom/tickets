import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  checkoutSessionEvent,
  createTestListing,
  describeWithEnv,
  expectRefundedWithNote,
  expectSessionFailed,
  expectWebhookKeptAndRefunded,
  setupStripe,
  signedMeta,
  singleItem,
} from "#test-utils";

describeWithEnv(
  "server webhooks > modifier price-mismatch refunds",
  { db: true },
  () => {
    afterEach(() => {
      resetStripeClient();
    });

    test("refunds a webhook whose total omits an applied modifier", async () => {
      await setupStripe();
      const listing = await createTestListing({
        maxAttendees: 50,
        unitPrice: 1000,
      });
      const modifier = await modifiersTable.insert({
        calcKind: "percent",
        calcValue: 10,
        direction: "charge",
        name: "Service charge",
      });

      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          // Paid only the ticket, not the surcharge the metadata records.
          amountTotal: 1000,
          eventId: "evt_modifier_mismatch",
          metadata: signedMeta(
            {
              email: "mod@example.com",
              items: singleItem(listing.id, 1, 1000),
              modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
              name: "Mod Buyer",
            },
            1000,
          ),
          paymentIntent: "pi_modifier_mismatch",
          sessionId: "cs_modifier_mismatch",
        }),
        "re_modifier",
      );
      // Signed by us → the booking is kept as a quantity-0 placeholder (not
      // dropped) and refunded once, with a system note recording the reason.
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      await expectRefundedWithNote(attendees[0]!.id, mockRefund);
      // The session is recorded as a terminal failure (placeholder kept, no
      // ticket attendee): attendee_id stays null and failure_data is set.
      await expectSessionFailed("cs_modifier_mismatch");
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
          metadata: signedMeta(
            {
              email: "mod@example.com",
              items: singleItem(listing.id, 1, 0),
              modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
              name: "Mod Buyer",
            },
            400,
          ),
          paymentIntent: "pi_addon_only_mismatch",
          sessionId: "cs_addon_only_mismatch",
        }),
        "re_addon_only",
      );
      // Signed by us → the booking is kept as a quantity-0 placeholder (not
      // dropped) and refunded once, with a system note recording the reason.
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      await expectRefundedWithNote(attendees[0]!.id, mockRefund);
      await expectSessionFailed("cs_addon_only_mismatch");
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
      const { consumeModifierStock } = await import("#test-utils");
      await consumeModifierStock(999, [
        { amountApplied: 100, modifierId: modifier.id, quantity: 1 },
      ]);

      const { mockRefund } = await expectWebhookKeptAndRefunded(
        checkoutSessionEvent({
          amountTotal: 1100,
          eventId: "evt_modifier_soldout",
          metadata: signedMeta(
            {
              email: "mod@example.com",
              items: singleItem(listing.id, 1, 1000),
              modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
              name: "Mod Buyer",
            },
            1100,
          ),
          paymentIntent: "pi_modifier_soldout",
          sessionId: "cs_modifier_soldout",
        }),
        "re_soldout",
      );
      // Signed by us → the booking is kept as a quantity-0 placeholder (not
      // dropped) and refunded once, with a system note recording the reason.
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      await expectRefundedWithNote(attendees[0]!.id, mockRefund);
      await expectSessionFailed("cs_modifier_soldout");
      // The greedy create's visit + booking are reversed, and the quantity-0
      // placeholder records neither, so the refunded order leaves no phantom
      // history on the buyer's contact.
      const { getContactRecord, getVisits, hashEmail } = await import(
        "#shared/db/contact-preferences.ts"
      );
      const { getTestPrivateKey } = await import("#test-utils");
      const buyerHash = await hashEmail("mod@example.com");
      expect(await getVisits(buyerHash)).toBe(0);
      expect(
        (await getContactRecord(buyerHash, await getTestPrivateKey()))
          .publicBookingCount,
      ).toBe(0);
    });
  },
);

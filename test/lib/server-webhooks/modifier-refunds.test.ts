import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  describeWithEnv,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  singleItem,
  stubWebhookVerify,
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

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  // Paid only the ticket, not the surcharge the metadata records.
                  amount_total: 1000,
                  id: "cs_modifier_mismatch",
                  metadata: signedMeta(
                    {
                      email: "mod@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                      name: "Mod Buyer",
                    },
                    1000,
                  ),
                  payment_intent: "pi_modifier_mismatch",
                  payment_status: "paid",
                },
              },
              id: "evt_modifier_mismatch",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_modifier" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            // The specific reason now lives in the system note, not the
            // customer message: the generic saved-details message is returned.
            expect(json.error).toContain("saved your details");
          },
        );
        // Signed by us → the booking is kept as a quantity-0 placeholder (not
        // dropped) and refunded once, with a system note recording the reason.
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(mockRefund.calls.length).toBe(1);
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        expect((await getNoteRows([attendees[0]!.id])).length).toBe(1);
        // The session is recorded as a terminal failure (placeholder kept, no
        // ticket attendee): attendee_id stays null and failure_data is set.
        const { isSessionProcessed } = await import(
          "#shared/db/processed-payments.ts"
        );
        const record = await isSessionProcessed("cs_modifier_mismatch");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
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

      const mockVerify = await stubWebhookVerify({
        data: {
          object: {
            // Expected total is the £5 add-on; simulate a stale £4 session.
            amount_total: 400,
            id: "cs_addon_only_mismatch",
            metadata: signedMeta(
              {
                email: "mod@example.com",
                items: singleItem(listing.id, 1, 0),
                modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                name: "Mod Buyer",
              },
              400,
            ),
            payment_intent: "pi_addon_only_mismatch",
            payment_status: "paid",
          },
        },
        id: "evt_addon_only_mismatch",
        type: "checkout.session.completed",
      });
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_addon_only" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            // The reason now lives in the note; the customer sees the generic
            // saved-details message.
            expect(json.error).toContain("saved your details");
          },
        );
        // Signed by us → the booking is kept as a quantity-0 placeholder (not
        // dropped) and refunded once, with a system note recording the reason.
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(mockRefund.calls.length).toBe(1);
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        expect((await getNoteRows([attendees[0]!.id])).length).toBe(1);
        const { isSessionProcessed } = await import(
          "#shared/db/processed-payments.ts"
        );
        const record = await isSessionProcessed("cs_addon_only_mismatch");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
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

      const { stripePaymentProvider } = await import(
        "#shared/stripe-provider.ts"
      );
      const mockVerify = stub(
        stripePaymentProvider,
        "verifyWebhookSignature",
        () =>
          Promise.resolve({
            listing: {
              data: {
                object: {
                  amount_total: 1100,
                  id: "cs_modifier_soldout",
                  metadata: signedMeta(
                    {
                      email: "mod@example.com",
                      items: singleItem(listing.id, 1, 1000),
                      modifiers: JSON.stringify([{ i: modifier.id, q: 1 }]),
                      name: "Mod Buyer",
                    },
                    1100,
                  ),
                  payment_intent: "pi_modifier_soldout",
                  payment_status: "paid",
                },
              },
              id: "evt_modifier_soldout",
              type: "checkout.session.completed",
            },
            valid: true,
          }),
      );
      const mockRefund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({ id: "re_soldout" } as unknown as Awaited<
          ReturnType<typeof stripeApi.refundPayment>
        >),
      );

      try {
        await assertJson(
          handleRequest(
            mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
          ),
          200,
          (json) => {
            expect(json.processed).toBe(false);
            // The sold-out reason now lives in the note; the customer sees the
            // generic saved-details message.
            expect(json.error).toContain("saved your details");
          },
        );
        // Signed by us → the booking is kept as a quantity-0 placeholder (not
        // dropped) and refunded once, with a system note recording the reason.
        const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
        const attendees = await getAttendeesRaw(listing.id);
        expect(attendees.length).toBe(1);
        expect(mockRefund.calls.length).toBe(1);
        const { getNoteRows } = await import("#shared/db/system-notes.ts");
        expect((await getNoteRows([attendees[0]!.id])).length).toBe(1);
        const { isSessionProcessed } = await import(
          "#shared/db/processed-payments.ts"
        );
        const record = await isSessionProcessed("cs_modifier_soldout");
        expect(record?.attendee_id).toBeNull();
        expect(record?.failure_data).not.toBe("");
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
      } finally {
        mockVerify.restore();
        mockRefund.restore();
      }
    });
  },
);

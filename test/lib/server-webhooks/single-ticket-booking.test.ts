import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { resetStripeClient } from "#shared/stripe.ts";
import {
  assertJson,
  createTestListing,
  describeWithEnv,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  singleItem,
} from "#test-utils";

describeWithEnv("server webhooks > single-ticket booking", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("processes valid single-ticket webhook and creates attendee", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
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
                amount_total: 1000,
                id: "cs_webhook_test",
                metadata: signedMeta(
                  {
                    email: "webhook@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    name: "Webhook User",
                  },
                  1000,
                ),
                payment_intent: "pi_webhook_test",
                payment_status: "paid",
              },
            },
            id: "evt_test",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.received).toBe(true);
          expect(json.processed).toBe(true);
        },
      );

      // Verify attendee was created with encrypted PII blob
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      expect(attendees.length).toBe(1);
      expect(attendees[0]?.pii_blob).not.toBe("");

      // Verify tokens ARE persisted in DB (webhook stores them for redirect to consume)
      const { isSessionProcessed } = await import(
        "#shared/db/processed-payments.ts"
      );
      const record = await isSessionProcessed("cs_webhook_test");
      expect(record?.ticket_tokens).not.toBe("");
    } finally {
      mockVerify.restore();
    }
  });

  test("dates booking ledger legs from the checkout time, not now", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });

    // Stripe stamps `created` (Unix seconds) when the checkout is made. Even a
    // webhook that arrives a day late must book the revenue on the day the
    // customer paid, so every leg takes its occurredAt from `created`.
    const created = Math.floor(Date.parse("2026-06-19T08:00:00.000Z") / 1000);
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
                amount_total: 1000,
                created,
                id: "cs_ledger_time",
                metadata: signedMeta(
                  {
                    email: "ledgertime@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    name: "Ledger Time",
                  },
                  1000,
                ),
                payment_intent: "pi_ledger_time",
                payment_status: "paid",
              },
            },
            id: "evt_ledger_time",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    try {
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.processed).toBe(true);
        },
      );

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const { attendeeAccount } = await import(
        "#shared/accounting/accounts.ts"
      );
      const { transfersByAccount } = await import(
        "#shared/accounting/queries.ts"
      );
      const attendees = await getAttendeesRaw(listing.id);
      const legs = await transfersByAccount(attendeeAccount(attendees[0]!.id));
      const expected = new Date(created * 1000).toISOString();
      expect(legs.length).toBeGreaterThan(0);
      for (const leg of legs) {
        expect(leg.occurredAt).toBe(expected);
      }
    } finally {
      mockVerify.restore();
    }
  });
});

import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { handleRequest } from "#routes";
import { getDb } from "#shared/db/client.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  assertJson,
  bookAttendee,
  createTestListing,
  describeWithEnv,
  makeParent,
  mockWebhookRequest,
  setupStripe,
  signedMeta,
  singleItem,
  webhookMeta,
} from "#test-utils";

describeWithEnv("server webhooks > multi-ticket booking", { db: true }, () => {
  afterEach(() => {
    resetStripeClient();
  });

  test("processes valid multi-ticket webhook and creates attendees", async () => {
    await setupStripe();

    const listing1 = await createTestListing({
      maxAttendees: 50,
      name: "Webhook Multi 1",
      unitPrice: 500,
    });
    const listing2 = await createTestListing({
      maxAttendees: 50,
      name: "Webhook Multi 2",
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
                amount_total: 2000,
                id: "cs_multi_webhook",
                metadata: signedMeta(
                  {
                    email: "multi@example.com",
                    items: JSON.stringify([
                      { e: listing1.id, p: 1000, q: 2 },
                      { e: listing2.id, p: 1000, q: 1 },
                    ]),
                    name: "Multi User",
                    phone: "123456",
                  },
                  2000,
                ),
                payment_intent: "pi_multi_webhook",
                payment_status: "paid",
              },
            },
            id: "evt_multi",
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

      // Verify attendees were created for both listings
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees1 = await getAttendeesRaw(listing1.id);
      const attendees2 = await getAttendeesRaw(listing2.id);
      expect(attendees1.length).toBe(1);
      expect(attendees1[0]?.quantity).toBe(2);
      expect(attendees2.length).toBe(1);
      expect(attendees2[0]?.quantity).toBe(1);
    } finally {
      mockVerify.restore();
    }
  });

  test("webhook with allocations expands child booking to per-parent row (Stage C)", async () => {
    await setupStripe();

    const { parent, child } = await makeParent({
      children: [{ maxAttendees: 10, unitPrice: 0 }],
      parent: { maxAttendees: 10, unitPrice: 1000 },
    });

    const allocations = [{ childId: child.id, parentId: parent.id, qty: 1 }];

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
                id: "cs_webhook_alloc",
                metadata: signedMeta(
                  {
                    allocations: JSON.stringify(allocations),
                    email: "alloc@example.com",
                    items: JSON.stringify([
                      { e: parent.id, p: 1000, q: 1 },
                      { e: child.id, p: 0, q: 1 },
                    ]),
                    name: "Alloc User",
                  },
                  1000,
                ),
                payment_intent: "pi_alloc",
                payment_status: "paid",
              },
            },
            id: "evt_alloc",
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

      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const childRows = await getAttendeesRaw(child.id);
      expect(childRows.length).toBe(1);
      const parentIdRow = await getDb().execute({
        args: [childRows[0]!.id, child.id],
        sql: "SELECT parent_listing_id FROM listing_attendees WHERE attendee_id = ? AND listing_id = ?",
      });
      expect(Number(parentIdRow.rows[0]!.parent_listing_id)).toBe(parent.id);
    } finally {
      mockVerify.restore();
    }
  });

  test("webhook handles sold-out listing and returns error in JSON", async () => {
    await setupStripe();

    const listing = await createTestListing({
      maxAttendees: 1,
      unitPrice: 1000,
    });

    // Fill the listing
    await bookAttendee(listing, {
      email: "first@example.com",
      name: "First",
      paymentId: "pi_first",
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
                id: "cs_soldout",
                metadata: signedMeta(
                  {
                    email: "late@example.com",
                    items: singleItem(listing.id, 1, 1000),
                    name: "Late Buyer",
                  },
                  1000,
                ),
                payment_intent: "pi_soldout",
                payment_status: "paid",
              },
            },
            id: "evt_soldout",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    const mockRefund = stub(stripeApi, "refundPayment", () =>
      Promise.resolve({ id: "re_test" } as unknown as Awaited<
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
          expect(json.received).toBe(true);
          expect(json.processed).toBe(false);
          // The sold-out reason now lives in the note; the customer sees the
          // generic saved-details message.
          expect(json.error).toContain("saved your details");
        },
      );
      // The late buyer is not dropped: a quantity-0 placeholder is kept
      // alongside the original sold-out attendee, refunded once, with a note.
      const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
      const attendees = await getAttendeesRaw(listing.id);
      const placeholder = attendees.find((a) => a.quantity === 0);
      expect(placeholder).toBeDefined();
      expect(mockRefund.calls.length).toBe(1);
      const { getNoteRows } = await import("#shared/db/system-notes.ts");
      expect((await getNoteRows([placeholder!.id])).length).toBe(1);
      const { isSessionProcessed } = await import(
        "#shared/db/processed-payments.ts"
      );
      const record = await isSessionProcessed("cs_soldout");
      expect(record?.attendee_id).toBeNull();
      expect(record?.failure_data).not.toBe("");
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
  });

  test("multi-ticket webhook creates attendees for multiple listings", async () => {
    await setupStripe();

    const listing1 = await createTestListing({
      maxAttendees: 50,
      name: "Multi WH OK 1",
      unitPrice: 500,
    });
    const listing2 = await createTestListing({
      maxAttendees: 50,
      name: "Multi WH OK 2",
      unitPrice: 300,
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
                amount_total: 1100,
                id: "cs_multi_ok",
                metadata: signedMeta(
                  {
                    email: "multi@example.com",
                    items: JSON.stringify([
                      { e: listing1.id, p: 500, q: 1 },
                      { e: listing2.id, p: 600, q: 2 },
                    ]),
                    name: "Multi Buyer",
                  },
                  1100,
                ),
                payment_intent: "pi_multi_ok",
                payment_status: "paid",
              },
            },
            id: "evt_multi_ok",
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
    } finally {
      mockVerify.restore();
    }
  });

  test("multi-ticket webhook handles listing not found without refund", async () => {
    await setupStripe();

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
                id: "cs_multi_notfound",
                metadata: webhookMeta({
                  email: "notfound@example.com",
                  items: JSON.stringify([{ e: 99999, p: 1000, q: 1 }]),
                  name: "Multi NotFound",
                }),
                payment_intent: "pi_multi_notfound",
                payment_status: "paid",
              },
            },
            id: "evt_multi_notfound",
            type: "checkout.session.completed",
          },
          valid: true,
        }),
    );

    const mockRefund = spy(stripeApi, "refundPayment");

    try {
      // Unsigned session (no valid price proof) for a listing we don't have:
      // ignored (200 ack) without processing — and crucially without a refund,
      // since the webhook may be for a different instance sharing the provider.
      await assertJson(
        handleRequest(
          mockWebhookRequest({}, { "stripe-signature": "sig_valid" }),
        ),
        200,
        (json) => {
          expect(json.received).toBe(true);
          expect(json.processed).toBeUndefined();
        },
      );
      // An unverifiable session must NOT trigger a refund.
      expect(mockRefund.calls.length).toBe(0);
    } finally {
      mockVerify.restore();
      mockRefund.restore();
    }
  });
});

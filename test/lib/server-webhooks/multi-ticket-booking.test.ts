import { expect } from "@std/expect";
import { afterEach, it as test } from "@std/testing/bdd";
import { spy } from "@std/testing/mock";
import { getDb } from "#shared/db/client.ts";
import { resetStripeClient, stripeApi } from "#shared/stripe.ts";
import {
  bookAttendee,
  checkoutSessionEvent,
  createTestListing,
  describeWithEnv,
  expectRefundedWithNote,
  expectSessionFailed,
  expectWebhookKeptAndRefunded,
  expectWebhookProcessed,
  makeParent,
  postWebhookAndAssert,
  setupStripe,
  signedMeta,
  singleItem,
  stubWebhookVerify,
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

    await expectWebhookProcessed(
      checkoutSessionEvent({
        amountTotal: 2000,
        eventId: "evt_multi",
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
        paymentIntent: "pi_multi_webhook",
        sessionId: "cs_multi_webhook",
      }),
    );

    // Verify attendees were created for both listings
    const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
    const attendees1 = await getAttendeesRaw(listing1.id);
    const attendees2 = await getAttendeesRaw(listing2.id);
    expect(attendees1.length).toBe(1);
    expect(attendees1[0]?.quantity).toBe(2);
    expect(attendees2.length).toBe(1);
    expect(attendees2[0]?.quantity).toBe(1);
  });

  test("webhook with allocations expands child booking to per-parent row (Stage C)", async () => {
    await setupStripe();

    const { parent, child } = await makeParent({
      children: [{ maxAttendees: 10, unitPrice: 0 }],
      parent: { maxAttendees: 10, unitPrice: 1000 },
    });

    const allocations = [{ childId: child.id, parentId: parent.id, qty: 1 }];

    await expectWebhookProcessed(
      checkoutSessionEvent({
        amountTotal: 1000,
        eventId: "evt_alloc",
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
        paymentIntent: "pi_alloc",
        sessionId: "cs_webhook_alloc",
      }),
    );

    const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
    const childRows = await getAttendeesRaw(child.id);
    expect(childRows.length).toBe(1);
    const parentIdRow = await getDb().execute({
      args: [childRows[0]!.id, child.id],
      sql: "SELECT parent_listing_id FROM listing_attendees WHERE attendee_id = ? AND listing_id = ?",
    });
    expect(Number(parentIdRow.rows[0]!.parent_listing_id)).toBe(parent.id);
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

    const { mockRefund } = await expectWebhookKeptAndRefunded(
      checkoutSessionEvent({
        amountTotal: 1000,
        eventId: "evt_soldout",
        metadata: signedMeta(
          {
            email: "late@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Late Buyer",
          },
          1000,
        ),
        paymentIntent: "pi_soldout",
        sessionId: "cs_soldout",
      }),
    );
    // The late buyer is not dropped: a quantity-0 placeholder is kept
    // alongside the original sold-out attendee, refunded once, with a note.
    const { getAttendeesRaw } = await import("#shared/db/attendees.ts");
    const attendees = await getAttendeesRaw(listing.id);
    const placeholder = attendees.find((a) => a.quantity === 0);
    expect(placeholder).toBeDefined();
    await expectRefundedWithNote(placeholder!.id, mockRefund);
    await expectSessionFailed("cs_soldout");
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

    await expectWebhookProcessed(
      checkoutSessionEvent({
        amountTotal: 1100,
        eventId: "evt_multi_ok",
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
        paymentIntent: "pi_multi_ok",
        sessionId: "cs_multi_ok",
      }),
    );
  });

  test("multi-ticket webhook handles listing not found without refund", async () => {
    await setupStripe();

    const mockVerify = await stubWebhookVerify(
      checkoutSessionEvent({
        amountTotal: 1000,
        eventId: "evt_multi_notfound",
        metadata: webhookMeta({
          email: "notfound@example.com",
          items: JSON.stringify([{ e: 99999, p: 1000, q: 1 }]),
          name: "Multi NotFound",
        }),
        paymentIntent: "pi_multi_notfound",
        sessionId: "cs_multi_notfound",
      }),
    );

    const mockRefund = spy(stripeApi, "refundPayment");

    // Unsigned session (no valid price proof) for a listing we don't have:
    // ignored (200 ack) without processing — and crucially without a refund,
    // since the webhook may be for a different instance sharing the provider.
    await postWebhookAndAssert(
      () => {
        mockVerify.restore();
        mockRefund.restore();
      },
      200,
      (json) => {
        expect(json.received).toBe(true);
        expect(json.processed).toBeUndefined();
      },
    );
    // An unverifiable session must NOT trigger a refund.
    expect(mockRefund.calls.length).toBe(0);
  });
});

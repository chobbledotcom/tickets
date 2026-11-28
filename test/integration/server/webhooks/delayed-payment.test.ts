import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { describeWithEnv } from "#test-utils/db.ts";
import { getAttendeesRaw } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { signedMeta, singleItem } from "#test-utils/factories.ts";
import { setupStripe } from "#test-utils/settings.ts";
import {
  checkoutSessionEvent,
  expectWebhookPending,
  expectWebhookProcessed,
} from "#test-utils/webhooks.ts";

describeWithEnv("server webhooks > delayed payment", { db: true }, () => {
  test("books the ticket when the async success event follows an unpaid completion", async () => {
    await setupStripe();
    const listing = await createTestListing({
      maxAttendees: 50,
      unitPrice: 1000,
    });
    const event = (opts: {
      eventId: string;
      paymentStatus: string;
      type:
        | "checkout.session.completed"
        | "checkout.session.async_payment_succeeded";
    }) =>
      checkoutSessionEvent({
        amountTotal: 1000,
        metadata: signedMeta(
          {
            email: "delayed@example.com",
            items: singleItem(listing.id, 1, 1000),
            name: "Delayed Payer",
          },
          1000,
        ),
        sessionId: "cs_delayed",
        ...opts,
      });

    await expectWebhookPending(
      event({
        eventId: "evt_delayed_unpaid",
        paymentStatus: "unpaid",
        type: "checkout.session.completed",
      }),
    );
    expect(await getAttendeesRaw(listing.id)).toHaveLength(0);

    await expectWebhookProcessed(
      event({
        eventId: "evt_delayed_paid",
        paymentStatus: "paid",
        type: "checkout.session.async_payment_succeeded",
      }),
    );
    expect(await getAttendeesRaw(listing.id)).toHaveLength(1);
  });
});

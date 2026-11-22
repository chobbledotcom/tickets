/** Once a sealed order's session is settled, the order gives way to a receipt
 * with no personal details. A retryable outcome keeps the whole order, and a
 * replay repairs a receipt write that the first delivery lost. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeesApi } from "#db/attendees/api.ts";
import {
  redirectRequest,
  runWebhook,
  setupWithListing,
  webhookRequest,
} from "#test/integration/webhook-price-signature/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import {
  expectReceiptOnly,
  openBundleOf,
  resealBundleOf,
  sealedSession,
  stubSessionRead,
} from "#test-utils/sealed-order.ts";

describeWithEnv("a settled sealed checkout order", { db: true }, () => {
  test("a booked session keeps only a receipt with no personal details", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_settled_booked");

    await runWebhook(session, async () => {
      expect((await webhookRequest()).status).toBe(200);
    });

    await expectReceiptOnly(session);
  });

  test("a session that ends refunded keeps only a receipt", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_settled_refunded", 999);

    await runWebhook(session, async (refund) => {
      expect((await webhookRequest()).status).toBe(200);
      expect(refund.calls).toHaveLength(1);
    });

    await expectReceiptOnly(session);
  });

  test("a booking that fails before it settles keeps the whole order for the retry", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_settled_retry");
    using _boom = stub(attendeesApi, "createBookingAtomic", () =>
      Promise.reject(new Error("synthetic create failure")),
    );
    using _env = withEnv({ TEST_EXPECT_ERROR: "1" });

    await runWebhook(session, async () => {
      expect((await webhookRequest()).status).toBe(503);
    });

    const opened = await openBundleOf(session);
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") return;
    expect(opened.record.name).toBe("Sealed Buyer");
  });

  test("the return page after the webhook booked still offers the order's thank-you link", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_settled_thanks");
    await runWebhook(session, async () => {
      await webhookRequest();
    });
    using _retrieve = stubSessionRead(session);

    const page = await redirectRequest(session.id);

    expect(page.status).toBe(200);
    expect(await page.text()).toContain("https://example.com/thanks");
  });

  test("a replay writes the receipt that the first delivery failed to write", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_replay_receipt");
    const opened = await openBundleOf(session);
    if (opened.status !== "opened") throw new Error("Sealed order must open");
    const deliver = () =>
      runWebhook(session, async () => {
        await webhookRequest();
      });
    await deliver();
    await resealBundleOf(session, opened.record);

    await deliver();

    await expectReceiptOnly(session);
  });
});

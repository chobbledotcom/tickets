/** Once a sealed order's session is settled, the order gives way to a receipt
 * with no personal details. A retryable outcome keeps the whole order. A
 * settled session whose receipt was pruned answers as settled, never as a lost
 * order. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { attendeesApi } from "#db/attendees/api.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { execute } from "#db/client.ts";
import { getNoteRows } from "#db/notes/queries.ts";
import { sql } from "#db/sql.ts";
import {
  redirectRequest,
  runWebhook,
  setupWithListing,
  webhookRequest,
} from "#test/integration/webhook-price-signature/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import {
  expectReceiptOnly,
  openBundleOf,
  pruneBundleOf,
  sealedSession,
  stubSessionRead,
} from "#test-utils/sealed-order.ts";

describeWithEnv("a settled sealed checkout order", { db: true }, () => {
  const errors = setupErrorSpy();

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

  test("a booked session whose receipt was pruned answers as settled, with no alarm", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_settled_pruned");
    await runWebhook(session, async () => {
      await webhookRequest();
      await pruneBundleOf(session);
      const replay = await webhookRequest();
      expect(replay.status).toBe(200);
      expect(await replay.json()).toEqual({
        error: "This payment has already been processed.",
        processed: false,
        received: true,
      });
    });

    expect(await getAttendeesRaw(listing.id)).toHaveLength(1);
    expect(await getNoteRows("listing", [listing.id])).toHaveLength(0);
    expect(errors.contains("bundle_missing")).toBe(false);
  });

  test("the ledger shows a session as settled after its payment row is pruned too", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_settled_ledger");
    await runWebhook(session, async () => {
      await webhookRequest();
      await pruneBundleOf(session);
      await execute(
        sql`DELETE FROM processed_payments WHERE payment_session_id = ${session.id}`,
      );
      expect((await webhookRequest()).status).toBe(200);
    });

    expect(await getNoteRows("listing", [listing.id])).toHaveLength(0);
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

  test("the return page for a settled session with no receipt shows the success page", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_settled_return");
    await runWebhook(session, async () => {
      await webhookRequest();
    });
    await pruneBundleOf(session);
    using _retrieve = stubSessionRead(session);

    const page = await redirectRequest(session.id);

    expect(page.status).toBe(200);
    expect(await getNoteRows("listing", [listing.id])).toHaveLength(0);
  });
});

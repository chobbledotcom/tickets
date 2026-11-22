/** The buyer's return and cancel pages for a sealed checkout, and the receipt
 * on a replay. Each answer follows where the session stands, not only whether
 * its order can still be read. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute } from "#db/client.ts";
import { sql } from "#db/sql.ts";
import { handleRequest } from "#routes";
import {
  redirectRequest,
  runWebhook,
  setupWithListing,
  webhookRequest,
} from "#test/integration/webhook-price-signature/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  expectReceiptOnly,
  openBundleOf,
  pruneBundleOf,
  resealBundleOf,
  type SealedSession,
  sealedSession,
  stubSessionRead,
} from "#test-utils/sealed-order.ts";

describeWithEnv("pages for a sealed checkout order", { db: true }, () => {
  const deliver = (session: SealedSession) =>
    runWebhook(session, async () => {
      await webhookRequest();
    });

  const returnPage = async (session: SealedSession) => {
    using _read = stubSessionRead(session);
    const page = await redirectRequest(session.id);
    return { status: page.status, text: await page.text() };
  };

  test("a refunded session whose receipt was pruned shows its refund message, not success", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_return_refunded", 999);
    await deliver(session);
    await pruneBundleOf(session);

    const page = await returnPage(session);

    expect(page.text).not.toContain('data-payment-result="success"');
    expect(page.text).toContain(
      "Your payment has been automatically refunded.",
    );
  });

  test("a booked session whose receipt and payment row are both gone says it was already handled", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_return_ledger");
    await deliver(session);
    await pruneBundleOf(session);
    await execute(
      sql`DELETE FROM processed_payments WHERE payment_session_id = ${session.id}`,
    );

    const page = await returnPage(session);

    expect(page.status).toBe(200);
    expect(page.text).toContain("This payment was already handled.");
  });

  test("the cancel page still answers once the order is pruned, with no retry link", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_cancel_pruned");
    await pruneBundleOf(session);
    using _read = stubSessionRead(session);

    const page = await handleRequest(
      mockRequest(`/payment/cancel?session_id=${session.id}`),
    );

    expect(page.status).toBe(200);
    const text = await page.text();
    expect(text).toContain('data-payment-result="cancel"');
    expect(text).not.toContain(`/ticket/${listing.slug}`);
  });

  test("a replay writes the receipt that the first delivery failed to write", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_replay_receipt");
    const opened = await openBundleOf(session);
    if (opened.status !== "opened") throw new Error("Sealed order must open");
    await deliver(session);
    await resealBundleOf(session, opened.record);

    await deliver(session);

    await expectReceiptOnly(session);
  });
});

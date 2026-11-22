/** A paid sealed checkout whose order is gone: the webhook and the buyer's
 * return page answer from where the session stands. Only a session that is
 * not settled raises the lost-order alarm. The cancel page still answers. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { execute } from "#db/client.ts";
import { getNoteRows } from "#db/notes/queries.ts";
import { sql } from "#db/sql.ts";
import { handleRequest } from "#routes";
import {
  redirectRequest,
  runWebhook,
  setupWithListing,
  webhookRequest,
} from "#test/integration/webhook-price-signature/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
import { mockRequest } from "#test-utils/mocks.ts";
import {
  pruneBundleOf,
  type SealedSession,
  sealedSession,
  stubSessionRead,
} from "#test-utils/sealed-order.ts";

describeWithEnv("a sealed checkout order that is gone", { db: true }, () => {
  const errors = setupErrorSpy();

  const deliver = (session: SealedSession) =>
    runWebhook(session, async () => {
      await webhookRequest();
    });

  const returnPage = async (session: SealedSession) => {
    using _read = stubSessionRead(session);
    const page = await redirectRequest(session.id);
    return { status: page.status, text: await page.text() };
  };

  test("a booked session answers the webhook as settled, with no alarm", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_standing_booked");
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

  test("a booked session shows the success page", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_standing_success");
    await deliver(session);
    await pruneBundleOf(session);

    const page = await returnPage(session);

    expect(page.status).toBe(200);
    expect(page.text).toContain('data-payment-result="success"');
  });

  test("a refunded session shows its refund message, not success", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(
      listing.id,
      "cs_standing_refunded",
      999,
    );
    await deliver(session);
    await pruneBundleOf(session);

    const page = await returnPage(session);

    expect(page.text).not.toContain('data-payment-result="success"');
    expect(page.text).toContain(
      "Your payment has been automatically refunded.",
    );
  });

  test("a session found only in the ledger says it was already handled", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_standing_ledger");
    await deliver(session);
    await pruneBundleOf(session);
    await execute(
      sql`DELETE FROM processed_payments WHERE payment_session_id = ${session.id}`,
    );

    const page = await returnPage(session);

    expect(page.status).toBe(200);
    expect(page.text).toContain("This payment was already handled.");
    expect(await getNoteRows("listing", [listing.id])).toHaveLength(0);
  });

  test("a paid session that is not settled raises the alarm on the return page and refuses retryably", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_standing_lost");
    await pruneBundleOf(session);

    const page = await returnPage(session);

    expect(page.status).toBe(503);
    expect(await getNoteRows("listing", [listing.id])).toHaveLength(1);
  });

  test("the cancel page still answers, with no retry link", async () => {
    const listing = await setupWithListing();
    const session = await sealedSession(listing.id, "cs_standing_cancel");
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
});

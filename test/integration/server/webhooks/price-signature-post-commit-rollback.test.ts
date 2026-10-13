/** A paid create batch that provably rolls back on the signed webhook route:
 *  the recovery releases the session's reservation and the provider's 503
 *  redelivery starts fresh. No booking, no answers, no contact source, no
 *  ledger, no refund, and no sends. */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { allTransfers } from "#accounting/queries.ts";
import { encrypt } from "#crypto/encryption.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { execute, queryOne } from "#db/client.ts";
import {
  runWebhook,
  setupWithListing,
  signedMeta,
  webhookRequest,
} from "#test/integration/webhook-price-signature/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  dropRejectingActivityTrigger,
  installRejectingActivityTrigger,
} from "#test-utils/db-helpers/activity-trigger.ts";
import { createQuestionWithAnswer } from "#test-utils/db-helpers/questions.ts";
import { withEnv } from "#test-utils/env.ts";
import { signMeta, singleItem, webhookMeta } from "#test-utils/factories.ts";
import { stubFetchEachTest } from "#test-utils/fetch-stub.ts";

/** Two webhook deliveries, each answered 503, and no refund issued: the
 *  proven-rollback answer whose redelivery starts fresh. */
const expect503TwiceWithoutRefund = async (session: {
  id: string;
  metadata: Record<string, string>;
  amount_total?: number;
}): Promise<void> => {
  using _env = withEnv({ TEST_EXPECT_ERROR: "1" });
  await runWebhook(session, async (refund) => {
    expect((await webhookRequest()).status).toBe(503);
    expect((await webhookRequest()).status).toBe(503);
    expect(refund.calls.length).toBe(0);
  });
};

describeWithEnv(
  "paid create rollback on the webhook route",
  { db: true },
  () => {
    const fetchSpy = stubFetchEachTest(() => new Response());

    test("a rejecting registration activity write rolls the batch back", async () => {
      const fetchCallsBefore = fetchSpy.calls.length;
      const listing = await setupWithListing();
      await execute(
        "UPDATE listings SET fields = ?, webhook_url = ? WHERE id = ?",
        [
          await encrypt("email"),
          await encrypt("https://registration.example.com/hook"),
          listing.id,
        ],
      );
      // A real answered question rides the batch, so the zero answer-row
      // assertion proves the answers rolled back with the booking.
      const choice = await createQuestionWithAnswer([listing.id]);
      const sessionId = "cs_activity_fault";
      const metadata = signMeta(
        webhookMeta({
          answer_ids: JSON.stringify({ [listing.id]: [choice.answerId] }),
          email: "fault-buyer@example.com",
          items: singleItem(listing.id, 1, 1000),
          name: "Fault Buyer",
          phone: "+447700900123",
        }),
        1000,
      );
      await installRejectingActivityTrigger();
      try {
        await expect503TwiceWithoutRefund({ id: sessionId, metadata });
      } finally {
        await dropRejectingActivityTrigger();
      }
      expect(await getAttendeesRaw(listing.id)).toEqual([]);
      expect(
        (await queryOne<{ count: number }>(
          "SELECT COUNT(*) AS count FROM attendee_answers",
        ))!.count,
      ).toBe(0);
      expect(
        (await queryOne<{ count: number }>(
          "SELECT COUNT(*) AS count FROM contact_preferences",
        ))!.count,
      ).toBe(0);
      expect(await allTransfers()).toEqual([]);
      // No sends left the process for the rolled-back booking.
      expect(fetchSpy.calls.slice(fetchCallsBefore)).toHaveLength(0);
    });

    test("a late finalize failure answers 503 twice and refunds nothing", async () => {
      const listing = await setupWithListing();
      const session = {
        id: "cs_proven_rollback",
        metadata: signedMeta(1000, {
          items: singleItem(listing.id, 1, 1000),
        }),
      };
      await execute(
        `CREATE TRIGGER test_late_payment_finalize_failure
       AFTER UPDATE OF attendee_id ON processed_payments
       WHEN NEW.payment_session_id = '${session.id}'
       BEGIN
         SELECT RAISE(ABORT, 'late payment finalize failure');
       END`,
      );
      try {
        // The batch carries the booking's whole completion, and its finalize
        // abort rolls everything back: no booking, no refund on a guess, and a
        // 503 answer whose redelivery starts fresh and fails the same way.
        await expect503TwiceWithoutRefund(session);
        expect(await getAttendeesRaw(listing.id)).toEqual([]);
      } finally {
        await execute("DROP TRIGGER test_late_payment_finalize_failure");
      }
    });
  },
);

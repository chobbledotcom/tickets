/* jscpd:ignore-start */
import { LibsqlError } from "@libsql/client";
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { spy, stub } from "@std/testing/mock";
import { processPaymentSession } from "#routes/api/payment-processing/index.ts";
import { attendeesApi } from "#shared/db/attendees/api.ts";
import { loadCheckoutStageByPaymentSession } from "#shared/db/checkout-stages.ts";
import { getDb, queryAll } from "#shared/db/client.ts";
import { stripeApi } from "#shared/stripe.ts";
import {
  attendeeIds,
  intentFor,
  paidSession,
  stageSession,
} from "#test/features/api/payment-processing/staged-runtime.helpers.ts";
import { registerStagedRuntimeTests } from "#test/features/api/payment-processing/staged-runtime-cases.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { withVirtualBackoff } from "#test-utils/virtual-time.ts";

/* jscpd:ignore-end */

registerStagedRuntimeTests();

describeWithEnv(
  "payment processing > pre-activation failure",
  { db: true },
  () => {
    test("keeps an exhausted ledger read retryable without refunding", async () => {
      await setupStripe();
      const listing = await createTestListing({ unitPrice: 1000 });
      const intent = intentFor(listing.id);
      const sessionId = "pre-activation-read-failure";
      const attendeeId = await stageSession(sessionId, intent);
      using activate = spy(attendeesApi, "activateStagedAttendee");
      using refund = stub(stripeApi, "refundPayment", () =>
        Promise.resolve({
          id: "must-not-refund",
          status: "succeeded",
        } as never),
      );
      const db = getDb();
      const execute = db.execute.bind(db);
      const outage = new LibsqlError(
        "Server returned HTTP status 503",
        "SERVER_ERROR",
      );
      let failedReads = 0;
      const failLedgerRead = stub(db, "execute", (statement) => {
        if (
          JSON.stringify(statement).includes("FROM transfers WHERE event_group")
        ) {
          failedReads += 1;
          return Promise.reject(outage);
        }
        return execute(statement);
      });

      try {
        await expect(
          withVirtualBackoff(() =>
            processPaymentSession(sessionId, paidSession(sessionId, intent)),
          ),
        ).rejects.toBe(outage);
      } finally {
        failLedgerRead.restore();
      }

      expect(failedReads).toBe(4);
      expect(activate.calls.length).toBe(0);
      expect(refund.calls.length).toBe(0);
      expect(await loadCheckoutStageByPaymentSession(sessionId)).toMatchObject({
        attendeeId,
        state: "pending",
      });
      expect(await attendeeIds()).toEqual([{ id: attendeeId }]);
      expect(
        await queryAll(
          "SELECT payment_session_id FROM processed_payments WHERE payment_session_id = ?",
          [sessionId],
        ),
      ).toEqual([]);

      expect(
        await processPaymentSession(sessionId, paidSession(sessionId, intent)),
      ).toMatchObject({ attendee: { id: attendeeId }, success: true });
      expect(activate.calls.length).toBe(1);
      expect(refund.calls.length).toBe(0);
    });
  },
);

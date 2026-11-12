import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { execute } from "#db/client.ts";
import { stripeApi } from "#shared/stripe.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { withEnv } from "#test-utils/env.ts";
import { setupStripe } from "#test-utils/settings.ts";
import { stubRefundPayment } from "#test-utils/webhooks/stripe.ts";
import {
  checkoutListingId,
  deliver,
  EXPECTED_PLACEHOLDER,
  expectActions,
  expectPlan,
  expectStatuses,
  observedSubscription,
  SESSION_ID,
  storedPlans,
  withRejectedCheckout,
  withUntouchedSubscription,
} from "./subscription-refund-helpers.ts";

describeWithEnv("rejected subscription checkout", { db: true }, () => {
  for (const reason of ["malformed charge", "blank reference"] as const) {
    test(`stores the plan and retries cancellation for a signed ${reason}`, async () => {
      await setupStripe();
      const listingId = await checkoutListingId();
      let canEnd = false;
      using cancel = stub(stripeApi, "cancelSubscription", async (id) => {
        await expectPlan(listingId);
        return canEnd
          ? observedSubscription(id, "canceled")
          : { reason: "rejected_request" as const, status: "invalid" as const };
      });
      using refund = stubRefundPayment("re_rejected_sub", 2000);
      using _env = withEnv({ TEST_EXPECT_ERROR: "1" });
      await withRejectedCheckout(listingId, reason, false, async () => {
        await expectStatuses(deliver, 503);
        expectActions(cancel, refund, 1, 0);
        await expectPlan(listingId);
        canEnd = true;
        await expectStatuses(deliver, 400, 400);
        expectActions(
          cancel,
          refund,
          reason === "blank reference" ? 3 : 2,
          reason === "blank reference" ? 0 : 1,
        );
        await expectPlan(listingId);
      });
    });

    test(`never cancels or refunds another instance's ${reason}`, async () => {
      await withUntouchedSubscription(async (listingId) => {
        await withRejectedCheckout(listingId, reason, true, async () => {
          await expectStatuses(deliver, 400);
          expect(await storedPlans(listingId)).toEqual([]);
        });
      });
    });
  }

  for (const pruned of [false, true]) {
    test(`never cancels a successful booking after a malformed replay (pruned=${pruned})`, async () => {
      await withUntouchedSubscription(async (listingId) => {
        await withRejectedCheckout(
          listingId,
          "malformed charge",
          false,
          async (session) => {
            session.amount_total = 2000;
            await expectStatuses(deliver, 302);
            if (pruned)
              await execute(
                "DELETE FROM processed_payments WHERE payment_session_id = ?",
                [SESSION_ID],
              );
            session.amount_total = null;
            await expectStatuses(deliver, 400);
            await expectPlan(listingId, {
              ...EXPECTED_PLACEHOLDER,
              quantity: 2,
            });
          },
        );
      });
    });
  }
});

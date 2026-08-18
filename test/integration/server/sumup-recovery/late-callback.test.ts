// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import {
  countingQuery,
  expectBookedExactlyOnce,
  makeSumupCheckoutDue,
  stageSignedSumupCheckout,
  sumupRecoveryRow,
  withSumupCheckoutStatus,
} from "#test-utils/sumup.ts";

// jscpd:ignore-end

const CHECKOUT_ID = "co_late";

describeWithEnv("server > SumUp callback after recovery", { db: true }, () => {
  test("a callback arriving after the check books nobody a second time", async () => {
    // The check runs hours after the payment, so a very late callback — a
    // queued retry, or the buyer finally returning to the page — can arrive
    // once the row is already closed. Closed rows refuse every move, so the
    // callback must not be trying to make one.
    const { reference } = await stageSignedSumupCheckout(CHECKOUT_ID);
    await makeSumupCheckoutDue(CHECKOUT_ID);
    const restore = withSumupCheckoutStatus(reference, "PAID", "txn_late");
    try {
      await runSumupRecovery();
      expect((await sumupRecoveryRow(CHECKOUT_ID)).state).toBe("finished");
      expect(await countingQuery("SELECT COUNT(*) AS n FROM attendees")).toBe(
        1,
      );

      const response = await handleRequest(
        mockWebhookRequest({
          event_type: "CHECKOUT_STATUS_CHANGED",
          id: CHECKOUT_ID,
        }),
      );

      // The callback is answered, not refused: the booking it names exists.
      expect(response.status).toBe(200);
      expect((await response.json()).processed).toBe(true);
      await expectBookedExactlyOnce();
      // The callback path raises no recovery event, so a closed row stays
      // closed rather than being asked for a move it refuses.
      expect((await sumupRecoveryRow(CHECKOUT_ID)).state).toBe("finished");
    } finally {
      restore.restore();
    }
  });

  test("the buyer returning to the page after the check sees their booking", async () => {
    const { reference } = await stageSignedSumupCheckout("co_late_return");
    await makeSumupCheckoutDue("co_late_return");
    const restore = withSumupCheckoutStatus(reference, "PAID", "txn_return");
    try {
      await runSumupRecovery();

      const response = await handleRequest(
        new Request(
          `https://example.com/payment/success?session_id=${reference}`,
        ),
      );

      // The success page redirects to the ticket it already has, rather than
      // trying to book it again.
      expect(response.status).toBe(302);
      await expectBookedExactlyOnce();
    } finally {
      restore.restore();
    }
  });
});

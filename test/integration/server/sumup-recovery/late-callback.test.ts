// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { handleRequest } from "#routes";
import { queryAll, queryOne } from "#shared/db/client.ts";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockWebhookRequest } from "#test-utils/mocks.ts";
import {
  makeSumupCheckoutDue,
  stageSignedSumupCheckout,
  withSumupCheckoutStatus,
} from "#test-utils/sumup.ts";

// jscpd:ignore-end

const CHECKOUT_ID = "co_late";

const countOf = async (sql: string): Promise<number> =>
  (await queryAll<{ n: number }>(sql))[0]?.n ?? 0;

const stateOf = async (): Promise<string> => {
  const row = await queryOne<{ recovery_state: string }>(
    "SELECT recovery_state FROM sumup_checkouts WHERE sumup_id = ?",
    [CHECKOUT_ID],
  );
  if (!row) throw new Error("The staged checkout is gone");
  return row.recovery_state;
};

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
      expect(await stateOf()).toBe("finished");
      expect(await countOf("SELECT COUNT(*) AS n FROM attendees")).toBe(1);

      const response = await handleRequest(
        mockWebhookRequest({
          event_type: "CHECKOUT_STATUS_CHANGED",
          id: CHECKOUT_ID,
        }),
      );

      // The callback is answered, not refused: the booking it names exists.
      expect(response.status).toBe(200);
      expect((await response.json()).processed).toBe(true);
      expect(await countOf("SELECT COUNT(*) AS n FROM attendees")).toBe(1);
      expect(
        await countOf("SELECT COUNT(*) AS n FROM processed_payments"),
      ).toBe(1);
      // The callback path raises no recovery event, so a closed row stays
      // closed rather than being asked for a move it refuses.
      expect(await stateOf()).toBe("finished");
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
      expect(await countOf("SELECT COUNT(*) AS n FROM attendees")).toBe(1);
      expect(
        await countOf("SELECT COUNT(*) AS n FROM processed_payments"),
      ).toBe(1);
    } finally {
      restore.restore();
    }
  });
});

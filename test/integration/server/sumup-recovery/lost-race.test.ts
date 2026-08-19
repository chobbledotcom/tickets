// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { execute, queryOne } from "#db/client.ts";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { sumupApi } from "#shared/sumup.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  makeSumupCheckoutDue,
  stageSignedSumupCheckout,
} from "#test-utils/sumup.ts";

// jscpd:ignore-end

const CHECKOUT_ID = "co_beaten";

describeWithEnv("server > SumUp recovery loses a race", { db: true }, () => {
  test("gives up its write when another runner answered first", async () => {
    // Asking SumUp is the slow part, so that is the window another runner
    // lands in. The stub answers the read and, while it is doing so, moves
    // the row on the way a second runner would.
    const { reference } = await stageSignedSumupCheckout(CHECKOUT_ID);
    await makeSumupCheckoutDue(CHECKOUT_ID);
    const restore = stub(sumupApi, "readCheckoutById", async () => {
      await execute(
        "UPDATE sumup_checkouts SET recovery_state = 'unpaid', next_check_at = NULL WHERE sumup_id = ?",
        [CHECKOUT_ID],
      );
      return {
        resource: {
          amountMinor: 1000,
          currency: "GBP",
          reference,
          status: "PENDING" as const,
          transactionId: "",
        },
        status: "found" as const,
      };
    });
    try {
      await runSumupRecovery();

      const row = await queryOne<{
        next_check_at: string | null;
        recovery_state: string;
      }>(
        "SELECT recovery_state, next_check_at FROM sumup_checkouts WHERE sumup_id = ?",
        [CHECKOUT_ID],
      );
      // The winner's answer stands, and the loser did not push the check time
      // back out into the future on top of it.
      expect(row?.recovery_state).toBe("unpaid");
      expect(row?.next_check_at).toBeNull();
    } finally {
      restore.restore();
    }
  });
});

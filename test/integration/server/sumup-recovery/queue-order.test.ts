// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { execute, queryAll } from "#shared/db/client.ts";
import { SUMUP_RECOVERY_BATCH } from "#shared/limits.ts";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { sumupApi } from "#shared/sumup.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  makeSumupCheckoutDue,
  stageSignedSumupCheckout,
} from "#test-utils/sumup.ts";

// jscpd:ignore-end

/** More checkouts than one run can take, so the queue order decides who is
 * seen. All of them are due, oldest first. */
const DUE_COUNT = SUMUP_RECOVERY_BATCH + 2;

const checkedIds = async (): Promise<string[]> =>
  (
    await queryAll<{ sumup_id: string }>(
      "SELECT sumup_id FROM sumup_checkouts WHERE next_check_at > ? ORDER BY sumup_id",
      ["2000-01-02T00:00:00.000Z"],
    )
  ).map((row) => row.sumup_id);

describeWithEnv("server > SumUp recovery queue order", { db: true }, () => {
  test("a checkout that never settles stops holding up the others", async () => {
    // Oldest-first with a fixed batch would let one permanently unanswerable
    // checkout be re-read forever while newer ones are never looked at. Every
    // check moves the row's own next check forward, which puts it behind
    // everything that became due while it was being looked at.
    for (let index = 0; index < DUE_COUNT; index++) {
      const id = `co_queue_${index}`;
      await stageSignedSumupCheckout(id);
      await makeSumupCheckoutDue(id);
      // Stagger them so the order is well defined.
      await execute(
        "UPDATE sumup_checkouts SET next_check_at = ? WHERE sumup_id = ?",
        [`2000-01-01T00:00:0${index}.000Z`, id],
      );
    }
    // SumUp can never answer for any of them, so none of them ever settles.
    const restore = stub(sumupApi, "readCheckoutById", () =>
      Promise.resolve({
        reason: "provider_error" as const,
        status: "unavailable" as const,
      }),
    );
    try {
      await runSumupRecovery();
      const firstRound = await checkedIds();
      expect(firstRound.length).toBe(SUMUP_RECOVERY_BATCH);

      await runSumupRecovery();
      const afterSecond = await checkedIds();

      // The second run reached checkouts the first one never saw.
      expect(afterSecond.length).toBeGreaterThan(firstRound.length);
      expect(afterSecond.length).toBe(DUE_COUNT);
    } finally {
      restore.restore();
    }
  });
});

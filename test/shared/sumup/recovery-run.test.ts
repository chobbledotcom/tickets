/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { SUMUP_RECOVERY_BATCH } from "#shared/limits.ts";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { sumupApi } from "#shared/sumup.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import {
  makeSumupCheckoutDue,
  stageSignedSumupCheckout,
  sumupRecoveryRow,
} from "#test-utils/sumup.ts";

/* jscpd:ignore-end */

/** SumUp is never reachable, so every checkout stays open — this suite is
 * about how a run picks work up, not about what an answer means. */
const withUnreachableSumup = () =>
  stub(sumupApi, "readCheckoutById", () =>
    Promise.resolve({
      reason: "provider_error" as const,
      status: "unavailable" as const,
    }),
  );

const stageDue = async (id: string): Promise<void> => {
  await stageSignedSumupCheckout(id);
  await makeSumupCheckoutDue(id);
};

describeWithEnv("sumup recovery run", { db: true }, () => {
  test("asks about nothing when nothing is due", async () => {
    const read = withUnreachableSumup();
    try {
      expect(await runSumupRecovery()).toBe(false);
      expect(read.calls).toHaveLength(0);
    } finally {
      read.restore();
    }
  });

  test("does not ask to run again after a part-filled batch", async () => {
    // Only a full batch means there may be more waiting behind it.
    await stageDue("co_one");
    const read = withUnreachableSumup();
    try {
      expect(await runSumupRecovery()).toBe(false);
      expect(read.calls).toHaveLength(1);
    } finally {
      read.restore();
    }
  });

  test("asks to run again after a full batch", async () => {
    for (let index = 0; index < SUMUP_RECOVERY_BATCH; index++) {
      await stageDue(`co_full_${index}`);
    }
    const read = withUnreachableSumup();
    try {
      expect(await runSumupRecovery()).toBe(true);
      expect(read.calls).toHaveLength(SUMUP_RECOVERY_BATCH);
    } finally {
      read.restore();
    }
  });

  test("moves every checkout it took, not just the first", async () => {
    await stageDue("co_a");
    await stageDue("co_b");
    const read = withUnreachableSumup();
    try {
      await runSumupRecovery();

      for (const id of ["co_a", "co_b"]) {
        const row = await sumupRecoveryRow(id);
        expect(row.state, id).toBe("waiting");
        expect(Date.parse(row.nextCheckAt ?? ""), id).toBeGreaterThan(
          Date.now(),
        );
      }
    } finally {
      read.restore();
    }
  });
});

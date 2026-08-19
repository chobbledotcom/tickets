/* jscpd:ignore-start -- imports */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { execute } from "#shared/db/client.ts";
import { SUMUP_RECOVERY_BATCH } from "#shared/limits.ts";
import { runSumupRecovery } from "#shared/sumup/recovery-run.ts";
import { sumupApi } from "#shared/sumup.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { debugLogged, useDebugLogSpy } from "#test-utils/debug-log.ts";
import { setupErrorSpy } from "#test-utils/error-spy.ts";
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

const stageDue = async (id: string, when?: string): Promise<void> => {
  await stageSignedSumupCheckout(id);
  await makeSumupCheckoutDue(id, when);
};

describeWithEnv("sumup recovery run", { db: true }, () => {
  const errors = setupErrorSpy();
  const debug = useDebugLogSpy();
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

  test("keeps asking about the rows behind one that keeps failing", async () => {
    // The oldest row blows up on every read: without a catch it stays first
    // in line forever and nothing behind it is ever asked about.
    await stageDue("co_poison", "1999-01-01T00:00:00.000Z");
    await stageDue("co_behind");
    const read = stub(sumupApi, "readCheckoutById", (id: string) =>
      id === "co_poison"
        ? Promise.reject(new Error("the read blew up"))
        : Promise.resolve({
            reason: "provider_error" as const,
            status: "unavailable" as const,
          }),
    );
    try {
      await runSumupRecovery();

      const poison = await sumupRecoveryRow("co_poison");
      expect(poison.state).toBe("waiting");
      expect(Date.parse(poison.nextCheckAt ?? "")).toBeGreaterThan(Date.now());
      const behind = await sumupRecoveryRow("co_behind");
      expect(behind.state).toBe("waiting");
      expect(Date.parse(behind.nextCheckAt ?? "")).toBeGreaterThan(Date.now());
      expect(errors.contains("co_poison")).toBe(true);
    } finally {
      read.restore();
    }
  });

  test("lets another runner's answer stand when it wins the row", async () => {
    await stageDue("co_race");
    const read = stub(sumupApi, "readCheckoutById", async () => {
      // Another runner answers the row while this one is out asking.
      await execute(
        "UPDATE sumup_checkouts SET next_check_at = ? WHERE sumup_id = ?",
        ["2999-01-01T00:00:00.000Z", "co_race"],
      );
      return {
        reason: "provider_error" as const,
        status: "unavailable" as const,
      };
    });
    try {
      await runSumupRecovery();

      // Our write found the row changed, so the winner's check time stands.
      expect(await sumupRecoveryRow("co_race")).toEqual({
        nextCheckAt: "2999-01-01T00:00:00.000Z",
        state: "waiting",
      });
      expect(debugLogged(debug, "beaten")).toBe(true);
    } finally {
      read.restore();
    }
  });
});

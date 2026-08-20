// jscpd:ignore-start
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { execute, queryAll } from "#db/client.ts";
import { runDatabasePruning } from "#db/prune.ts";
import {
  RECOVERY_NODES,
  type RecoveryNodeId,
} from "#payment/sumup-recovery-machine-spec.ts";
import { PRUNE_SUMUP_RETENTION_MS } from "#shared/limits.ts";
import { isoBefore } from "#shared/now.ts";
import { describeWithEnv } from "#test-utils/db.ts";

// jscpd:ignore-end

describeWithEnv("server > SumUp recovery pruning", { db: true }, () => {
  /** An ancient row in each state, well past the retention window. */
  const seedOldRows = async (): Promise<void> => {
    const old = isoBefore(PRUNE_SUMUP_RETENTION_MS + 60_000);
    for (const node of RECOVERY_NODES) {
      await execute(
        `INSERT INTO sumup_checkouts
           (reference_index, wrapped_key, metadata, sumup_id, created_at,
            recovery_state, next_check_at)
         VALUES (?, '', '', ?, ?, ?, NULL)`,
        [
          `idx_${node.id}`,
          node.id === "staged" ? "" : `co_${node.id}`,
          old,
          node.id,
        ],
      );
    }
  };

  const survivingStates = async (): Promise<RecoveryNodeId[]> =>
    (
      await queryAll<{ recovery_state: RecoveryNodeId }>(
        "SELECT recovery_state FROM sumup_checkouts ORDER BY recovery_state",
      )
    ).map((row) => row.recovery_state);

  test("keeps every old row that may still be holding money", async () => {
    await seedOldRows();

    await runDatabasePruning(null);

    // Derived from the machine, so a node that stops being deletable is
    // covered here without this test being touched.
    const kept = RECOVERY_NODES.filter((node) => !node.prunable)
      .map((node) => node.id)
      .sort();
    expect(await survivingStates()).toEqual(kept);
    expect(kept).toEqual(["owed", "waiting"]);
  });

  test("still deletes an old row that reached a definitive answer", async () => {
    await seedOldRows();

    await runDatabasePruning(null);

    const survivors = await survivingStates();
    for (const node of RECOVERY_NODES.filter((one) => one.prunable)) {
      expect(survivors, `${node.id} should have gone`).not.toContain(node.id);
    }
  });

  test("keeps an owed row however old it gets", async () => {
    // Age alone never deletes a row that may owe somebody a booking, so
    // pruning it twice more must still leave it there.
    await seedOldRows();

    await runDatabasePruning(null);
    await runDatabasePruning(null);
    await runDatabasePruning(null);

    expect(await survivingStates()).toContain("owed");
  });
});

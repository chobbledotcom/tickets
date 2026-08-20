import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import sumupRecoveryMigration from "#db/migrations/2026-08-18_sumup_recovery_state.ts";
import { applySchemaChanges, syncIndexes } from "#db/migrations/schema-sync.ts";
import {
  recoveryNodeOf,
  type SumupRecoveryState,
} from "#payment/sumup-recovery-machine-spec.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const context = buildMigrationContext({ applySchemaChanges, syncIndexes });
const runMigration = (): Promise<void> => sumupRecoveryMigration(context).up();

/** A row as an older release would have left it: no state, no check time. */
const insertLegacyRow = (index: string, sumupId: string) =>
  getDb().execute({
    args: [index, sumupId],
    sql: `INSERT INTO sumup_checkouts
            (reference_index, wrapped_key, metadata, sumup_id, created_at)
          VALUES (?, '', '', ?, '2026-08-01T00:00:00.000Z')`,
  });

const storedRow = async (index: string) => {
  const result = await getDb().execute({
    args: [index],
    sql: "SELECT sumup_id, recovery_state, next_check_at FROM sumup_checkouts WHERE reference_index = ?",
  });
  const row = result.rows[0]!;
  return {
    nextCheckAt: row.next_check_at as string | null,
    recoveryState: row.recovery_state as SumupRecoveryState,
    sumupId: String(row.sumup_id),
  };
};

describeWithEnv("db > migrations > sumup recovery state", { db: true }, () => {
  test("declares its identity, columns, and index", () => {
    const migration = sumupRecoveryMigration(context);
    expect({ id: migration.id, requires: migration.requires }).toEqual({
      id: "2026-08-18_sumup_recovery_state",
      requires: {
        columns: { sumup_checkouts: ["next_check_at", "recovery_state"] },
        indexes: ["idx_sumup_checkouts_next_check"],
      },
    });
  });

  test("leaves a row that never got a checkout id as staged", async () => {
    await insertLegacyRow("idx_no_id", "");

    await runMigration();

    const row = await storedRow("idx_no_id");
    expect(row.recoveryState).toBe("staged");
    // Nothing to ask SumUp about, so nothing is scheduled.
    expect(row.nextCheckAt).toBeNull();
  });

  test("puts a live checkout in the queue, due straight away", async () => {
    // This is the backlog the feature exists to work through: rows that were
    // already staged when the site upgraded and were never asked about.
    await insertLegacyRow("idx_live", "co_upgraded");

    const before = Date.now();
    await runMigration();
    const after = Date.now();

    const row = await storedRow("idx_live");
    expect(row.recoveryState).toBe("waiting");
    // Due the moment the upgrade lands, not at some later hour: nothing
    // re-stages the backlog, so a delayed start would skip it entirely.
    const dueAt = Date.parse(row.nextCheckAt!);
    expect(dueAt).toBeGreaterThanOrEqual(before);
    expect(dueAt).toBeLessThanOrEqual(after);
  });

  test("derives a state the row reader accepts for every row", async () => {
    await insertLegacyRow("idx_a", "");
    await insertLegacyRow("idx_b", "co_b");

    await runMigration();

    for (const index of ["idx_a", "idx_b"]) {
      const row = await storedRow(index);
      // Totality is the point: the reader refuses a state word and a checkout
      // id that disagree, so a wrong derivation is loud rather than stored.
      expect(
        recoveryNodeOf({
          recoveryState: row.recoveryState,
          sumupId: row.sumupId,
        }),
        index,
      ).toBe(row.recoveryState);
    }
  });

  test("does not reopen a row a check has already answered", async () => {
    // A verify retry can re-run the migration. It must not drag a finished
    // row back into the queue.
    await insertLegacyRow("idx_done", "co_done");
    await runMigration();
    await getDb().execute(
      "UPDATE sumup_checkouts SET recovery_state = 'finished', next_check_at = NULL WHERE reference_index = 'idx_done'",
    );

    await runMigration();

    const row = await storedRow("idx_done");
    expect(row.recoveryState).toBe("finished");
    expect(row.nextCheckAt).toBeNull();
  });
});

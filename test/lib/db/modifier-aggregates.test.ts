import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { MIGRATIONS } from "#shared/db/migrations.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { describeWithEnv } from "#test-utils";

/**
 * The modifiers aggregate columns (total_uses, usage_count, total_revenue) are
 * maintained by triggers on modifier_usages. These tests drive the triggers
 * directly with raw INSERT/UPDATE/DELETE so the trigger SQL itself is the unit
 * under test — including the branches the higher-level booking flows don't hit:
 * moving a row between modifiers, and leaving the columns untouched when an
 * unrelated column changes.
 */
describeWithEnv(
  "db > modifiers aggregate triggers",
  {
    db: true,
    triggers: true,
  },
  () => {
    type Aggregates = {
      total_uses: number;
      usage_count: number;
      total_revenue: number;
    };

    const makeModifier = () =>
      modifiersTable.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Add-on",
      });

    const aggregates = async (modifierId: number): Promise<Aggregates> => {
      const result = await getDb().execute({
        args: [modifierId],
        sql: "SELECT total_uses, usage_count, total_revenue FROM modifiers WHERE id = ?",
      });
      const row = result.rows[0]!;
      return {
        total_revenue: Number(row.total_revenue),
        total_uses: Number(row.total_uses),
        usage_count: Number(row.usage_count),
      };
    };

    const insertUsage = (
      modifierId: number,
      attendeeId: number,
      quantity: number,
      amountApplied: number,
    ): Promise<unknown> =>
      getDb().execute({
        args: [modifierId, attendeeId, quantity, amountApplied, "2026-06-17"],
        sql: "INSERT INTO modifier_usages (modifier_id, attendee_id, quantity, amount_applied, created) VALUES (?, ?, ?, ?, ?)",
      });

    test("a new modifier starts with zeroed aggregates", async () => {
      const m = await makeModifier();
      expect(await aggregates(m.id)).toEqual({
        total_revenue: 0,
        total_uses: 0,
        usage_count: 0,
      });
    });

    test("modifiersTable read exposes the trigger-maintained aggregates", async () => {
      const m = await makeModifier();
      await insertUsage(m.id, 1, 3, 1500);
      const reread = await modifiersTable.findById(m.id);
      expect(reread).toMatchObject({
        total_revenue: 1500,
        total_uses: 3,
        usage_count: 1,
      });
    });

    test("insert increments uses, usage count and revenue", async () => {
      const m = await makeModifier();
      await insertUsage(m.id, 1, 3, 1500);
      await insertUsage(m.id, 2, 2, 1000);
      expect(await aggregates(m.id)).toEqual({
        total_revenue: 2500,
        total_uses: 5,
        usage_count: 2,
      });
    });

    test("delete decrements the row's contribution", async () => {
      const m = await makeModifier();
      await insertUsage(m.id, 1, 3, 1500);
      await insertUsage(m.id, 2, 2, 1000);
      await getDb().execute({
        args: [m.id, 1],
        sql: "DELETE FROM modifier_usages WHERE modifier_id = ? AND attendee_id = ?",
      });
      expect(await aggregates(m.id)).toEqual({
        total_revenue: 1000,
        total_uses: 2,
        usage_count: 1,
      });
    });

    test("updating quantity and amount_applied applies the delta", async () => {
      const m = await makeModifier();
      await insertUsage(m.id, 1, 3, 1500);
      await getDb().execute({
        args: [m.id, 1],
        sql: "UPDATE modifier_usages SET quantity = 5, amount_applied = 4000 WHERE modifier_id = ? AND attendee_id = ?",
      });
      expect(await aggregates(m.id)).toEqual({
        total_revenue: 4000,
        total_uses: 5,
        usage_count: 1,
      });
    });

    test("moving a row to another modifier shifts its aggregates", async () => {
      const from = await makeModifier();
      const to = await makeModifier();
      await insertUsage(from.id, 1, 4, 2000);

      await getDb().execute({
        args: [to.id, from.id, 1],
        sql: "UPDATE modifier_usages SET modifier_id = ? WHERE modifier_id = ? AND attendee_id = ?",
      });

      expect(await aggregates(from.id)).toEqual({
        total_revenue: 0,
        total_uses: 0,
        usage_count: 0,
      });
      expect(await aggregates(to.id)).toEqual({
        total_revenue: 2000,
        total_uses: 4,
        usage_count: 1,
      });
    });

    test("updating an unrelated column leaves aggregates unchanged", async () => {
      const m = await makeModifier();
      await insertUsage(m.id, 1, 3, 1500);
      const before = await aggregates(m.id);

      // created is not in the trigger's UPDATE OF list, so this must not fire.
      await getDb().execute({
        args: [m.id, 1],
        sql: "UPDATE modifier_usages SET created = '2099-01-01' WHERE modifier_id = ? AND attendee_id = ?",
      });

      expect(await aggregates(m.id)).toEqual(before);
    });

    test("the migration's backfill recomputes stale aggregates from scratch", async () => {
      const m = await makeModifier();
      await insertUsage(m.id, 1, 3, 1500);
      await insertUsage(m.id, 2, 2, 1000);

      // Reproduce a pre-trigger state: drop the triggers, then corrupt the
      // columns directly (no trigger fires to correct them).
      const migration = MIGRATIONS.find(
        (mig) => mig.id === "2026-06-17_modifier_aggregates",
      )!;
      await getDb().batch(
        [
          "DROP TRIGGER IF EXISTS trg_modifier_usages_aggregates_insert",
          "DROP TRIGGER IF EXISTS trg_modifier_usages_aggregates_delete",
          "DROP TRIGGER IF EXISTS trg_modifier_usages_aggregates_update",
        ],
        "write",
      );
      await getDb().execute(
        "UPDATE modifiers SET total_uses = 999, usage_count = 999, total_revenue = 999",
      );

      // Re-running up() recreates the triggers and recomputes the absolute totals.
      await migration.up();

      expect(await aggregates(m.id)).toEqual({
        total_revenue: 2500,
        total_uses: 5,
        usage_count: 2,
      });
    });
  },
);

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { MIGRATIONS } from "#shared/db/migrations.ts";
import {
  adjustModifierRevenue,
  getActiveModifiers,
  getAllModifiers,
  getModifierAggregateRecalculation,
  modifiersTable,
  resetModifierAggregateFields,
  updateModifierAggregateValues,
} from "#shared/db/modifiers.ts";
import { describeWithEnv, insertModifierUsage } from "#test-utils";
import { postModifierLeg } from "#test-utils/ledger.ts";

/**
 * The modifiers count columns (total_uses, usage_count) are maintained by
 * triggers on modifier_usages. These tests drive the triggers directly with raw
 * INSERT/UPDATE/DELETE so the trigger SQL itself is the unit under test —
 * including the branches the higher-level booking flows don't hit: moving a row
 * between modifiers, and leaving the columns untouched when an unrelated column
 * changes.
 *
 * total_revenue is no longer a trigger-maintained column: it is projected from
 * the transfers ledger as balanceOf(modifier:M) (the modifier account's net
 * effect on revenue) at read time, so it is exercised separately via posted
 * modifier ledger legs rather than via amount_applied.
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
        sql: "SELECT total_uses, usage_count FROM modifiers WHERE id = ?",
      });
      const row = result.rows[0]!;
      return {
        total_uses: Number(row.total_uses),
        usage_count: Number(row.usage_count),
      };
    };

    /** total_revenue as the table read projects it (from the ledger). */
    const projectedRevenue = async (modifierId: number): Promise<number> =>
      (await getAllModifiers()).find((m) => m.id === modifierId)!.total_revenue;

    test("a new modifier starts with zeroed aggregates", async () => {
      const m = await makeModifier();
      expect(await aggregates(m.id)).toEqual({
        total_uses: 0,
        usage_count: 0,
      });
    });

    test("modifiersTable read exposes the trigger-maintained counts", async () => {
      const m = await makeModifier();
      await insertModifierUsage(m.id, 1, 3, 1500);
      const reread = await modifiersTable.findById(m.id);
      expect(reread).toMatchObject({
        total_uses: 3,
        usage_count: 1,
      });
    });

    test("insert increments uses and usage count", async () => {
      const m = await makeModifier();
      await insertModifierUsage(m.id, 1, 3, 1500);
      await insertModifierUsage(m.id, 2, 2, 1000);
      expect(await aggregates(m.id)).toEqual({
        total_uses: 5,
        usage_count: 2,
      });
    });

    test("delete decrements the row's contribution", async () => {
      const m = await makeModifier();
      await insertModifierUsage(m.id, 1, 3, 1500);
      await insertModifierUsage(m.id, 2, 2, 1000);
      await getDb().execute({
        args: [m.id, 1],
        sql: "DELETE FROM modifier_usages WHERE modifier_id = ? AND attendee_id = ?",
      });
      expect(await aggregates(m.id)).toEqual({
        total_uses: 2,
        usage_count: 1,
      });
    });

    test("updating quantity applies the delta", async () => {
      const m = await makeModifier();
      await insertModifierUsage(m.id, 1, 3, 1500);
      await getDb().execute({
        args: [m.id, 1],
        sql: "UPDATE modifier_usages SET quantity = 5 WHERE modifier_id = ? AND attendee_id = ?",
      });
      expect(await aggregates(m.id)).toEqual({
        total_uses: 5,
        usage_count: 1,
      });
    });

    test("moving a row to another modifier shifts its aggregates", async () => {
      const from = await makeModifier();
      const to = await makeModifier();
      await insertModifierUsage(from.id, 1, 4, 2000);

      await getDb().execute({
        args: [to.id, from.id, 1],
        sql: "UPDATE modifier_usages SET modifier_id = ? WHERE modifier_id = ? AND attendee_id = ?",
      });

      expect(await aggregates(from.id)).toEqual({
        total_uses: 0,
        usage_count: 0,
      });
      expect(await aggregates(to.id)).toEqual({
        total_uses: 4,
        usage_count: 1,
      });
    });

    test("updating an unrelated column leaves aggregates unchanged", async () => {
      const m = await makeModifier();
      await insertModifierUsage(m.id, 1, 3, 1500);
      const before = await aggregates(m.id);

      // amount_applied is no longer in the trigger's UPDATE OF list (it drives
      // no maintained aggregate now), so changing it must not fire the trigger.
      await getDb().execute({
        args: [m.id, 1],
        sql: "UPDATE modifier_usages SET amount_applied = 9999 WHERE modifier_id = ? AND attendee_id = ?",
      });

      expect(await aggregates(m.id)).toEqual(before);
    });

    test("total_revenue is projected from the modifier's net ledger balance", async () => {
      const m = await makeModifier();
      // A usage row with no posted modifier legs contributes nothing to revenue.
      await insertModifierUsage(m.id, 1, 1, 1500);
      expect(await projectedRevenue(m.id)).toBe(0);

      // A surcharge bills the attendee (attendee→modifier), so balanceOf(modifier)
      // rises by the delta — exactly what the projection reads, never negated.
      await postModifierLeg({ delta: 1500, modifierId: m.id });
      expect(await projectedRevenue(m.id)).toBe(1500);
    });

    test("a discount nets the modifier's projected revenue down", async () => {
      const m = await makeModifier();
      // A surcharge then a larger discount: the modifier's net effect is
      // negative (it funded the attendee more than it billed them).
      await postModifierLeg({ attendeeId: 1, delta: 500, modifierId: m.id });
      await postModifierLeg({ attendeeId: 2, delta: -800, modifierId: m.id });
      expect(await projectedRevenue(m.id)).toBe(-300);
    });

    test("getActiveModifiers projects total_revenue for active modifiers", async () => {
      const m = await makeModifier();
      await postModifierLeg({ delta: 2500, modifierId: m.id });
      const active = await getActiveModifiers();
      expect(active.find((row) => row.id === m.id)?.total_revenue).toBe(2500);
    });

    test("raising revenue via the correction path moves the projection up by the delta", async () => {
      const m = await makeModifier();
      await postModifierLeg({ delta: 1000, modifierId: m.id });
      expect(await projectedRevenue(m.id)).toBe(1000);

      // Correcting revenue up credits the modifier account (writeoff→modifier),
      // so balanceOf(modifier) — what the projection reads — rises by the delta
      // (recomputed from the live 1000 projection inside the write transaction).
      await adjustModifierRevenue(m.id, 1750);
      expect(await projectedRevenue(m.id)).toBe(1750);
    });

    test("lowering revenue via the correction path moves the projection down by the delta", async () => {
      const m = await makeModifier();
      await postModifierLeg({ delta: 3000, modifierId: m.id });
      expect(await projectedRevenue(m.id)).toBe(3000);

      // Correcting revenue down debits the modifier account (modifier→writeoff).
      await adjustModifierRevenue(m.id, 1200);
      expect(await projectedRevenue(m.id)).toBe(1200);
    });

    test("a correction can drive the modifier's net revenue negative", async () => {
      // total_revenue is signed (a net discount is legitimately negative), so a
      // correction below zero is allowed and the projection follows it.
      const m = await makeModifier();
      await adjustModifierRevenue(m.id, -500);
      expect(await projectedRevenue(m.id)).toBe(-500);
    });

    test("manual aggregate edits override the trigger-maintained counts", async () => {
      const m = await makeModifier();
      await insertModifierUsage(m.id, 1, 3, 1500);

      await updateModifierAggregateValues(m.id, {
        total_uses: 8,
        usage_count: 4,
      });

      expect(await aggregates(m.id)).toEqual({
        total_uses: 8,
        usage_count: 4,
      });
    });

    test("selected aggregate reset fields are rebuilt from usage rows", async () => {
      const m = await makeModifier();
      await insertModifierUsage(m.id, 1, 3, 1500);
      await insertModifierUsage(m.id, 2, 2, 1000);
      await updateModifierAggregateValues(m.id, {
        total_uses: 8,
        usage_count: 4,
      });

      const stale = (await modifiersTable.findById(m.id))!;
      expect(await getModifierAggregateRecalculation(stale)).toEqual({
        total_uses: { current: 8, recalculated: 5 },
        usage_count: { current: 4, recalculated: 2 },
      });

      await resetModifierAggregateFields(m.id, ["total_uses"]);

      expect(await aggregates(m.id)).toEqual({
        total_uses: 5,
        usage_count: 4,
      });
    });

    test("the migration's backfill recomputes stale aggregates from scratch", async () => {
      const m = await makeModifier();
      await insertModifierUsage(m.id, 1, 3, 1500);
      await insertModifierUsage(m.id, 2, 2, 1000);

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
        "UPDATE modifiers SET total_uses = 999, usage_count = 999",
      );

      // Re-running up() recreates the triggers and recomputes the absolute totals.
      await migration.up();

      expect(await aggregates(m.id)).toEqual({
        total_uses: 5,
        usage_count: 2,
      });
    });
  },
);

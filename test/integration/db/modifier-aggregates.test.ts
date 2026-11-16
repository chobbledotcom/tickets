import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import { loadMigrations } from "#db/migrations/context.ts";
import {
  adjustModifierRevenue,
  getActiveModifiers,
  getAllModifiers,
  getModifier,
  getModifierAggregateRecalculation,
  MODIFIER_AGGREGATE_FIELDS,
  modifierAggregates,
} from "#db/modifiers.ts";
import { records } from "#db/record-table.ts";
import { sql } from "#db/sql.ts";
import {
  type AggregateRows,
  describeAggregateTriggerCases,
  seedAggregateRows,
  sharedAggregateTriggerCases,
} from "#test-utils/db/aggregate-trigger-cases.ts";
import { readModifierAggregates as aggregates } from "#test-utils/db/migration-test-helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { postModifierLeg } from "#test-utils/ledger.ts";

const MIGRATIONS = await loadMigrations();
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
    /** modifier_usages declares no default for this pair; no count reads it. */
    const usageRows: AggregateRows = {
      parent: "modifier_id",
      table: "modifier_usages",
      values: { amount_applied: 0, created: "2026-06-17" },
    };
    const makeModifier = () =>
      records.modifiers.insert({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Add-on",
      });
    const shared = sharedAggregateTriggerCases({
      counts: (quantity, rows) => ({
        total_uses: quantity,
        usage_count: rows,
      }),
      insert: "insert increments uses and usage count",
      parent: "modifier",
      // amount_applied drives no aggregate, so the UPDATE trigger omits it.
      unrelatedColumn: "amount_applied",
    });
    const triggerFixture = {
      createParent: makeModifier,
      readCounts: aggregates,
      rows: usageRows,
    };

    /** total_revenue as the table read projects it (from the ledger). */
    const projectedRevenue = async (modifierId: number): Promise<number> =>
      (await getAllModifiers()).find((m) => m.id === modifierId)!.total_revenue;

    test("a bare create fills the behavioural defaults", async () => {
      // The base create form supplies only the pricing rule; the schema's
      // defaults must make the modifier an active, automatic, whole-order rule
      // with no gates — exactly what the admin docs promise a fresh modifier is.
      const m = await makeModifier();
      const stored = (await records.modifiers.find(m.id))!;
      expect(stored).toMatchObject({
        active: true,
        code_index: null,
        min_subtotal: 0,
        min_visits: 0,
        scope: "all",
        stock: null,
        trigger: "automatic",
      });
    });

    test("getModifier reads one modifier with its projected revenue", async () => {
      const m = await makeModifier();
      await postModifierLeg({ delta: 1200, modifierId: m.id });
      const read = await getModifier(m.id);
      expect(read).toMatchObject({
        id: m.id,
        name: "Add-on",
        total_revenue: 1200,
      });
      // A missing id reads back as null, never a phantom row.
      expect(await getModifier(m.id + 999)).toBeNull();
    });

    test("modifiersTable read exposes the trigger-maintained counts", async () => {
      const m = await makeModifier();
      await seedAggregateRows(usageRows, m.id, [[1, 3]]);
      const reread = await records.modifiers.find(m.id);
      expect(reread).toMatchObject({
        total_uses: 3,
        usage_count: 1,
      });
    });

    describeAggregateTriggerCases(triggerFixture, [
      shared.zeroStart,
      shared.insert,
      shared.delete,
      shared.updateQuantity,
      shared.moveToOtherParent,
      shared.unrelatedColumn,
    ]);

    test("resetting every published aggregate field rebuilds both counts", async () => {
      // Drives the reset through MODIFIER_AGGREGATE_FIELDS itself — the list the
      // admin recalculate form submits — so a renamed/dropped field there breaks
      // here, not silently on the form.
      const m = await makeModifier();
      await seedAggregateRows(usageRows, m.id, [[1, 3]]);
      await modifierAggregates.update(m.id, {
        totalUses: 9,
        usageCount: 9,
      });

      await modifierAggregates.reset(m.id, [...MODIFIER_AGGREGATE_FIELDS]);

      expect(await aggregates(m.id)).toEqual({
        total_uses: 3,
        usage_count: 1,
      });
    });

    test("total_revenue is projected from the modifier's net ledger balance", async () => {
      const m = await makeModifier();
      // A usage row with no posted modifier legs contributes nothing to revenue.
      await seedAggregateRows(usageRows, m.id, [[1, 1]]);
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
      await seedAggregateRows(usageRows, m.id, [[1, 3]]);

      await modifierAggregates.update(m.id, {
        totalUses: 8,
        usageCount: 4,
      });

      expect(await aggregates(m.id)).toEqual({
        total_uses: 8,
        usage_count: 4,
      });
    });

    test("selected aggregate reset fields are rebuilt from usage rows", async () => {
      const m = await makeModifier();
      await seedAggregateRows(usageRows, m.id, [
        [1, 3],
        [2, 2],
      ]);
      await modifierAggregates.update(m.id, {
        totalUses: 8,
        usageCount: 4,
      });

      const stale = (await records.modifiers.find(m.id))!;
      expect(await getModifierAggregateRecalculation(stale)).toEqual({
        total_uses: { current: 8, recalculated: 5 },
        usage_count: { current: 4, recalculated: 2 },
      });

      await modifierAggregates.reset(m.id, ["totalUses"]);

      expect(await aggregates(m.id)).toEqual({
        total_uses: 5,
        usage_count: 4,
      });
    });

    test("the migration's backfill recomputes stale aggregates from scratch", async () => {
      const m = await makeModifier();
      await seedAggregateRows(usageRows, m.id, [
        [1, 3],
        [2, 2],
      ]);

      // Reproduce a pre-trigger state: drop the triggers, then corrupt the
      // columns directly (no trigger fires to correct them).
      const migration = MIGRATIONS.find(
        (mig) => mig.id === "2026-06-17_modifier_aggregates",
      )!;
      await getDb().batch(
        [
          sql`DROP TRIGGER IF EXISTS trg_modifier_usages_aggregates_insert`,
          sql`DROP TRIGGER IF EXISTS trg_modifier_usages_aggregates_delete`,
          sql`DROP TRIGGER IF EXISTS trg_modifier_usages_aggregates_update`,
        ],
        "write",
      );
      await getDb().execute(
        sql`UPDATE modifiers SET total_uses = 999, usage_count = 999`,
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

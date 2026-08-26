import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#db/client.ts";
import {
  adjustModifierRevenue,
  getActiveModifiers,
  getAllModifiers,
  getModifier,
  getModifierGroupListingIdsByModifierId,
  getModifierNamesByIds,
  MODIFIER_AGGREGATE_FIELDS,
  modifiersTable,
  resetModifierAggregateFields,
  updateModifierAggregateValues,
} from "#db/modifiers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { insertModifier, insertModifierUsage } from "#test-utils/modifiers.ts";

describeWithEnv("db modifiers table", { db: true }, () => {
  describe("modifiersTable", () => {
    test("applies the stored defaults to a bare insert", async () => {
      const row = await insertModifier({ name: "Defaults" });
      const stored = await getModifier(row.id);
      expect(stored?.active).toBe(true);
      expect(stored?.min_subtotal).toBe(0);
      expect(stored?.min_visits).toBe(0);
      expect(stored?.max_per_order).toBeNull();
      expect(stored?.scope).toBe("all");
      expect(stored?.trigger).toBe("automatic");
    });

    test("update writes behavioural columns", async () => {
      const row = await insertModifier({ name: "Capped" });
      await modifiersTable.update(row.id, {
        maxPerOrder: 1,
        trigger: "answer",
      });
      expect((await getModifier(row.id))?.max_per_order).toBe(1);
    });
  });

  describe("loaders", () => {
    test("getModifier reads one decrypted modifier by id", async () => {
      const row = await insertModifier({ name: "Solo" });
      expect((await getModifier(row.id))?.name).toBe("Solo");
      expect(await getModifier(row.id + 999)).toBeNull();
    });

    test("getAllModifiers returns every modifier, oldest first", async () => {
      const first = await insertModifier({ name: "First" });
      const second = await insertModifier({ name: "Second" });
      const names = (await getAllModifiers()).map((m) => m.name);
      expect(names.indexOf("First")).toBeLessThan(names.indexOf("Second"));
      expect(await getModifier(first.id)).not.toBeNull();
      expect(await getModifier(second.id)).not.toBeNull();
    });

    test("getActiveModifiers returns only the active ones", async () => {
      const active = await insertModifier({ name: "Live" });
      const inactive = await insertModifier({ name: "Off" });
      await modifiersTable.update(inactive.id, { active: false });

      const names = (await getActiveModifiers()).map((m) => m.name);
      expect(names).toContain("Live");
      expect(names).not.toContain("Off");
      expect(await getModifier(active.id)).not.toBeNull();
    });

    test("getModifierNamesByIds maps ids to decrypted names", async () => {
      const row = await insertModifier({ name: "Named" });
      expect(await getModifierNamesByIds([row.id])).toEqual(
        new Map([[row.id, "Named"]]),
      );
    });

    test("group scopes resolve through each group's listings", async () => {
      const row = await insertModifier({ name: "Scoped" });
      await getDb().execute({
        args: [row.id, 42],
        sql: "INSERT INTO modifier_groups (modifier_id, group_id) VALUES (?, ?)",
      });
      await getDb().execute({
        args: [42, 7],
        sql: "INSERT INTO group_listings (group_id, listing_id) VALUES (?, ?)",
      });

      expect(await getModifierGroupListingIdsByModifierId([row.id])).toEqual(
        new Map([[row.id, [7]]]),
      );
    });
  });

  describe("aggregates", () => {
    test("manual aggregate writes persist", async () => {
      const row = await insertModifier({ name: "Counted" });
      await updateModifierAggregateValues(row.id, {
        total_uses: 9,
        usage_count: 4,
      });
      const stored = await getModifier(row.id);
      expect(stored?.total_uses).toBe(9);
      expect(stored?.usage_count).toBe(4);
    });

    test("resetting the aggregates recalculates them from usage rows", async () => {
      const row = await insertModifier({ name: "Recounted" });
      await insertModifierUsage(row.id, 1, 3, 150);
      await insertModifierUsage(row.id, 2, 2, 100);
      await updateModifierAggregateValues(row.id, {
        total_uses: 99,
        usage_count: 99,
      });

      await resetModifierAggregateFields(row.id, [
        ...MODIFIER_AGGREGATE_FIELDS,
      ]);
      const stored = await getModifier(row.id);
      expect(stored?.total_uses).toBe(5);
      expect(stored?.usage_count).toBe(2);
    });

    test("adjustModifierRevenue moves the projected total to the target", async () => {
      const row = await insertModifier({ name: "Earner" });
      expect((await getModifier(row.id))?.total_revenue).toBe(0);

      await adjustModifierRevenue(row.id, 1750);
      expect((await getModifier(row.id))?.total_revenue).toBe(1750);

      // Re-adjusting to the same target is a no-op, and lowering moves it down.
      await adjustModifierRevenue(row.id, 1750);
      await adjustModifierRevenue(row.id, 1200);
      expect((await getModifier(row.id))?.total_revenue).toBe(1200);
    });
  });
});

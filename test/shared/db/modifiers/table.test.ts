import { assert, assertArrayIncludes } from "@std/assert";
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
  modifierAggregates,
} from "#db/modifiers.ts";
import { records } from "#db/record-table.ts";
import { sql } from "#db/sql.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { insertModifierWithUsages } from "#test-utils/db-helpers/modifier-usages.ts";
import { insertModifier } from "#test-utils/modifiers.ts";

describeWithEnv("db modifiers table", { db: true }, () => {
  describe("modifiersTable", () => {
    test("applies the stored defaults to a bare insert", async () => {
      const row = await insertModifier({ name: "Defaults" });
      const stored = await getModifier(row.id);
      expect(stored?.active).toBe(true);
      expect(stored?.minSubtotal).toBe(0);
      expect(stored?.minVisits).toBe(0);
      expect(stored?.maxPerOrder).toBeNull();
      expect(stored?.scope).toBe("all");
      expect(stored?.trigger).toBe("automatic");
    });

    test("update writes behavioural columns", async () => {
      const row = await insertModifier({ name: "Capped" });
      await records.modifiers.update(row.id, {
        maxPerOrder: 1,
        trigger: "answer",
      });
      expect((await getModifier(row.id))?.maxPerOrder).toBe(1);
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
      await records.modifiers.update(inactive.id, { active: false });

      const names = (await getActiveModifiers()).map((m) => m.name);
      assertArrayIncludes(names, ["Live"]);
      assert(!names.includes("Off"));
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
      await getDb().execute(
        sql`INSERT INTO modifier_groups (modifier_id, group_id) VALUES (${row.id}, ${42})`,
      );
      await getDb().execute(
        sql`INSERT INTO group_listings (group_id, listing_id) VALUES (${42}, ${7})`,
      );

      expect(await getModifierGroupListingIdsByModifierId([row.id])).toEqual(
        new Map([[row.id, [7]]]),
      );
    });
  });

  describe("aggregates", () => {
    test("manual aggregate writes persist", async () => {
      const row = await insertModifier({ name: "Counted" });
      const totals = { totalUses: 9, usageCount: 4 };
      await modifierAggregates.update(row.id, totals);
      expect(await getModifier(row.id)).toMatchObject(totals);
    });

    test("resetting the aggregates recalculates them from usage rows", async () => {
      const row = await insertModifierWithUsages({ name: "Recounted" });
      const wrong = { totalUses: 99, usageCount: 99 };
      await modifierAggregates.update(row.id, wrong);

      await modifierAggregates.reset(row.id, [...MODIFIER_AGGREGATE_FIELDS]);
      expect(await getModifier(row.id)).toMatchObject({
        totalUses: 5,
        usageCount: 2,
      });
    });

    test("adjustModifierRevenue moves the projected total to the target", async () => {
      const row = await insertModifier({ name: "Earner" });
      expect((await getModifier(row.id))?.totalRevenue).toBe(0);

      await adjustModifierRevenue(row.id, 1750);
      expect((await getModifier(row.id))?.totalRevenue).toBe(1750);

      // Re-adjusting to the same target is a no-op, and lowering moves it down.
      await adjustModifierRevenue(row.id, 1750);
      await adjustModifierRevenue(row.id, 1200);
      expect((await getModifier(row.id))?.totalRevenue).toBe(1200);
    });
  });
});

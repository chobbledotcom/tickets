import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { toMinorUnits } from "#shared/currency.ts";
import { getDb } from "#shared/db/client.ts";
import {
  resolveModifiers,
  specsFromRefs,
} from "#shared/db/modifier-resolve.ts";
import { type ModifierInput, modifiersTable } from "#shared/db/modifiers.ts";
import type { CheckoutItem } from "#shared/payments.ts";
import { describeWithEnv } from "#test-utils";

const item = (overrides: Partial<CheckoutItem> = {}): CheckoutItem => ({
  listingId: 1,
  name: "General",
  quantity: 1,
  slug: "general",
  unitPrice: 1000,
  ...overrides,
});

const insertModifier = (overrides: Partial<ModifierInput> = {}) =>
  modifiersTable.insert({
    calcKind: "fixed",
    calcValue: 5,
    direction: "charge",
    name: "Add-on",
    ...overrides,
  });

/** Override behavioural columns the base create form doesn't expose yet. */
const patchModifier = (id: number, set: Record<string, string | number>) => {
  const cols = Object.keys(set);
  const assignments = cols.map((c) => `${c} = ?`).join(", ");
  return getDb().execute({
    args: [...cols.map((c) => set[c]!), id],
    sql: `UPDATE modifiers SET ${assignments} WHERE id = ?`,
  });
};

describeWithEnv("db > modifier-resolve", { db: true }, () => {
  describe("resolveModifiers", () => {
    test("builds a spec for an active automatic whole-order modifier", async () => {
      await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Parking",
      });
      const specs = await resolveModifiers([item()]);
      expect(specs).toEqual([
        {
          id: specs[0]!.id,
          kind: "fixed",
          listingIds: null,
          name: "Parking",
          quantity: 1,
          value: toMinorUnits(5),
        },
      ]);
    });

    test("negates the value for a discount and leaves a multiplier as-is", async () => {
      await insertModifier({
        calcKind: "percent",
        calcValue: 10,
        direction: "discount",
        name: "Loyalty",
      });
      await insertModifier({
        calcKind: "multiply",
        calcValue: 1.5,
        direction: "charge",
        name: "Peak",
      });
      const specs = await resolveModifiers([item()]);
      const byName = new Map(specs.map((s) => [s.name, s]));
      expect(byName.get("Loyalty")!.value).toBe(-10);
      expect(byName.get("Peak")!.value).toBe(1.5);
    });

    test("excludes inactive, non-automatic, scoped, or below-minimum modifiers", async () => {
      const inactive = await insertModifier({ name: "Inactive" });
      await patchModifier(inactive.id, { active: 0 });
      const coded = await insertModifier({ name: "Coded" });
      await patchModifier(coded.id, { trigger: "code" });
      const scoped = await insertModifier({ name: "Scoped" });
      await patchModifier(scoped.id, { scope: "listings" });
      const gated = await insertModifier({ name: "BigSpendOnly" });
      await patchModifier(gated.id, { min_subtotal: 999999 });

      const specs = await resolveModifiers([item({ unitPrice: 1000 })]);
      expect(specs.map((s) => s.name)).toEqual([]);
    });
  });

  describe("specsFromRefs", () => {
    test("returns [] for no references", async () => {
      expect(await specsFromRefs([])).toEqual([]);
    });

    test("rebuilds specs from references, re-fetching current values", async () => {
      const created = await insertModifier({
        calcKind: "fixed",
        calcValue: 5,
        direction: "charge",
        name: "Parking",
      });
      const specs = await specsFromRefs([{ i: created.id, q: 2 }]);
      expect(specs).toEqual([
        {
          id: created.id,
          kind: "fixed",
          listingIds: null,
          name: "Parking",
          quantity: 2,
          value: toMinorUnits(5),
        },
      ]);
    });

    test("drops references to modifiers that no longer resolve", async () => {
      const created = await insertModifier({ name: "Gone" });
      await patchModifier(created.id, { active: 0 });
      expect(await specsFromRefs([{ i: created.id, q: 1 }])).toEqual([]);
      expect(await specsFromRefs([{ i: 9999, q: 1 }])).toEqual([]);
    });
  });
});

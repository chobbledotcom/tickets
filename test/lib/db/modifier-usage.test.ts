import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import {
  consumeModifierStock,
  modifierUsedQuantities,
} from "#shared/db/modifier-usage.ts";
import { modifiersTable } from "#shared/db/modifiers.ts";
import { describeWithEnv } from "#test-utils";

const makeModifier = (stock: number | null) =>
  modifiersTable.insert({
    calcKind: "fixed",
    calcValue: 5,
    direction: "charge",
    name: "Add-on",
    stock,
  });

const usage = (modifierId: number, quantity = 1) => ({
  amountApplied: 500,
  modifierId,
  quantity,
});

const usageAmount = async (modifierId: number): Promise<number> => {
  const result = await getDb().execute({
    args: [modifierId],
    sql: "SELECT amount_applied FROM modifier_usages WHERE modifier_id = ?",
  });
  return Number(result.rows[0]!.amount_applied);
};

describeWithEnv("db > modifier-usage", { db: true }, () => {
  describe("consumeModifierStock", () => {
    test("returns true for no usages", async () => {
      expect(await consumeModifierStock(1, [])).toBe(true);
    });

    test("records usage for an unlimited modifier", async () => {
      const m = await makeModifier(null);
      expect(await consumeModifierStock(100, [usage(m.id, 2)])).toBe(true);
      expect(await modifierUsedQuantities([m.id])).toEqual(
        new Map([[m.id, 2]]),
      );
      expect(await usageAmount(m.id)).toBe(500);
    });

    test("refuses to oversell a stock-limited modifier", async () => {
      const m = await makeModifier(1);
      expect(await consumeModifierStock(100, [usage(m.id)])).toBe(true);
      // The single unit is gone, so a second order cannot consume it.
      expect(await consumeModifierStock(200, [usage(m.id)])).toBe(false);
      expect(await modifierUsedQuantities([m.id])).toEqual(
        new Map([[m.id, 1]]),
      );
    });

    test("rolls back partial usage when any modifier is sold out", async () => {
      const unlimited = await makeModifier(null);
      const limited = await makeModifier(1);
      await consumeModifierStock(100, [usage(limited.id)]); // exhaust it

      const ok = await consumeModifierStock(200, [
        usage(unlimited.id),
        usage(limited.id),
      ]);
      expect(ok).toBe(false);
      // The unlimited usage recorded for attendee 200 was rolled back.
      expect(await modifierUsedQuantities([unlimited.id])).toEqual(new Map());
    });
  });

  describe("modifierUsedQuantities", () => {
    test("returns an empty map for no ids", async () => {
      expect(await modifierUsedQuantities([])).toEqual(new Map());
    });
  });
});

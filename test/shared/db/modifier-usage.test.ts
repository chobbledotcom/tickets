import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  allModifiersInStockCondition,
  anyModifierSoldOut,
  modifierUsedQuantities,
} from "#db/modifier-usage.ts";
import { modifiersTable } from "#db/modifiers.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > modifier-usage", { db: true }, () => {
  test("modifierUsedQuantities returns an empty map for no ids", async () => {
    expect(await modifierUsedQuantities([])).toEqual(new Map());
  });

  test("an empty request has no sold-out modifier", async () => {
    expect(await anyModifierSoldOut([])).toBe(false);
  });

  test("distinguishes sold-out stock from available stock", async () => {
    const soldOut = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "charge",
      name: "Sold out",
      stock: 0,
    });
    const available = await modifiersTable.insert({
      calcKind: "fixed",
      calcValue: 1,
      direction: "charge",
      name: "Available",
      stock: 2,
    });

    expect(
      await anyModifierSoldOut([
        { amountApplied: 100, modifierId: soldOut.id, quantity: 1 },
      ]),
    ).toBe(true);
    expect(
      await anyModifierSoldOut([
        { amountApplied: 100, modifierId: available.id, quantity: 1 },
      ]),
    ).toBe(false);
  });
});

describe("allModifiersInStockCondition", () => {
  test("an empty list is always in stock without bound values", () => {
    expect(numberedStatement(allModifiersInStockCondition([]))).toEqual({
      args: [],
      sql: "1 = 1",
    });
  });

  test("binds each modifier id once across its complete stock check", () => {
    const statement = numberedStatement(
      allModifiersInStockCondition([
        { amountApplied: 100, modifierId: 7, quantity: 2 },
        { amountApplied: 50, modifierId: 11, quantity: 3 },
      ]),
    );

    expect(statement.args).toEqual([7, 2, 11, 3]);
    expect(statement.sql.match(/\?1/gu)).toHaveLength(3);
    expect(statement.sql.match(/\?3/gu)).toHaveLength(3);
    expect(statement.sql).toContain(">= ?2");
    expect(statement.sql).toContain(">= ?4");
    expect(statement.sql).toContain(") AND (");
  });
});

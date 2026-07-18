import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import {
  allModifiersInStockCondition,
  anyModifierSoldOut,
  modifierUsedQuantities,
} from "#shared/db/modifier-usage.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createTestAttendee } from "#test-utils/db-helpers/attendees.ts";
import { createTestListing } from "#test-utils/db-helpers/listings.ts";
import {
  insertModifier,
  insertModifierUsage,
  patchModifier,
} from "#test-utils/modifiers.ts";

describeWithEnv("db > modifier-usage", { db: true }, () => {
  test("modifierUsedQuantities returns an empty map for no ids", async () => {
    expect(await modifierUsedQuantities([])).toEqual(new Map());
  });

  test("the empty stock guard is an exact always-true statement", () => {
    expect(allModifiersInStockCondition([])).toEqual({
      args: [],
      sql: "1 = 1",
    });
  });

  test("combines every modifier stock guard", () => {
    const condition = allModifiersInStockCondition([
      { amountApplied: 100, modifierId: 11, quantity: 2 },
      { amountApplied: -50, modifierId: 22, quantity: 3 },
    ]);
    expect(condition.args).toEqual([11, 11, 11, 2, 22, 22, 22, 3]);
    expect(condition.sql.split(" AND ")).toHaveLength(2);
  });

  test("reports whether any requested modifier is sold out", async () => {
    const listing = await createTestListing();
    const attendee = await createTestAttendee(
      listing.id,
      listing.slug,
      "Modifier user",
      "modifier-user@example.com",
    );
    const modifier = await insertModifier();
    await patchModifier(modifier.id, { stock: 3 });
    await insertModifierUsage(modifier.id, attendee.id, 2, 100);

    expect(await anyModifierSoldOut([])).toBe(false);
    expect(
      await anyModifierSoldOut([
        { amountApplied: 100, modifierId: modifier.id, quantity: 1 },
      ]),
    ).toBe(false);
    expect(
      await anyModifierSoldOut([
        { amountApplied: 200, modifierId: modifier.id, quantity: 2 },
      ]),
    ).toBe(true);
  });
});

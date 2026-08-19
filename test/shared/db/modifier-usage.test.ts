import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { modifierUsedQuantities } from "#db/modifier-usage.ts";
import { describeWithEnv } from "#test-utils/db.ts";

describeWithEnv("db > modifier-usage", { db: true }, () => {
  test("modifierUsedQuantities returns an empty map for no ids", async () => {
    expect(await modifierUsedQuantities([])).toEqual(new Map());
  });
});

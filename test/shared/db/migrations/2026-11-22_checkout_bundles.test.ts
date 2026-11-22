import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import checkoutBundles from "#db/migrations/2026-11-22_checkout_bundles.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const migration = () => checkoutBundles(buildMigrationContext());

describeWithEnv("db > migrations > checkout bundles", { db: true }, () => {
  test("declares the table it owns", () => {
    expect(migration().id).toBe("2026-11-22_checkout_bundles");
    expect(migration().requires).toEqual({
      indexes: [],
      newTables: ["checkout_bundles"],
    });
  });
});

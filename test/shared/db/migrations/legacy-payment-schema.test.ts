import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { getDb } from "#shared/db/client.ts";
import { legacyPaymentSchemaMigration } from "#shared/db/migrations/legacy-payment-schema.ts";
import type { SchemaRequirement } from "#shared/db/migrations/types.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { createLegacyPaymentTables } from "#test-utils/legacy-payment-tables.ts";
import { context } from "./payment-aggregate-test-utils.ts";

const migrationFor = (requires: SchemaRequirement) =>
  legacyPaymentSchemaMigration(
    "legacy-schema-test",
    "Test legacy schema",
    requires,
  )(context);

describeWithEnv("legacy payment migration schema", { db: true }, () => {
  test("verify accepts an already retired table", async () => {
    const migration = migrationFor({ newTables: ["checkout_stages"] });

    await expect(migration.verify()).resolves.toBeUndefined();
  });

  test("verify names a missing table", async () => {
    await createLegacyPaymentTables(getDb, ["checkout_stages"]);
    const migration = migrationFor({
      newTables: ["checkout_stages", "missing_legacy_table"],
    });

    await expect(migration.verify()).rejects.toThrow(
      "Missing legacy table missing_legacy_table",
    );
  });

  test("verify names a missing index", async () => {
    await createLegacyPaymentTables(getDb, ["checkout_stages"]);
    const migration = migrationFor({
      indexes: ["missing_legacy_index"],
      newTables: ["checkout_stages"],
    });

    await expect(migration.verify()).rejects.toThrow(
      "Missing legacy index missing_legacy_index",
    );
  });

  test("verify names a missing column", async () => {
    await createLegacyPaymentTables(getDb, ["checkout_stages"]);
    const migration = migrationFor({
      columns: { checkout_stages: ["missing_legacy_column"] },
      newTables: ["checkout_stages"],
    });

    await expect(migration.verify()).rejects.toThrow(
      "Missing legacy column checkout_stages.missing_legacy_column",
    );
  });

  test("up rejects a declaration without a legacy table", () => {
    expect(() => migrationFor({}).up()).toThrow(
      "Historical payment migration has no legacy table",
    );
  });

  test("up rejects an unknown legacy column", async () => {
    const migration = migrationFor({
      columns: { checkout_stages: ["missing_legacy_column"] },
    });

    await expect(migration.up()).rejects.toThrow(
      "Unknown legacy column checkout_stages.missing_legacy_column",
    );
  });
});

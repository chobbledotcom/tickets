import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import paymentRecords from "#shared/db/migrations/2026-07-26_payment_records.ts";
import { MIGRATION_IDS } from "#shared/db/migrations/registry.ts";
import { paymentTables } from "#shared/db/migrations/schema/payments/index.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

const migration = paymentRecords(buildMigrationContext());

describe("db > migrations > payment records", () => {
  test("is registered under the id it declares", () => {
    // The id is what the applied-marker is written under: a mismatch with the
    // registry would run the migration again on every boot.
    expect(MIGRATION_IDS).toContain(migration.id);
    expect(migration.id).toBe("2026-07-26_payment_records");
  });

  test("asks for every table a payment record lives in", () => {
    // A table left off this list is never created, so the first site to
    // migrate would run without it.
    expect([...(migration.requires.newTables ?? [])].sort()).toEqual(
      paymentTables.map(([name]) => name).sort(),
    );
  });

  test("asks for every index those tables declare", () => {
    const declared = paymentTables.flatMap(([, table]) =>
      (table.indexes ?? []).map((index) => index.name),
    );

    expect([...(migration.requires.indexes ?? [])].sort()).toEqual(
      declared.sort(),
    );
  });

  test("says what it does", () => {
    expect(migration.description).toContain("payment record");
  });
});

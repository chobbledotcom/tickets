import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { declaredIndexes } from "#shared/db/migrations/schema-sync.ts";

test("lists unique and non-unique schema indexes with their SQL", () => {
  const indexes = declaredIndexes();

  expect(
    indexes.find(({ name }) => name === "idx_listings_slug_index"),
  ).toEqual({
    columns: ["slug_index"],
    name: "idx_listings_slug_index",
    sql: "CREATE UNIQUE INDEX IF NOT EXISTS idx_listings_slug_index ON listings(slug_index)",
    tableName: "listings",
    unique: true,
  });
  expect(
    indexes.find(({ name }) => name === "idx_maintenance_tasks_due"),
  ).toEqual({
    columns: ["next_run_at", "lease_expires_at", "name"],
    name: "idx_maintenance_tasks_due",
    sql: "CREATE INDEX IF NOT EXISTS idx_maintenance_tasks_due ON maintenance_tasks(next_run_at, lease_expires_at, name)",
    tableName: "maintenance_tasks",
  });
});

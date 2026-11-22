import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { coreTables } from "#db/migrations/schema/tables-core.ts";
import { jsonHash } from "#test-utils/hash.ts";
import { sqlText } from "#test-utils/sql-text.ts";

test("keeps the complete core schema declaration exact", async () => {
  expect(await jsonHash(sqlText(coreTables))).toBe(
    "a7c79aad4ac0c84ed5fdf8065b7d7eb76f7e2f04d7848c403430b5f380d053a9",
  );
});

test("defines fenced maintenance task state and its due-work index", () => {
  expect(sqlText(coreTables)).toContainEqual([
    "maintenance_tasks",
    {
      columns: [
        ["name", "TEXT PRIMARY KEY"],
        ["checkpoint", "TEXT"],
        ["completed_at", "INTEGER"],
        ["next_run_at", "INTEGER NOT NULL"],
        ["lease_token", "TEXT"],
        ["lease_expires_at", "INTEGER"],
        ["last_started_at", "INTEGER"],
        [
          "last_finished_at",
          "INTEGER CHECK ((lease_token IS NULL) = (lease_expires_at IS NULL))",
        ],
      ],
      indexes: [
        {
          columns: ["next_run_at", "lease_expires_at", "name"],
          name: "idx_maintenance_tasks_due",
        },
      ],
    },
  ]);
});

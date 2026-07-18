import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { coreTables } from "#shared/db/migrations/schema/tables-core.ts";
import { jsonHash } from "#test-utils/hash.ts";

test("keeps the complete core schema declaration exact", async () => {
  expect(await jsonHash(coreTables)).toBe(
    "ff790be7ea46e365150243155f1a9c55a0e489117f7d12023491081042c631b3",
  );
});

test("defines fenced maintenance task state and its due-work index", () => {
  expect(coreTables).toContainEqual([
    "maintenance_tasks",
    {
      columns: [
        ["name", "TEXT PRIMARY KEY"],
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

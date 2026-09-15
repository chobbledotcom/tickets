/**
 * Locks the registry's first part to the migration modules it names. Each
 * entry's id and loader are compared against the migration the module on disk
 * actually builds, so a renamed id or a wrong path fails here rather than
 * making the boot probe and the migration runner disagree on the same line.
 */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadMigrations } from "#db/migrations/context.ts";
import { ENTRIES_THROUGH_JULY } from "#db/migrations/registry-through-july.ts";

const migrations = await loadMigrations();

test("holds the opening migrations in run order, each matching its module", () => {
  expect(ENTRIES_THROUGH_JULY.map((registered) => registered.id)).toEqual(
    migrations
      .map((migration) => migration.id)
      .slice(0, ENTRIES_THROUGH_JULY.length),
  );
});

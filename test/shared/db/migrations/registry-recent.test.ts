/**
 * Locks the registry's recent part to the migration modules it names, the same
 * way the first part's mirror does: ids and loaders are compared against the
 * migration the module on disk actually builds.
 */
import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadMigrations } from "#db/migrations/context.ts";
import { ENTRIES_RECENT } from "#db/migrations/registry-recent.ts";

const migrations = await loadMigrations();

test("holds the recent migrations in run order, each matching its module", () => {
  expect(ENTRIES_RECENT.map((registered) => registered.id)).toEqual(
    migrations
      .map((migration) => migration.id)
      .slice(ENTRIES_RECENT.length * -1),
  );
});

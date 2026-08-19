import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import builtSitesLastPrunedMigration from "#db/migrations/2026-06-19_built_sites_last_pruned.ts";
import { buildMigrationContext } from "#test-utils/migrations.ts";

test("keeps the built-site prune marker as an inert historical migration", async () => {
  const migration = builtSitesLastPrunedMigration(buildMigrationContext());

  expect(migration.id).toBe("2026-06-19_built_sites_last_pruned");
  expect(migration.description).toBe("Historical built-site prune marker.");
  expect(migration.requires).toEqual({});
  await expect(migration.up()).resolves.toBeUndefined();
});

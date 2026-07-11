/**
 * Locks the migration registry to the migration implementations. The boot
 * probe reads only the registry's ids (the implementations load lazily), so
 * an entry whose id differs from the migration its module actually builds
 * would make the probe and the migration runner disagree about what has been
 * applied. Loading every entry here keeps the two from drifting.
 */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import {
  MIGRATION_IDS,
  MIGRATION_REGISTRY,
} from "#shared/db/migrations/registry.ts";
import { loadMigrations } from "#shared/db/migrations.ts";

const MIGRATIONS = await loadMigrations();

describe("db > migration registry", () => {
  test("every entry's id matches its loaded migration's id, in order", () => {
    expect(MIGRATIONS.map((migration) => migration.id)).toEqual(
      MIGRATION_REGISTRY.map((entry) => entry.id),
    );
  });

  test("ids are unique", () => {
    expect(new Set(MIGRATION_IDS).size).toBe(MIGRATION_IDS.length);
  });

  test("MIGRATION_IDS lists the registry ids in run order", () => {
    expect(MIGRATION_IDS).toEqual(MIGRATION_REGISTRY.map((entry) => entry.id));
  });
});

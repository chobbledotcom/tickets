/**
 * Locks the migration registry to the migration implementations. The boot
 * probe reads only the registry's ids (the implementations load lazily), so
 * an entry whose id differs from the migration its module actually builds
 * would make the probe and the migration runner disagree about what has been
 * applied. Loading every entry here keeps the two from drifting.
 */
import { expect } from "@std/expect";
import { describe, it as test } from "@std/testing/bdd";
import { loadMigrations } from "#shared/db/migrations/context.ts";
import {
  MIGRATION_IDS,
  MIGRATION_REGISTRY,
} from "#shared/db/migrations/registry.ts";

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

  test("orders every scheduled-maintenance schema change", () => {
    // Found by name rather than by counting back from the end, so a later
    // migration joining the list does not read as these having moved.
    const first = MIGRATION_IDS.indexOf("2026-07-18_maintenance_tasks");
    expect(MIGRATION_IDS.slice(first, first + 5)).toEqual([
      "2026-07-18_maintenance_tasks",
      "2026-07-18_drop_built_sites_last_pruned",
      "2026-07-19_maintenance_checkpoint",
      "2026-07-21_activity_backfill_complete",
      "2026-07-22_maintenance_completion",
    ]);
  });

  test("adds the payment record tables after the maintenance work", () => {
    expect(MIGRATION_IDS.at(-1)).toBe("2026-07-26_payment_records");
  });
});

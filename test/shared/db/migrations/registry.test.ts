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
    const maintenanceOrder = [
      "2026-07-18_maintenance_tasks",
      "2026-07-18_drop_built_sites_last_pruned",
      "2026-07-19_maintenance_checkpoint",
      "2026-07-21_activity_backfill_complete",
      "2026-07-22_maintenance_completion",
    ];
    // Taken from where the run starts rather than from the end of the list, so
    // a later migration does not look like the maintenance run losing its order.
    const start = MIGRATION_IDS.indexOf(maintenanceOrder[0]!);

    expect(MIGRATION_IDS.slice(start, start + maintenanceOrder.length)).toEqual(
      maintenanceOrder,
    );
  });

  // A missing name reads as position -1, which every later position beats, so
  // each name is confirmed present before the two are compared.
  const positionOf = (id: string): number => {
    expect(MIGRATION_IDS).toContain(id);
    return MIGRATION_IDS.indexOf(id);
  };

  test("adds the payment record tables after the maintenance work", () => {
    // Compared by position rather than by being last, so a later migration
    // joining the list does not read as this one having moved.
    expect(positionOf("2026-07-26_payment_records")).toBeGreaterThan(
      positionOf("2026-07-22_maintenance_completion"),
    );
  });

  test("adds the payment record tables after notes learn what they are about", () => {
    // Creating the payment tables asks the database to match the whole current
    // schema, including the two columns notes gained. A site that skipped the
    // note release still has rows in system_notes without them, and SQLite
    // refuses to add a NOT NULL column to a table with rows — so the note
    // migration, which adds them with a default and fills them in, has to go
    // first. Reversing these two blocks that site from starting at all.
    expect(positionOf("2026-07-26_payment_records")).toBeGreaterThan(
      positionOf("2026-07-28_note_entities"),
    );
  });
});

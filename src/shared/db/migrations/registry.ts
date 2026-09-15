/**
 * The boot path reads only the ids here. The migration implementations, and
 * everything they import, therefore stay out of the cold-start module graph.
 * They load lazily on the rare request that has migration work to do.
 *
 * This list IS the run order. Keep it in the exact order migrations must run.
 *
 * Each entry's id doubles as its module filename, and a test asserts the built
 * migration carries the same id, so the two cannot drift.
 */

import type { MigrationRegistryEntry } from "./registry-load.ts";
import { ENTRIES_RECENT } from "./registry-recent.ts";
import { ENTRIES_THROUGH_JULY } from "./registry-through-july.ts";

export const MIGRATION_REGISTRY: MigrationRegistryEntry[] = [
  ...ENTRIES_THROUGH_JULY,
  ...ENTRIES_RECENT,
];

/** Every migration id, in run order. */
export const MIGRATION_IDS: string[] = MIGRATION_REGISTRY.map(
  (migration) => migration.id,
);

import { assertLiveTableColumns } from "./schema-assertions.ts";
import {
  getAppSchemaColumns,
  type LiveSchema,
  snapshotLiveSchema,
} from "./schema-sync.ts";
import type {
  AdditiveMigration,
  Migration,
  SchemaRequirement,
} from "./types.ts";

const assertRequiredTables = (
  live: LiveSchema,
  req: SchemaRequirement,
): void => {
  for (const name of req.newTables ?? []) {
    assertLiveTableColumns("migration", live, name, [
      ...getAppSchemaColumns(name),
    ]);
  }
  for (const [name, cols] of Object.entries(req.columns ?? {})) {
    assertLiveTableColumns("migration", live, name, cols);
  }
};

const assertRequiredIndexes = (
  live: LiveSchema,
  req: SchemaRequirement,
): void => {
  for (const index of req.indexes ?? []) {
    if (!live.indexes.has(index)) {
      throw new Error(`Migration verification failed: missing index ${index}`);
    }
  }
};

const assertRequiredTriggers = (
  live: LiveSchema,
  req: SchemaRequirement,
): void => {
  for (const trigger of req.triggers ?? []) {
    if (!live.triggers.has(trigger)) {
      throw new Error(
        `Migration verification failed: missing trigger ${trigger}`,
      );
    }
  }
};

const assertAbsentTables = (live: LiveSchema, req: SchemaRequirement): void => {
  for (const name of req.absentTables ?? []) {
    if (live.tables.has(name)) {
      throw new Error(
        `Migration verification failed: legacy table ${name} still present`,
      );
    }
  }
};

/**
 * Build a verify() that checks only the objects a migration owns, from a single
 * schema snapshot.
 */
export const verifyRequirement =
  (req: SchemaRequirement) => async (): Promise<void> => {
    const live = await snapshotLiveSchema();
    assertRequiredTables(live, req);
    assertRequiredIndexes(live, req);
    assertRequiredTriggers(live, req);
    assertAbsentTables(live, req);
  };

/** Build a migration whose verify() is derived from the objects it owns. */
export const additive = (m: AdditiveMigration): Migration => ({
  ...m,
  verify: verifyRequirement(m.requires),
});

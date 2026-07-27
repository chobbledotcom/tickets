/**
 * The rows that record what has been applied: one marker per migration, plus
 * the two settings rows naming the schema this build expects.
 */

import type { SqlStatement } from "#shared/db/client.ts";
import { executeBatch, getDb } from "#shared/db/client.ts";
import { stringColumnSet } from "#shared/db/query.ts";
import { nowIso } from "#shared/now.ts";

import {
  executeWhileMigrationLockOwned,
  releaseMigrationLockStatement,
  whileMigrationLockOwned,
} from "./lock.ts";
import { SCHEMA, SCHEMA_HASH } from "./schema/index.ts";
import {
  DB_SCHEMA_HASH_KEY,
  LATEST_DB_UPDATE_KEY,
  LATEST_UPDATE,
  SCHEMA_MIGRATIONS_TABLE,
} from "./schema/version.ts";
import { createTableSql } from "./schema-sync.ts";
import type { Migration } from "./types.ts";

/** The key/value pairs naming the schema this build expects. */
const SCHEMA_MARKERS = [
  [LATEST_DB_UPDATE_KEY, LATEST_UPDATE],
  [DB_SCHEMA_HASH_KEY, SCHEMA_HASH],
] as const;

export const schemaMarkerStatements = (): SqlStatement[] =>
  SCHEMA_MARKERS.map(([key, value]) => ({
    args: [value],
    sql: `INSERT OR REPLACE INTO settings (key, value) VALUES ('${key}', ?)`,
  }));

/** The same schema markers, written only while this request holds the lock. */
const ownedSchemaMarkerStatements = (lockToken: string): SqlStatement[] =>
  SCHEMA_MARKERS.map(([key, value]) =>
    whileMigrationLockOwned(
      "INSERT OR REPLACE INTO settings (key, value) SELECT ?, ?",
      [key, value],
      lockToken,
    ),
  );

export const writeSchemaMarkers = async (): Promise<void> => {
  await executeBatch(schemaMarkerStatements());
};

/** Build the INSERT that records a migration as applied. */
export const migrationMarkerStatement = (
  migration: Migration,
  appliedAt: string,
): SqlStatement => ({
  args: [migration.id, migration.description, appliedAt],
  sql: `INSERT OR REPLACE INTO ${SCHEMA_MIGRATIONS_TABLE} (id, description, applied_at) VALUES (?, ?, ?)`,
});

const buildMigrationMarkerStatements =
  (build: (migration: Migration, appliedAt: string) => SqlStatement) =>
  (migrations: Migration[]): SqlStatement[] => {
    const appliedAt = nowIso();
    return migrations.map((migration) => build(migration, appliedAt));
  };

const migrationMarkerStatements = buildMigrationMarkerStatements(
  migrationMarkerStatement,
);

const ownedMigrationMarkerStatements = (
  migrations: Migration[],
  lockToken: string,
): SqlStatement[] =>
  buildMigrationMarkerStatements((migration, appliedAt) =>
    whileMigrationLockOwned(
      `INSERT OR REPLACE INTO ${SCHEMA_MIGRATIONS_TABLE} (id, description, applied_at) SELECT ?, ?, ?`,
      [migration.id, migration.description, appliedAt],
      lockToken,
    ),
  )(migrations);

/**
 * Record several completed migrations in one batch transaction, so one
 * round-trip replaces one write per migration. Callers only pass a non-empty
 * list.
 */
export const markMigrationsApplied = async (
  migrations: Migration[],
): Promise<void> => {
  await getDb().batch(migrationMarkerStatements(migrations), "write");
};

/** Record migrations that finished before a later one failed, so the progress
 *  is not replayed on the next request. */
export const recordCompletedProgress = (
  migrations: Migration[],
  lockToken: string,
): Promise<void> =>
  executeWhileMigrationLockOwned(
    ownedMigrationMarkerStatements(migrations, lockToken),
    lockToken,
  );

/** Record one migration batch, optionally seal the finished schema, and release
 * its lock atomically. */
export const recordMigrationBatch = (
  migrations: Migration[],
  finished: boolean,
  lockToken: string,
): Promise<void> =>
  executeWhileMigrationLockOwned(
    [
      ...ownedMigrationMarkerStatements(migrations, lockToken),
      ...(finished ? ownedSchemaMarkerStatements(lockToken) : []),
      releaseMigrationLockStatement(lockToken),
    ],
    lockToken,
  );

const ensureMigrationTrackingTable = async (): Promise<void> => {
  await getDb().execute(
    createTableSql(SCHEMA.find(([name]) => name === SCHEMA_MIGRATIONS_TABLE)!),
  );
};

export const getAppliedMigrationIds = async (): Promise<Set<string>> => {
  await ensureMigrationTrackingTable();
  const result = await getDb().execute(
    `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`,
  );
  return stringColumnSet(result.rows, "id");
};

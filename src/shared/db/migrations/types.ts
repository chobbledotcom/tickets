import type { StatementClient } from "#db/client.ts";

/**
 * The tables a scoped schema step can touch. A schemaMigration passes the
 * tables it declares, so an incremental step never reaches a table a later
 * migration redefines.
 */
export type SchemaApplyScope = { tables: readonly string[] };

/**
 * The schema objects a single migration is responsible for. Drives that
 * migration's verify() so failures name exactly what the migration was meant
 * to add or remove.
 */
export type SchemaRequirement = {
  /** Tables this migration creates (verified to have their full SCHEMA columns). */
  newTables?: string[];
  /** Columns this migration adds to already-existing tables. */
  columns?: Record<string, string[]>;
  /** Indexes this migration creates. */
  indexes?: string[];
  /** Triggers this migration creates. */
  triggers?: string[];
  /** Legacy tables this migration removes (must be absent afterwards). */
  absentTables?: string[];
};

export type Migration = {
  id: string;
  description: string;
  up: () => Promise<void>;
  /** Runs after up(). A failure leaves the migration unrecorded for retry. */
  verify: () => Promise<void>;
  /** Objects this migration owns. These drive verify() and the restore tests. */
  requires?: SchemaRequirement;
};

export type AdditiveMigration = Omit<Migration, "verify"> & {
  requires: SchemaRequirement;
};

/** The default export of every dated migration module. */
export type MigrationBuilder = (context: MigrationContext) => Migration;

/** One piece of migration work that takes no input. */
export type MigrationStep = () => Promise<void>;

export type MigrationContext = {
  additive: (migration: AdditiveMigration) => Migration;
  applySchemaChanges: (scope?: SchemaApplyScope) => Promise<void>;
  backfillAnswerAggregates: MigrationStep;
  backfillListingAggregates: MigrationStep;
  backfillModifierAggregates: MigrationStep;
  ensureDefaultAttendeeStatus: MigrationStep;
  getDb: () => StatementClient;
  /** Rebuild a table from its SCHEMA definition, dropping any columns and
   * attached triggers no longer declared (preserving data for shared columns). */
  recreateTable: (table: string) => Promise<void>;
  renameEventsToListings: MigrationStep;
  syncCurrentSchema: MigrationStep;
  syncIndexes: MigrationStep;
  syncTriggers: MigrationStep;
  tableExists: (table: string) => Promise<boolean>;
  verifyCurrentAppSchema: MigrationStep;
  verifyRequirement: (req: SchemaRequirement) => MigrationStep;
};

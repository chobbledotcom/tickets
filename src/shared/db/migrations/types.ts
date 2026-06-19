import type { Client } from "@libsql/client";

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
  /** Runs after up(); a failure leaves the migration unrecorded for retry. */
  verify: () => Promise<void>;
  /** Objects this migration owns; drives verify() and the restore tests. */
  requires?: SchemaRequirement;
};

export type AdditiveMigration = Omit<Migration, "verify"> & {
  requires: SchemaRequirement;
};

export type MigrationContext = {
  additive: (migration: AdditiveMigration) => Migration;
  applySchemaChanges: () => Promise<void>;
  backfillAnswerAggregates: () => Promise<void>;
  backfillListingAggregates: () => Promise<void>;
  backfillModifierAggregates: () => Promise<void>;
  ensureDefaultAttendeeStatus: () => Promise<void>;
  getDb: () => Client;
  /** Rebuild a table from its SCHEMA definition, dropping any columns and
   * attached triggers no longer declared (preserving data for shared columns). */
  recreateTable: (table: string) => Promise<void>;
  renameEventsToListings: () => Promise<void>;
  syncCurrentSchema: () => Promise<void>;
  syncIndexes: () => Promise<void>;
  syncTriggers: () => Promise<void>;
  tableExists: (table: string) => Promise<boolean>;
  verifyCurrentAppSchema: () => Promise<void>;
  verifyRequirement: (req: SchemaRequirement) => () => Promise<void>;
};

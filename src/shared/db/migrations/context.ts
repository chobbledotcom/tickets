/**
 * The toolbox every dated migration is handed, and the lazy loader that builds
 * the migrations from it.
 */

import { once } from "#fp";
import { getDb } from "#shared/db/client.ts";

import { MIGRATION_REGISTRY } from "./registry.ts";
import { EVENT_TO_LISTING_RENAME_PLAN } from "./rename-plan.ts";
import { repairLegacyRenames } from "./rename-utils.ts";
import {
  applySchemaChanges,
  backfillAnswerAggregates,
  backfillListingAggregates,
  backfillModifierAggregates,
  recreateTable,
  syncCurrentSchema as syncCurrentSchemaBase,
  syncIndexes,
  syncTriggers,
  tableExists,
  verifyCurrentAppSchema,
} from "./schema-sync.ts";
import type { Migration, MigrationContext } from "./types.ts";
import { additive, verifyRequirement } from "./verify.ts";

/**
 * Rename the legacy "event" domain to "listing". Public entrypoint so tests
 * can drive the rename directly; in production it is called by the baseline
 * reconcile and by the `2026-06-14_rename_events_to_listings` migration (as an
 * idempotent verification/cleanup step).
 */
export const renameEventsToListings = async (): Promise<void> => {
  await repairLegacyRenames(EVENT_TO_LISTING_RENAME_PLAN);
  await applySchemaChanges();
  await syncIndexes();
};

const syncCurrentSchema = async (): Promise<void> => {
  await syncCurrentSchemaBase(() =>
    repairLegacyRenames(EVENT_TO_LISTING_RENAME_PLAN),
  );
};

/** Seed the default attendee status. Loaded on demand: only migration,
 *  fresh-install, and restore paths need it, and a static import would put the
 *  attendee-statuses module into every cold start's eager graph. */
export const ensureDefaultAttendeeStatus = async (): Promise<void> => {
  const { ensureDefaultAttendeeStatus: seedDefaultStatus } = await import(
    "#shared/db/attendee-statuses.ts"
  );
  await seedDefaultStatus();
};

const migrationContext: MigrationContext = {
  additive,
  applySchemaChanges,
  backfillAnswerAggregates,
  backfillListingAggregates,
  backfillModifierAggregates,
  ensureDefaultAttendeeStatus,
  getDb,
  recreateTable,
  renameEventsToListings,
  syncCurrentSchema,
  syncIndexes,
  syncTriggers,
  tableExists,
  verifyCurrentAppSchema,
  verifyRequirement,
};

/**
 * Load and build every migration, in run order. Deliberately lazy (and cached
 * after the first call): a steady-state boot only ever needs the migration
 * *ids* for its probe, so the ~70 dated migration modules — and the domain
 * modules they import — stay out of the cold-start graph and load only on the
 * rare request that has real migration work (or a fresh install) to do.
 */
export const loadMigrations = once(async (): Promise<Migration[]> => {
  const modules = await Promise.all(
    MIGRATION_REGISTRY.map((migration) => migration.load()),
  );
  return modules.map((module) => module.default(migrationContext));
});

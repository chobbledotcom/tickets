/**
 * The populated-database migration chain, walked forward once.
 *
 * The database is seeded with the populated fixture and wound back to the
 * first historical upgrade start point, one time. The walk then applies every
 * migration in order through the production `applyMigrationWithRetry`, and
 * each boundary test checks the fixture at its own point in the chain. The
 * last migration stays pending: one real `initDb()` finishes the chain and
 * seals the schema markers through the production `finished` batch.
 *
 * A test whose boundary is ahead of the walk advances to that boundary first,
 * so a `--filter` run still walks in order and cannot skip a migration.
 */
import { expect } from "@std/expect";
import { afterAll, beforeAll, describe, it as test } from "@std/testing/bdd";
import {
  getAppliedMigrationIds,
  markMigrationsApplied,
} from "#db/migrations/markers.ts";
import { applyMigrationWithRetry } from "#db/migrations/runner.ts";
import {
  DB_SCHEMA_HASH_KEY,
  LATEST_DB_UPDATE_KEY,
} from "#db/migrations/schema/version.ts";
import {
  initDb,
  LATEST_UPDATE,
  rebuildWipedSchema,
  resetDatabase,
  SCHEMA_HASH,
} from "#db/migrations.ts";
import {
  assertPopulatedFixtureSurvived,
  MIGRATIONS,
  markAppliedThrough,
  markSchemaMarkersStale,
  migrationBoundaries,
  migrationsAfter,
  restoreSchemaBeforeMigrations,
  seedPopulatedMigrationFixture,
  verifyMigratedSchema,
} from "#test/integration/db/migration-restore/helpers.ts";
import { seedPreDropLedgerColumns } from "#test-utils/db/migration-test-helpers.ts";
import { setupTestDbEnvironment } from "#test-utils/db.ts";
import { settingsValueOrNull } from "#test-utils/migrations.ts";

/**
 * The boundaries whose migrations write a value that only their own column or
 * table holds, plus the late ones whose migrations rewrite the fixture data. A
 * pristine start keeps those claims honest: it applies the chain to the seeded
 * fixture values, where the column or table still holds the fixture row.
 */
const PRISTINE_BOUNDARY_IDS = [
  "2026-06-14_attendee_statuses",
  "2026-06-16_modifiers",
  "2026-06-17_modifier_aggregates",
  "2026-07-18_drop_built_sites_last_pruned",
  "2026-08-18_sumup_recovery_state",
  "2026-09-30_checked_in_count",
  "2026-10-07_holiday_date_padding",
  "2026-10-12_listing_fields_trim",
] as const;

/** The first historical upgrade start point. The setup winds back to it. */
const seedBoundaryId = migrationBoundaries[0]!.id;
/** The index in `MIGRATIONS` of that boundary. */
const seededThrough = MIGRATIONS.indexOf(migrationBoundaries[0]!);
/** The index in `migrationBoundaries` of the last start point. */
const lastBoundaryIndex = migrationBoundaries.length - 1;
/** The id of that last start point. */
const lastBoundaryId = migrationBoundaries[lastBoundaryIndex]!.id;
/**
 * The walk's progress: the index in `MIGRATIONS` of the last applied
 * migration, and the count the walk applied since it seeded the first
 * boundary.
 */
const walk = { applied: 0, appliedThrough: seededThrough };
/**
 * The boundary ids the walk reached, in order, each one time. It starts at the
 * seeded boundary, which the setup applied.
 */
const walkedBoundaries: string[] = [seedBoundaryId];

/** Prove that the recorded markers name exactly the migrations that ran. */
const assertMarkersRecorded = async (): Promise<void> => {
  const expected = MIGRATIONS.slice(0, walk.appliedThrough + 1).map(
    ({ id }) => id,
  );
  const recorded = await getAppliedMigrationIds();
  expect(recorded.size, "recorded migration count").toBe(expected.length);
  for (const id of expected) {
    expect(recorded.has(id), `recorded marker for ${id}`).toBe(true);
  }
  expect(walk.applied, "migrations applied by the walk").toBe(
    walk.appliedThrough - seededThrough,
  );
};

/**
 * Seed the populated fixture and wind the live schema back to just before
 * `boundaryId` ran, so a chain can migrate forward from there.
 *
 * The fixture is inserted at the current schema, so the seed sees every
 * column. Then the objects that the later migrations own are dropped. The
 * ledger columns the transfer backfill reads come back too: production had
 * them until the drop migrations of the same chain remove them again.
 */
const prepareBoundary = async (boundaryId: string): Promise<void> => {
  await seedPopulatedMigrationFixture();
  await seedPreDropLedgerColumns();
  await restoreSchemaBeforeMigrations(migrationsAfter(boundaryId));
  await markAppliedThrough(boundaryId);
  await markSchemaMarkersStale();
};

/** Run the pending migrations through the real boot path and check the result. */
const finishChain = async (
  seedBoundary: string,
  boundaryId: string,
): Promise<void> => {
  await initDb();
  await verifyMigratedSchema();
  await assertPopulatedFixtureSurvived(seedBoundary, boundaryId);
};

/** Migrate one populated boundary to the current schema through `initDb()`. */
const migrateFromBoundary = async (boundaryId: string): Promise<void> => {
  await prepareBoundary(boundaryId);
  await finishChain(boundaryId, boundaryId);
};

/** Apply every migration between the walk's position and `boundaryIndex`. */
const walkTo = async (boundaryIndex: number): Promise<void> => {
  const boundary = migrationBoundaries[boundaryIndex]!;
  const pending = MIGRATIONS.slice(
    walk.appliedThrough + 1,
    MIGRATIONS.indexOf(boundary) + 1,
  );
  for (const migration of pending) {
    await applyMigrationWithRetry(migration);
    await markMigrationsApplied([migration]);
    walk.appliedThrough = MIGRATIONS.indexOf(migration);
    walk.applied += 1;
    walkedBoundaries.push(migration.id);
  }
  await assertMarkersRecorded();
};

/** The database cleanup this file runs in `afterAll`, and on a setup throw. */
const lifecycle: { cleanup: (() => void) | undefined } = { cleanup: undefined };

describe("db > migration chain", () => {
  beforeAll(async () => {
    lifecycle.cleanup = await setupTestDbEnvironment(true);
    try {
      await prepareBoundary(seedBoundaryId);
    } catch (error) {
      lifecycle.cleanup();
      lifecycle.cleanup = undefined;
      throw error;
    }
  });

  afterAll(() => lifecycle.cleanup?.());

  for (const [index, boundary] of migrationBoundaries.entries()) {
    test(`migrates a populated database from ${boundary.id} to the current schema`, async () => {
      await walkTo(index);
      await assertPopulatedFixtureSurvived(seedBoundaryId, boundary.id);
    });
  }

  test("walks every upgrade start point exactly once", async () => {
    await walkTo(lastBoundaryIndex);
    expect(walkedBoundaries).toEqual(migrationBoundaries.map(({ id }) => id));
  });

  test("finishes the chain with the last migration and seals the markers", async () => {
    await walkTo(lastBoundaryIndex);
    await finishChain(seedBoundaryId, lastBoundaryId);
    // The production `finished` batch writes both schema markers.
    expect(await settingsValueOrNull(LATEST_DB_UPDATE_KEY)).toBe(LATEST_UPDATE);
    expect(await settingsValueOrNull(DB_SCHEMA_HASH_KEY)).toBe(SCHEMA_HASH);
  });

  // A pristine start begins from the full current schema, so it rebuilds that
  // schema in the one database this file shares.
  describe("pristine starts", () => {
    for (const boundaryId of PRISTINE_BOUNDARY_IDS) {
      test(`migrates a pristine database from ${boundaryId} to the current schema`, async () => {
        await resetDatabase();
        await rebuildWipedSchema();
        await migrateFromBoundary(boundaryId);
        expect((await getAppliedMigrationIds()).size).toBe(MIGRATIONS.length);
      });
    }
  });
});

/**
 * The update flag must not stand between a deploy and its migrations. initDb
 * runs before the read-only gate on every request, so the first request after
 * the deploy migrates the database even while UPDATE_IN_PROGRESS is set. This
 * suite rewinds one additive migration and proves a guarded request re-runs
 * it.
 */

import { expect } from "@std/expect";
import { it as test } from "@std/testing/bdd";
import { loadMigrations } from "#db/migrations/context.ts";
import { handleRequest } from "#routes";
import {
  additiveMigrations,
  dropOwnedObjects,
  markAppliedThrough,
  markSchemaMarkersStale,
  seedSentinelListing,
  sentinelListingExists,
} from "#test/integration/db/migration-restore/helpers.ts";
import { describeWithEnv } from "#test-utils/db.ts";
import { mockRequest } from "#test-utils/mocks.ts";

const MIGRATIONS = await loadMigrations();

describeWithEnv(
  "update mode keeps migrations running",
  { db: true, env: { UPDATE_IN_PROGRESS: "1" }, triggers: true },
  () => {
    test("a guarded request re-runs a pending migration", async () => {
      const migration = additiveMigrations.at(-1)!;
      const previous = MIGRATIONS[MIGRATIONS.indexOf(migration) - 1]!;

      await seedSentinelListing();
      // Precondition: a freshly-migrated database satisfies the migration.
      await migration.verify();
      await dropOwnedObjects(migration.requires!);
      await expect(migration.verify()).rejects.toThrow(
        "Migration verification failed",
      );

      // Wind the applied marker back and stale the schema markers, exactly
      // like the upgrade chain suites, so initDb has real work to do.
      await markAppliedThrough(previous.id);
      await markSchemaMarkersStale();

      const res = await handleRequest(mockRequest("/read-only"));
      expect(res.status).toBe(200);
      // The request's initDb re-ran the migration and kept the data.
      await migration.verify();
      expect(await sentinelListingExists()).toBe(true);
    });
  },
);

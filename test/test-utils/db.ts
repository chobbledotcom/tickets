import type { Client } from "@libsql/client";
import { afterAll, afterEach, beforeEach, describe } from "@std/testing/bdd";
import { lazyRef } from "#fp";
import { runCleanups } from "#scripts/cleanup.ts";
import { invalidateCachesForTable } from "#shared/cache-registry.ts";
import { resetEffectiveDomain } from "#shared/config.ts";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { queryOne, setDb } from "#shared/db/client.ts";
import { groups } from "#shared/db/groups.ts";
import { holidays } from "#shared/db/holidays.ts";
import { invalidateListingsCache } from "#shared/db/listings/records.ts";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  resetHostEmailConfig,
  setHostEmailConfigForTest,
} from "#shared/email.ts";
import { setStorageConfigForTest } from "#shared/storage.ts";
import { createTestDbClient } from "#test-utils/db-client.ts";
import {
  type EnvScope,
  setupTestEncryptionKey,
  withEnv,
} from "#test-utils/env.ts";
import { type TempPath, tempDir } from "#test-utils/files.ts";
import {
  type DescribeEnvOptions,
  type RawListingRange,
  resetTestSession,
  resetTestSlugCounter,
  setTestSession,
  setTestStoragePath,
  TEST_STORAGE_ZONE,
} from "#test-utils/internal.ts";
import {
  maybeReclaimLeakedFds,
  reclaimLeakedFdsNow,
} from "#test-utils/reclaim-fds.ts";
import {
  cleanupTestDbPath,
  createTrackedTestDbFile,
} from "#test-utils/temp-db-files.ts";
import {
  getOrCreateGoldenDb,
  replaySetupState,
  reusableSetupState,
  runSetupCeremony,
  setSetupState,
} from "#test-utils/test-state.ts";

interface TestDbResource {
  client: Client;
  env: EnvScope;
  path: string;
}

const [getTestDbResource, setTestDbResource] = lazyRef<TestDbResource | null>(
  () => null,
);

const cleanupUnlessKept = (
  cleanup: () => void,
): Disposable & {
  keep(): void;
} => {
  const state = { cleanup };
  return {
    keep: () => {
      state.cleanup = () => {};
    },
    [Symbol.dispose]: () => state.cleanup(),
  };
};

const prepareTestClient = async (triggers = false): Promise<void> => {
  if (getTestDbResource()) resetDb();
  // Keep libsql's leaked file descriptors from exhausting the process limit
  // under high `--parallel` worker counts (see reclaim-fds.ts).
  maybeReclaimLeakedFds();
  setupTestEncryptionKey();
  settings.setup.clearCache();
  invalidateCachesForTable("sessions");
  invalidateUsersCache();
  invalidateListingsCache();
  holidays.invalidate();
  groups.cache.invalidate();
  logisticsAgents.invalidate();
  attendeeStatuses.invalidate();

  // A temp file, not ":memory:": interactive transactions (withTransaction) open
  // a second connection, and each ":memory:" connection is its own *separate*
  // empty database — a transaction would see no schema. A file is shared across
  // connections. `createTestDbClient` keeps the speed settings on it.
  //
  // Copy the golden DB (schema + default status, prebuilt by the harness for
  // the whole run, else built once per isolate — see test-state.ts) rather
  // than re-running the schema SQL on every test — a file copy is much cheaper
  // than executing 100+ CREATE TABLE / INDEX / TRIGGER statements.
  const goldenPath = await getOrCreateGoldenDb();
  const path = await createTrackedTestDbFile(".db");
  await Deno.copyFile(goldenPath, path);
  const env = withEnv({
    DB_URL: `file:${path}`,
    DISABLE_AGGREGATE_TRIGGERS_FOR_TEST: triggers ? undefined : "1",
  });
  const client = await createTestDbClient(path);
  setTestDbResource({ client, env, path });
  using rollback = cleanupUnlessKept(resetDb);
  setDb(client);
  rollback.keep();
};

export const createTestDb = async (triggers = false): Promise<void> => {
  await prepareTestClient(triggers);
  resetTestSession();
};

/**
 * Set up a temp-file database for tests that use interactive transactions
 * (`withTransaction`). A `:memory:` URL gives each connection its own database,
 * so a transaction opened on a fresh connection would see no schema or data; a
 * real file is shared across connections. Returns a cleanup function that
 * detaches the client, closes it, restores the env, and removes the file — call
 * it from `afterEach`.
 */
export const setupTransactionalTestDb = async (): Promise<
  () => Promise<void>
> => {
  // Same libsql fd leak as prepareTestClient: this path also mints a fresh
  // file-backed client per test and runs many `withTransaction` writes.
  maybeReclaimLeakedFds();
  setupTestEncryptionKey();
  const goldenPath = await getOrCreateGoldenDb();
  const path = await createTrackedTestDbFile(".db");
  await Deno.copyFile(goldenPath, path);
  const env = withEnv({
    DB_URL: `file:${path}`,
    DISABLE_AGGREGATE_TRIGGERS_FOR_TEST: "1",
  });
  const client = await createTestDbClient(path);
  setDb(client);
  return async () => {
    setDb(null);
    client.close();
    env.dispose();
    cleanupTestDbPath(path);
  };
};

export const createTestDbWithSetup = async (
  country = "GB",
  triggers = false,
): Promise<void> => {
  await prepareTestClient(triggers);
  resetTestSession();
  using rollback = cleanupUnlessKept(resetDb);
  // Replay captured setup rows (isolate cache or the run-wide snapshot) in one
  // batch rather than re-running the ceremony's hashing and key generation.
  const reusable = reusableSetupState(country);
  if (reusable) await replaySetupState(reusable);
  else {
    const { state, liveSession } = await runSetupCeremony(country);
    setSetupState(state);
    setTestSession(liveSession);
  }
  rollback.keep();
};

/** Close and remove the exact database resource created for this test. */
const cleanupTestDbFile = (): void => {
  const resource = getTestDbResource();
  if (!resource) return;
  try {
    resource.client.close();
  } finally {
    try {
      resource.env.dispose();
    } finally {
      try {
        cleanupTestDbPath(resource.path);
      } finally {
        setTestDbResource(null);
      }
    }
  }
};

export const resetDb = (): void => {
  try {
    cleanupTestDbFile();
  } finally {
    setDb(null);
    settings.setup.clearCache();
    settings.invalidateCache();
    invalidateUsersCache();
    invalidateListingsCache();
    holidays.invalidate();
    groups.cache.invalidate();
    logisticsAgents.invalidate();
    attendeeStatuses.invalidate();
    invalidateCachesForTable("sessions");
    setTestSession(null);
    setDemoModeForTest(false);
    resetEffectiveDomain();
    resetHostEmailConfig();
    settings.appleWallet.resetHostConfig();
    settings.googleWallet.resetHostConfig();
    settings.clearTestOverrides();
  }
};

/** Set up the standard configured-site database used by integration tests.
 * Returns the one cleanup that must run after the test or Cucumber Scenario. */
export const setupTestDbEnvironment = async (
  triggers = false,
): Promise<() => void> => {
  resetTestSlugCounter();
  setHostEmailConfigForTest(null);
  settings.appleWallet.setHostConfigForTest(null);
  settings.googleWallet.setHostConfigForTest(null);
  await createTestDbWithSetup("GB", triggers);
  return resetDb;
};

/**
 * Establish the requested `storage` backend for a test as a typed suite-level
 * `StorageConfig` (read via `#shared/storage.ts`, layered under any per-test
 * `runWithStorageConfig` scope and over env). Each backend fully specifies both
 * dimensions so it resolves deterministically regardless of ambient env — no
 * `STORAGE_ZONE_*` / `LOCAL_STORAGE_PATH` vars are touched:
 * - `"cdn"`: the Bunny test zone, with `localPath: ""` so an ambient local path
 *   can't route uploads to disk instead of the CDN.
 * - `"local"`: a fresh temp dir (recorded for `getTestStoragePath`) with empty
 *   zone creds, so ambient Bunny creds can't shadow the local backend.
 */
export const setupTestStorage = (
  storage: DescribeEnvOptions["storage"],
): TempPath | undefined => {
  if (storage === "cdn") {
    setStorageConfigForTest({
      localPath: "",
      zoneKey: TEST_STORAGE_ZONE.zoneKey,
      zoneName: TEST_STORAGE_ZONE.zoneName,
    });
    return;
  }
  if (storage === "local") {
    const dir = tempDir();
    setTestStoragePath(dir.path);
    setStorageConfigForTest({
      localPath: dir.path,
      zoneKey: "",
      zoneName: "",
    });
    return dir;
  }
  return;
};

/** Clear the suite-level storage config and remove any `"local"` temp dir. */
export const teardownTestStorage = (dir: TempPath | undefined): void => {
  setStorageConfigForTest(null);
  setTestStoragePath(null);
  dir?.dispose();
};

export const describeWithEnv = (
  name: string,
  options: DescribeEnvOptions,
  fn: () => void,
): void => {
  describe(name, () => {
    let cleanupDb: (() => void) | undefined;
    let env: EnvScope | undefined;
    let storageDir: TempPath | undefined;
    beforeEach(async () => {
      if (options.encryptionKey) setupTestEncryptionKey();
      if (options.db) {
        cleanupDb = await setupTestDbEnvironment(options.triggers ?? false);
      }
      if (options.env) env = withEnv(options.env);
      storageDir = setupTestStorage(options.storage);
    });
    // Register this teardown after nested suite hooks so inner env scopes close
    // before this suite restores its outer database and env layers.
    fn();
    afterEach(async () => {
      const dbCleanup = cleanupDb;
      const envCleanup = env;
      const currentStorageDir = storageDir;
      cleanupDb = undefined;
      env = undefined;
      storageDir = undefined;
      await runCleanups([
        () => teardownTestStorage(currentStorageDir),
        ...(envCleanup ? [() => envCleanup.dispose()] : []),
        ...(dbCleanup ? [dbCleanup] : []),
      ]);
    });
    // A small suite may never reach the amortised reclaim threshold, so hand
    // back its leaked descriptors when it finishes (see reclaim-fds.ts).
    afterAll(() => {
      reclaimLeakedFdsNow();
    });
  });
};

export const rawListingRange = (
  listingId: number,
): Promise<RawListingRange | null> =>
  queryOne<RawListingRange>(
    "SELECT start_at, end_at, quantity FROM listing_attendees WHERE listing_id = ? ORDER BY attendee_id LIMIT 1",
    [listingId],
  );

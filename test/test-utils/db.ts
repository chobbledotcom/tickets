import { createClient } from "@libsql/client";
import { afterAll, afterEach, beforeEach, describe } from "@std/testing/bdd";
import { resetEffectiveDomain } from "#shared/config.ts";
import { attendeeStatuses } from "#shared/db/attendee-statuses.ts";
import { getDb, queryOne, setDb } from "#shared/db/client.ts";
import { groups } from "#shared/db/groups.ts";
import { holidays } from "#shared/db/holidays.ts";
import { invalidateListingsCache } from "#shared/db/listings/records.ts";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import { resetSessionCache } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  resetHostEmailConfig,
  setHostEmailConfigForTest,
} from "#shared/email.ts";
import { getEnv } from "#shared/env.ts";
import { setStorageConfigForTest } from "#shared/storage.ts";
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

const prepareTestClient = async (triggers = false): Promise<void> => {
  // Keep libsql's leaked file descriptors from exhausting the process limit
  // under high `--parallel` worker counts (see reclaim-fds.ts).
  maybeReclaimLeakedFds();
  setupTestEncryptionKey();
  settings.setup.clearCache();
  resetSessionCache();
  invalidateUsersCache();
  invalidateListingsCache();
  holidays.invalidate();
  groups.cache.invalidate();
  logisticsAgents.invalidate();
  attendeeStatuses.invalidate();

  // A temp file, not ":memory:": interactive transactions (withTransaction) open
  // a second connection, and each ":memory:" connection is its own *separate*
  // empty database — a transaction would see no schema. A file is shared across
  // connections. Durability is irrelevant in tests, so relax fsync to keep speed
  // close to in-memory.
  //
  // Copy the golden DB (schema + default status, prebuilt by the harness for
  // the whole run, else built once per isolate — see test-state.ts) rather
  // than re-running the schema SQL on every test — a file copy is much cheaper
  // than executing 100+ CREATE TABLE / INDEX / TRIGGER statements.
  const goldenPath = await getOrCreateGoldenDb();
  const path = await createTrackedTestDbFile(".db");
  await Deno.copyFile(goldenPath, path);
  withEnv({
    DB_URL: `file:${path}`,
    DISABLE_AGGREGATE_TRIGGERS_FOR_TEST: triggers ? undefined : "1",
  });
  const client = createClient({ url: `file:${path}` });
  setDb(client);
  // journal_mode persists in the SQLite header from the golden; synchronous=OFF
  // is per-connection only and must be re-applied.
  await client.executeMultiple("PRAGMA synchronous=OFF;");
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
  const client = createClient({ url: `file:${path}` });
  setDb(client);
  await client.executeMultiple("PRAGMA synchronous=OFF;");
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

  // Replay captured setup rows (isolate cache or the run-wide snapshot) in one
  // batch rather than re-running the ceremony's hashing and key generation.
  const reusable = reusableSetupState(country);
  if (reusable) {
    await replaySetupState(reusable);
    return;
  }

  const { state, liveSession } = await runSetupCeremony(country);
  setSetupState(state);
  setTestSession(liveSession);
};

/** Close the active test client and delete its temp DB file. Best-effort: the
 *  container is ephemeral, so a missed unlink just lingers until teardown. */
const cleanupTestDbFile = (): void => {
  const url = getEnv("DB_URL");
  if (!url?.startsWith("file:")) return;
  try {
    getDb().close();
  } catch {
    // client already closed or never opened
  }
  cleanupTestDbPath(url.slice("file:".length));
};

export const resetDb = (): void => {
  cleanupTestDbFile();
  setDb(null);
  settings.setup.clearCache();
  settings.invalidateCache();
  invalidateUsersCache();
  invalidateListingsCache();
  holidays.invalidate();
  groups.cache.invalidate();
  logisticsAgents.invalidate();
  attendeeStatuses.invalidate();
  resetSessionCache();
  setTestSession(null);
  setDemoModeForTest(false);
  resetEffectiveDomain();
  resetHostEmailConfig();
  settings.appleWallet.resetHostConfig();
  settings.googleWallet.resetHostConfig();
  settings.clearTestOverrides();
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
const applyStorageConfig = (
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
const teardownStorageConfig = (dir: TempPath | undefined): void => {
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
    let env: EnvScope | undefined;
    let storageDir: TempPath | undefined;
    beforeEach(async () => {
      if (options.encryptionKey) setupTestEncryptionKey();
      if (options.db) {
        resetTestSlugCounter();
        setHostEmailConfigForTest(null);
        settings.appleWallet.setHostConfigForTest(null);
        settings.googleWallet.setHostConfigForTest(null);
        await createTestDbWithSetup("GB", options.triggers ?? false);
      }
      if (options.env) env = withEnv(options.env);
      storageDir = applyStorageConfig(options.storage);
    });
    afterEach(() => {
      if (options.db) resetDb();
      env?.dispose();
      env = undefined;
      teardownStorageConfig(storageDir);
      storageDir = undefined;
    });
    // A small suite may never reach the amortised reclaim threshold, so hand
    // back its leaked descriptors when it finishes (see reclaim-fds.ts).
    afterAll(() => {
      reclaimLeakedFdsNow();
    });
    fn();
  });
};

export const rawListingRange = (
  listingId: number,
): Promise<RawListingRange | null> =>
  queryOne<RawListingRange>(
    "SELECT start_at, end_at, quantity FROM listing_attendees WHERE listing_id = ? ORDER BY attendee_id LIMIT 1",
    [listingId],
  );

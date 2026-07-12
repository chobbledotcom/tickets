import { createClient, type InValue, type Row } from "@libsql/client";
import { afterAll, afterEach, beforeEach, describe } from "@std/testing/bdd";
import { once } from "#fp";
import { resetEffectiveDomain } from "#shared/config.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  attendeeStatuses,
  ensureDefaultAttendeeStatus,
} from "#shared/db/attendee-statuses.ts";
import { getDb, insert, queryOne, setDb } from "#shared/db/client.ts";
import { groups } from "#shared/db/groups.ts";
import { holidays } from "#shared/db/holidays.ts";
import { invalidateListingsCache } from "#shared/db/listings/records.ts";
import { logisticsAgents } from "#shared/db/logistics-agents.ts";
import { SCHEMA } from "#shared/db/migrations/schema/index.ts";
import { TRIGGERS } from "#shared/db/migrations/schema/triggers.ts";
import { SCHEMA_MIGRATIONS_TABLE } from "#shared/db/migrations/schema/version.ts";
import {
  LATEST_UPDATE,
  loadMigrations,
  SCHEMA_HASH,
} from "#shared/db/migrations.ts";
import { resetSessionCache } from "#shared/db/sessions.ts";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import { setDemoModeForTest } from "#shared/demo/mode.ts";
import {
  resetHostEmailConfig,
  setHostEmailConfigForTest,
} from "#shared/email.ts";
import { getEnv } from "#shared/env.ts";
import { setStorageConfigForTest } from "#shared/storage.ts";
import { setTestEnv, setupTestEncryptionKey } from "#test-utils/env.ts";
import {
  type DescribeEnvOptions,
  getCachedSetupSettings,
  getCachedSetupUsers,
  getTestStoragePath,
  type RawListingRange,
  resetTestSession,
  resetTestSlugCounter,
  setCachedAdminSession,
  setCachedSetupSettings,
  setCachedSetupUsers,
  setTestSession,
  setTestStoragePath,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
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

const MIGRATIONS = await loadMigrations();
type SchemaEntry = (typeof SCHEMA)[number];
type SchemaIndex = NonNullable<SchemaEntry[1]["indexes"]>[number];

const createTableSql = ([name, table]: SchemaEntry): string =>
  `CREATE TABLE IF NOT EXISTS ${name} (${table.columns
    .map(([col, type]) => `${col} ${type}`)
    .join(", ")})`;

const createIndexSql = (tableName: string, idx: SchemaIndex): string => {
  const unique = idx.unique ? "UNIQUE " : "";
  return `CREATE ${unique}INDEX IF NOT EXISTS ${idx.name} ON ${tableName}(${idx.columns.join(
    ", ",
  )})`;
};

const sqlString = (value: string): string => `'${value.replaceAll("'", "''")}'`;

const TEST_SCHEMA_SQL = `${[
  ...SCHEMA.map(createTableSql),
  ...SCHEMA.flatMap(([name, table]) =>
    (table.indexes ?? []).map((idx) => createIndexSql(name, idx)),
  ),
  ...TRIGGERS.map((trigger) => trigger.sql),
  `INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_db_update', ${sqlString(
    LATEST_UPDATE,
  )})`,
  `INSERT OR REPLACE INTO settings (key, value) VALUES ('db_schema_hash', ${sqlString(
    SCHEMA_HASH,
  )})`,
  ...MIGRATIONS.map(
    (migration) =>
      `INSERT OR REPLACE INTO ${SCHEMA_MIGRATIONS_TABLE} (id, description, applied_at) VALUES (${sqlString(
        migration.id,
      )}, ${sqlString(migration.description)}, '2026-01-01T00:00:00.000Z')`,
  ),
].join(";\n")};`;

// Golden DB: schema + default attendee status built once per worker, then
// copied per test instead of re-executing 100+ CREATE TABLE/INDEX/TRIGGER
// statements on every beforeEach.
const getOrCreateGoldenDb: () => Promise<string> = once(
  async (): Promise<string> => {
    const path = await createTrackedTestDbFile("-golden.db");
    const client = createClient({ url: `file:${path}` });
    setDb(client);
    await client.executeMultiple(
      "PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;",
    );
    await client.executeMultiple(TEST_SCHEMA_SQL);
    await ensureDefaultAttendeeStatus();
    client.close();
    setDb(null);
    return path;
  },
);

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
  // Copy the golden DB (schema + default status, built once per worker) rather
  // than re-running the schema SQL on every test — a file copy is much cheaper
  // than executing 100+ CREATE TABLE / INDEX / TRIGGER statements.
  const goldenPath = await getOrCreateGoldenDb();
  const path = await createTrackedTestDbFile(".db");
  await Deno.copyFile(goldenPath, path);
  setTestEnv({
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
  const restoreEnv = setTestEnv({
    DB_URL: `file:${path}`,
    DISABLE_AGGREGATE_TRIGGERS_FOR_TEST: "1",
  });
  const client = createClient({ url: `file:${path}` });
  setDb(client);
  await client.executeMultiple("PRAGMA synchronous=OFF;");
  return async () => {
    setDb(null);
    client.close();
    restoreEnv();
    cleanupTestDbPath(path);
  };
};

export const createTestDbWithSetup = async (
  country = "GB",
  triggers = false,
): Promise<void> => {
  await prepareTestClient(triggers);
  resetTestSession();

  if (getCachedSetupSettings()) {
    // Restore settings and users in one batch rather than N sequential round-trips.
    await getDb().batch(
      [
        { args: [], sql: "DELETE FROM settings" },
        ...getCachedSetupSettings()!.map((row) =>
          insert("settings", { key: row.key, value: row.value }),
        ),
        ...getCachedSetupUsers()!.map((row) =>
          insert("users", {
            admin_level: row.admin_level as InValue,
            id: row.id as InValue,
            invite_code_hash: row.invite_code_hash as InValue,
            invite_expiry: row.invite_expiry as InValue,
            invite_wrapped_data_key: row.invite_wrapped_data_key as InValue,
            kek_version: row.kek_version as InValue,
            password_hash: row.password_hash as InValue,
            username_hash: row.username_hash as InValue,
            username_index: row.username_index as InValue,
            wrapped_data_key: row.wrapped_data_key as InValue,
          }),
        ),
      ],
      "write",
    );
    settings.invalidateCache();
    await settings.loadKeys(ALL_SETTINGS_KEYS);

    settings.setForTest({ timezone: "UTC" });
    return;
  }

  await settings.setup.complete(
    TEST_ADMIN_USERNAME,
    TEST_ADMIN_PASSWORD,
    country,
  );
  await settings.loadKeys(ALL_SETTINGS_KEYS);

  settings.setForTest({ timezone: "UTC" });

  const result = await getDb().execute("SELECT key, value FROM settings");
  setCachedSetupSettings(
    result.rows.map((r) => ({
      key: r.key as string,
      value: r.value as string,
    })),
  );

  const usersResult = await getDb().execute("SELECT * FROM users");
  setCachedSetupUsers(usersResult.rows.map((r) => ({ ...r })));

  const session = await createDirectAdminSession();
  const sessionsResult = await getDb().execute(
    `SELECT token, csrf_token, expires,
            wrapped_data_key, user_id
     FROM sessions LIMIT 1`,
  );
  if (sessionsResult.rows.length > 0) {
    const row = sessionsResult.rows[0] as Row;
    setCachedAdminSession({
      cookie: session.cookie,
      sessionRow: {
        csrf_token: row.csrf_token as string,
        expires: row.expires as number,
        token: row.token as string,
        user_id: row.user_id as number | null,
        wrapped_data_key: row.wrapped_data_key as string | null,
      },
    });
  }
  setTestSession(session);
};

const createDirectAdminSession = async (): Promise<{
  cookie: string;
  csrfToken: string;
}> => {
  const { generateSecureToken } = await import("#shared/crypto/utils.ts");
  const { deriveKEKFromPassword, unwrapKey, wrapKeyWithToken } = await import(
    "#shared/crypto/keys.ts"
  );
  const { createSession: createDbSession } = await import(
    "#shared/db/sessions.ts"
  );
  const { buildSessionCookie } = await import("#shared/cookies.ts");
  const { getUserByUsername, verifyUserPassword } = await import(
    "#shared/db/users.ts"
  );
  const { nowMs } = await import("#shared/now.ts");

  const user = (await getUserByUsername(TEST_ADMIN_USERNAME))!;
  const ownerHash = (await verifyUserPassword(user, TEST_ADMIN_PASSWORD))!;
  const kek = await deriveKEKFromPassword(TEST_ADMIN_PASSWORD, ownerHash);
  const dataKey = await unwrapKey(user.wrapped_data_key!, kek);

  const token = generateSecureToken();
  const csrfToken = generateSecureToken();
  const expires = nowMs() + 24 * 60 * 60 * 1000;
  const wrappedDataKey = await wrapKeyWithToken(dataKey, token);
  await createDbSession(token, csrfToken, expires, wrappedDataKey, user.id);

  const cookie = buildSessionCookie(token);
  const signedCsrf = await signCsrfToken();
  return { cookie, csrfToken: signedCsrf };
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

export const invalidateTestDbCache = (): void => {
  setCachedSetupSettings(null);
  setCachedSetupUsers(null);
  setCachedAdminSession(null);
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
const applyStorageConfig = async (
  storage: DescribeEnvOptions["storage"],
): Promise<void> => {
  if (storage === "cdn") {
    setStorageConfigForTest({
      localPath: "",
      zoneKey: TEST_STORAGE_ZONE.zoneKey,
      zoneName: TEST_STORAGE_ZONE.zoneName,
    });
    return;
  }
  if (storage === "local") {
    const dir = await Deno.makeTempDir();
    setTestStoragePath(dir);
    setStorageConfigForTest({ localPath: dir, zoneKey: "", zoneName: "" });
  }
};

/** Clear the suite-level storage config and remove any `"local"` temp dir. */
const teardownStorageConfig = async (): Promise<void> => {
  setStorageConfigForTest(null);
  const dir = getTestStoragePath();
  if (!dir) return;
  setTestStoragePath(null);
  await Deno.remove(dir, { recursive: true });
};

export const describeWithEnv = (
  name: string,
  options: DescribeEnvOptions,
  fn: () => void,
): void => {
  describe(name, () => {
    let restoreEnv: (() => void) | undefined;
    beforeEach(async () => {
      if (options.encryptionKey) setupTestEncryptionKey();
      if (options.db) {
        resetTestSlugCounter();
        setHostEmailConfigForTest(null);
        settings.appleWallet.setHostConfigForTest(null);
        settings.googleWallet.setHostConfigForTest(null);
        await createTestDbWithSetup("GB", options.triggers ?? false);
      }
      if (options.env) restoreEnv = setTestEnv(options.env);
      await applyStorageConfig(options.storage);
    });
    afterEach(async () => {
      if (options.db) resetDb();
      if (restoreEnv) restoreEnv();
      restoreEnv = undefined;
      await teardownStorageConfig();
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

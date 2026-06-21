import { createClient, type InValue, type Row } from "@libsql/client";
import { afterEach, beforeEach, describe } from "@std/testing/bdd";
import { resetEffectiveDomain } from "#shared/config.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { ensureDefaultAttendeeStatus } from "#shared/db/attendee-statuses.ts";
import { getDb, insert, queryOne, setDb } from "#shared/db/client.ts";
import { invalidateGroupsCache } from "#shared/db/groups.ts";
import { invalidateHolidaysCache } from "#shared/db/holidays.ts";
import { invalidateListingsCache } from "#shared/db/listings.ts";
import { invalidateLogisticsAgentsCache } from "#shared/db/logistics-agents.ts";
import {
  SCHEMA,
  SCHEMA_MIGRATIONS_TABLE,
  TRIGGERS,
} from "#shared/db/migrations/schema.ts";
import {
  LATEST_UPDATE,
  MIGRATIONS,
  SCHEMA_HASH,
} from "#shared/db/migrations.ts";
import { resetSessionCache } from "#shared/db/sessions.ts";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { invalidateUsersCache } from "#shared/db/users.ts";
import { setDemoModeForTest } from "#shared/demo.ts";
import {
  resetHostEmailConfig,
  setHostEmailConfigForTest,
} from "#shared/email.ts";
import { setTestEnv, setupTestEncryptionKey } from "#test-utils/env.ts";
import {
  type DescribeEnvOptions,
  getCachedSetupSettings,
  getCachedSetupUsers,
  type RawListingRange,
  resetTestSession,
  resetTestSlugCounter,
  setCachedAdminSession,
  setCachedSetupSettings,
  setCachedSetupUsers,
  setTestSession,
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";

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

const prepareTestClient = async (triggers = false): Promise<void> => {
  setupTestEncryptionKey();
  settings.setup.clearCache();
  resetSessionCache();
  invalidateUsersCache();
  invalidateListingsCache();
  invalidateHolidaysCache();
  invalidateGroupsCache();
  invalidateLogisticsAgentsCache();

  setTestEnv({
    DB_URL: ":memory:",
    DISABLE_AGGREGATE_TRIGGERS_FOR_TEST: triggers ? undefined : "1",
  });
  const client = createClient({ url: ":memory:" });
  setDb(client);
  await client.executeMultiple(TEST_SCHEMA_SQL);
  await ensureDefaultAttendeeStatus();
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
  setupTestEncryptionKey();
  const path = await Deno.makeTempFile({ suffix: ".db" });
  const restoreEnv = setTestEnv({
    DB_URL: `file:${path}`,
    DISABLE_AGGREGATE_TRIGGERS_FOR_TEST: "1",
  });
  const client = createClient({ url: `file:${path}` });
  setDb(client);
  await client.executeMultiple(TEST_SCHEMA_SQL);
  return async () => {
    setDb(null);
    client.close();
    restoreEnv();
    await Deno.remove(path);
  };
};

export const createTestDbWithSetup = async (
  country = "GB",
  triggers = false,
): Promise<void> => {
  await prepareTestClient(triggers);
  resetTestSession();

  if (getCachedSetupSettings()) {
    getDb().execute("DELETE FROM settings");
    for (const row of getCachedSetupSettings()!) {
      await getDb().execute(
        insert("settings", {
          key: row.key,
          value: row.value,
        }),
      );
    }
    if (getCachedSetupUsers()) {
      for (const row of getCachedSetupUsers()!) {
        await getDb().execute(
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
        );
      }
    }
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

  const user = await getUserByUsername(TEST_ADMIN_USERNAME);
  if (!user?.wrapped_data_key) {
    throw new Error("Admin user not found after setup");
  }
  const ownerHash = (await verifyUserPassword(user, TEST_ADMIN_PASSWORD))!;
  const kek = await deriveKEKFromPassword(TEST_ADMIN_PASSWORD, ownerHash);
  const dataKey = await unwrapKey(user.wrapped_data_key, kek);

  const token = generateSecureToken();
  const csrfToken = generateSecureToken();
  const expires = nowMs() + 24 * 60 * 60 * 1000;
  const wrappedDataKey = await wrapKeyWithToken(dataKey, token);
  await createDbSession(token, csrfToken, expires, wrappedDataKey, user.id);

  const cookie = buildSessionCookie(token);
  const signedCsrf = await signCsrfToken();
  return { cookie, csrfToken: signedCsrf };
};

export const resetDb = (): void => {
  setDb(null);
  settings.setup.clearCache();
  settings.invalidateCache();
  invalidateUsersCache();
  invalidateListingsCache();
  invalidateHolidaysCache();
  invalidateGroupsCache();
  invalidateLogisticsAgentsCache();
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
    });
    afterEach(() => {
      if (options.db) resetDb();
      if (restoreEnv) restoreEnv();
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

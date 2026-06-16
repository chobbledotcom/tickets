import { createClient, type InValue, type Row } from "@libsql/client";
import { afterEach, beforeEach, describe } from "@std/testing/bdd";
import { resetEffectiveDomain } from "#shared/config.ts";
import { signCsrfToken } from "#shared/csrf.ts";
import { getDb, insert, queryOne, setDb } from "#shared/db/client.ts";
import { invalidateDeliveryAgentsCache } from "#shared/db/delivery-agents.ts";
import { invalidateGroupsCache } from "#shared/db/groups.ts";
import { invalidateHolidaysCache } from "#shared/db/holidays.ts";
import { invalidateListingsCache } from "#shared/db/listings.ts";
import { initDb } from "#shared/db/migrations.ts";
import { resetSessionCache } from "#shared/db/sessions.ts";
import { settings } from "#shared/db/settings.ts";
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

const prepareTestClient = async (): Promise<void> => {
  setupTestEncryptionKey();
  settings.setup.clearCache();
  resetSessionCache();
  invalidateUsersCache();
  invalidateListingsCache();
  invalidateHolidaysCache();
  invalidateGroupsCache();
  invalidateDeliveryAgentsCache();

  setTestEnv({ DB_URL: ":memory:" });
  const client = createClient({ url: ":memory:" });
  setDb(client);
  await initDb({ allowMissingSettings: true });
};

export const createTestDb = async (): Promise<void> => {
  await prepareTestClient();
  resetTestSession();
};

export const createTestDbWithSetup = async (country = "GB"): Promise<void> => {
  await prepareTestClient();
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
            password_hash: row.password_hash as InValue,
            username_hash: row.username_hash as InValue,
            username_index: row.username_index as InValue,
            wrapped_data_key: row.wrapped_data_key as InValue,
          }),
        );
      }
    }
    settings.invalidateCache();
    await settings.loadAll();

    settings.setForTest({ timezone: "UTC" });
    return;
  }

  await settings.setup.complete(
    TEST_ADMIN_USERNAME,
    TEST_ADMIN_PASSWORD,
    country,
  );
  await settings.loadAll();

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
  const { deriveKEK, unwrapKey, wrapKeyWithToken } = await import(
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
  const passwordHash = await verifyUserPassword(user, TEST_ADMIN_PASSWORD);
  if (!passwordHash) {
    throw new Error("Admin password verification failed after setup");
  }
  const kek = await deriveKEK(passwordHash);
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
  invalidateDeliveryAgentsCache();
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
        await createTestDbWithSetup();
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

/**
 * Run-scoped test state: the golden schema database plus the completed
 * site-setup rows (settings, users, admin session) that DB tests start from.
 *
 * Building this state is expensive — 100+ CREATE statements, ~80 migration
 * modules, a password hash, an RSA keypair, key wrapping — and module state is
 * per test file (each file runs in its own isolate), so without sharing, every
 * DB-using test file rebuilds all of it. The test harness therefore builds it
 * once per run (`writeTestState`, called from scripts/test-harness.ts) into a
 * directory exported as TICKETS_TEST_STATE_DIR; every test isolate then seeds
 * itself from that directory for the cost of a file copy and one JSON read.
 * Without the env var — a bare `deno test` on a single file — the same
 * builders run in-isolate on first use, exactly as they always have.
 *
 * Note for mutation testing: the harness builds this state before any mutant
 * is applied, so a mutant inside the setup ceremony itself is only exercised
 * by tests that run the ceremony directly (e.g. the setup-route tests), not by
 * every DB test's fixture. Those direct tests are the ones that must kill it.
 */

import { join } from "node:path";
import { createClient, type InValue, type Row } from "@libsql/client";
import { lazyRef, once } from "#fp";
import { signCsrfToken } from "#shared/csrf.ts";
import {
  attendeeStatuses,
  ensureDefaultAttendeeStatus,
} from "#shared/db/attendee-statuses.ts";
import { getDb, insert, setDb } from "#shared/db/client.ts";
import { SCHEMA } from "#shared/db/migrations/schema/index.ts";
import { TRIGGERS } from "#shared/db/migrations/schema/triggers.ts";
import { SCHEMA_MIGRATIONS_TABLE } from "#shared/db/migrations/schema/version.ts";
import {
  LATEST_UPDATE,
  loadMigrations,
  SCHEMA_HASH,
} from "#shared/db/migrations.ts";
import { ALL_SETTINGS_KEYS, settings } from "#shared/db/settings.ts";
import { setTestEnv, setupTestEncryptionKey } from "#test-utils/env.ts";
import {
  TEST_ADMIN_PASSWORD,
  TEST_ADMIN_USERNAME,
} from "#test-utils/internal.ts";
import {
  createTrackedTestDbFile,
  DB_FILE_SUFFIXES,
} from "#test-utils/temp-db-files.ts";

/** Directory holding the run-wide prebuilt state (golden.db + state.json). */
export const TEST_STATE_DIR_ENV = "TICKETS_TEST_STATE_DIR";

const GOLDEN_DB_FILE = "golden.db";
const STATE_JSON_FILE = "state.json";

type AdminSessionRow = {
  token: string;
  csrf_token: string;
  expires: number;
  wrapped_data_key: string | null;
  user_id: number | null;
};

type AdminSessionCache = {
  cookie: string;
  sessionRow: AdminSessionRow;
} | null;

/**
 * Everything the initial site-setup ceremony produced, captured so it can be
 * replayed into a fresh per-test database instead of re-running the ceremony.
 */
export type SetupState = {
  country: string;
  settings: { key: string; value: string }[];
  users: Row[];
  session: AdminSessionCache;
};

// The setup state the current isolate last replayed (or built). Cleared by
// invalidateTestDbCache so a test can force the next fixture through the real
// ceremony.
export const [getSetupState, setSetupState] = lazyRef<SetupState | null>(
  () => null,
);

// Once a test explicitly invalidates, the run-wide snapshot must not quietly
// re-seed the very state the test wanted rebuilt from scratch.
const [isSnapshotDisabled, setSnapshotDisabled] = lazyRef<boolean>(() => false);

export const invalidateTestDbCache = (): void => {
  setSetupState(null);
  setSnapshotDisabled(true);
};

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

// Lazy (and cached): the migration modules are only needed to stamp a fresh
// schema, so isolates seeded from the run-wide snapshot never load them.
const buildTestSchemaSql = once(async (): Promise<string> => {
  const migrations = await loadMigrations();
  return `${[
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
    ...migrations.map(
      (migration) =>
        `INSERT OR REPLACE INTO ${SCHEMA_MIGRATIONS_TABLE} (id, description, applied_at) VALUES (${sqlString(
          migration.id,
        )}, ${sqlString(migration.description)}, '2026-01-01T00:00:00.000Z')`,
    ),
  ].join(";\n")};`;
});

/** Build the full test schema plus the default attendee status into `path`. */
const createGoldenDbAt = async (path: string): Promise<void> => {
  const client = createClient({ url: `file:${path}` });
  setDb(client);
  await client.executeMultiple(
    "PRAGMA journal_mode=MEMORY; PRAGMA synchronous=OFF;",
  );
  await client.executeMultiple(await buildTestSchemaSql());
  await ensureDefaultAttendeeStatus();
  attendeeStatuses.invalidate();
  client.close();
  setDb(null);
};

/**
 * Parse and shape-check a state.json. The file is written by this same module
 * earlier in the run, so a bad shape means the harness is broken — throw.
 */
const parseSetupState = (json: string): SetupState => {
  const state = JSON.parse(json) as SetupState;
  if (
    typeof state.country !== "string" ||
    !Array.isArray(state.settings) ||
    !Array.isArray(state.users)
  ) {
    throw new Error(
      `Prebuilt test state is malformed — rebuild it (${TEST_STATE_DIR_ENV})`,
    );
  }
  return state;
};

/**
 * The run-wide prebuilt state, if the harness exported one. Read once per
 * isolate. An env var pointing at unreadable files is a harness bug and
 * throws — silently rebuilding per file would hide it as slowness.
 */
const readSnapshot = once(
  (): { goldenPath: string; state: SetupState } | null => {
    const dir = Deno.env.get(TEST_STATE_DIR_ENV);
    if (!dir) return null;
    const json = Deno.readTextFileSync(join(dir, STATE_JSON_FILE));
    return {
      goldenPath: join(dir, GOLDEN_DB_FILE),
      state: parseSetupState(json),
    };
  },
);

/**
 * Path of the golden DB every test copies its fresh database from: the
 * run-wide one when the harness prebuilt it, else built once per isolate.
 */
export const getOrCreateGoldenDb: () => Promise<string> = once(
  async (): Promise<string> => {
    const snapshot = readSnapshot();
    if (snapshot) return snapshot.goldenPath;
    const path = await createTrackedTestDbFile("-golden.db");
    await createGoldenDbAt(path);
    return path;
  },
);

/**
 * The setup state to replay for `country`: the isolate's last-used state when
 * it matches, else the run-wide snapshot — unless a test explicitly
 * invalidated, which pins the next fixture to the real ceremony.
 */
export const reusableSetupState = (country: string): SetupState | null => {
  const cached = getSetupState();
  if (cached && cached.country === country) return cached;
  if (isSnapshotDisabled()) return null;
  const snapshot = readSnapshot();
  return snapshot && snapshot.state.country === country ? snapshot.state : null;
};

/** Replay captured setup rows into the active (fresh) test database. One
 * batch, not N round-trips. */
export const replaySetupState = async (state: SetupState): Promise<void> => {
  await getDb().batch(
    [
      { args: [], sql: "DELETE FROM settings" },
      ...state.settings.map((row) =>
        insert("settings", { key: row.key, value: row.value }),
      ),
      ...state.users.map((row) =>
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
  setSetupState(state);
};

/** Log in the standard test admin directly (no HTTP), returning the session
 * cookie and a signed CSRF token. */
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

/**
 * Run the real site-setup ceremony against the active test database and
 * capture everything it produced (settings rows, user rows, a live admin
 * session) as a replayable SetupState. Also returns the live session so the
 * calling test file can adopt it directly.
 */
export const runSetupCeremony = async (
  country: string,
): Promise<{
  state: SetupState;
  liveSession: { cookie: string; csrfToken: string };
}> => {
  await settings.setup.complete(
    TEST_ADMIN_USERNAME,
    TEST_ADMIN_PASSWORD,
    country,
  );
  await settings.loadKeys(ALL_SETTINGS_KEYS);
  settings.setForTest({ timezone: "UTC" });

  const settingsResult = await getDb().execute(
    "SELECT key, value FROM settings",
  );
  const settingsRows = settingsResult.rows.map((r) => ({
    key: r.key as string,
    value: r.value as string,
  }));
  const usersResult = await getDb().execute("SELECT * FROM users");
  const users = usersResult.rows.map((r) => ({ ...r }));

  const liveSession = await createDirectAdminSession();
  const sessionsResult = await getDb().execute(
    `SELECT token, csrf_token, expires,
            wrapped_data_key, user_id
     FROM sessions LIMIT 1`,
  );
  const sessionRow = sessionsResult.rows[0] as Row | undefined;
  const session: AdminSessionCache = sessionRow
    ? {
        cookie: liveSession.cookie,
        sessionRow: {
          csrf_token: sessionRow.csrf_token as string,
          expires: sessionRow.expires as number,
          token: sessionRow.token as string,
          user_id: sessionRow.user_id as number | null,
          wrapped_data_key: sessionRow.wrapped_data_key as string | null,
        },
      }
    : null;

  return {
    liveSession,
    state: { country, session, settings: settingsRows, users },
  };
};

/**
 * Build the full run-wide test state into `dir`: the golden schema DB plus a
 * state.json of the completed setup ceremony. Called once per run by the test
 * harness, in the harness process, before any test spawns.
 */
export const writeTestState = async (dir: string): Promise<void> => {
  setupTestEncryptionKey();
  const goldenPath = join(dir, GOLDEN_DB_FILE);
  await createGoldenDbAt(goldenPath);

  // Run the ceremony on a scratch copy so the golden stays schema-only (it
  // also backs createTestDb fixtures that must start without any setup).
  const workPath = join(dir, "setup-work.db");
  await Deno.copyFile(goldenPath, workPath);
  const restoreEnv = setTestEnv({
    DB_URL: `file:${workPath}`,
    DISABLE_AGGREGATE_TRIGGERS_FOR_TEST: "1",
  });
  const client = createClient({ url: `file:${workPath}` });
  setDb(client);
  await client.executeMultiple("PRAGMA synchronous=OFF;");
  try {
    const { state } = await runSetupCeremony("GB");
    await Deno.writeTextFile(join(dir, STATE_JSON_FILE), JSON.stringify(state));
  } finally {
    setDb(null);
    client.close();
    restoreEnv();
    for (const suffix of DB_FILE_SUFFIXES) {
      await Deno.remove(workPath + suffix).catch(() => {
        // scratch side-files may legitimately not exist
      });
    }
  }
};

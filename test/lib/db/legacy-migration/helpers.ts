import { createClient, type ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { insert, setDb } from "#shared/db/client.ts";
import { resetDb, setupTestEncryptionKey } from "#test-utils";
import {
  cleanupTestDbPath,
  createTrackedTestDbFile,
} from "#test-utils/temp-db-files.ts";

/**
 * Shared setup for the legacy-schema migration tests: the full on-main
 * ("legacy") schema, the fixtures that build a legacy database, and the small
 * assertions each test reuses. Split out so the six migration tests — each of
 * which runs a full `initDb()` upgrade — can live in separate shard files that
 * `deno test --parallel` runs at the same time instead of one ~13s sequential
 * file.
 *
 * Migration context: these tests verify that migrating from the main-branch
 * schema (attendees with a listing_id FK) to the current schema
 * (listing_attendees table) works even when `PRAGMA foreign_keys=OFF` is
 * ineffective, as happens on remote libsql / Turso where the pragma doesn't
 * persist across HTTP requests.
 */

type Client = ReturnType<typeof createClient>;

export const LEGACY_DB_UPDATE = "legacy-update";
export const LEGACY_DB_SCHEMA_HASH = "legacy-schema-hash";

/** SQL statements that create the complete legacy schema (as on main) */
export const LEGACY_SCHEMA_SQL = [
  "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
  `CREATE TABLE listings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created TEXT NOT NULL,
      max_attendees INTEGER NOT NULL,
      thank_you_url TEXT,
      unit_price INTEGER,
      max_quantity INTEGER NOT NULL DEFAULT 1,
      webhook_url TEXT,
      slug TEXT,
      slug_index TEXT,
      group_id INTEGER NOT NULL DEFAULT 0,
      active INTEGER NOT NULL DEFAULT 1,
      fields TEXT NOT NULL DEFAULT 'email',
      closes_at TEXT,
      name TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      listing_type TEXT NOT NULL DEFAULT 'standard',
      bookable_days TEXT NOT NULL DEFAULT '["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]',
      minimum_days_before INTEGER NOT NULL DEFAULT 1,
      maximum_days_after INTEGER NOT NULL DEFAULT 90,
      date TEXT NOT NULL DEFAULT '',
      location TEXT NOT NULL DEFAULT '',
      image_url TEXT NOT NULL DEFAULT '',
      attachment_url TEXT NOT NULL DEFAULT '',
      attachment_name TEXT NOT NULL DEFAULT '',
      non_transferable INTEGER NOT NULL DEFAULT 0,
      can_pay_more INTEGER NOT NULL DEFAULT 0,
      hidden INTEGER NOT NULL DEFAULT 0,
      max_price INTEGER NOT NULL DEFAULT 0
    )`,
  "CREATE UNIQUE INDEX idx_listings_slug_index ON listings(slug_index)",
  `CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username_hash TEXT NOT NULL,
      username_index TEXT NOT NULL,
      password_hash TEXT NOT NULL DEFAULT '',
      wrapped_data_key TEXT,
      admin_level TEXT NOT NULL,
      invite_code_hash TEXT,
      invite_expiry TEXT
    )`,
  "CREATE UNIQUE INDEX idx_users_username_index ON users(username_index)",
  `CREATE TABLE sessions (
      token TEXT PRIMARY KEY,
      csrf_token TEXT NOT NULL,
      expires INTEGER NOT NULL,
      wrapped_data_key TEXT,
      user_id INTEGER
    )`,
  `CREATE TABLE login_attempts (
      ip TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      locked_until INTEGER
    )`,
  `CREATE TABLE attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      created TEXT NOT NULL,
      payment_id TEXT,
      quantity INTEGER NOT NULL DEFAULT 1,
      phone TEXT NOT NULL DEFAULT '',
      ticket_token TEXT NOT NULL DEFAULT '',
      price_paid TEXT,
      checked_in TEXT NOT NULL DEFAULT '',
      date TEXT DEFAULT NULL,
      address TEXT NOT NULL DEFAULT '',
      special_instructions TEXT NOT NULL DEFAULT '',
      ticket_token_index TEXT,
      refunded TEXT NOT NULL DEFAULT '',
      attachment_downloads INTEGER NOT NULL DEFAULT 0,
      pii_blob TEXT NOT NULL DEFAULT '',
      checked_in_v2 INTEGER NOT NULL DEFAULT 0,
      refunded_v2 INTEGER NOT NULL DEFAULT 0,
      price_paid_v2 INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (listing_id) REFERENCES listings(id)
    )`,
  `CREATE UNIQUE INDEX
     idx_attendees_ticket_token_index
     ON attendees(ticket_token_index)`,
  `CREATE TABLE processed_payments (
      payment_session_id TEXT PRIMARY KEY,
      attendee_id INTEGER,
      processed_at TEXT NOT NULL,
      ticket_tokens TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (attendee_id) REFERENCES attendees(id)
    )`,
  `CREATE TABLE activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created TEXT NOT NULL,
      listing_id INTEGER,
      message TEXT NOT NULL,
      FOREIGN KEY (listing_id) REFERENCES listings(id) ON DELETE SET NULL
    )`,
  `CREATE TABLE groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL,
      slug_index TEXT NOT NULL,
      name TEXT NOT NULL,
      terms_and_conditions TEXT NOT NULL DEFAULT '',
      max_attendees INTEGER NOT NULL DEFAULT 0
    )`,
  "CREATE UNIQUE INDEX idx_groups_slug_index ON groups(slug_index)",
  `CREATE TABLE holidays (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL
    )`,
  `CREATE TABLE api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      key_index TEXT NOT NULL,
      wrapped_data_key TEXT NOT NULL,
      name TEXT NOT NULL,
      created TEXT NOT NULL,
      last_used TEXT NOT NULL DEFAULT '',
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`,
  "CREATE UNIQUE INDEX idx_api_keys_key_index ON api_keys(key_index)",
  `CREATE TABLE questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL
    )`,
  `CREATE TABLE answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      text TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (question_id) REFERENCES questions(id)
    )`,
  "CREATE INDEX idx_answers_question_id ON answers(question_id)",
  `CREATE TABLE listing_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (listing_id) REFERENCES listings(id),
      FOREIGN KEY (question_id) REFERENCES questions(id)
    )`,
  "CREATE INDEX idx_listing_questions_listing_id ON listing_questions(listing_id)",
  `CREATE UNIQUE INDEX
     idx_listing_questions_unique
     ON listing_questions(listing_id, question_id)`,
  `CREATE TABLE built_sites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      site_data TEXT NOT NULL,
      created TEXT NOT NULL
    )`,
  `CREATE TABLE attendee_answers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      attendee_id INTEGER NOT NULL,
      answer_id INTEGER NOT NULL,
      FOREIGN KEY (attendee_id) REFERENCES attendees(id),
      FOREIGN KEY (answer_id) REFERENCES answers(id)
    )`,
  `CREATE INDEX idx_attendee_answers_attendee_id
     ON attendee_answers(attendee_id)`,
  `CREATE INDEX idx_attendee_answers_answer_id
     ON attendee_answers(answer_id)`,
  `CREATE UNIQUE INDEX
     idx_attendee_answers_unique
     ON attendee_answers(attendee_id, answer_id)`,
];

/** Seed the two legacy schema-version markers a legacy database carries. */
export const seedLegacySchemaMarkers = async (
  client: Client,
): Promise<void> => {
  await client.execute({
    args: ["latest_db_update", LEGACY_DB_UPDATE],
    sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
  });
  await client.execute({
    args: ["db_schema_hash", LEGACY_DB_SCHEMA_HASH],
    sql: "INSERT INTO settings (key, value) VALUES (?, ?)",
  });
};

/**
 * Stub `PRAGMA foreign_keys = OFF` to be a no-op. This simulates remote libsql
 * (Turso) where the pragma doesn't persist across HTTP requests.
 */
export const stubPragmaForeignKeysOff = (client: Client) => {
  const origExecute = client.execute.bind(client);
  return stub(client, "execute", (stmt: unknown) => {
    const sql = typeof stmt === "string" ? stmt : (stmt as { sql: string }).sql;
    if (/PRAGMA\s+foreign_keys\s*=\s*OFF/i.test(sql)) {
      return Promise.resolve({
        columns: [],
        columnTypes: [],
        lastInsertRowid: 0n,
        rows: [],
        rowsAffected: 0,
        toJSON: () => ({
          columns: [],
          columnTypes: [],
          lastInsertRowid: "0",
          rows: [],
          rowsAffected: 0,
        }),
      } as ResultSet);
    }
    return origExecute(stmt as Parameters<typeof origExecute>[0]);
  });
};

/** Assert which columns are absent from / present on the attendees table. */
export const expectAttendeeCols = async (
  client: Client,
  absent: readonly string[],
  present: readonly string[],
): Promise<void> => {
  const cols = await client.execute("PRAGMA table_info(attendees)");
  const colNames = cols.rows.map((r) => r.name);
  for (const col of absent) {
    expect(colNames).not.toContain(col);
  }
  for (const col of present) {
    expect(colNames).toContain(col);
  }
};

/**
 * A per-file harness that tracks the temp file databases a shard opens and
 * cleans them up. `recreateTable` rebuilds inside an interactive transaction,
 * which opens a second connection — so these tests use a temp file rather than
 * `:memory:` (each `:memory:` connection is its own empty database).
 */
export type LegacyMigrationHarness = {
  newFileDb: () => Promise<Client>;
  createLegacyDb: () => Promise<Client>;
  createLegacyDbWithListing: () => Promise<Client>;
  cleanup: () => Promise<void>;
};

export const createLegacyMigrationHarness = (): LegacyMigrationHarness => {
  const openFileDbs: Array<{ client: Client; path: string }> = [];

  const newFileDb = async (): Promise<Client> => {
    const path = await createTrackedTestDbFile(".db");
    const client = createClient({ url: `file:${path}` });
    openFileDbs.push({ client, path });
    return client;
  };

  /** Create the legacy schema and return the client. */
  const createLegacyDb = async (): Promise<Client> => {
    setupTestEncryptionKey();
    const client = await newFileDb();
    setDb(client);
    for (const sql of LEGACY_SCHEMA_SQL) {
      await client.execute(sql);
    }
    await seedLegacySchemaMarkers(client);
    return client;
  };

  /**
   * A legacy DB with FK enforcement on and one listing row — the shared setup
   * for the "adds display type" and "deletes under FK" migration tests.
   */
  const createLegacyDbWithListing = async (): Promise<Client> => {
    const client = await createLegacyDb();
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute(
      insert("listings", {
        created: "2024-01-01T00:00:00Z",
        id: 1,
        max_attendees: 100,
        name: "Test Listing",
      }),
    );
    return client;
  };

  const cleanup = async (): Promise<void> => {
    resetDb();
    for (const { client, path } of openFileDbs.splice(0)) {
      client.close();
      cleanupTestDbPath(path);
    }
  };

  return { cleanup, createLegacyDb, createLegacyDbWithListing, newFileDb };
};

import { createClient, type ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { insert, setDb } from "#lib/db/client.ts";
import { initDb } from "#lib/db/migrations.ts";
import { resetDb, setupTestEncryptionKey } from "#test-utils";

/**
 * Migration test: verifies that migrating from the main-branch schema
 * (attendees with event_id FK) to the new schema (event_attendees table)
 * works correctly even when PRAGMA foreign_keys=OFF is ineffective
 * (as happens in remote libsql / Turso where it doesn't persist across
 * HTTP requests).
 */
describe("db > event_attendees migration from legacy schema", () => {
  afterEach(() => {
    resetDb();
  });

  /** SQL statements that create the complete legacy schema (as on main) */
  const LEGACY_SCHEMA_SQL = [
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    `CREATE TABLE events (
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
      event_type TEXT NOT NULL DEFAULT 'standard',
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
    "CREATE UNIQUE INDEX idx_events_slug_index ON events(slug_index)",
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
      event_id INTEGER NOT NULL,
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
      FOREIGN KEY (event_id) REFERENCES events(id)
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
      event_id INTEGER,
      message TEXT NOT NULL,
      FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL
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
    `CREATE TABLE event_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (event_id) REFERENCES events(id),
      FOREIGN KEY (question_id) REFERENCES questions(id)
    )`,
    "CREATE INDEX idx_event_questions_event_id ON event_questions(event_id)",
    `CREATE UNIQUE INDEX
     idx_event_questions_unique
     ON event_questions(event_id, question_id)`,
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

  /** Create the legacy schema and return the client */
  const createLegacyDb = async () => {
    setupTestEncryptionKey();
    const client = createClient({ url: ":memory:" });
    setDb(client);
    for (const sql of LEGACY_SCHEMA_SQL) {
      await client.execute(sql);
    }
    return client;
  };

  /**
   * Stub PRAGMA foreign_keys = OFF to be a no-op.
   * This simulates remote libsql (Turso) where PRAGMA doesn't persist
   * across HTTP requests.
   */
  const stubPragmaForeignKeysOff = (
    client: ReturnType<typeof createClient>,
  ) => {
    const origExecute = client.execute.bind(client);
    return stub(client, "execute", (stmt: unknown) => {
      const sql =
        typeof stmt === "string" ? stmt : (stmt as { sql: string }).sql;
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

  test("migration backfills event_attendees and preserves processed_payments", async () => {
    const client = await createLegacyDb();

    await client.execute(
      insert("events", {
        created: "2024-01-01T00:00:00Z",
        id: 1,
        max_attendees: 100,
        name: "Test Event",
      }),
    );
    await client.execute(
      insert("attendees", {
        checked_in_v2: 0,
        created: "2024-01-01T00:00:00Z",
        date: "2024-06-15",
        email: "test@example.com",
        event_id: 1,
        id: 1,
        name: "Test User",
        price_paid_v2: 1000,
        quantity: 2,
        refunded_v2: 0,
      }),
    );
    await client.execute(
      insert("processed_payments", {
        attendee_id: 1,
        payment_session_id: "ps_test_123",
        processed_at: "2024-01-01T00:00:00Z",
      }),
    );

    const pragmaStub = stubPragmaForeignKeysOff(client);
    try {
      await initDb();
    } finally {
      pragmaStub.restore();
    }

    const ea = await client.execute("SELECT * FROM event_attendees");
    expect(ea.rows.length).toBe(1);
    expect(ea.rows[0]!.event_id).toBe(1);
    expect(ea.rows[0]!.attendee_id).toBe(1);
    expect(ea.rows[0]!.quantity).toBe(2);
    expect(ea.rows[0]!.price_paid).toBe(1000);
    expect(ea.rows[0]!.start_at).toBe("2024-06-15T00:00:00Z");
    expect(ea.rows[0]!.end_at).toBe("2024-06-16T00:00:00Z");

    const cols = await client.execute("PRAGMA table_info(attendees)");
    const colNames = cols.rows.map((r) => r.name);
    expect(colNames).not.toContain("event_id");
    expect(colNames).not.toContain("date");
    expect(colNames).not.toContain("quantity");
    expect(colNames).toContain("id");
    expect(colNames).toContain("pii_blob");

    const payments = await client.execute("SELECT * FROM processed_payments");
    expect(payments.rows.length).toBe(1);
    expect(payments.rows[0]!.attendee_id).toBe(1);
  });
});

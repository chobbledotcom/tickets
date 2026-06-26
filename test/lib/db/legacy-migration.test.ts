import { createClient, type ResultSet } from "@libsql/client";
import { expect } from "@std/expect";
import { afterEach, describe, it as test } from "@std/testing/bdd";
import { stub } from "@std/testing/mock";
import { insert, setDb } from "#shared/db/client.ts";
import { deleteListing } from "#shared/db/listings.ts";
import { initDb, invalidateInitDbCache } from "#shared/db/migrations.ts";
import { resetDb, setupTestEncryptionKey } from "#test-utils";

/**
 * Migration test: verifies that migrating from the main-branch schema
 * (attendees with listing_id FK) to the new schema (listing_attendees table)
 * works correctly even when PRAGMA foreign_keys=OFF is ineffective
 * (as happens in remote libsql / Turso where it doesn't persist across
 * HTTP requests).
 */
describe("db > listing_attendees migration from legacy schema", () => {
  // recreateTable now rebuilds inside an interactive transaction, which opens a
  // second connection — so these tests use a temp file rather than ":memory:"
  // (each ":memory:" connection is its own empty database; see test-utils/db.ts).
  const openFileDbs: Array<{
    client: ReturnType<typeof createClient>;
    path: string;
  }> = [];

  const newFileDb = async (): Promise<ReturnType<typeof createClient>> => {
    const path = await Deno.makeTempFile({ suffix: ".db" });
    const client = createClient({ url: `file:${path}` });
    openFileDbs.push({ client, path });
    return client;
  };

  afterEach(async () => {
    resetDb();
    for (const { client, path } of openFileDbs.splice(0)) {
      try {
        client.close();
      } catch {
        // already closed
      }
      await Deno.remove(path).catch(() => {});
    }
  });

  const LEGACY_DB_UPDATE = "legacy-update";
  const LEGACY_DB_SCHEMA_HASH = "legacy-schema-hash";

  /** SQL statements that create the complete legacy schema (as on main) */
  const LEGACY_SCHEMA_SQL = [
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

  /** Create the legacy schema and return the client */
  const createLegacyDb = async () => {
    setupTestEncryptionKey();
    const client = await newFileDb();
    setDb(client);
    for (const sql of LEGACY_SCHEMA_SQL) {
      await client.execute(sql);
    }
    await seedLegacySchemaMarkers(client);
    return client;
  };

  /** Create a legacy DB with FK enforcement on and one listing row — the
   *  shared setup for the "adds display type" and "deletes under FK"
   *  migration tests. */
  const createLegacyDbWithListing = async () => {
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

  const seedLegacySchemaMarkers = async (
    client: ReturnType<typeof createClient>,
  ) => {
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

  const expectAttendeeCols = async (
    client: ReturnType<typeof createClient>,
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

  test("migration backfills listing_attendees, listing duration, and processed_payments", async () => {
    const client = await createLegacyDb();

    await client.execute(
      insert("listings", {
        created: "2024-01-01T00:00:00Z",
        id: 1,
        max_attendees: 100,
        name: "Test Listing",
      }),
    );
    await client.execute(
      insert("attendees", {
        checked_in_v2: 0,
        created: "2024-01-01T00:00:00Z",
        date: "2024-06-15",
        email: "test@example.com",
        id: 1,
        listing_id: 1,
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

    const listings = await client.execute("SELECT duration_days FROM listings");
    expect(listings.rows[0]!.duration_days).toBe(1);

    const ea = await client.execute("SELECT * FROM listing_attendees");
    expect(ea.rows.length).toBe(1);
    expect(ea.rows[0]!.listing_id).toBe(1);
    expect(ea.rows[0]!.attendee_id).toBe(1);
    expect(ea.rows[0]!.quantity).toBe(2);
    // price_paid is no longer a column — a booking's amount projects from the
    // transfers ledger. Like the dropped refunded flag, the legacy price_paid_v2
    // value isn't carried by the reconcile (no live site predates the ledger).
    expect(ea.rows[0]!.price_paid).toBeUndefined();
    expect(ea.rows[0]!.start_at).toBe("2024-06-15T00:00:00Z");
    expect(ea.rows[0]!.end_at).toBe("2024-06-16T00:00:00Z");

    // price_paid is dropped — amount paid is a per-row listing_attendees figure
    // (ledger-projected), never an attendees column.
    await expectAttendeeCols(
      client,
      [
        "address",
        "date",
        "email",
        "listing_id",
        "name",
        "payment_id",
        "phone",
        "price_paid",
        "quantity",
      ],
      ["id", "pii_blob"],
    );

    const payments = await client.execute("SELECT * FROM processed_payments");
    expect(payments.rows.length).toBe(1);
    expect(payments.rows[0]!.attendee_id).toBe(1);
  });

  test("adds question display type when legacy question tables have foreign keys", async () => {
    const client = await createLegacyDbWithListing();
    await client.execute(
      insert("questions", {
        id: 1,
        text: "Encrypted question",
      }),
    );
    await client.execute(
      insert("answers", {
        id: 1,
        question_id: 1,
        text: "Encrypted answer",
      }),
    );
    await client.execute(
      insert("listing_questions", {
        id: 1,
        listing_id: 1,
        question_id: 1,
      }),
    );

    const pragmaStub = stubPragmaForeignKeysOff(client);
    try {
      await initDb();
    } finally {
      pragmaStub.restore();
    }

    const questions = await client.execute(
      "SELECT id, text, sort_order, display_type FROM questions",
    );
    expect(questions.rows.length).toBe(1);
    expect(questions.rows[0]!.display_type).toBe("radio");
    expect(questions.rows[0]!.id).toBe(1);
    expect(questions.rows[0]!.text).toBe("Encrypted question");

    const answers = await client.execute(
      "SELECT id, question_id, text FROM answers",
    );
    expect(answers.rows).toEqual([
      { id: 1, question_id: 1, text: "Encrypted answer" },
    ]);
  });

  test("deletes a migrated listing and its question links under FK enforcement", async () => {
    const client = await createLegacyDbWithListing();
    await client.execute(insert("questions", { id: 1, text: "Encrypted" }));
    await client.execute(
      insert("listing_questions", { id: 1, listing_id: 1, question_id: 1 }),
    );

    const pragmaStub = stubPragmaForeignKeysOff(client);
    try {
      await initDb();
    } finally {
      pragmaStub.restore();
    }

    // The free-text migration rebuilds listing_questions FK-free (so the
    // questions table it references can itself be rebuilt to relax the
    // display_type CHECK). deleteListing still clears the link rows as part of
    // its cascade, so — even with FK enforcement on, as on the Turso primary —
    // deleting a listing with an assigned question succeeds and leaves no
    // orphaned links.
    await deleteListing(1);

    const listings = await client.execute("SELECT id FROM listings");
    expect(listings.rows.length).toBe(0);
    const links = await client.execute("SELECT id FROM listing_questions");
    expect(links.rows.length).toBe(0);
  });

  test("drops PII columns when listing_id was dropped in a prior partial run", async () => {
    setupTestEncryptionKey();
    const client = await newFileDb();
    setDb(client);

    // Simulate a DB in the intermediate state: listing_id and its relatives
    // have already been dropped (e.g. by a partial earlier migration), but
    // the pre-pii_blob PII columns are still present with NOT NULL.
    await client.execute(
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    await seedLegacySchemaMarkers(client);
    await client.execute(`CREATE TABLE attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      payment_id TEXT,
      created TEXT NOT NULL,
      ticket_token_index TEXT,
      pii_blob TEXT NOT NULL DEFAULT '',
      checked_in TEXT NOT NULL DEFAULT '',
      price_paid TEXT
    )`);

    await client.execute(
      insert("attendees", {
        created: "2024-03-01T00:00:00Z",
        email: "alice@example.com",
        id: 1,
        name: "Alice",
        pii_blob: "encrypted-data",
        ticket_token_index: "tok_abc",
      }),
    );

    await initDb();

    await expectAttendeeCols(
      client,
      ["address", "email", "name", "payment_id", "phone"],
      ["pii_blob", "ticket_token_index"],
    );

    const rows = await client.execute("SELECT * FROM attendees WHERE id = 1");
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.created).toBe("2024-03-01T00:00:00Z");
    expect(rows.rows[0]!.pii_blob).toBe("encrypted-data");
    expect(rows.rows[0]!.ticket_token_index).toBe("tok_abc");
  });

  test("fails instead of marking progress for unknown legacy attendee shape", async () => {
    setupTestEncryptionKey();
    const client = await newFileDb();
    setDb(client);

    await client.execute(
      "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    await seedLegacySchemaMarkers(client);
    await client.execute(`CREATE TABLE attendees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      listing_id INTEGER NOT NULL,
      created TEXT NOT NULL
    )`);

    await expect(initDb()).rejects.toThrow("missing expected legacy column");

    const markerRows = await client.execute(
      "SELECT key, value FROM settings WHERE key IN ('latest_db_update', 'db_schema_hash') ORDER BY key",
    );
    expect(markerRows.rows.map((row) => [row.key, row.value])).toEqual([
      ["db_schema_hash", LEGACY_DB_SCHEMA_HASH],
      ["latest_db_update", LEGACY_DB_UPDATE],
    ]);

    const migrationRows = await client.execute(
      "SELECT id FROM schema_migrations",
    );
    expect(migrationRows.rows.length).toBe(0);

    // The advisory lock must be released on failure so a retry isn't
    // blocked until the lock TTL expires.
    const lockRows = await client.execute(
      "SELECT 1 FROM settings WHERE key = 'migration_lock'",
    );
    expect(lockRows.rows.length).toBe(0);
  });

  test("skips table recreation when attendees already matches schema", async () => {
    setupTestEncryptionKey();
    const client = await newFileDb();
    setDb(client);

    // Run initDb on a fresh DB so everything is created and up to date
    await initDb({ allowMissingSettings: true });

    // Insert a row so we can verify it's untouched (not lost to a spurious recreation)
    await client.execute(
      insert("attendees", {
        created: "2024-05-01T00:00:00Z",
        id: 1,
        pii_blob: "blob-data",
        ticket_token_index: "tok_skip",
      }),
    );

    // Force a named migration re-run by making legacy markers stale and
    // clearing named migration history.
    await client.execute({
      args: [LEGACY_DB_UPDATE],
      sql: "UPDATE settings SET value = ? WHERE key = 'latest_db_update'",
    });
    await client.execute({
      args: [LEGACY_DB_SCHEMA_HASH],
      sql: "UPDATE settings SET value = ? WHERE key = 'db_schema_hash'",
    });
    await client.execute("DROP TABLE schema_migrations");
    invalidateInitDbCache();
    await initDb();

    const cols = await client.execute("PRAGMA table_info(attendees)");
    const colNames = cols.rows.map((r) => r.name);
    expect(colNames).toContain("id");
    expect(colNames).toContain("pii_blob");
    expect(colNames).toContain("created");

    const rows = await client.execute("SELECT * FROM attendees WHERE id = 1");
    expect(rows.rows.length).toBe(1);
    expect(rows.rows[0]!.pii_blob).toBe("blob-data");
    expect(rows.rows[0]!.ticket_token_index).toBe("tok_skip");
  });
});

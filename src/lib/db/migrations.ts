/**
 * Database migrations — declarative schema with algorithmic application
 *
 * To modify the schema:
 * - Add a column: add it to the table's `columns` array
 * - Add a table: add it to SCHEMA (after its FK dependencies)
 * - Add an index: add it to the table's `indexes` array
 *
 * Then update LATEST_UPDATE to describe the change.
 * The schema hash is computed automatically — if you forget to update
 * LATEST_UPDATE, migrations will still re-run (the hash will differ).
 */

import { getDb } from "#lib/db/client.ts";

// ─── Types ──────────────────────────────────────────────────────

type Column = [name: string, type: string];

type Index = {
  name: string;
  columns: string[];
  unique?: boolean;
};

type Table = {
  columns: Column[];
  foreignKeys?: string[];
  indexes?: Index[];
};

// ─── Version — update LATEST_UPDATE to describe each change ─────

export const LATEST_UPDATE = "multi-event attendees with per-event status";

// ─── Schema (ordered: tables with no FK deps first) ─────────────

const SCHEMA: [name: string, table: Table][] = [
  [
    "settings",
    {
      columns: [
        ["key", "TEXT PRIMARY KEY"],
        ["value", "TEXT NOT NULL"],
      ],
    },
  ],

  [
    "events",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["created", "TEXT NOT NULL"],
        ["max_attendees", "INTEGER NOT NULL"],
        ["thank_you_url", "TEXT"],
        ["unit_price", "INTEGER"],
        ["max_quantity", "INTEGER NOT NULL DEFAULT 1"],
        ["webhook_url", "TEXT"],
        ["slug", "TEXT"],
        ["slug_index", "TEXT"],
        ["group_id", "INTEGER NOT NULL DEFAULT 0"],
        ["active", "INTEGER NOT NULL DEFAULT 1"],
        ["fields", "TEXT NOT NULL DEFAULT 'email'"],
        ["closes_at", "TEXT"],
        ["name", "TEXT NOT NULL DEFAULT ''"],
        ["description", "TEXT NOT NULL DEFAULT ''"],
        ["event_type", "TEXT NOT NULL DEFAULT 'standard'"],
        [
          "bookable_days",
          `TEXT NOT NULL DEFAULT '["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]'`,
        ],
        ["minimum_days_before", "INTEGER NOT NULL DEFAULT 1"],
        ["maximum_days_after", "INTEGER NOT NULL DEFAULT 90"],
        ["date", "TEXT NOT NULL DEFAULT ''"],
        ["location", "TEXT NOT NULL DEFAULT ''"],
        ["image_url", "TEXT NOT NULL DEFAULT ''"],
        ["attachment_url", "TEXT NOT NULL DEFAULT ''"],
        ["attachment_name", "TEXT NOT NULL DEFAULT ''"],
        ["non_transferable", "INTEGER NOT NULL DEFAULT 0"],
        ["can_pay_more", "INTEGER NOT NULL DEFAULT 0"],
        ["hidden", "INTEGER NOT NULL DEFAULT 0"],
        ["max_price", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [
        {
          name: "idx_events_slug_index",
          columns: ["slug_index"],
          unique: true,
        },
      ],
    },
  ],

  [
    "users",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["username_hash", "TEXT NOT NULL"],
        ["username_index", "TEXT NOT NULL"],
        ["password_hash", "TEXT NOT NULL DEFAULT ''"],
        ["wrapped_data_key", "TEXT"],
        ["admin_level", "TEXT NOT NULL"],
        ["invite_code_hash", "TEXT"],
        ["invite_expiry", "TEXT"],
      ],
      indexes: [
        {
          name: "idx_users_username_index",
          columns: ["username_index"],
          unique: true,
        },
      ],
    },
  ],

  [
    "sessions",
    {
      columns: [
        ["token", "TEXT PRIMARY KEY"],
        ["csrf_token", "TEXT NOT NULL"],
        ["expires", "INTEGER NOT NULL"],
        ["wrapped_data_key", "TEXT"],
        ["user_id", "INTEGER"],
      ],
    },
  ],

  [
    "login_attempts",
    {
      columns: [
        ["ip", "TEXT PRIMARY KEY"],
        ["attempts", "INTEGER NOT NULL DEFAULT 0"],
        ["locked_until", "INTEGER"],
      ],
    },
  ],

  [
    "attendees",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["name", "TEXT NOT NULL"],
        ["email", "TEXT NOT NULL"],
        ["created", "TEXT NOT NULL"],
        ["payment_id", "TEXT"],
        ["phone", "TEXT NOT NULL DEFAULT ''"],
        ["ticket_token", "TEXT NOT NULL DEFAULT ''"],
        ["price_paid", "TEXT"],
        ["checked_in", "TEXT NOT NULL DEFAULT ''"],
        ["address", "TEXT NOT NULL DEFAULT ''"],
        ["special_instructions", "TEXT NOT NULL DEFAULT ''"],
        ["ticket_token_index", "TEXT"],
        ["refunded", "TEXT NOT NULL DEFAULT ''"],
        ["attachment_downloads", "INTEGER NOT NULL DEFAULT 0"],
        ["pii_blob", "TEXT NOT NULL DEFAULT ''"],
      ],
      indexes: [
        {
          name: "idx_attendees_ticket_token_index",
          columns: ["ticket_token_index"],
          unique: true,
        },
      ],
    },
  ],

  [
    "event_attendees",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["event_id", "INTEGER NOT NULL"],
        ["attendee_id", "INTEGER NOT NULL"],
        ["start_at", "TEXT DEFAULT NULL"],
        ["end_at", "TEXT DEFAULT NULL"],
        ["quantity", "INTEGER NOT NULL DEFAULT 1"],
        ["checked_in", "INTEGER NOT NULL DEFAULT 0"],
        ["refunded", "INTEGER NOT NULL DEFAULT 0"],
        ["price_paid", "INTEGER NOT NULL DEFAULT 0"],
      ],
      foreignKeys: [
        "FOREIGN KEY (event_id) REFERENCES events(id)",
        "FOREIGN KEY (attendee_id) REFERENCES attendees(id)",
      ],
      indexes: [
        {
          name: "idx_event_attendees_event_attendee_start",
          columns: ["event_id", "attendee_id", "start_at"],
          unique: true,
        },
        {
          name: "idx_event_attendees_attendee_event",
          columns: ["attendee_id", "event_id"],
        },
        {
          name: "idx_event_attendees_event_start_end",
          columns: ["event_id", "start_at", "end_at"],
        },
      ],
    },
  ],

  [
    "processed_payments",
    {
      columns: [
        ["payment_session_id", "TEXT PRIMARY KEY"],
        ["attendee_id", "INTEGER"],
        ["processed_at", "TEXT NOT NULL"],
        ["ticket_tokens", "TEXT NOT NULL DEFAULT ''"],
      ],
      foreignKeys: ["FOREIGN KEY (attendee_id) REFERENCES attendees(id)"],
    },
  ],

  [
    "activity_log",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["created", "TEXT NOT NULL"],
        ["event_id", "INTEGER"],
        ["message", "TEXT NOT NULL"],
      ],
      foreignKeys: [
        "FOREIGN KEY (event_id) REFERENCES events(id) ON DELETE SET NULL",
      ],
    },
  ],

  [
    "groups",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["slug", "TEXT NOT NULL"],
        ["slug_index", "TEXT NOT NULL"],
        ["name", "TEXT NOT NULL"],
        ["terms_and_conditions", "TEXT NOT NULL DEFAULT ''"],
        ["max_attendees", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [
        {
          name: "idx_groups_slug_index",
          columns: ["slug_index"],
          unique: true,
        },
      ],
    },
  ],

  [
    "holidays",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["name", "TEXT NOT NULL"],
        ["start_date", "TEXT NOT NULL"],
        ["end_date", "TEXT NOT NULL"],
      ],
    },
  ],

  [
    "api_keys",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["user_id", "INTEGER NOT NULL"],
        ["key_index", "TEXT NOT NULL"],
        ["wrapped_data_key", "TEXT NOT NULL"],
        ["name", "TEXT NOT NULL"],
        ["created", "TEXT NOT NULL"],
        ["last_used", "TEXT NOT NULL DEFAULT ''"],
      ],
      foreignKeys: [
        "FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE",
      ],
      indexes: [
        {
          name: "idx_api_keys_key_index",
          columns: ["key_index"],
          unique: true,
        },
      ],
    },
  ],

  [
    "questions",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["text", "TEXT NOT NULL"],
      ],
    },
  ],

  [
    "answers",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["question_id", "INTEGER NOT NULL"],
        ["text", "TEXT NOT NULL"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
      ],
      foreignKeys: ["FOREIGN KEY (question_id) REFERENCES questions(id)"],
      indexes: [{ name: "idx_answers_question_id", columns: ["question_id"] }],
    },
  ],

  [
    "event_questions",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["event_id", "INTEGER NOT NULL"],
        ["question_id", "INTEGER NOT NULL"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
      ],
      foreignKeys: [
        "FOREIGN KEY (event_id) REFERENCES events(id)",
        "FOREIGN KEY (question_id) REFERENCES questions(id)",
      ],
      indexes: [
        { name: "idx_event_questions_event_id", columns: ["event_id"] },
        {
          name: "idx_event_questions_unique",
          columns: ["event_id", "question_id"],
          unique: true,
        },
      ],
    },
  ],

  [
    "built_sites",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["site_data", "TEXT NOT NULL"],
        ["created", "TEXT NOT NULL"],
      ],
    },
  ],

  [
    "attendee_answers",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["attendee_id", "INTEGER NOT NULL"],
        ["answer_id", "INTEGER NOT NULL"],
      ],
      foreignKeys: [
        "FOREIGN KEY (attendee_id) REFERENCES attendees(id)",
        "FOREIGN KEY (answer_id) REFERENCES answers(id)",
      ],
      indexes: [
        {
          name: "idx_attendee_answers_attendee_id",
          columns: ["attendee_id"],
        },
        { name: "idx_attendee_answers_answer_id", columns: ["answer_id"] },
        {
          name: "idx_attendee_answers_unique",
          columns: ["attendee_id", "answer_id"],
          unique: true,
        },
      ],
    },
  ],
];

// ─── Schema hash (auto-detects changes even if LATEST_UPDATE isn't bumped) ──

/** DJB2 hash — deterministic, fast, good enough for change detection */
const djb2 = (str: string): string => {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
};

export const SCHEMA_HASH = djb2(JSON.stringify(SCHEMA));

// ─── Helpers ────────────────────────────────────────────────────

/** Run a migration that may fail if already applied */
const runMigration = async (sql: string): Promise<void> => {
  try {
    await getDb().execute(sql);
  } catch {
    // Already applied
  }
};

/** Get the set of existing column names for a table */
const getExistingColumns = async (table: string): Promise<Set<string>> => {
  const result = await getDb().execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
};

/** Check if database is already up to date (version + schema hash) */
const isDbUpToDate = async (): Promise<boolean> => {
  try {
    const result = await getDb().execute(
      "SELECT key, value FROM settings WHERE key IN ('latest_db_update', 'db_schema_hash')",
    );
    const values = new Map(
      result.rows.map((r) => [r.key as string, r.value as string]),
    );
    return (
      values.get("latest_db_update") === LATEST_UPDATE &&
      values.get("db_schema_hash") === SCHEMA_HASH
    );
  } catch {
    return false;
  }
};

/** Create indexes for a named table from SCHEMA */
const createIndexesForTable = async (
  tableName: string,
  indexes: Index[],
): Promise<void> => {
  for (const idx of indexes) {
    const unique = idx.unique ? "UNIQUE " : "";
    await runMigration(
      `CREATE ${unique}INDEX IF NOT EXISTS ${idx.name} ON ${tableName}(${idx.columns.join(", ")})`,
    );
  }
};

/**
 * Drop event_id, date, quantity from attendees table.
 * SQLite can't DROP COLUMN when a FK references the column, so we recreate the table.
 * Only runs if the old columns still exist (idempotent).
 */
const dropDeprecatedAttendeeColumns = async (): Promise<void> => {
  const cols = await getExistingColumns("attendees");
  if (!cols.has("event_id")) return;

  const tableSchema = SCHEMA.find(([name]) => name === "attendees")!;
  const newCols = tableSchema[1].columns;
  const colNames = newCols.map(([col]) => col).join(", ");
  const colDefs = newCols.map(([col, type]) => `${col} ${type}`).join(", ");

  await getDb().batch(
    [
      { sql: `CREATE TABLE attendees_new (${colDefs})`, args: [] },
      {
        sql: `INSERT INTO attendees_new (${colNames}) SELECT ${colNames} FROM attendees`,
        args: [],
      },
      { sql: "DROP TABLE attendees", args: [] },
      { sql: "ALTER TABLE attendees_new RENAME TO attendees", args: [] },
    ],
    "write",
  );

  await createIndexesForTable("attendees", tableSchema[1].indexes ?? []);
};

/** Create missing tables and add missing columns in a single pass */
const applySchemaChanges = async (): Promise<void> => {
  for (const [name, table] of SCHEMA) {
    const parts = [
      ...table.columns.map(([col, type]) => `${col} ${type}`),
      ...(table.foreignKeys ?? []),
    ];
    await runMigration(
      `CREATE TABLE IF NOT EXISTS ${name} (${parts.join(", ")})`,
    );
    const existing = await getExistingColumns(name);
    for (const [col, type] of table.columns) {
      if (!existing.has(col)) {
        await runMigration(`ALTER TABLE ${name} ADD COLUMN ${col} ${type}`);
      }
    }
  }
};

/** Create missing indexes and drop legacy ones */
const syncIndexes = async (): Promise<void> => {
  const declaredIndexNames = new Set<string>();
  for (const [name, table] of SCHEMA) {
    const indexes = table.indexes ?? [];
    for (const idx of indexes) declaredIndexNames.add(idx.name);
    await createIndexesForTable(name, indexes);
  }
  const allIndexes = await getDb().execute(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
  );
  for (const row of allIndexes.rows) {
    const indexName = String(row.name);
    if (!declaredIndexNames.has(indexName)) {
      await runMigration(`DROP INDEX IF EXISTS ${indexName}`);
    }
  }
};

const MIGRATION_LOCK_KEY = "migration_lock";

/**
 * Acquire an advisory migration lock via the settings table.
 * Returns true if acquired, false if another process holds it.
 * The lock has no TTL — if a migration crashes, the lock persists
 * and requires manual clearing (the DB may need investigation).
 */
const acquireMigrationLock = async (): Promise<boolean> => {
  const result = await getDb()
    .execute({
      sql: "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING",
      args: [MIGRATION_LOCK_KEY, new Date().toISOString()],
    })
    .catch(() => null); // settings table may not exist yet on first run
  return result === null || result.rowsAffected === 1;
};

/** Release the migration lock */
const releaseMigrationLock = async (): Promise<void> => {
  await runMigration(
    `DELETE FROM settings WHERE key = '${MIGRATION_LOCK_KEY}'`,
  );
};

// ─── Main migration ─────────────────────────────────────────────

/**
 * Initialize database tables — idempotent, safe to call on every startup.
 * Uses an advisory lock to prevent concurrent migrations.
 */
export const initDb = async (): Promise<void> => {
  if (await isDbUpToDate()) return;

  const acquired = await acquireMigrationLock();
  if (!acquired) {
    throw new Error(
      "Database migration is already in progress (migration_lock held). " +
        "If a previous migration crashed, manually DELETE FROM settings WHERE key = 'migration_lock'.",
    );
  }

  // Re-check after acquiring lock (another process may have finished)
  if (await isDbUpToDate()) {
    await releaseMigrationLock();
    return;
  }

  await applySchemaChanges();
  await syncIndexes();

  // 4. Backfill event_attendees from existing attendees data (idempotent)
  // Convert attendees.date ("YYYY-MM-DD") to start_at/end_at (full-day UTC range)
  // Also copies per-event status columns to event_attendees
  await runMigration(
    `INSERT OR IGNORE INTO event_attendees (event_id, attendee_id, start_at, end_at, quantity, checked_in, refunded, price_paid)
     SELECT event_id, id,
       CASE WHEN date IS NOT NULL THEN date || 'T00:00:00Z' ELSE NULL END,
       CASE WHEN date IS NOT NULL THEN DATE(date, '+1 day') || 'T00:00:00Z' ELSE NULL END,
       quantity, checked_in_v2, refunded_v2, price_paid_v2
     FROM attendees
     WHERE id NOT IN (SELECT attendee_id FROM event_attendees)`,
  );

  // 4b. Backfill per-event status into event_attendees for rows created before this migration
  await runMigration(
    `UPDATE event_attendees SET
       checked_in = (SELECT a.checked_in_v2 FROM attendees a WHERE a.id = event_attendees.attendee_id),
       refunded = (SELECT a.refunded_v2 FROM attendees a WHERE a.id = event_attendees.attendee_id),
       price_paid = (SELECT a.price_paid_v2 FROM attendees a WHERE a.id = event_attendees.attendee_id)
     WHERE checked_in = 0 AND refunded = 0 AND price_paid = 0
       AND EXISTS (SELECT 1 FROM attendees a WHERE a.id = event_attendees.attendee_id AND (a.checked_in_v2 != 0 OR a.refunded_v2 != 0 OR a.price_paid_v2 != 0))`,
  );

  // 5. Drop deprecated columns from attendees → now on event_attendees.
  await dropDeprecatedAttendeeColumns();

  // 6. Update version marker and schema hash
  await getDb().execute({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_db_update', ?)",
    args: [LATEST_UPDATE],
  });
  await getDb().execute({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('db_schema_hash', ?)",
    args: [SCHEMA_HASH],
  });

  // Release lock only on success — if migration crashes, lock persists
  // and requires manual investigation + clearing
  await releaseMigrationLock();
};

// ─── Reset ──────────────────────────────────────────────────────

/**
 * Reset the database by dropping all tables (reverse order for FK safety)
 */
export const resetDatabase = async (): Promise<void> => {
  const client = getDb();
  for (const [name] of [...SCHEMA].reverse()) {
    await client.execute(`DROP TABLE IF EXISTS ${name}`);
  }
};

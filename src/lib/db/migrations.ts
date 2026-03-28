/**
 * Database migrations — declarative schema with algorithmic application
 *
 * To modify the schema:
 * - Add a column: add it to the table's `columns` array
 * - Add a table: add it to SCHEMA (after its FK dependencies)
 * - Rename a column: add an entry to COLUMN_RENAMES
 * - Add an index: add it to the table's `indexes` array
 *
 * Then update LATEST_UPDATE to trigger re-evaluation on next startup.
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

// ─── Version — update when schema changes ───────────────────────

export const LATEST_UPDATE = "declarative schema migrations";

// ─── Column renames (old → new, safe to re-run) ─────────────────

const COLUMN_RENAMES: { table: string; from: string; to: string }[] = [
  { table: "attendees", from: "stripe_payment_id", to: "payment_id" },
];

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
        ["event_id", "INTEGER NOT NULL"],
        ["name", "TEXT NOT NULL"],
        ["email", "TEXT NOT NULL"],
        ["created", "TEXT NOT NULL"],
        ["payment_id", "TEXT"],
        ["quantity", "INTEGER NOT NULL DEFAULT 1"],
        ["phone", "TEXT NOT NULL DEFAULT ''"],
        ["ticket_token", "TEXT NOT NULL DEFAULT ''"],
        ["price_paid", "TEXT"],
        ["checked_in", "TEXT NOT NULL DEFAULT ''"],
        ["date", "TEXT DEFAULT NULL"],
        ["address", "TEXT NOT NULL DEFAULT ''"],
        ["special_instructions", "TEXT NOT NULL DEFAULT ''"],
        ["ticket_token_index", "TEXT"],
        ["refunded", "TEXT NOT NULL DEFAULT ''"],
        ["attachment_downloads", "INTEGER NOT NULL DEFAULT 0"],
        ["pii_blob", "TEXT NOT NULL DEFAULT ''"],
        ["checked_in_v2", "INTEGER NOT NULL DEFAULT 0"],
        ["refunded_v2", "INTEGER NOT NULL DEFAULT 0"],
        ["price_paid_v2", "INTEGER NOT NULL DEFAULT 0"],
      ],
      foreignKeys: ["FOREIGN KEY (event_id) REFERENCES events(id)"],
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

/** Check if database is already up to date */
const isDbUpToDate = async (): Promise<boolean> => {
  try {
    const result = await getDb().execute(
      "SELECT value FROM settings WHERE key = 'latest_db_update'",
    );
    return result.rows[0]?.value === LATEST_UPDATE;
  } catch {
    return false;
  }
};

// ─── Main migration ─────────────────────────────────────────────

/**
 * Initialize database tables — idempotent, safe to call on every startup.
 *
 * 1. Create tables that don't exist
 * 2. Apply pending column renames
 * 3. Add any missing columns to existing tables
 * 4. Create any missing indexes
 */
export const initDb = async (): Promise<void> => {
  if (await isDbUpToDate()) return;

  // 1. Create tables
  for (const [name, table] of SCHEMA) {
    const parts = [
      ...table.columns.map(([col, type]) => `${col} ${type}`),
      ...(table.foreignKeys ?? []),
    ];
    await runMigration(
      `CREATE TABLE IF NOT EXISTS ${name} (${parts.join(", ")})`,
    );
  }

  // 2. Rename columns (errors silently if already renamed)
  for (const { table, from, to } of COLUMN_RENAMES) {
    await runMigration(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  }

  // 3. Add missing columns
  for (const [name, table] of SCHEMA) {
    const existing = await getExistingColumns(name);
    for (const [col, type] of table.columns) {
      if (!existing.has(col)) {
        await runMigration(`ALTER TABLE ${name} ADD COLUMN ${col} ${type}`);
      }
    }
  }

  // 4. Create indexes
  for (const [name, table] of SCHEMA) {
    for (const idx of table.indexes ?? []) {
      const unique = idx.unique ? "UNIQUE " : "";
      await runMigration(
        `CREATE ${unique}INDEX IF NOT EXISTS ${idx.name} ON ${name}(${idx.columns.join(", ")})`,
      );
    }
  }

  // 5. Update version marker
  await getDb().execute({
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_db_update', ?)",
    args: [LATEST_UPDATE],
  });
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

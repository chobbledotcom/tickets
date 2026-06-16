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

import type { Client } from "@libsql/client";
import { lazyRef } from "#fp";
import { ensureDefaultAttendeeStatus } from "#shared/db/attendee-statuses.ts";
import { createAndUploadBackup, hasRecentBackup } from "#shared/db/backup.ts";
import { getDb } from "#shared/db/client.ts";
import { getEnv } from "#shared/env.ts";
import { logDebug } from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";
import { isStorageEnabled } from "#shared/storage.ts";

// ─── Types ──────────────────────────────────────────────────────

type Column = [name: string, type: string];

type Index = {
  name: string;
  columns: string[];
  unique?: boolean;
};

type Table = {
  columns: Column[];
  indexes?: Index[];
};

// ─── Version — update LATEST_UPDATE to describe each change ─────

export const LATEST_UPDATE =
  "rename the event domain to listing (tables, columns and indexes); add a global sort_order column to questions for unified ordering; add email_preferences table for marketing opt-outs and contact history; add customisable_days and day_prices columns to listings for visitor-chosen multi-day bookings with per-day-count pricing; add attendee_statuses table with status_id and remaining_balance on attendees, plus attendee_id on activity_log, for the reservation and balance-payment flow; add idx_activity_log_listing_id so per-listing activity log reads are index scans instead of full-table scans; add a logistics_agents table plus a uses_logistics flag on listings, a split_logistics_agents flag on attendees, and start_agent_id/end_agent_id/start_time/end_time on listing_attendees for the logistics flow";

// ─── Schema (ordered: tables with no FK deps first) ─────────────

const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";

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
    SCHEMA_MIGRATIONS_TABLE,
    {
      columns: [
        ["id", "TEXT PRIMARY KEY"],
        ["description", "TEXT NOT NULL"],
        ["applied_at", "TEXT NOT NULL"],
      ],
    },
  ],

  [
    "listings",
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
        ["listing_type", "TEXT NOT NULL DEFAULT 'standard'"],
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
        ["purchase_only", "INTEGER NOT NULL DEFAULT 0"],
        ["assign_built_site", "INTEGER NOT NULL DEFAULT 0"],
        ["max_price", "INTEGER NOT NULL DEFAULT 0"],
        ["months_per_unit", "INTEGER NOT NULL DEFAULT 0"],
        ["initial_site_months", "INTEGER NOT NULL DEFAULT 0"],
        ["duration_days", "INTEGER NOT NULL DEFAULT 1"],
        ["customisable_days", "INTEGER NOT NULL DEFAULT 0"],
        ["day_prices", "TEXT NOT NULL DEFAULT '{}'"],
        ["uses_logistics", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [
        {
          columns: ["slug_index"],
          name: "idx_listings_slug_index",
          unique: true,
        },
      ],
    },
  ],

  [
    "logistics_agents",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["name", "TEXT NOT NULL"],
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
          columns: ["username_index"],
          name: "idx_users_username_index",
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
      indexes: [
        {
          columns: ["locked_until"],
          name: "idx_login_attempts_locked_until",
        },
      ],
    },
  ],

  [
    "token_attempts",
    {
      columns: [
        ["ip", "TEXT PRIMARY KEY"],
        ["recent_tokens", "TEXT NOT NULL DEFAULT '[]'"],
        ["locked_until", "INTEGER"],
        ["window_start", "INTEGER NOT NULL DEFAULT 0"],
        ["last_attempt", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [
        {
          columns: ["last_attempt"],
          name: "idx_token_attempts_last_attempt",
        },
      ],
    },
  ],

  [
    "attendee_statuses",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
        ["name", "TEXT NOT NULL"],
        ["is_public_default", "INTEGER NOT NULL DEFAULT 0"],
        ["is_paid_default", "INTEGER NOT NULL DEFAULT 0"],
        ["is_reservation", "INTEGER NOT NULL DEFAULT 0"],
        ["reservation_amount", "TEXT NOT NULL DEFAULT '0'"],
      ],
      indexes: [
        {
          columns: ["sort_order"],
          name: "idx_attendee_statuses_sort_order",
        },
      ],
    },
  ],

  [
    "attendees",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["created", "TEXT NOT NULL"],
        ["price_paid", "TEXT"],
        ["checked_in", "TEXT NOT NULL DEFAULT ''"],
        ["ticket_token_index", "TEXT"],
        ["pii_blob", "TEXT NOT NULL DEFAULT ''"],
        ["status_id", "INTEGER DEFAULT NULL"],
        ["remaining_balance", "INTEGER NOT NULL DEFAULT 0"],
        ["split_logistics_agents", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [
        {
          columns: ["ticket_token_index"],
          name: "idx_attendees_ticket_token_index",
          unique: true,
        },
        {
          columns: ["status_id"],
          name: "idx_attendees_status_id",
        },
      ],
    },
  ],

  [
    "listing_attendees",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["listing_id", "INTEGER NOT NULL"],
        ["attendee_id", "INTEGER NOT NULL"],
        ["start_at", "TEXT DEFAULT NULL"],
        ["end_at", "TEXT DEFAULT NULL"],
        ["quantity", "INTEGER NOT NULL DEFAULT 1"],
        ["checked_in", "INTEGER NOT NULL DEFAULT 0"],
        ["refunded", "INTEGER NOT NULL DEFAULT 0"],
        ["price_paid", "INTEGER NOT NULL DEFAULT 0"],
        ["attachment_downloads", "INTEGER NOT NULL DEFAULT 0"],
        ["start_agent_id", "INTEGER DEFAULT NULL"],
        ["end_agent_id", "INTEGER DEFAULT NULL"],
        ["start_time", "TEXT NOT NULL DEFAULT ''"],
        ["end_time", "TEXT NOT NULL DEFAULT ''"],
      ],
      // FKs omitted — libsql's FK enforcement causes issues during table
      // recreation migrations. Referential integrity is enforced by application
      // logic and the indexes below.
      indexes: [
        {
          columns: ["listing_id", "attendee_id", "start_at"],
          name: "idx_listing_attendees_listing_attendee_start",
          unique: true,
        },
        {
          columns: ["attendee_id", "listing_id"],
          name: "idx_listing_attendees_attendee_listing",
        },
        // Overlap queries filter `start_at < dayEnd AND end_at > dayStart`
        // where both bounds are in the future. With end_at first, the index
        // range scan skips historical rows (end_at in the past) instead of
        // visiting every row ever booked and rejecting on the residual
        // predicate — per-day capacity SUMs stay O(active rows).
        {
          columns: ["listing_id", "end_at", "start_at"],
          name: "idx_listing_attendees_listing_end_start",
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
      // FK declarations removed — libsql's FK enforcement breaks table
      // recreation migrations (PRAGMA foreign_keys is connection-scoped and
      // doesn't persist into batch operations on remote databases).
      // Referential integrity is enforced by application logic.
    },
  ],

  [
    "activity_log",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["created", "TEXT NOT NULL"],
        ["listing_id", "INTEGER"],
        ["message", "TEXT NOT NULL"],
        ["attendee_id", "INTEGER"],
      ],
      indexes: [
        {
          columns: ["attendee_id"],
          name: "idx_activity_log_attendee_id",
        },
        // Per-listing log reads filter on listing_id and order by id DESC.
        // Because id is AUTOINCREMENT (== rowid), this index already orders its
        // entries by (listing_id, id), so the filter + newest-first scan is an
        // index range scan with no sort — instead of scanning the whole
        // (unbounded) log table on every admin listing page view.
        {
          columns: ["listing_id"],
          name: "idx_activity_log_listing_id",
        },
      ],
    },
  ],

  [
    // SumUp checkouts can't carry arbitrary metadata through the provider
    // (unlike Stripe sessions / Square orders), so booking metadata is staged
    // here between checkout creation and payment completion, then read back on
    // webhook/redirect. The blob contains PII, so it is encrypted with a
    // per-row data key wrapped by the checkout reference — the plaintext
    // reference never rests in this DB (it arrives at runtime from the
    // redirect URL or SumUp's API), so a DB dump alone cannot decrypt these
    // rows. Lookup is by HMAC of the reference, like ticket_token_index.
    // Rows are short-lived: pruned after PRUNE_SUMUP_RETENTION_HOURS.
    // wrapped_key has a DEFAULT so ADD COLUMN self-heals pre-release dev DBs
    // that created the earlier plaintext shape of this table.
    "sumup_checkouts",
    {
      columns: [
        ["reference_index", "TEXT PRIMARY KEY"],
        ["wrapped_key", "TEXT NOT NULL DEFAULT ''"],
        ["metadata", "TEXT NOT NULL"],
        ["sumup_id", "TEXT NOT NULL DEFAULT ''"],
        ["created_at", "TEXT NOT NULL"],
      ],
      indexes: [
        {
          columns: ["sumup_id"],
          name: "idx_sumup_checkouts_sumup_id",
        },
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
        ["description", "TEXT NOT NULL DEFAULT ''"],
        ["terms_and_conditions", "TEXT NOT NULL DEFAULT ''"],
        ["max_attendees", "INTEGER NOT NULL DEFAULT 0"],
        ["hidden", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [
        {
          columns: ["slug_index"],
          name: "idx_groups_slug_index",
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
      indexes: [
        {
          columns: ["key_index"],
          name: "idx_api_keys_key_index",
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
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
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
      indexes: [{ columns: ["question_id"], name: "idx_answers_question_id" }],
    },
  ],

  [
    "listing_questions",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["listing_id", "INTEGER NOT NULL"],
        ["question_id", "INTEGER NOT NULL"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [
        { columns: ["listing_id"], name: "idx_listing_questions_listing_id" },
        {
          columns: ["listing_id", "question_id"],
          name: "idx_listing_questions_unique",
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
        ["assignable", "INTEGER NOT NULL DEFAULT 0"],
        ["assigned_attendee_id", "INTEGER DEFAULT NULL"],
        ["assigned_listing_id", "INTEGER DEFAULT NULL"],
        ["created", "TEXT NOT NULL"],
        ["renewal_token_index", "TEXT DEFAULT NULL"],
        ["read_only_from", "TEXT NOT NULL DEFAULT ''"],
      ],
      indexes: [
        {
          columns: ["renewal_token_index"],
          name: "idx_built_sites_renewal_token_index",
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
      indexes: [
        {
          columns: ["attendee_id"],
          name: "idx_attendee_answers_attendee_id",
        },
        { columns: ["answer_id"], name: "idx_attendee_answers_answer_id" },
        {
          columns: ["attendee_id", "answer_id"],
          name: "idx_attendee_answers_unique",
          unique: true,
        },
      ],
    },
  ],

  [
    // Per-email marketing preferences + contact history, keyed by the HMAC of
    // the address (same blind-index approach as ticket_token_index, so a DB
    // dump never reveals which address a row belongs to). `unsubscribed` is
    // plaintext so the public, key-less /unsubscribe page can toggle it;
    // `stats_blob` is a hybrid-encrypted {c,t,s} (contact count, last contact,
    // last subject) only the admin private key can read.
    "email_preferences",
    {
      columns: [
        ["email_hash", "TEXT PRIMARY KEY"],
        ["unsubscribed", "INTEGER NOT NULL DEFAULT 0"],
        ["stats_blob", "TEXT NOT NULL DEFAULT ''"],
        ["created", "TEXT NOT NULL"],
      ],
    },
  ],
];

/** Ordered table names — matches FK dependency order (parents before children) */
export const SCHEMA_TABLE_NAMES: string[] = SCHEMA.map(([name]) => name);

// ─── Schema hash (auto-detects changes even if LATEST_UPDATE isn't bumped) ──

/** DJB2 hash — deterministic, fast, good enough for change detection */
const djb2 = (str: string): string => {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
};

const APP_SCHEMA = SCHEMA.filter(([name]) => name !== SCHEMA_MIGRATIONS_TABLE);

export const SCHEMA_HASH = djb2(JSON.stringify(APP_SCHEMA));

// ─── Helpers ────────────────────────────────────────────────────

/** Run an idempotent migration — swallows expected "already done" errors */
const runMigration = async (sql: string): Promise<void> => {
  try {
    await getDb().execute(sql);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // Expected when re-running on an already-migrated DB or racing another
    // isolate through an idempotent DDL statement.
    if (msg.includes("already exists") || msg.includes("duplicate")) {
      return;
    }
    // Anything else is a real error — log and rethrow
    logDebug("Migration", `Error: ${msg} — SQL: ${sql.slice(0, 80)}`);
    throw e;
  }
};

/** Get the set of existing column names for a table */
const getExistingColumns = async (table: string): Promise<Set<string>> => {
  const result = await getDb().execute(`PRAGMA table_info(${table})`);
  return new Set(result.rows.map((row) => String(row.name)));
};

const tableExists = async (table: string): Promise<boolean> => {
  const result = await getDb().execute({
    args: [table],
    sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
  });
  return result.rows.length > 0;
};

const indexExists = async (indexName: string): Promise<boolean> => {
  const result = await getDb().execute({
    args: [indexName],
    sql: "SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?",
  });
  return result.rows.length > 0;
};

type DbState =
  | "up_to_date"
  | "needs_migration"
  | "missing_settings"
  | "uninitialized_settings";

export class MissingSettingsTableError extends Error {
  constructor(message = "Database settings table does not exist") {
    super(message);
    this.name = "MissingSettingsTableError";
  }
}

/**
 * Thrown when another isolate holds the migration lock — i.e. a database
 * migration (including its pre-migration backup) is already running. The
 * request can be retried once the migration finishes, so callers surface a
 * dedicated "migration in progress" page that auto-refreshes rather than the
 * generic temporary-error page.
 */
export class MigrationInProgressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MigrationInProgressError";
  }
}

const isMissingSettingsTableError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:?\s*(\w+\.)?settings\b/i.test(message);
};

/** Check database state: up-to-date, needs migration, or missing settings table */
const getDbState = async (): Promise<DbState> => {
  try {
    const result = await getDb().execute(
      "SELECT key, value FROM settings WHERE key IN ('latest_db_update', 'db_schema_hash')",
    );
    if (result.rows.length === 0) return "uninitialized_settings";
    const values = new Map(
      result.rows.map((r) => [r.key as string, r.value as string]),
    );
    return values.get("latest_db_update") === LATEST_UPDATE &&
      values.get("db_schema_hash") === SCHEMA_HASH
      ? "up_to_date"
      : "needs_migration";
  } catch (error) {
    if (isMissingSettingsTableError(error)) return "missing_settings";
    throw error;
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
      `CREATE ${unique}INDEX IF NOT EXISTS ${idx.name} ON ${tableName}(${idx.columns.join(
        ", ",
      )})`,
    );
  }
};

/**
 * Recreate a table from its SCHEMA definition, preserving data for matching columns.
 *
 * The new table is created WITHOUT foreign keys (only column definitions).
 * This means any FKs the original table had are removed after recreation.
 *
 * IMPORTANT: If other tables have FKs referencing this table and contain data,
 * those tables must be recreated FIRST (to remove their FK constraints).
 * Otherwise DROP TABLE will fail with FOREIGN KEY constraint in libsql.
 * We do NOT use PRAGMA foreign_keys=OFF because it doesn't persist across
 * HTTP requests in remote libsql (Turso).
 */
const recreateTable = async (tableName: string): Promise<void> => {
  const tableSchema = SCHEMA.find(([name]) => name === tableName)!;
  const cols = tableSchema[1].columns;
  const colNames = cols.map(([col]) => col).join(", ");
  const colDefs = cols.map(([col, type]) => `${col} ${type}`).join(", ");
  const tmpName = `${tableName}_new`;

  const selectExprs = cols
    .map(([col, type]) => {
      const defaultMatch = type.match(/DEFAULT\s+'([^']*)'/i);
      return defaultMatch ? `COALESCE(${col}, '${defaultMatch[1]}')` : col;
    })
    .join(", ");

  await getDb().batch(
    [
      { args: [], sql: `CREATE TABLE ${tmpName} (${colDefs})` },
      {
        args: [],
        sql: `INSERT INTO ${tmpName} (${colNames}) SELECT ${selectExprs} FROM ${tableName}`,
      },
      { args: [], sql: `DROP TABLE ${tableName}` },
      { args: [], sql: `ALTER TABLE ${tmpName} RENAME TO ${tableName}` },
    ],
    "write",
  );

  await createIndexesForTable(tableName, tableSchema[1].indexes ?? []);
};

const getAppSchemaColumns = (tableName: string): Set<string> =>
  new Set(
    APP_SCHEMA.find(([n]) => n === tableName)![1].columns.map(([c]) => c),
  );

const requireColumns = (
  table: string,
  existing: Set<string>,
  required: string[],
): void => {
  const missing = required.filter((col) => !existing.has(col));
  if (missing.length > 0) {
    throw new Error(
      `Cannot migrate ${table}: missing expected legacy column(s): ${missing.join(
        ", ",
      )}`,
    );
  }
};

const backfillListingAttendees = async (): Promise<void> => {
  const attendeeColumns = await getExistingColumns("attendees");
  if (!attendeeColumns.has("listing_id")) {
    logDebug(
      "Migration",
      "attendees.listing_id is absent, skipping listing_attendees backfill",
    );
    return;
  }

  requireColumns("attendees", attendeeColumns, [
    "id",
    "listing_id",
    "date",
    "quantity",
    "checked_in_v2",
    "refunded_v2",
    "price_paid_v2",
    "attachment_downloads",
  ]);
  requireColumns(
    "listing_attendees",
    await getExistingColumns("listing_attendees"),
    [
      "listing_id",
      "attendee_id",
      "start_at",
      "end_at",
      "quantity",
      "checked_in",
      "refunded",
      "price_paid",
      "attachment_downloads",
    ],
  );

  await getDb().execute(
    `INSERT OR IGNORE INTO listing_attendees (listing_id, attendee_id, start_at, end_at, quantity, checked_in, refunded, price_paid, attachment_downloads)
     SELECT listing_id, id,
       CASE WHEN date IS NOT NULL THEN date || 'T00:00:00Z' ELSE NULL END,
       CASE WHEN date IS NOT NULL THEN DATE(date, '+1 day') || 'T00:00:00Z' ELSE NULL END,
       quantity, checked_in_v2, refunded_v2, price_paid_v2, attachment_downloads
     FROM attendees
     WHERE id NOT IN (SELECT attendee_id FROM listing_attendees)`,
  );
};

/**
 * Drop any legacy columns from attendees that aren't in the current schema
 * (listing_id, date, quantity, and the pre-pii_blob PII columns: name, email,
 * phone, address, payment_id, etc).
 *
 * SQLite can't DROP COLUMN when a FK references the column, so we recreate
 * the table. Idempotent: if every existing column matches the schema, skip.
 */
const dropDeprecatedAttendeeColumns = async (): Promise<void> => {
  const cols = await getExistingColumns("attendees");
  const expected = getAppSchemaColumns("attendees");
  const hasLegacy = [...cols].some((c) => !expected.has(c));
  if (!hasLegacy) {
    logDebug(
      "Migration",
      "attendees has no legacy columns, skipping table recreation",
    );
    return;
  }
  // Recreate tables that reference attendees(id) FIRST — the live DB's
  // original tables have FK declarations baked in from their CREATE TABLE.
  // libsql won't let us DROP attendees while those FKs exist. Recreating
  // them first replaces the FK-bearing originals with clean versions.
  logDebug("Migration", "Recreating listing_attendees (removing FKs)...");
  await recreateTable("listing_attendees");
  logDebug("Migration", "Recreating processed_payments (removing FKs)...");
  await recreateTable("processed_payments");
  logDebug("Migration", "Recreating attendee_answers (removing FKs)...");
  await recreateTable("attendee_answers");
  // Now safe to recreate attendees — no other table references it via FK
  logDebug(
    "Migration",
    "Recreating attendees (dropping deprecated columns)...",
  );
  await recreateTable("attendees");
  logDebug("Migration", "Table recreation complete.");
};

/** Create missing tables and add missing columns in a single pass */
const createTableSql = ([name, table]: [string, Table]): string => {
  const parts = table.columns.map(([col, type]) => `${col} ${type}`);
  return `CREATE TABLE IF NOT EXISTS ${name} (${parts.join(", ")})`;
};

const applySchemaChanges = async (): Promise<void> => {
  for (const entry of SCHEMA) {
    const [name, table] = entry;
    await runMigration(createTableSql(entry));
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

const verifyCurrentAppSchema = async (): Promise<void> => {
  for (const [name, table] of APP_SCHEMA) {
    if (!(await tableExists(name))) {
      throw new Error(
        `Database schema verification failed: missing table ${name}`,
      );
    }

    const existing = await getExistingColumns(name);
    const missingColumns = table.columns
      .map(([col]) => col)
      .filter((col) => !existing.has(col));
    if (missingColumns.length > 0) {
      throw new Error(
        `Database schema verification failed: ${name} missing column(s): ${missingColumns.join(
          ", ",
        )}`,
      );
    }

    for (const index of table.indexes ?? []) {
      if (!(await indexExists(index.name))) {
        throw new Error(
          `Database schema verification failed: missing index ${index.name}`,
        );
      }
    }
  }
};

const syncCurrentSchema = async (): Promise<void> => {
  logDebug("Migration", "Step 1: applying schema changes...");
  await applySchemaChanges();
  logDebug("Migration", "Step 2: syncing indexes...");
  await syncIndexes();

  logDebug("Migration", "Step 3: backfilling listing_attendees...");
  await backfillListingAttendees();

  logDebug("Migration", "Step 4: dropping deprecated attendee columns...");
  await dropDeprecatedAttendeeColumns();
};

type Migration = {
  id: string;
  description: string;
  up: () => Promise<void>;
  /** Runs after up(); a failure leaves the migration unrecorded for retry. */
  verify: () => Promise<void>;
};

/** Verify the reordered overlap index exists (syncIndexes drops the old
 * (listing_id, start_at, end_at) ordering and creates this one). */
const verifyOverlapIndex = async (): Promise<void> => {
  const result = await getDb().execute(
    "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_listing_attendees_listing_end_start'",
  );
  if (result.rows.length === 0) {
    throw new Error(
      "Migration verification failed: idx_listing_attendees_listing_end_start missing",
    );
  }
};

/**
 * Rename the legacy "event" domain to "listing".
 *
 * Renames are guarded so this is a no-op on fresh databases (where the
 * declarative schema already created the listing-named tables) and only
 * rewrites genuine legacy "event" tables/columns. Index names are left to
 * syncIndexes(), which drops any index not declared in SCHEMA and recreates
 * the listing-named ones.
 */
const renameTableIfLegacy = async (from: string, to: string): Promise<void> => {
  if ((await tableExists(from)) && !(await tableExists(to))) {
    await runMigration(`ALTER TABLE ${from} RENAME TO ${to}`);
  }
};

const renameColumnIfLegacy = async (
  table: string,
  from: string,
  to: string,
): Promise<void> => {
  if (!(await tableExists(table))) return;
  const cols = await getExistingColumns(table);
  if (cols.has(from) && !cols.has(to)) {
    await runMigration(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  }
};

export const renameEventsToListings = async (): Promise<void> => {
  await renameTableIfLegacy("events", "listings");
  await renameTableIfLegacy("event_attendees", "listing_attendees");
  await renameTableIfLegacy("event_questions", "listing_questions");

  await renameColumnIfLegacy("listings", "event_type", "listing_type");
  await renameColumnIfLegacy("listing_attendees", "event_id", "listing_id");
  await renameColumnIfLegacy("listing_questions", "event_id", "listing_id");
  await renameColumnIfLegacy("activity_log", "event_id", "listing_id");
  await renameColumnIfLegacy(
    "built_sites",
    "assigned_event_id",
    "assigned_listing_id",
  );
  // Legacy attendees table carried event_id before backfill dropped it.
  await renameColumnIfLegacy("attendees", "event_id", "listing_id");

  await applySchemaChanges();
  await syncIndexes();
};

const MIGRATIONS: Migration[] = [
  {
    description:
      "Reconcile legacy databases with the current declarative schema",
    id: "2026-06-11_current_schema",
    up: syncCurrentSchema,
    verify: verifyCurrentAppSchema,
  },
  {
    description:
      "Add encrypted sumup_checkouts staging table for SumUp metadata",
    id: "2026-06-12_sumup_checkouts",
    up: async () => {
      await applySchemaChanges();
      await syncIndexes();
    },
    verify: verifyCurrentAppSchema,
  },
  {
    description:
      "Reorder listing_attendees overlap index to (listing_id, end_at, start_at) so per-day capacity scans skip historical rows",
    // NB: legacy id retained verbatim — this is a stored marker, not display text
    id: "2026-06-13_event_attendees_overlap_index",
    up: syncIndexes,
    verify: verifyOverlapIndex,
  },
  {
    description:
      "Rename the 'event' domain to 'listing' (tables, columns and indexes)",
    id: "2026-06-14_rename_events_to_listings",
    up: renameEventsToListings,
    verify: verifyCurrentAppSchema,
  },
  {
    description:
      "Add a single global sort_order per question (replacing per-listing ordering); backfill existing questions from their row id to preserve creation order",
    id: "2026-06-14_question_sort_order",
    up: async () => {
      await applySchemaChanges();
      // One-time backfill: existing rows all default to 0, so seed each from
      // its id (distinct, creation-ordered). New questions are assigned a
      // non-zero sort_order on creation, so this never re-touches them.
      await getDb().execute(
        "UPDATE questions SET sort_order = id WHERE sort_order = 0",
      );
    },
    verify: verifyCurrentAppSchema,
  },
  {
    description:
      "Add email_preferences table for marketing opt-outs and contact history",
    id: "2026-06-14_email_preferences",
    up: async () => {
      await applySchemaChanges();
      await syncIndexes();
    },
    verify: verifyCurrentAppSchema,
  },
  {
    description:
      "Add customisable_days and day_prices columns to listings so visitors can choose how many days to book with per-day-count pricing",
    id: "2026-06-14_listing_customisable_days",
    up: async () => {
      await applySchemaChanges();
    },
    verify: verifyCurrentAppSchema,
  },
  {
    description:
      "Add attendee_statuses table, status_id + remaining_balance on attendees, and attendee_id on activity_log; seed the default status and backfill existing attendees onto it",
    id: "2026-06-14_attendee_statuses",
    up: async () => {
      await applySchemaChanges();
      await syncIndexes();
      await ensureDefaultAttendeeStatus();
    },
    verify: verifyCurrentAppSchema,
  },
  {
    description:
      "Add idx_activity_log_listing_id so per-listing activity log lookups use an index range scan instead of a full table scan",
    id: "2026-06-15_activity_log_listing_id_index",
    up: syncIndexes,
    verify: verifyCurrentAppSchema,
  },
  {
    description:
      "Add logistics_agents table, uses_logistics flag on listings, split_logistics_agents on attendees, and start_agent_id/end_agent_id/start_time/end_time on listing_attendees for the logistics flow",
    id: "2026-06-16_logistics_agents",
    up: async () => {
      await applySchemaChanges();
    },
    verify: verifyCurrentAppSchema,
  },
];

export const MIGRATION_IDS: string[] = MIGRATIONS.map(
  (migration) => migration.id,
);

const ensureMigrationTrackingTable = async (): Promise<void> => {
  await getDb().execute(
    createTableSql(SCHEMA.find(([name]) => name === SCHEMA_MIGRATIONS_TABLE)!),
  );
};

const getAppliedMigrationIds = async (): Promise<Set<string>> => {
  await ensureMigrationTrackingTable();
  const result = await getDb().execute(
    `SELECT id FROM ${SCHEMA_MIGRATIONS_TABLE}`,
  );
  return new Set(result.rows.map((row) => String(row.id)));
};

const markMigrationApplied = async (migration: Migration): Promise<void> => {
  await ensureMigrationTrackingTable();
  await getDb().execute({
    args: [migration.id, migration.description, new Date().toISOString()],
    sql: `INSERT OR REPLACE INTO ${SCHEMA_MIGRATIONS_TABLE} (id, description, applied_at) VALUES (?, ?, ?)`,
  });
};

const writeSchemaMarkers = async (): Promise<void> => {
  await getDb().execute({
    args: [LATEST_UPDATE],
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('latest_db_update', ?)",
  });
  await getDb().execute({
    args: [SCHEMA_HASH],
    sql: "INSERT OR REPLACE INTO settings (key, value) VALUES ('db_schema_hash', ?)",
  });
};

const baselineCurrentSchemaIfNeeded = async (): Promise<void> => {
  const applied = await getAppliedMigrationIds();
  const missing = MIGRATIONS.filter((migration) => !applied.has(migration.id));
  if (missing.length === 0) return;

  await verifyCurrentAppSchema();
  logDebug(
    "Migration",
    `Baselining ${missing.length} already-applied migration(s)`,
  );
  for (const migration of missing) {
    await markMigrationApplied(migration);
  }
};

const pendingMigrations = async (): Promise<Migration[]> => {
  const applied = await getAppliedMigrationIds();
  return MIGRATIONS.filter((migration) => !applied.has(migration.id));
};

const runPendingMigrations = async (pending: Migration[]): Promise<void> => {
  for (const migration of pending) {
    logDebug("Migration", `Running ${migration.id}: ${migration.description}`);
    await migration.up();
    await migration.verify();
    await markMigrationApplied(migration);
  }
};

/**
 * Stale markers with nothing pending happen two ways: a previous run was
 * killed after recording its migrations but before refreshing the markers
 * (verification passes — rewrite the markers), or SCHEMA was changed without
 * adding a named migration (verification fails — refuse to guess).
 */
const restoreStaleSchemaMarkers = async (): Promise<void> => {
  try {
    await verifyCurrentAppSchema();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      "Database schema markers are stale, no named migrations are pending, " +
        `and the live schema does not match (${detail}). ` +
        "Every SCHEMA change must ship with a new entry in MIGRATIONS.",
    );
  }
  logDebug("Migration", "Schema verified; restoring stale schema markers");
  await writeSchemaMarkers();
};

const MIGRATION_LOCK_KEY = "migration_lock";

/**
 * A migration lock older than this is treated as abandoned and stolen.
 * Migrations run inline on edge isolates that can be evicted mid-run,
 * orphaning the lock; the TTL lets the next boot self-heal instead of
 * requiring a manual DELETE FROM settings.
 */
export const MIGRATION_LOCK_TTL_MS = 2 * 60 * 1000;

/**
 * Acquire an advisory migration lock via the settings table.
 * Returns true if acquired, false if another process holds a fresh lock.
 * Stored values are ISO-8601 UTC timestamps, which sort lexicographically,
 * so a single atomic UPSERT both takes a free lock and steals an expired
 * one: DO UPDATE only fires when the held lock predates the cutoff, and a
 * fresh lock leaves rowsAffected at 0. Race-free across concurrent isolates
 * without a separate read.
 */
const acquireMigrationLock = async (
  allowMissingSettings: boolean,
): Promise<boolean> => {
  const now = new Date();
  const cutoff = new Date(now.getTime() - MIGRATION_LOCK_TTL_MS).toISOString();
  const stamp = now.toISOString();
  const result = await getDb()
    .execute({
      args: [MIGRATION_LOCK_KEY, stamp, stamp, cutoff],
      sql:
        "INSERT INTO settings (key, value) VALUES (?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = ? WHERE settings.value < ?",
    })
    .catch((error) => {
      if (allowMissingSettings && isMissingSettingsTableError(error)) {
        return null;
      }
      throw error;
    });
  return result === null || result.rowsAffected === 1;
};

/** Release the migration lock */
const releaseMigrationLock = async (): Promise<void> => {
  await runMigration(
    `DELETE FROM settings WHERE key = '${MIGRATION_LOCK_KEY}'`,
  );
};

type InitDbOptions = {
  /** Only setup/restore/bootstrap callers should create a missing settings table. */
  allowMissingSettings?: boolean;
};

// ─── Main migration ─────────────────────────────────────────────

/**
 * The client most recently confirmed ready by initDb. initDb runs on every
 * request, so once a client is confirmed the hot path must cost zero
 * queries. Only success is cached — failures are retried on the next call.
 */
const [getReadyClient, setReadyClient] = lazyRef<Client | null>(() => null);

/** Forget the per-isolate "database is ready" cache. */
export const invalidateInitDbCache = (): void => {
  setReadyClient(null);
};

/**
 * Initialize database tables for an existing database.
 * Fresh database creation requires allowMissingSettings.
 * Uses an advisory lock to prevent concurrent migrations.
 */
export const initDb = async (opts: InitDbOptions = {}): Promise<void> => {
  const client = getDb();
  if (client === getReadyClient()) return;
  await initDbUncached(opts.allowMissingSettings ?? false);
  setReadyClient(client);
};

const initDbUncached = async (allowMissingSettings: boolean): Promise<void> => {
  let state = await getDbState();
  if (state === "up_to_date") {
    await baselineCurrentSchemaIfNeeded();
    return;
  }
  if (state === "missing_settings" && !allowMissingSettings) {
    throw new MissingSettingsTableError();
  }
  if (state === "uninitialized_settings" && !allowMissingSettings) {
    throw new MissingSettingsTableError(
      "Database settings table is uninitialized",
    );
  }

  const acquired = await acquireMigrationLock(allowMissingSettings);
  if (!acquired) {
    void sendNtfyError(`E_DB_MIGRATION_LOCK ${getEnv("DB_URL") ?? "unknown"}`);
    throw new MigrationInProgressError(
      "Database migration is already in progress (migration_lock held). " +
        `The request can be retried; a crashed migration's lock is reclaimed automatically after ${
          MIGRATION_LOCK_TTL_MS / 60000
        } minutes, or manually DELETE FROM settings WHERE key = 'migration_lock'.`,
    );
  }

  try {
    // Re-check after acquiring lock (another process may have finished)
    state = await getDbState();
    if (state === "up_to_date") {
      await baselineCurrentSchemaIfNeeded();
      return;
    }

    const pending = await pendingMigrations();
    if (pending.length === 0) {
      await restoreStaleSchemaMarkers();
      return;
    }

    // Back up before migrating — but only for existing databases, not fresh installs.
    // Skip if a recent backup already exists (e.g. a retried migration after a crash).
    if (state === "needs_migration" && isStorageEnabled()) {
      if (await hasRecentBackup()) {
        logDebug(
          "Migration",
          "Recent backup exists, skipping pre-migration backup",
        );
      } else {
        logDebug("Migration", "Creating pre-migration backup...");
        const filename = await createAndUploadBackup();
        logDebug("Migration", `Pre-migration backup saved: ${filename}`);
      }
    }

    await runPendingMigrations(pending);

    logDebug("Migration", "Updating version marker...");
    await writeSchemaMarkers();
  } finally {
    // If the isolate is evicted mid-migration this finally will not run, so
    // stale locks are still reclaimed by MIGRATION_LOCK_TTL_MS.
    await releaseMigrationLock().catch((error) =>
      logDebug(
        "Migration",
        `Failed to release migration lock: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ),
    );
  }
};

// ─── Reset ──────────────────────────────────────────────────────

/**
 * Reset the database by dropping all tables (reverse order for FK safety)
 */
export const resetDatabase = async (): Promise<void> => {
  invalidateInitDbCache();
  const client = getDb();
  for (const [name] of [...SCHEMA].reverse()) {
    await client.execute(`DROP TABLE IF EXISTS ${name}`);
  }
};

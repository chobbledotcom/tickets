/** Declarative database schema and schema hash. */

// ─── Types ──────────────────────────────────────────────────────

export type Column = [name: string, type: string];

export type Index = {
  name: string;
  columns: string[];
  unique?: boolean;
};

export type Table = {
  columns: Column[];
  indexes?: Index[];
};

/**
 * A SQLite trigger that maintains a precomputed aggregate. Unlike indexes,
 * triggers aren't part of a single table's definition (they fire on one table
 * and write to another), so they live in their own list. `table` is the table
 * the trigger fires ON — used to re-create the trigger after that table is
 * rebuilt by {@link recreateTable}, which silently drops attached triggers.
 * `sql` is the full idempotent `CREATE TRIGGER IF NOT EXISTS …` statement.
 */
export type Trigger = {
  name: string;
  table: string;
  sql: string;
};

// ─── Version — update LATEST_UPDATE to describe each change ─────

export const LATEST_UPDATE =
  "Add idx_listing_attendees_ledger_event_group so the ledger-replay owner lookup (attendeeIdByLedgerEventGroup: SELECT attendee_id FROM listing_attendees WHERE ledger_event_group = ?) resolves via an index seek instead of a full-table scan of every booking ever made.";

// ─── Schema (ordered: tables with no FK deps first) ─────────────

export const SCHEMA_MIGRATIONS_TABLE = "schema_migrations";

export const SCHEMA: [name: string, table: Table][] = [
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
        // Precomputed counts over listing_attendees, maintained by the
        // LISTING_AGGREGATE_TRIGGERS so listing reads and the active-listing
        // stats never COUNT the listing_attendees table. booked_quantity is
        // SUM(quantity) and tickets_count counts only real-ticket rows
        // (quantity > 0 — the no-quantity sentinel, quantity = 0, keeps its
        // link but is not a ticket; see TICKET_COUNTS_PREDICATE), scoped to
        // this listing. Income is no longer stored: it is projected from the
        // transfers ledger (gross credits to revenue:<listingId>) at read time.
        ["booked_quantity", "INTEGER NOT NULL DEFAULT 0"],
        ["tickets_count", "INTEGER NOT NULL DEFAULT 0"],
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
        // KEK derivation scheme for wrapped_data_key: 1 = legacy (KEK derived
        // from the stored password hash, so a DB dump + DB_ENCRYPTION_KEY can
        // re-derive it), 2 = password-bound (KEK derived from the raw password,
        // never stored). New activated users are created at 2; legacy rows are
        // upgraded lazily on their owner's next login.
        ["kek_version", "INTEGER NOT NULL DEFAULT 1"],
        // DATA_KEY wrapped under the single-use invite code, set when a user is
        // invited so they can self-activate at /join (unwrap with the code, then
        // re-wrap under their new password's KEK). NULL once activated. The code
        // is only ever stored hashed, so this is not unwrappable from a DB dump.
        ["invite_wrapped_data_key", "TEXT"],
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
    // Many-to-many link between agent users and the logistics agents
    // (vans/crews) they drive. One user may cover several agents and one
    // agent may be driven by several users. No FKs (see note on
    // listing_attendees); application logic + the indexes keep it consistent,
    // and both deleteUser and logistics-agent deletion prune their rows.
    "user_logistics_agents",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["user_id", "INTEGER NOT NULL"],
        ["agent_id", "INTEGER NOT NULL"],
      ],
      indexes: [
        {
          columns: ["user_id", "agent_id"],
          name: "idx_user_logistics_agents_unique",
          unique: true,
        },
        {
          columns: ["agent_id"],
          name: "idx_user_logistics_agents_agent_id",
        },
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
        ["checked_in", "TEXT NOT NULL DEFAULT ''"],
        ["ticket_token_index", "TEXT"],
        ["pii_blob", "TEXT NOT NULL DEFAULT ''"],
        ["status_id", "INTEGER DEFAULT NULL"],
        ["split_logistics_agents", "INTEGER NOT NULL DEFAULT 0"],
        // HMAC blind-index of the attendee's phone, populated lazily the first
        // time an admin texts them, so inbound SMS replies can be matched back
        // to the attendee without storing the number in the clear.
        ["phone_index", "TEXT NOT NULL DEFAULT ''"],
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
        {
          columns: ["phone_index"],
          name: "idx_attendees_phone_index",
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
        // The ledger event group of the booking order this row belongs to, so a
        // per-row money projection (amount paid) can find exactly this booking's
        // legs even when an attendee holds several orders for one listing. Set on
        // booking creation and by the backfill; '' for rows with no ledger legs.
        ["ledger_event_group", "TEXT NOT NULL DEFAULT ''"],
        ["attachment_downloads", "INTEGER NOT NULL DEFAULT 0"],
        ["start_agent_id", "INTEGER DEFAULT NULL"],
        ["end_agent_id", "INTEGER DEFAULT NULL"],
        ["start_time", "TEXT NOT NULL DEFAULT ''"],
        ["end_time", "TEXT NOT NULL DEFAULT ''"],
        ["start_done", "INTEGER NOT NULL DEFAULT 0"],
        ["end_done", "INTEGER NOT NULL DEFAULT 0"],
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
        // The ledger-replay owner lookup (attendeeIdByLedgerEventGroup) seeks a
        // booking by its event group: WHERE ledger_event_group = ?. Without this
        // it full-scans every row ever booked; the '' default rows (no ledger
        // legs) collapse to one key, so a real group still seeks straight to it.
        {
          columns: ["ledger_event_group"],
          name: "idx_listing_attendees_ledger_event_group",
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
        ["failure_data", "TEXT NOT NULL DEFAULT ''"],
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
    "modifiers",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["name", "TEXT NOT NULL"],
        ["calc_kind", "TEXT NOT NULL"],
        ["calc_value", "REAL NOT NULL"],
        ["direction", "TEXT NOT NULL"],
        ["active", "INTEGER NOT NULL DEFAULT 1"],
        ["trigger", "TEXT NOT NULL DEFAULT 'automatic'"],
        ["code", "TEXT NOT NULL DEFAULT ''"],
        ["code_index", "TEXT"],
        ["scope", "TEXT NOT NULL DEFAULT 'all'"],
        ["stock", "INTEGER"],
        ["max_per_order", "INTEGER"],
        ["min_subtotal", "INTEGER NOT NULL DEFAULT 0"],
        ["min_visits", "INTEGER NOT NULL DEFAULT 0"],
        // Precomputed count aggregates over modifier_usages, maintained by the
        // MODIFIER_AGGREGATE_TRIGGERS so admin reads never SUM/COUNT the
        // modifier_usages table. total_uses is SUM(quantity) and usage_count is
        // COUNT(*), both scoped to this modifier. Answer-triggered modifiers
        // record usages here too, so an answer "pricing tier" reports
        // cumulative totals like any modifier. The money figure (total_revenue)
        // is not a column: it is projected from the transfers ledger as
        // balanceOf(modifier:M) at read time (see modifierRevenueSubquery).
        ["total_uses", "INTEGER NOT NULL DEFAULT 0"],
        ["usage_count", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [{ columns: ["code_index"], name: "idx_modifiers_code_index" }],
    },
  ],

  [
    "modifier_listings",
    {
      columns: [
        ["modifier_id", "INTEGER NOT NULL"],
        ["listing_id", "INTEGER NOT NULL"],
      ],
      indexes: [
        {
          columns: ["modifier_id", "listing_id"],
          name: "idx_modifier_listings_pair",
          unique: true,
        },
        { columns: ["listing_id"], name: "idx_modifier_listings_listing" },
      ],
    },
  ],

  [
    "modifier_groups",
    {
      columns: [
        ["modifier_id", "INTEGER NOT NULL"],
        ["group_id", "INTEGER NOT NULL"],
      ],
      indexes: [
        {
          columns: ["modifier_id", "group_id"],
          name: "idx_modifier_groups_pair",
          unique: true,
        },
        { columns: ["group_id"], name: "idx_modifier_groups_group" },
      ],
    },
  ],

  [
    "modifier_usages",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["modifier_id", "INTEGER NOT NULL"],
        ["attendee_id", "INTEGER NOT NULL"],
        ["quantity", "INTEGER NOT NULL"],
        ["amount_applied", "INTEGER NOT NULL"],
        ["created", "TEXT NOT NULL"],
      ],
      indexes: [
        { columns: ["modifier_id"], name: "idx_modifier_usages_modifier" },
        { columns: ["attendee_id"], name: "idx_modifier_usages_attendee" },
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
        [
          "display_type",
          "TEXT NOT NULL DEFAULT 'radio' CHECK (display_type IN ('radio', 'select', 'free_text'))",
        ],
        ["assign_all", "INTEGER NOT NULL DEFAULT 0"],
      ],
    },
  ],

  [
    "strings",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["text_index", "TEXT NOT NULL"],
        ["encrypted_text", "TEXT NOT NULL"],
        ["used_count", "INTEGER NOT NULL DEFAULT 0"],
        ["created", "TEXT NOT NULL DEFAULT ''"],
      ],
      indexes: [
        {
          columns: ["text_index"],
          name: "idx_strings_text_index",
          unique: true,
        },
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
        // The price modifier this answer triggers (an "answer"-trigger
        // modifier), or NULL for an answer with no price effect. Many answers
        // may point at one "pricing tier" modifier; an answer has at most one.
        ["modifier_id", "INTEGER"],
        // Precomputed COUNT of attendee_answers rows for this answer,
        // maintained by the ANSWER_AGGREGATE_TRIGGERS so the question/answer
        // admin pages report how many times the answer was chosen without
        // scanning attendee_answers. Owner-editable on the answer edit page;
        // the recalculate flow rebuilds it from attendee_answers when it drifts.
        ["times_selected", "INTEGER NOT NULL DEFAULT 0"],
        // Deactivated answers (active = 0) are hidden on the public booking
        // form but still shown on the admin edit form for an attendee who
        // already selected them, so historic answers are never silently lost.
        ["active", "INTEGER NOT NULL DEFAULT 1"],
      ],
      indexes: [
        { columns: ["question_id"], name: "idx_answers_question_id" },
        { columns: ["modifier_id"], name: "idx_answers_modifier_id" },
      ],
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
        // ISO timestamp of the last time the master poked this site to trigger
        // its prune; '' (never) sorts first so the master walks every site in
        // round-robin order. Operational metadata, not PII, so it lives outside
        // the encrypted site_data blob.
        ["last_pruned", "TEXT NOT NULL DEFAULT ''"],
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
        ["answer_id", "INTEGER"],
        ["question_id", "INTEGER"],
        ["string_id", "INTEGER"],
      ],
      indexes: [
        {
          columns: ["attendee_id"],
          name: "idx_attendee_answers_attendee_id",
        },
        { columns: ["answer_id"], name: "idx_attendee_answers_answer_id" },
        { columns: ["question_id"], name: "idx_attendee_answers_question_id" },
        { columns: ["string_id"], name: "idx_attendee_answers_string_id" },
        {
          columns: ["attendee_id", "answer_id"],
          name: "idx_attendee_answers_unique",
          unique: true,
        },
        {
          columns: ["attendee_id", "question_id"],
          name: "idx_attendee_string_answers_unique",
          unique: true,
        },
      ],
    },
  ],

  [
    // Per-attendee notes the operator sees on the attendee record. `note` is
    // always stored encrypted — a `system` note (auto-generated, e.g. the
    // refunded-but-stored booking warning) with the symmetric DB_ENCRYPTION_KEY
    // so a key-less system path can both write and read it back, an `owner` note
    // (operator-authored) with the owner public key so only the owner can read
    // it. System notes are kept PII-free by convention. No FKs — the attendee
    // delete path prunes these rows explicitly.
    "system_notes",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["attendee_id", "INTEGER NOT NULL"],
        [
          "type",
          "TEXT NOT NULL DEFAULT 'system' CHECK (type IN ('system', 'owner'))",
        ],
        ["note", "TEXT NOT NULL"],
        ["created", "TEXT NOT NULL"],
      ],
      indexes: [
        { columns: ["attendee_id"], name: "idx_system_notes_attendee_id" },
      ],
    },
  ],

  [
    // Per-contact marketing preferences, contact history, and visit counts,
    // keyed by an opaque HMAC blind index. Public checkout/unsubscribe paths can
    // read the plaintext operational scalars; richer outreach stats stay in the
    // owner-keypair-encrypted stats_blob.
    "contact_preferences",
    {
      columns: [
        ["contact_hash", "TEXT PRIMARY KEY"],
        ["unsubscribed", "INTEGER NOT NULL DEFAULT 0"],
        ["visits", "INTEGER NOT NULL DEFAULT 0"],
        ["public_booking_count", "INTEGER NOT NULL DEFAULT 0"],
        ["admin_booking_count", "INTEGER NOT NULL DEFAULT 0"],
        ["stats_blob", "TEXT NOT NULL DEFAULT ''"],
        ["last_activity", "INTEGER NOT NULL DEFAULT 0"],
      ],
      indexes: [
        {
          columns: ["unsubscribed"],
          name: "idx_contact_prefs_unsubscribed",
        },
        {
          columns: ["last_activity"],
          name: "idx_contact_prefs_last_activity",
        },
      ],
    },
  ],

  [
    // Reusable email templates — subject and body stored as owner-keypair-
    // encrypted blobs so the operator cannot read content without the owner's
    // password. Encryption/decryption is handled at the route layer (same
    // approach as bulk_email_draft in settings).
    "email_templates",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["subject", "TEXT NOT NULL"],
        ["body", "TEXT NOT NULL"],
      ],
    },
  ],

  [
    // Lean, PII-free map from the gateway's message id to the attendee it was
    // sent to, so delivery/failure webhooks can be logged against the right
    // attendee. Message content and recipient numbers live only in the
    // (encrypted) activity log — never here. Rows are deleted on a terminal
    // status event and pruned by age as a backstop.
    "sms_messages",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["attendee_id", "INTEGER NOT NULL"],
        ["listing_id", "INTEGER NOT NULL"],
        ["provider_id", "TEXT NOT NULL"],
        ["created", "TEXT NOT NULL"],
      ],
      indexes: [
        { columns: ["provider_id"], name: "idx_sms_messages_provider_id" },
        { columns: ["created"], name: "idx_sms_messages_created" },
      ],
    },
  ],

  [
    // Short-lived inbound idempotency ledger keyed by the gateway's stable
    // inbound id. Contains no SMS content or sender number.
    "processed_sms_inbound",
    {
      columns: [
        ["webhook_id", "TEXT PRIMARY KEY"],
        ["created", "TEXT NOT NULL"],
      ],
      indexes: [
        { columns: ["created"], name: "idx_processed_sms_inbound_created" },
      ],
    },
  ],

  [
    // Append-only double-entry ledger: each row moves a positive `amount` from a
    // (source_type, source_id) account to a (dest_type, dest_id) account at
    // occurred_at (business time). Balances are derived — nothing here is ever
    // mutated. PII- and provider-id-free: `reference` is an opaque HMAC, and any
    // memo that could carry PII is owner-key encrypted by the host before it
    // reaches the column. No FKs, so erasing an attendee never cascades here.
    "transfers",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["source_type", "TEXT NOT NULL"],
        ["source_id", "TEXT NOT NULL"],
        ["dest_type", "TEXT NOT NULL"],
        ["dest_id", "TEXT NOT NULL"],
        ["amount", "INTEGER NOT NULL CHECK (amount > 0)"],
        // Epoch-millis: the indexed time column then sorts/ranges chronologically
        // with integer comparisons at high row counts. The host stores any ISO
        // instant as its epoch-millis and reads it back canonical (see
        // shared/validation/timestamp.ts).
        ["occurred_at", "INTEGER NOT NULL"],
        ["recorded_at", "INTEGER NOT NULL"],
        ["reference", "TEXT NOT NULL"],
        ["event_group", "TEXT NOT NULL"],
        ["kind", "TEXT NOT NULL DEFAULT ''"],
        ["memo", "TEXT NOT NULL DEFAULT ''"],
        ["reverses_id", "INTEGER DEFAULT NULL"],
        ["posted_by", "TEXT NOT NULL DEFAULT 'system'"],
      ],
      indexes: [
        // Idempotency: one row per opaque reference (the ON CONFLICT target).
        {
          columns: ["reference"],
          name: "idx_transfers_reference",
          unique: true,
        },
        // Balance projections scan by account.
        { columns: ["source_type", "source_id"], name: "idx_transfers_source" },
        { columns: ["dest_type", "dest_id"], name: "idx_transfers_dest" },
        // Period reports and statement ordering.
        { columns: ["occurred_at"], name: "idx_transfers_occurred_at" },
        // Order-scoped guards/refunds group by event.
        { columns: ["event_group"], name: "idx_transfers_event_group" },
        // At most one void per original: a non-NULL reverses_id is unique
        // (SQLite treats NULLs as distinct, so ordinary transfers are free).
        {
          columns: ["reverses_id"],
          name: "idx_transfers_reverses_id",
          unique: true,
        },
      ],
    },
  ],
];

/**
 * The listing_attendees columns that shift the listing count aggregates
 * (booked_quantity, tickets_count). The UPDATE trigger fires on exactly these
 * columns; the cache-invalidation gate in listings.ts reads the same constant so
 * the two cannot drift. price_paid is no longer here — income is projected from
 * the transfers ledger at read time, not maintained from this column.
 */
export const LISTING_AGGREGATE_WRITE_COLUMNS = [
  "quantity",
  "listing_id",
] as const;

/**
 * The predicate deciding whether a listing_attendees row counts toward
 * listings.tickets_count. A quantity = 0 line is the "no quantity" sentinel — it
 * keeps the attendee↔listing link but is not a ticket — so tickets_count counts
 * only rows where quantity > 0. booked_quantity (SUM(quantity)) already treats 0
 * correctly and must NOT use this predicate.
 *
 * Every site that computes tickets_count references this one constant so the
 * rule cannot silently diverge (mirrors LISTING_AGGREGATE_WRITE_COLUMNS): the
 * three triggers below, the two queries in listings.ts (reset + recalculation),
 * the schema-sync backfill, and the hold-delete restore in attendees/delete.ts.
 * A guard test asserts the predicate appears at every one of those sites.
 */
export const TICKET_COUNTS_PREDICATE = "quantity > 0";

/**
 * tickets_count as a COALESCE(SUM(CASE …)) over {@link TICKET_COUNTS_PREDICATE},
 * for the recalculation/restore SELECTs that compute it in one pass alongside
 * SUM(quantity). COALESCE because SUM over zero rows is NULL (unlike COUNT(*)'s
 * 0), so an empty listing would otherwise report bogus drift against a stored 0.
 */
export const ticketCountSumExpr = (): string =>
  `COALESCE(SUM(CASE WHEN ${TICKET_COUNTS_PREDICATE} THEN 1 ELSE 0 END), 0)`;

/**
 * The per-row delta a listing-aggregate trigger adds to / subtracts from
 * tickets_count for a NEW/OLD row: +1 only when that row is a real ticket, so
 * toggling a line 0↔n nets out correctly via the OLD/NEW deltas.
 */
const ticketCountTriggerDelta = (row: "NEW" | "OLD"): string =>
  `CASE WHEN ${row}.${TICKET_COUNTS_PREDICATE} THEN 1 ELSE 0 END`;

/**
 * Triggers that keep the listing count aggregates (booked_quantity,
 * tickets_count) in lockstep with listing_attendees, so the hot listing reads
 * and the active-listing stats cost one row read instead of scanning every
 * attendee row. tickets_count counts only quantity > 0 rows (see
 * TICKET_COUNTS_PREDICATE); income is no longer an aggregate column — it is
 * projected from the transfers ledger (gross credits to revenue:<listingId>) at
 * read time.
 *
 * The UPDATE trigger is scoped to `OF quantity, listing_id` so the frequent
 * check-in / refund / attachment-download / price writes (which touch other
 * columns) don't fire it. It subtracts the OLD row's contribution from its old
 * listing and adds the NEW row's to its new listing, so a row moving between
 * listings stays correct and a same-listing edit nets out to the delta.
 *
 * booked_quantity mirrors the previous SUM(quantity) exactly (every row counts
 * toward capacity, including the quantity = 0 no-quantity sentinel, which adds
 * nothing); tickets_count counts only quantity > 0 rows, so the sentinel keeps
 * its attendee↔listing link without inflating the ticket total.
 */
const LISTING_AGGREGATE_TRIGGERS: Trigger[] = [
  {
    name: "trg_listing_attendees_aggregates_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_listing_attendees_aggregates_insert
AFTER INSERT ON listing_attendees
FOR EACH ROW
BEGIN
  UPDATE listings SET
    booked_quantity = booked_quantity + NEW.quantity,
    tickets_count = tickets_count + ${ticketCountTriggerDelta("NEW")}
  WHERE id = NEW.listing_id;
END`,
    table: "listing_attendees",
  },
  {
    name: "trg_listing_attendees_aggregates_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_listing_attendees_aggregates_delete
AFTER DELETE ON listing_attendees
FOR EACH ROW
BEGIN
  UPDATE listings SET
    booked_quantity = booked_quantity - OLD.quantity,
    tickets_count = tickets_count - ${ticketCountTriggerDelta("OLD")}
  WHERE id = OLD.listing_id;
END`,
    table: "listing_attendees",
  },
  {
    name: "trg_listing_attendees_aggregates_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_listing_attendees_aggregates_update
AFTER UPDATE OF ${LISTING_AGGREGATE_WRITE_COLUMNS.join(", ")} ON listing_attendees
FOR EACH ROW
BEGIN
  UPDATE listings SET
    booked_quantity = booked_quantity - OLD.quantity,
    tickets_count = tickets_count - ${ticketCountTriggerDelta("OLD")}
  WHERE id = OLD.listing_id;
  UPDATE listings SET
    booked_quantity = booked_quantity + NEW.quantity,
    tickets_count = tickets_count + ${ticketCountTriggerDelta("NEW")}
  WHERE id = NEW.listing_id;
END`,
    table: "listing_attendees",
  },
];

/**
 * Modifier aggregate triggers keep modifiers.total_uses and modifiers.usage_count
 * in step with the modifier_usages ledger, the same way the listing triggers
 * maintain the listings aggregates. The UPDATE trigger is scoped to OF quantity,
 * modifier_id so the only writes that affect the counts fire it, and it subtracts
 * the OLD row's contribution from its old modifier and adds the NEW row's to its
 * new modifier so a row moving between modifiers stays correct.
 *
 * Semantics mirror the previous SUM(quantity) / COUNT(*) queries over
 * modifier_usages exactly. The money figure (total_revenue) is no longer a
 * maintained column — it is projected from the transfers ledger at read time —
 * so amount_applied no longer drives any aggregate and is out of the UPDATE OF
 * list.
 */
const MODIFIER_AGGREGATE_TRIGGERS: Trigger[] = [
  {
    name: "trg_modifier_usages_aggregates_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_modifier_usages_aggregates_insert
AFTER INSERT ON modifier_usages
FOR EACH ROW
BEGIN
  UPDATE modifiers SET
    total_uses = total_uses + NEW.quantity,
    usage_count = usage_count + 1
  WHERE id = NEW.modifier_id;
END`,
    table: "modifier_usages",
  },
  {
    name: "trg_modifier_usages_aggregates_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_modifier_usages_aggregates_delete
AFTER DELETE ON modifier_usages
FOR EACH ROW
BEGIN
  UPDATE modifiers SET
    total_uses = total_uses - OLD.quantity,
    usage_count = usage_count - 1
  WHERE id = OLD.modifier_id;
END`,
    table: "modifier_usages",
  },
  {
    name: "trg_modifier_usages_aggregates_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_modifier_usages_aggregates_update
AFTER UPDATE OF quantity, modifier_id ON modifier_usages
FOR EACH ROW
BEGIN
  UPDATE modifiers SET
    total_uses = total_uses - OLD.quantity,
    usage_count = usage_count - 1
  WHERE id = OLD.modifier_id;
  UPDATE modifiers SET
    total_uses = total_uses + NEW.quantity,
    usage_count = usage_count + 1
  WHERE id = NEW.modifier_id;
END`,
    table: "modifier_usages",
  },
];

/**
 * Answer aggregate triggers keep answers.times_selected in step with the
 * attendee_answers join table, the same way the listing and modifier triggers
 * maintain their aggregates. Each attendee_answers row is one selection, so the
 * count is COUNT(*) per answer_id. The UPDATE trigger is scoped to OF answer_id
 * — the only column whose change moves a selection between answers — and it
 * subtracts the OLD answer's contribution and adds the NEW answer's so a
 * reassigned row stays correct.
 *
 * Semantics mirror the previous COUNT(*) query over attendee_answers exactly.
 */
const ANSWER_AGGREGATE_TRIGGERS: Trigger[] = [
  {
    name: "trg_attendee_answers_aggregates_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_aggregates_insert
AFTER INSERT ON attendee_answers
FOR EACH ROW
WHEN NEW.answer_id IS NOT NULL
BEGIN
  UPDATE answers SET times_selected = times_selected + 1
  WHERE id = NEW.answer_id;
END`,
    table: "attendee_answers",
  },
  {
    name: "trg_attendee_answers_aggregates_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_aggregates_delete
AFTER DELETE ON attendee_answers
FOR EACH ROW
WHEN OLD.answer_id IS NOT NULL
BEGIN
  UPDATE answers SET times_selected = times_selected - 1
  WHERE id = OLD.answer_id;
END`,
    table: "attendee_answers",
  },
  {
    name: "trg_attendee_answers_aggregates_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_aggregates_update
AFTER UPDATE OF answer_id ON attendee_answers
FOR EACH ROW
WHEN OLD.answer_id IS NOT NEW.answer_id
BEGIN
  UPDATE answers SET times_selected = times_selected - 1
  WHERE id = OLD.answer_id;
  UPDATE answers SET times_selected = times_selected + 1
  WHERE id = NEW.answer_id;
END`,
    table: "attendee_answers",
  },
];

const ATTENDEE_ANSWER_VALIDATION_TRIGGERS: Trigger[] = [
  {
    name: "trg_attendee_answers_validate_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_validate_insert
BEFORE INSERT ON attendee_answers
WHEN NOT (
  (NEW.answer_id IS NOT NULL AND NEW.question_id IS NOT NULL AND NEW.string_id IS NULL) OR
  (NEW.answer_id IS NULL AND NEW.question_id IS NOT NULL AND NEW.string_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid attendee answer');
END`,
    table: "attendee_answers",
  },
  {
    name: "trg_attendee_answers_validate_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_validate_update
BEFORE UPDATE ON attendee_answers
WHEN NOT (
  (NEW.answer_id IS NOT NULL AND NEW.question_id IS NOT NULL AND NEW.string_id IS NULL) OR
  (NEW.answer_id IS NULL AND NEW.question_id IS NOT NULL AND NEW.string_id IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'invalid attendee answer');
END`,
    table: "attendee_answers",
  },
];

const STRING_AGGREGATE_TRIGGERS: Trigger[] = [
  {
    name: "trg_attendee_answers_strings_insert",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_strings_insert
AFTER INSERT ON attendee_answers
WHEN NEW.string_id IS NOT NULL
BEGIN
  UPDATE strings SET used_count = used_count + 1 WHERE id = NEW.string_id;
END`,
    table: "attendee_answers",
  },
  {
    name: "trg_attendee_answers_strings_delete",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_strings_delete
AFTER DELETE ON attendee_answers
WHEN OLD.string_id IS NOT NULL
BEGIN
  UPDATE strings SET used_count = used_count - 1 WHERE id = OLD.string_id;
END`,
    table: "attendee_answers",
  },
  {
    name: "trg_attendee_answers_strings_update",
    sql: `CREATE TRIGGER IF NOT EXISTS trg_attendee_answers_strings_update
AFTER UPDATE OF string_id ON attendee_answers
WHEN OLD.string_id IS NOT NEW.string_id
BEGIN
  UPDATE strings SET used_count = used_count - 1 WHERE id = OLD.string_id;
  UPDATE strings SET used_count = used_count + 1 WHERE id = NEW.string_id;
END`,
    table: "attendee_answers",
  },
];

/** Every declared trigger, across all aggregate relationships. */
export const TRIGGERS: Trigger[] = [
  ...LISTING_AGGREGATE_TRIGGERS,
  ...MODIFIER_AGGREGATE_TRIGGERS,
  ...ANSWER_AGGREGATE_TRIGGERS,
  ...ATTENDEE_ANSWER_VALIDATION_TRIGGERS,
  ...STRING_AGGREGATE_TRIGGERS,
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

export const APP_SCHEMA = SCHEMA.filter(
  ([name]) => name !== SCHEMA_MIGRATIONS_TABLE,
);

// Triggers join the hash input so changing a trigger's SQL re-runs migrations
// even if no column/index changed (the same safety net columns already have).
export const SCHEMA_HASH = djb2(JSON.stringify([APP_SCHEMA, TRIGGERS]));

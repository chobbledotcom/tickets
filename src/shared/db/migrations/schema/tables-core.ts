/** Core schema tables: system config, auth, listings, assets, rate limits. */

import { itemLinkColumns } from "./columns.ts";
import type { Table } from "./types.ts";
import { SCHEMA_MIGRATIONS_TABLE } from "./version.ts";

export const coreTables: [name: string, table: Table][] = [
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
        // day_prices is no longer a column: per-day-count prices live in the
        // listing_prices "day_count" dimension (migrated in and projected back on
        // read via a json_group_object subquery). unit_price stays as the hot-path
        // base price, mirrored by the listing_prices "base" row.
        ["uses_logistics", "INTEGER NOT NULL DEFAULT 0"],
        ["use_defaults", "INTEGER NOT NULL DEFAULT 0"],
        ["bookable_alone", "INTEGER NOT NULL DEFAULT 0"],
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
    // Generalised per-listing pricing, keyed by a pricing *dimension*: a
    // `price_type` (e.g. "base", "day_count", "group", "group_day", and —
    // reserved for later — "start_day") and a `price_id` selecting within it (""
    // for base, the day count "2", a group id, "<groupId>/<n>", a weekday). One
    // row per (listing, dimension, key) so future dimensions (weekday pricing)
    // slot in with no schema change. "base" mirrors the surviving
    // `listings.unit_price` column (the hot-path read); "day_count" (per-day-count
    // price, migrated from `listings.day_prices`), "group" (flat package override,
    // migrated from group_listings.package_price), and "group_day" (per-day
    // package override) are the SOURCE of truth — their columns were dropped.
    "listing_prices",
    {
      columns: [
        ["listing_id", "INTEGER NOT NULL"],
        ["price_type", "TEXT NOT NULL"],
        ["price_id", "TEXT NOT NULL DEFAULT ''"],
        ["unit_price", "INTEGER NOT NULL"],
      ],
      indexes: [
        {
          columns: ["listing_id", "price_type", "price_id"],
          name: "idx_listing_prices_key",
          unique: true,
        },
        {
          columns: ["listing_id"],
          name: "idx_listing_prices_listing",
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
    // First-class uploaded images. All string columns are encrypted with the
    // same DB_ENCRYPTION_KEY-backed helpers as listings/groups; filenames are
    // storage object keys, not public URLs.
    "images",
    {
      columns: [
        ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
        ["name", "TEXT NOT NULL DEFAULT ''"],
        ["filename", "TEXT NOT NULL CHECK (filename <> '')"],
        ["filename_thumb", "TEXT NOT NULL CHECK (filename_thumb <> '')"],
        ["alt_text", "TEXT NOT NULL DEFAULT ''"],
      ],
    },
  ],

  [
    // Ordered, reusable image attachments. A row links one image to one item
    // (listing or group). No FKs (house style); delete paths prune these rows
    // explicitly and the unique key prevents duplicate use of the same image on
    // one item.
    "image_uses",
    {
      columns: [["image_id", "INTEGER NOT NULL"], ...itemLinkColumns],
      indexes: [
        {
          columns: ["item_type", "item_id", "sort_order"],
          name: "idx_image_uses_item_order",
        },
        {
          columns: ["image_id", "item_type", "item_id"],
          name: "idx_image_uses_unique",
          unique: true,
        },
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
];

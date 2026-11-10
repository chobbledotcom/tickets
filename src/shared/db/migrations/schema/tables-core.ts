/** Core schema tables: system config, auth, listings, assets, rate limits. */

import { datedRowColumns, itemLinkColumns } from "./columns.ts";
import {
  checked,
  defaulted,
  rowId,
  text,
  textKey,
  textOrNull,
  textStartingBlank,
  wholeNumber,
  wholeNumberOrNull,
  wholeNumberStartingAtOne,
  wholeNumberStartingAtZero,
} from "./scalar-columns.ts";
import type { Table } from "./types.ts";
import { SCHEMA_MIGRATIONS_TABLE } from "./version.ts";

export const coreTables: [name: string, table: Table][] = [
  [
    "settings",
    {
      columns: [
        ["key", textKey],
        ["value", text],
      ],
    },
  ],

  [
    SCHEMA_MIGRATIONS_TABLE,
    {
      columns: [
        ["id", textKey],
        ["description", text],
        ["applied_at", text],
      ],
    },
  ],

  [
    "maintenance_tasks",
    {
      columns: [
        ["name", textKey],
        ["checkpoint", textOrNull],
        ["completed_at", wholeNumberOrNull],
        ["next_run_at", wholeNumber],
        ["lease_token", textOrNull],
        ["lease_expires_at", wholeNumberOrNull],
        ["last_started_at", wholeNumberOrNull],
        [
          "last_finished_at",
          checked("(lease_token IS NULL) = (lease_expires_at IS NULL)")(
            wholeNumberOrNull,
          ),
        ],
      ],
      indexes: [
        {
          columns: ["next_run_at", "lease_expires_at", "name"],
          name: "idx_maintenance_tasks_due",
        },
      ],
    },
  ],

  [
    "listings",
    {
      columns: [
        ...datedRowColumns,
        ["max_attendees", wholeNumber],
        ["thank_you_url", textOrNull],
        ["unit_price", wholeNumberOrNull],
        ["max_quantity", wholeNumberStartingAtOne],
        ["min_quantity", wholeNumberStartingAtOne],
        ["webhook_url", textOrNull],
        ["slug", textOrNull],
        ["slug_index", textOrNull],
        ["active", wholeNumberStartingAtOne],
        ["fields", defaulted(text, "email")],
        ["closes_at", textOrNull],
        ["name", textStartingBlank],
        ["description", textStartingBlank],
        ["listing_type", defaulted(text, "standard")],
        [
          "bookable_days",
          defaulted(
            text,
            '["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"]',
          ),
        ],
        ["minimum_days_before", wholeNumberStartingAtOne],
        ["maximum_days_after", defaulted(wholeNumber, 90)],
        ["date", textStartingBlank],
        ["location", textStartingBlank],
        ["attachment_url", textStartingBlank],
        ["attachment_name", textStartingBlank],
        ["non_transferable", wholeNumberStartingAtZero],
        ["can_pay_more", wholeNumberStartingAtZero],
        ["hidden", wholeNumberStartingAtZero],
        ["purchase_only", wholeNumberStartingAtZero],
        ["assign_built_site", wholeNumberStartingAtZero],
        ["max_price", wholeNumberStartingAtZero],
        ["months_per_unit", wholeNumberStartingAtZero],
        ["initial_site_months", wholeNumberStartingAtZero],
        ["duration_days", wholeNumberStartingAtOne],
        ["customisable_days", wholeNumberStartingAtZero],
        // day_prices is no longer a column: per-day-count prices live in the
        // listing_prices "day_count" dimension (migrated in and projected back on
        // read via a json_group_object subquery). unit_price stays as the hot-path
        // base price, mirrored by the listing_prices "base" row.
        ["uses_logistics", wholeNumberStartingAtZero],
        ["use_defaults", wholeNumberStartingAtZero],
        ["bookable_alone", wholeNumberStartingAtZero],
        // The plan a new subscriber gets: minor units before VAT, and week,
        // month, or year. A price of 0 means an ordinary ticket.
        ["recurring_price", wholeNumberStartingAtZero],
        ["recurring_interval", textStartingBlank],
        // Precomputed counts over listing_attendees, maintained by the
        // LISTING_AGGREGATE_TRIGGERS so listing reads and the active-listing
        // stats never COUNT the listing_attendees table. booked_quantity is
        // SUM(quantity) and tickets_count counts only real-ticket rows
        // (quantity > 0 — the no-quantity sentinel, quantity = 0, keeps its
        // link but is not a ticket; see TICKET_COUNTS_PREDICATE), scoped to
        // this listing. Income is no longer stored: it is projected from the
        // transfers ledger (gross credits to revenue:<listingId>) at read time.
        ["booked_quantity", wholeNumberStartingAtZero],
        ["tickets_count", wholeNumberStartingAtZero],
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
        ["listing_id", wholeNumber],
        ["price_type", text],
        ["price_id", textStartingBlank],
        ["unit_price", wholeNumber],
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
        ["id", rowId],
        ["name", text],
      ],
    },
  ],

  [
    "users",
    {
      columns: [
        ["id", rowId],
        ["username_hash", text],
        ["username_index", text],
        ["password_hash", textStartingBlank],
        ["wrapped_data_key", textOrNull],
        ["admin_level", text],
        ["invite_code_hash", textOrNull],
        ["invite_expiry", textOrNull],
        // KEK derivation scheme for wrapped_data_key: 1 = legacy (KEK derived
        // from the stored password hash, so a DB dump + DB_ENCRYPTION_KEY can
        // re-derive it), 2 = password-bound (KEK derived from the raw password,
        // never stored). New activated users are created at 2; legacy rows are
        // upgraded lazily on their owner's next login.
        ["kek_version", wholeNumberStartingAtOne],
        // DATA_KEY wrapped under the single-use invite code, set when a user is
        // invited so they can self-activate at /join (unwrap with the code, then
        // re-wrap under their new password's KEK). NULL once activated. The code
        // is only ever stored hashed, so this is not unwrappable from a DB dump.
        ["invite_wrapped_data_key", textOrNull],
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
        ["token", textKey],
        ["csrf_token", text],
        ["expires", wholeNumber],
        ["wrapped_data_key", textOrNull],
        ["user_id", wholeNumberOrNull],
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
        ["id", rowId],
        ["name", textStartingBlank],
        ["filename", checked("filename <> ''")(text)],
        ["filename_thumb", checked("filename_thumb <> ''")(text)],
        ["alt_text", textStartingBlank],
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
      columns: [["image_id", wholeNumber], ...itemLinkColumns],
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
        ["id", rowId],
        ["user_id", wholeNumber],
        ["agent_id", wholeNumber],
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
        ["ip", textKey],
        ["attempts", wholeNumberStartingAtZero],
        ["locked_until", wholeNumberOrNull],
        ["last_attempt", wholeNumberStartingAtZero],
      ],
      indexes: [
        {
          columns: ["locked_until"],
          name: "idx_login_attempts_locked_until",
        },
        {
          columns: ["last_attempt"],
          name: "idx_login_attempts_last_attempt",
        },
      ],
    },
  ],

  [
    "token_attempts",
    {
      columns: [
        ["ip", textKey],
        ["recent_tokens", defaulted(text, "[]")],
        ["locked_until", wholeNumberOrNull],
        ["window_start", wholeNumberStartingAtZero],
        ["last_attempt", wholeNumberStartingAtZero],
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

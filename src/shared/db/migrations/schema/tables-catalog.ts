/** Catalog tables: groups, modifiers, listing hierarchy, holidays, api keys. */

import type { Table } from "./types.ts";

export const catalogTables: [name: string, table: Table][] = [
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
        ["is_package", "INTEGER NOT NULL DEFAULT 0"],
        ["hide_package_listings", "INTEGER NOT NULL DEFAULT 0"],
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
    // Many-to-many membership between groups and listings: one row means
    // listing_id belongs to group_id. Replaces the old single listings.group_id
    // FK so a listing can sit in several groups at once. No FKs (house style);
    // the app keeps it consistent and the group/listing delete paths prune both
    // sides. `quantity` is how many of this listing one unit of the package
    // includes (≥1; default 1). The per-listing flat price override lives in
    // `listing_prices` ("group" dimension), not here (the old `package_price`
    // column was migrated in and dropped). The PK covers group→listings lookups;
    // the extra index serves listing→groups.
    "group_listings",
    {
      columns: [
        ["group_id", "INTEGER NOT NULL"],
        ["listing_id", "INTEGER NOT NULL"],
        ["quantity", "INTEGER NOT NULL DEFAULT 1"],
      ],
      indexes: [
        {
          columns: ["group_id", "listing_id"],
          name: "idx_group_listings_pair",
          unique: true,
        },
        { columns: ["listing_id"], name: "idx_group_listings_listing" },
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
    // Child→parent edges between listings: a row means child_listing_id is a
    // chooseable child of parent_listing_id. No FKs (house style); the app keeps
    // it consistent and deleteListing prunes both sides. The unique pair index
    // also serves the hot parent→children lookup (parent prefix); the extra
    // single index serves the child→parents lookup.
    "listing_parents",
    {
      columns: [
        ["parent_listing_id", "INTEGER NOT NULL"],
        ["child_listing_id", "INTEGER NOT NULL"],
      ],
      indexes: [
        {
          columns: ["parent_listing_id", "child_listing_id"],
          name: "idx_listing_parents_pair",
          unique: true,
        },
        { columns: ["child_listing_id"], name: "idx_listing_parents_child" },
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
];

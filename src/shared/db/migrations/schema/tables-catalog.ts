/** Catalog tables: groups, modifiers, listing hierarchy, holidays, api keys. */

/* jscpd:ignore-start -- imports */
import { attendeeIdColumn, slugNamedEntityColumns } from "./columns.ts";
import {
  defaulted,
  real,
  rowId,
  text,
  textOrNull,
  textStartingBlank,
  wholeNumber,
  wholeNumberOrNull,
  wholeNumberStartingAtOne,
  wholeNumberStartingAtZero,
} from "./scalar-columns.ts";
import type { Table } from "./types.ts";
/* jscpd:ignore-end */

export const catalogTables: [name: string, table: Table][] = [
  [
    "groups",
    {
      columns: [
        ...slugNamedEntityColumns,
        ["description", textStartingBlank],
        ["terms_and_conditions", textStartingBlank],
        ["max_attendees", wholeNumberStartingAtZero],
        ["hidden", wholeNumberStartingAtZero],
        ["is_package", wholeNumberStartingAtZero],
        ["hide_package_listings", wholeNumberStartingAtZero],
        ["scan_checks_in_all_listings", wholeNumberStartingAtZero],
        ["show_hidden_listings", wholeNumberStartingAtOne],
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
        ["group_id", wholeNumber],
        ["listing_id", wholeNumber],
        ["quantity", wholeNumberStartingAtOne],
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
        ["id", rowId],
        ["name", text],
        ["calc_kind", text],
        ["calc_value", real],
        ["direction", text],
        ["active", wholeNumberStartingAtOne],
        ["trigger", defaulted(text, "automatic")],
        ["code", textStartingBlank],
        ["code_index", textOrNull],
        ["scope", defaulted(text, "all")],
        ["stock", wholeNumberOrNull],
        ["max_per_order", wholeNumberOrNull],
        ["min_subtotal", wholeNumberStartingAtZero],
        ["min_visits", wholeNumberStartingAtZero],
        // Precomputed count aggregates over modifier_usages, maintained by the
        // MODIFIER_AGGREGATE_TRIGGERS so admin reads never SUM/COUNT the
        // modifier_usages table. total_uses is SUM(quantity) and usage_count is
        // COUNT(*), both scoped to this modifier. Answer-triggered modifiers
        // record usages here too, so an answer "pricing tier" reports
        // cumulative totals like any modifier. The money figure (total_revenue)
        // is not a column: it is projected from the transfers ledger as
        // balanceOf(modifier:M) at read time (see modifierRevenueSubquery).
        ["total_uses", wholeNumberStartingAtZero],
        ["usage_count", wholeNumberStartingAtZero],
      ],
      indexes: [{ columns: ["code_index"], name: "idx_modifiers_code_index" }],
    },
  ],

  [
    "modifier_listings",
    {
      columns: [
        ["modifier_id", wholeNumber],
        ["listing_id", wholeNumber],
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
        ["parent_listing_id", wholeNumber],
        ["child_listing_id", wholeNumber],
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
        ["modifier_id", wholeNumber],
        ["group_id", wholeNumber],
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
        ["id", rowId],
        ["modifier_id", wholeNumber],
        attendeeIdColumn,
        ["quantity", wholeNumber],
        ["amount_applied", wholeNumber],
        ["created", text],
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
        ["id", rowId],
        ["name", text],
        ["start_date", text],
        ["end_date", text],
      ],
    },
  ],

  [
    "api_keys",
    {
      columns: [
        ["id", rowId],
        ["user_id", wholeNumber],
        ["key_index", text],
        ["wrapped_data_key", text],
        ["name", text],
        ["created", text],
        ["last_used", textStartingBlank],
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

/** Reusable column fragments shared across schema tables.

These are pure data — slices of a table's `columns` array that two or more
tables declare identically. Keeping them here means one definition instead of
duplicated column lists that can drift. */

import type { Column } from "./types.ts";

/**
 * Columns shared by slug-addressed named entities (groups, site_pages): an
 * auto-increment id, the plaintext slug, its HMAC blind index, and a name.
 * Callers spread this then append their own columns (description, meta_title,
 * etc.) — the four columns above are the shared header.
 */
export const slugNamedEntityColumns: Column[] = [
  ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
  ["slug", "TEXT NOT NULL"],
  ["slug_index", "TEXT NOT NULL"],
  ["name", "TEXT NOT NULL"],
];

/**
 * Columns shared by ordered link tables keyed by a polymorphic (item_type,
 * item_id) reference: the item reference itself and a sort_order. The owning
 * FK column (e.g. image_id, page_id) is declared by each caller before
 * spreading these.
 */
export const itemLinkColumns: Column[] = [
  ["item_type", "TEXT NOT NULL"],
  ["item_id", "INTEGER NOT NULL"],
  ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
];

/**
 * Columns shared by tables keyed by an auto-increment id whose first real
 * column is the owning user: api_keys, user_logistics_agents. Callers spread
 * this then append their own columns.
 */
export const idUserIdColumns: Column[] = [
  ["id", "INTEGER PRIMARY KEY AUTOINCREMENT"],
  ["user_id", "INTEGER NOT NULL"],
];

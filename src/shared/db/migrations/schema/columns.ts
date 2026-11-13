/** Reusable column fragments shared across schema tables.

These are pure data — slices of a table's `columns` array that two or more
tables declare identically. Keeping them here means one definition instead of
duplicated column lists that can drift. */

import {
  rowId,
  text,
  textStartingBlank,
  wholeNumber,
  wholeNumberStartingAtZero,
} from "./scalar-columns.ts";
import type { Column } from "./types.ts";

/**
 * Columns shared by slug-addressed named entities (groups, site_pages): an
 * auto-increment id, the plaintext slug, its HMAC blind index, and a name.
 * Callers spread this then append their own columns (description, meta_title,
 * etc.) — the four columns above are the shared header.
 */
export const slugNamedEntityColumns: Column[] = [
  ["id", rowId],
  ["slug", text],
  ["slug_index", text],
  ["name", text],
];

/** The attendee an owned row belongs to. Every attendee-owned table declares
 *  it the same way. */
export const attendeeIdColumn: Column = ["attendee_id", wholeNumber];

/**
 * The header a dated table carries: its own id, and when its row was made.
 * Callers spread this first, then append their own columns.
 */
export const datedRowColumns: Column[] = [
  ["id", rowId],
  ["created", text],
];

/** The position of a row within its list. A new row starts at zero. */
export const sortOrderColumn: Column = [
  "sort_order",
  wholeNumberStartingAtZero,
];

/**
 * Columns shared by ordered link tables keyed by a polymorphic (item_type,
 * item_id) reference: the item reference itself and a sort_order. The owning
 * FK column (e.g. image_id, page_id) is declared by each caller before
 * spreading these.
 */
export const itemLinkColumns: Column[] = [
  ["item_type", text],
  ["item_id", wholeNumber],
  sortOrderColumn,
];

/**
 * The tail a stateful table carries: its state word, and when its row was
 * made. Callers spread this last, after their own columns.
 */
export const statefulColumns: Column[] = [
  ["state", text],
  ["created_at", text],
];

/** A subscription plan: minor units each period, and week, month, or year. A
 * listing states the plan a new subscriber gets, before VAT. A booking row
 * keeps the plan Stripe started, VAT included. A price of 0 means none. */
export const recurringOfferColumns: Column[] = [
  ["recurring_price", wholeNumberStartingAtZero],
  ["recurring_interval", textStartingBlank],
];

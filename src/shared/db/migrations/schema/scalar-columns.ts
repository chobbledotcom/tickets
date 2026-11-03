/** Single reusable column definitions shared across schema tables.

Like the fragments in `columns.ts`, these are pure data — individual `columns`
entries that many tables declare identically. One definition each means the
tables can never drift on the exact type string. */

import type { Column } from "./types.ts";

/** The attendee an owned row belongs to. Every attendee-owned table declares
 *  it the same way, so the tables can never drift on the exact type string. */
export const attendeeIdColumn: Column = ["attendee_id", "INTEGER NOT NULL"];

/** A plaintext ISO-timestamp `created` column, `NOT NULL` with no default. */
export const createdColumn: Column = ["created", "TEXT NOT NULL"];

/** A `sort_order` column defaulting to 0 (the position within a list). */
export const sortOrderColumn: Column = [
  "sort_order",
  "INTEGER NOT NULL DEFAULT 0",
];

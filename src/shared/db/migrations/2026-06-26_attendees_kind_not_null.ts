import { schemaMigration } from "./define.ts";

/**
 * Tighten `attendees.kind` from a nullable column (the `CHECK (kind IS NULL OR
 * kind IN (...))` escape hatch added by 2026-06-24_attendees_kind, whose
 * "NOT NULL" was only a trailing comment, not a real constraint) into a real
 * `NOT NULL` invariant.
 *
 * A row with `kind = NULL` was insertable/updatable, consumed
 * `booked_quantity` (the capacity trigger sums `quantity` regardless of kind),
 * yet was excluded from both the `kind='attendee'` and `kind='servicing'`
 * readers and not counted by `tickets_count` — a "limbo" row that blocked
 * capacity as neither customer nor servicing hold. The CHECK constraint is the
 * only defence, so it must actually reject NULL.
 *
 * SQLite can't tighten an existing column's constraint via `ALTER TABLE`, so
 * the table is rebuilt from the (now NOT NULL) SCHEMA. `recreateTable` copies
 * each shared column across with `COALESCE(<col>, <default>)` for columns that
 * carry a DEFAULT — `kind` defaults to `'attendee'`, so any NULL-kind row is
 * repaired to `'attendee'` as it is copied into the NOT NULL table. The rebuild
 * also re-creates `idx_attendees_kind` and the listing-aggregate triggers that
 * read `attendees.kind`, all in the same transaction.
 *
 * Owns no additive object (`{}` requires): the change is a constraint
 * tightening on an existing column, covered by the schema-hash guard. Run after
 * `2026-06-24_attendees_kind` so the column already exists to be tightened.
 */
export default schemaMigration(
  "2026-06-26_attendees_kind_not_null",
  "Tighten attendees.kind to NOT NULL by rebuilding the table from SCHEMA, repairing any NULL-kind rows to the 'attendee' default via the copy-time COALESCE.",
  {},
  async ({ recreateTable }) => {
    await recreateTable("attendees");
  },
);

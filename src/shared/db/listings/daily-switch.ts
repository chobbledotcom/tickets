/**
 * Switching a listing to booked by the day while it holds undated bookings.
 *
 * A booking made while the listing was standard carries no day (`start_at`
 * NULL). The per-day capacity count of a daily listing excludes those rows.
 * So a full listing silently reopens the moment the type flips. This module
 * is the one place that dates those bookings. It holds the load that finds
 * them and the transactional move that gives every one of them a day. The
 * move uses the same capacity guard a booking write uses. A third guard
 * refuses a bare type switch while undated bookings remain.
 */

import { logActivity } from "#db/activity-log.ts";
import type { DesiredListingLine } from "#db/attendee-types.ts";
import {
  CAPACITY_GUARD,
  updateStatementFor,
} from "#db/attendees/atomic-update.ts";
import {
  queryAllPrimary,
  resultRows,
  type SqlStatement,
  type TxScope,
} from "#db/client.ts";
import { TransactionValidationError } from "#db/transaction.ts";
import { t } from "#i18n";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { dayPriceFieldsFromInput } from "#shared/listing-edge.ts";
import type { ListingType } from "#types";

/** The move a confirmed save performs: give every undated booking this day. */
export interface AssignPlan {
  /** How many bookings the move will date — the rows, the same count the
   * card named (the flash suffix's count). */
  count: number;
  date: string;
}

/** How long a booking moved to a day occupies: the stay length the switched
 * listing sells — one day when customers pick their own. The same defaults
 * the form layer applies, so a moved booking spans exactly what a fresh
 * booking on that date spans. */
export const wouldBeStaySpanDays = (input: ListingInput): number => {
  const fields = dayPriceFieldsFromInput(input);
  return fields.customisable_days ? 1 : fields.duration_days;
};

/** One undated booking of a listing: its row key and the places it holds. */
export interface UndatedBooking {
  attendeeId: number;
  packageGroupId: number;
  parentListingId: number;
  quantity: number;
}

/** One statement of a transaction batch whose single row answers one read. */
const singleStatement = (sql: string, listingId: number): SqlStatement => ({
  args: [listingId],
  sql,
});

/** The stored type a switch leaves behind. Read inside the write's own
 * transaction, so a concurrent type change cannot slip past the guard. */
const storedTypeTx = async (
  tx: TxScope,
  listingId: number,
): Promise<string> => {
  const results = await tx.batch([
    singleStatement(
      "SELECT listing_type FROM listings WHERE id = ?",
      listingId,
    ),
  ]);
  return resultRows<{ listing_type: string }>(results[0]!)[0]!.listing_type;
};

/** The rows that block a switch: a booking whose day nobody set and whose
 * places somebody holds. A quantity-0 ghost line books nothing, so it never
 * blocks. The guard's count and the move's rows derive from this one clause,
 * so they can never disagree about which bookings block the switch. */
const UNDATED_WHERE = "listing_id = ? AND start_at IS NULL AND quantity > 0";

const UNDATED_ROWS_SQL = `SELECT attendee_id AS "attendeeId",
            package_group_id AS "packageGroupId",
            parent_listing_id AS "parentListingId",
            quantity
       FROM listing_attendees
      WHERE ${UNDATED_WHERE}`;

const UNDATED_COUNT_SQL = `SELECT COUNT(*) AS undated FROM listing_attendees WHERE ${UNDATED_WHERE}`;

/** The undated bookings of one listing — the rows a switch to daily must
 * give a day first. The plan's pre-check, pinned to the primary: a lagging
 * replica names a stale count on the card. The move reads the same rows
 * through its own transaction. */
export const undatedBookingsForListing = (
  listingId: number,
): Promise<UndatedBooking[]> =>
  queryAllPrimary<UndatedBooking>(singleStatement(UNDATED_ROWS_SQL, listingId));

/** Refuse a save that flips the listing type to daily while undated bookings
 * remain. The HTML assign flow does not run this guard — its move dates every
 * undated row inside the same transaction. */
export const refuseUndatedSwitchTx = async (
  tx: TxScope,
  listingId: number,
  wouldBeType: ListingType,
): Promise<string | null> => {
  if (wouldBeType !== "daily") return null;
  if ((await storedTypeTx(tx, listingId)) === "daily") return null;
  const results = await tx.batch([
    singleStatement(UNDATED_COUNT_SQL, listingId),
  ]);
  const { undated } = resultRows<{ undated: number }>(results[0]!)[0]!;
  return undated === 0
    ? null
    : t("listings_table.switch_daily_undated_guard", { count: undated });
};

/** The one move statement for an undated row: set its range under the same
 * capacity predicate a booking write carries, pinned to the row's slot. */
const moveStatement = (
  row: UndatedBooking,
  listingId: number,
  date: string,
  durationDays: number,
): SqlStatement => {
  const line: DesiredListingLine = {
    date,
    durationDays,
    exists: true,
    key: `${listingId}||${row.parentListingId}|${row.packageGroupId}`,
    listingId,
    packageGroupId: row.packageGroupId,
    parentListingId: row.parentListingId,
    quantity: row.quantity,
  };
  return updateStatementFor(
    line,
    row.attendeeId,
    {
      packageGroupId: row.packageGroupId,
      parentListingId: row.parentListingId,
      startAt: null,
    },
    false,
  );
};

/** Date every undated booking of the listing in one guarded batch. The
 * save's transaction runs this after the listing row and its joins are
 * written. The capacity predicate then counts the listing as the daily
 * listing it becomes. The rows are read through the save's own transaction.
 * A booking a lagging replica has not caught up with is still dated, never
 * stranded dayless behind the flip. Refusals surface as a validation error
 * that rolls the whole save back. Returns the number of rows it dated. */
export const moveUndatedBookingsToDayTx = async (
  tx: TxScope,
  listingId: number,
  listingName: string,
  date: string,
  durationDays: number,
): Promise<number> => {
  const results = await tx.batch([
    singleStatement(UNDATED_ROWS_SQL, listingId),
  ]);
  const rows = resultRows<UndatedBooking>(results[0]!);
  if (rows.length === 0) return 0;
  const statements = rows.flatMap((row) => [
    moveStatement(row, listingId, date, durationDays),
    CAPACITY_GUARD,
  ]);
  try {
    await tx.batch(statements);
  } catch (error) {
    // The capacity predicate let no row through. The guard then fired its
    // NULL insert, and SQLite named listing_attendees.listing_id.
    if (
      error instanceof Error &&
      error.message.includes(
        "NOT NULL constraint failed: listing_attendees.listing_id",
      )
    ) {
      throw new TransactionValidationError(
        t("listings_table.switch_daily_undated_refused", {
          count: rows.reduce((total, row) => total + row.quantity, 0),
          date,
          name: listingName,
        }),
      );
    }
    throw error;
  }
  await logActivity(
    `Listing '${listingName}': moved ${rows.length} booking${rows.length === 1 ? "" : "s"} to ${date}`,
    { id: listingId },
    null,
    tx,
  );
  return rows.length;
};

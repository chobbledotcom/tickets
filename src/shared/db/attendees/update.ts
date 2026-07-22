/**
 * Update operations for attendees and their per-listing bookings.
 */

import { filter, map, pipe, reduce, sumOf, unique } from "#fp";
import { ledgerTx } from "#shared/accounting/ledger-tx.ts";
import { countsPerDate } from "#shared/capacity-rules.ts";
import type { UpdateAttendeePIIInput } from "#shared/db/attendee-types.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import {
  execute,
  executeUpdate,
  queryAll,
  rawSql,
  update,
  withTransaction,
} from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { clampDurationDays, type ListingType } from "#shared/types.ts";

/**
 * Set a line's check-in flag, refusing a no-quantity (quantity 0) line — it
 * isn't a real ticket, mirroring the refunded-ticket guard in checkin.ts. The
 * `quantity > 0` predicate scopes the write so a ghost row is a no-op (it can
 * never have been checked in, so scoping the check-OUT case too is harmless).
 */
export const updateCheckedIn = async (
  attendeeId: number,
  listingId: number,
  checkedIn: boolean,
): Promise<void> => {
  await execute(
    "UPDATE listing_attendees SET checked_in = ? WHERE attendee_id = ? AND listing_id = ? AND quantity > 0",
    [checkedIn ? 1 : 0, attendeeId, listingId],
  );
};

/**
 * Set an attendee's status from the admin edit form (a plain column write,
 * outside the encrypted pii_blob). The outstanding balance is NOT set from the
 * form — it projects from the transfers ledger, and an operator adjusts it
 * through the ledger's manual write-off entries.
 *
 * Every assignment uses a write transaction so it serialises with status
 * deletion. When `clearBalance` is set, a stranded receivable is reconciled to
 * 0 in that SAME transaction, so the two writes land atomically.
 */
export const updateAttendeeStatus = async (
  attendeeId: number,
  statusId: number | null,
  clearBalance = false,
): Promise<void> => {
  await withTransaction(async (tx) => {
    await tx.execute(
      update("attendees", { status_id: statusId }, { id: attendeeId }),
    );
    if (clearBalance) await ledgerTx.correct.owed(tx, attendeeId, 0);
  });
};

export const incrementAttachmentDownloads = async (
  attendeeId: number,
  listingId: number,
): Promise<void> => {
  await executeUpdate(
    "listing_attendees",
    { attachment_downloads: rawSql("attachment_downloads + 1") },
    { attendee_id: attendeeId, listing_id: listingId },
  );
};

export const updateAttendeePII = async (
  attendeeId: number,
  input: UpdateAttendeePIIInput,
): Promise<void> => {
  const encryptedPiiBlob = await encryptPiiBlob(
    buildPiiBlob({
      ...input,
      payment_id: input.payment_id,
      ticket_token: input.ticket_token,
    }),
    settings.publicKey,
  );
  await executeUpdate(
    "attendees",
    { pii_blob: encryptedPiiBlob },
    { id: attendeeId },
  );
};

/**
 * Recompute `end_at` on all existing `listing_attendees` rows for an listing
 * based on a new `duration_days` value. Leaves NULL-start rows alone.
 * The `.000Z` suffix matches the format fresh inserts produce via
 * toISOString() so raw-row dumps stay consistent.
 */
export const recomputeListingBookingRanges = async (
  listingId: number,
  durationDays: number,
): Promise<void> => {
  const duration = clampDurationDays(durationDays);
  await execute(
    `UPDATE listing_attendees
           SET end_at = REPLACE(datetime(start_at, '+' || ? || ' days'), ' ', 'T') || '.000Z'
           WHERE listing_id = ? AND start_at IS NOT NULL`,
    [duration, listingId],
  );
};

/** A booking's day range as [start, end) YYYY-MM-DD strings (day-aligned —
 * every writer stores midnight-anchored ranges). */
type DayInterval = { start: string; end: string; quantity: number };

type GroupBookingRow = {
  listing_id: number;
  listing_type: ListingType;
  start_at: string | null;
  end_at: string | null;
  quantity: number;
};

type GroupBookingRangeRow = GroupBookingRow & {
  start_at: string;
  end_at: string;
};

const isDailyWithRange = (row: GroupBookingRow): row is GroupBookingRangeRow =>
  countsPerDate(row.listing_type) &&
  row.start_at !== null &&
  row.end_at !== null;

const toDayInterval = (row: GroupBookingRangeRow): DayInterval => ({
  end: row.end_at.slice(0, 10),
  quantity: row.quantity,
  start: row.start_at.slice(0, 10),
});

/** Daily occupancy after each start/end boundary. */
const loadsAtBoundaries = (intervals: DayInterval[]): Map<string, number> => {
  const deltas = reduce((acc: Map<string, number>, interval: DayInterval) => {
    acc.set(interval.start, (acc.get(interval.start) ?? 0) + interval.quantity);
    acc.set(interval.end, (acc.get(interval.end) ?? 0) - interval.quantity);
    return acc;
  }, new Map<string, number>())(intervals);
  const loads = new Map<string, number>();
  let running = 0;
  for (const day of [...deltas.keys()].sort()) {
    running += deltas.get(day)!;
    loads.set(day, running);
  }
  return loads;
};

/** Earliest over-capacity boundary covered by one of the changed listing's
 * ranges, or null when every covered day fits. */
const firstOverCapacityDay = (
  intervals: DayInterval[],
  listingRanges: DayInterval[],
  base: number,
  groupLimit: number,
): string | null => {
  const loads = loadsAtBoundaries(intervals);
  // The comparator is a single-line, branchless `localeCompare` on purpose:
  // a multi-line arrow body or a `? :` here is mis-attributed by deno's
  // coverage when the function is exercised across `--parallel` workers.
  const sortedRanges = [...listingRanges].sort((a, b) =>
    a.start.localeCompare(b.start),
  );
  const startDays = unique(
    map((interval: DayInterval) => interval.start)(intervals),
  ).sort();
  let rangeIdx = 0;
  let maxEnd = "";
  for (const day of startDays) {
    while (
      rangeIdx < sortedRanges.length &&
      sortedRanges[rangeIdx]!.start <= day
    ) {
      const end = sortedRanges[rangeIdx]!.end;
      if (end > maxEnd) maxEnd = end;
      rangeIdx++;
    }
    if (day >= maxEnd) continue;
    if (base + loads.get(day)! > groupLimit) return day;
  }
  return null;
};

/** Pure group-cap sweep over already-loaded booking rows. */
const groupCapOverflowDay = (
  rows: GroupBookingRow[],
  listingId: number,
  groupLimit: number,
): string | null => {
  // Non-daily rows count on every day. Daily rows count only over their stored
  // [start, end) range; legacy daily rows without a full range never count.
  const base = pipe(
    filter((row: GroupBookingRow) => !countsPerDate(row.listing_type)),
    sumOf((row) => row.quantity),
  )(rows);
  const intervals = rows.filter(isDailyWithRange).map(toDayInterval);
  const listingRanges = rows
    .filter((row) => row.listing_id === listingId)
    .filter(isDailyWithRange)
    .map(toDayInterval);
  return firstOverCapacityDay(intervals, listingRanges, base, groupLimit);
};

/**
 * After a duration change on a grouped listing, check whether any day in any
 * existing booking's new range now exceeds the group cap. Returns the
 * earliest over-capacity day, or null if everything fits.
 * Call AFTER recomputeListingBookingRanges so end_at is already updated.
 *
 * One query fetches every booking row in the group; per-day occupancy is
 * computed in JS with a boundary sweep. Occupancy only changes on days
 * where some booking starts, so checking interval start days that fall
 * inside this listing's booked ranges finds the earliest overflow without
 * walking (and querying) every day of every range.
 */
export const checkGroupCapAfterDurationChange = async (
  listingId: number,
  groupId: number,
): Promise<string | null> => {
  const cap = await queryAll<{ max_attendees: number }>(
    "SELECT max_attendees FROM groups WHERE id = ?",
    [groupId],
  );
  const groupLimit = cap[0]!.max_attendees;
  if (groupLimit <= 0) return null;

  const rows = await queryAll<GroupBookingRow>(
    `SELECT listingAttendee.listing_id, listing.listing_type, listingAttendee.start_at, listingAttendee.end_at, listingAttendee.quantity
     FROM listing_attendees AS listingAttendee
     JOIN listings AS listing ON listing.id = listingAttendee.listing_id
     WHERE listingAttendee.listing_id IN (SELECT listing_id FROM group_listings WHERE group_id = ?)`,
    [groupId],
  );

  return groupCapOverflowDay(rows, listingId, groupLimit);
};

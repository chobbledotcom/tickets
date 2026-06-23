/**
 * Update operations for attendees and their per-listing bookings.
 */

import { filter, map, pipe, reduce, sumOf, unique } from "#fp";
import { attendeeAccount } from "#shared/accounting/accounts.ts";
import { postWriteoffAdjustmentTx } from "#shared/accounting/adjustments.ts";
import { attendeeOwedTx } from "#shared/accounting/queries.ts";
import type { UpdateAttendeePIIInput } from "#shared/db/attendee-types.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import {
  execute,
  queryAll,
  type TxScope,
  withTransaction,
} from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { normalizeDurationDays } from "#shared/types.ts";

/** Update a per-listing status field on listing_attendees */
const updateListingAttendeeField =
  (field: string) =>
  async (
    attendeeId: number,
    listingId: number,
    value: number,
  ): Promise<void> => {
    await execute(
      `UPDATE listing_attendees SET ${field} = ? WHERE attendee_id = ? AND listing_id = ?`,
      [value, attendeeId, listingId],
    );
  };

const setCheckedIn = updateListingAttendeeField("checked_in");

export const updateCheckedIn = (
  attendeeId: number,
  listingId: number,
  checkedIn: boolean,
): Promise<void> => setCheckedIn(attendeeId, listingId, checkedIn ? 1 : 0);

/**
 * Reconcile an attendee's ledger-projected outstanding balance to `target` by
 * posting a single `adjustment` leg for the difference against the `writeoff`
 * contra-revenue account (decision 14), so the operator-set figure survives now
 * that the balance projects from the ledger (−balanceOf(attendee)) rather than a
 * stored column. A no-op (target already owed) posts nothing.
 *
 * Runs inside the caller's write transaction `tx`: the current owed figure is
 * read THROUGH `tx` (so it sees this transaction's own writes) and the
 * adjustment is posted THROUGH `tx`, so the read→delta→post is atomic and
 * recomputed from `target` under the write lock. That makes the correction
 * idempotent for a given target — a second submit of the same target reads the
 * first's committed balance and computes a zero delta — and lets it commit (or
 * roll back) together with whatever else the transaction does.
 *
 * Outstanding = −balanceOf(attendee), so `owed = -balance`. To move owed onto
 * `target` we credit the attendee account by `owed − target` in
 * {@link postWriteoffAdjustmentTx}'s terms: raising what's owed (target > owed)
 * is a negative delta ⇒ `attendee → writeoff` debit ⇒ balanceOf(attendee) drops
 * ⇒ owed = −balanceOf rises; lowering it credits the attendee from writeoff. The
 * correction never touches external cash or a listing's revenue account, so it
 * moves only what is owed — cash reports (`world→*`) stay honest.
 */
export const reconcileLedgerBalanceTx = async (
  tx: TxScope,
  attendeeId: number,
  target: number,
): Promise<void> => {
  const owed = await attendeeOwedTx(tx, attendeeId);
  await postWriteoffAdjustmentTx(
    tx,
    attendeeAccount(attendeeId),
    owed - target,
    ["balance-adjust", attendeeId],
  );
};

/**
 * Set an attendee's order fields from the admin edit form: the status (a plain
 * column write) and the outstanding balance (reconciled in the transfers ledger,
 * which now holds the balance — see {@link reconcileLedgerBalanceTx}). Both are
 * operator-editable; the status lives outside the encrypted pii_blob.
 *
 * The two run in ONE write transaction so they are atomic: a failure posting the
 * balance leg rolls the status change back too, never leaving the status moved
 * but the balance unrecorded. The balance reconcile recomputes its delta from
 * `remainingBalance` inside that transaction, so re-submitting the same form is
 * idempotent and two concurrent submits serialise on the write lock.
 */
export const updateAttendeeOrder = (
  attendeeId: number,
  statusId: number | null,
  remainingBalance: number,
): Promise<void> =>
  withTransaction(async (tx) => {
    await tx.execute({
      args: [statusId, attendeeId],
      sql: "UPDATE attendees SET status_id = ? WHERE id = ?",
    });
    await reconcileLedgerBalanceTx(tx, attendeeId, remainingBalance);
  });

export const incrementAttachmentDownloads = async (
  attendeeId: number,
  listingId: number,
): Promise<void> => {
  await execute(
    "UPDATE listing_attendees SET attachment_downloads = attachment_downloads + 1 WHERE attendee_id = ? AND listing_id = ?",
    [attendeeId, listingId],
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
  await execute("UPDATE attendees SET pii_blob = ? WHERE id = ?", [
    encryptedPiiBlob,
    attendeeId,
  ]);
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
  const duration = normalizeDurationDays(durationDays);
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
  if (groupId <= 0) return null;
  const cap = await queryAll<{ max_attendees: number }>(
    "SELECT max_attendees FROM groups WHERE id = ?",
    [groupId],
  );
  const groupLimit = cap[0]!.max_attendees;
  if (groupLimit <= 0) return null;

  const rows = await queryAll<{
    listing_id: number;
    listing_type: string;
    start_at: string | null;
    end_at: string | null;
    quantity: number;
  }>(
    `SELECT ea.listing_id, listing.listing_type, ea.start_at, ea.end_at, ea.quantity
     FROM listing_attendees ea
     JOIN listings AS listing ON listing.id = ea.listing_id
     WHERE listing.group_id = ?`,
    [groupId],
  );

  // Rows on non-daily listings count on every day; daily rows count on the
  // days of their [start, end) range. NULL-range rows on daily listings never
  // count (pre-daily legacy bookings), mirroring the SQL overlap predicate.
  type GroupRow = (typeof rows)[number];
  const isDailyWithRange = (row: GroupRow): boolean =>
    row.listing_type === "daily" &&
    row.start_at !== null &&
    row.end_at !== null;
  const toDayInterval = (row: GroupRow): DayInterval => ({
    end: row.end_at!.slice(0, 10),
    quantity: row.quantity,
    start: row.start_at!.slice(0, 10),
  });
  const base = pipe(
    filter((row: GroupRow) => row.listing_type !== "daily"),
    sumOf((row: GroupRow) => row.quantity),
  )(rows);
  const intervals = pipe(filter(isDailyWithRange), map(toDayInterval))(rows);
  const listingRanges = pipe(
    filter((row: GroupRow) => row.listing_id === listingId),
    filter(isDailyWithRange),
    map(toDayInterval),
  )(rows);

  // Boundary sweep: running occupancy at each day where any interval starts
  // or ends. loadAt(day) = total daily quantity covering that day.
  const deltas = reduce((acc: Map<string, number>, itv: DayInterval) => {
    acc.set(itv.start, (acc.get(itv.start) ?? 0) + itv.quantity);
    acc.set(itv.end, (acc.get(itv.end) ?? 0) - itv.quantity);
    return acc;
  }, new Map<string, number>())(intervals);
  const boundaries = [...deltas.keys()].sort();
  const loadAt = new Map<string, number>();
  let running = 0;
  for (const day of boundaries) {
    running += deltas.get(day)!;
    loadAt.set(day, running);
  }

  // Walk candidate days (interval starts) in ascending order, tracking the
  // max end of this listing's ranges that start at or before the candidate —
  // the candidate is inside this listing's booked days iff that end is later.
  // The comparator is a single-line, branchless `localeCompare` on purpose:
  // a multi-line arrow body or a `? :` here is mis-attributed by deno's
  // coverage when the function is exercised across `--parallel` workers,
  // producing a phantom uncovered branch. Date strings sort lexically, so
  // localeCompare gives the same ascending order with no branch to mis-merge.
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
    if (base + loadAt.get(day)! > groupLimit) return day;
  }
  return null;
};

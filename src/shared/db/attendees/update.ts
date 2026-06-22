/**
 * Update operations for attendees and their per-listing bookings.
 */

import { filter, map, pipe, reduce, sumOf, unique } from "#fp";
import { attendeeAccount, WORLD } from "#shared/accounting/accounts.ts";
import { accountBalance } from "#shared/accounting/queries.ts";
import { eventGroup, legReference } from "#shared/accounting/refs.ts";
import { postTransfers } from "#shared/accounting/store.ts";
import type { UpdateAttendeePIIInput } from "#shared/db/attendee-types.ts";
import { buildPiiBlob, encryptPiiBlob } from "#shared/db/attendees/pii.ts";
import { execute, queryAll } from "#shared/db/client.ts";
import { settings } from "#shared/db/settings.ts";
import { nowIso } from "#shared/now.ts";
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
 * posting a single adjustment leg for the difference, so the operator-set figure
 * survives now that the balance projects from the ledger (−balanceOf(attendee))
 * rather than a stored column. An increase bills the attendee (`attendee→world`),
 * a decrease credits them (`world→attendee`); a no-op (target already owed) posts
 * nothing. The legs touch only the attendee and external accounts — never a
 * listing's revenue account — so a manual correction never moves listing income
 * or a booking row's projected amount paid, only what is owed.
 *
 * Each save is its own business event (a fresh `nowIso()` group), so editing the
 * balance up, down, then back up again posts three distinct adjustments rather
 * than colliding with an earlier event's references.
 */
const reconcileLedgerBalance = async (
  attendeeId: number,
  target: number,
): Promise<void> => {
  const owed = -(await accountBalance(attendeeAccount(attendeeId)));
  const delta = target - owed;
  if (delta === 0) return;
  const attendee = attendeeAccount(attendeeId);
  const occurredAt = nowIso();
  const group = await eventGroup(["balance-adjust", attendeeId, occurredAt]);
  await postTransfers([
    {
      amount: Math.abs(delta),
      // Owing more bills the attendee (out to the world); owing less credits
      // them back from the world — either way no revenue account is touched.
      destination: delta > 0 ? WORLD : attendee,
      eventGroup: group,
      kind: "adjustment",
      occurredAt,
      reference: await legReference([
        "balance-adjust",
        attendeeId,
        occurredAt,
      ]),
      source: delta > 0 ? attendee : WORLD,
    },
  ]);
};

/**
 * Set an attendee's order fields from the admin edit form: the status (a plain
 * column write) and the outstanding balance (reconciled in the transfers ledger,
 * which now holds the balance — see {@link reconcileLedgerBalance}). Both are
 * operator-editable; the status lives outside the encrypted pii_blob.
 */
export const updateAttendeeOrder = async (
  attendeeId: number,
  statusId: number | null,
  remainingBalance: number,
): Promise<void> => {
  await execute("UPDATE attendees SET status_id = ? WHERE id = ?", [
    statusId,
    attendeeId,
  ]);
  await reconcileLedgerBalance(attendeeId, remainingBalance);
};

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

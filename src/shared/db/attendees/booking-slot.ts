/**
 * Booking-slot identity — the single definition of "which row" a listing line
 * targets.
 *
 * A booking slot is `(listing_id, date, parent_listing_id, package_group_id)`,
 * which for one attendee picks out exactly one row of the
 * `listing_attendees` unique index. The `parentListingId` dimension keeps the
 * same child chosen under two parents as two rows; `packageGroupId` keeps the
 * same listing booked through two overlapping packages as one row per path.
 *
 * Form validation and the DB write layer both dedupe on this identity, so it
 * lives in one dependency-free module they can import without dragging in the
 * rest of the DB layer. A `parentListingId` or `packageGroupId` of 0 mirrors
 * the DB default that standalone and parent rows carry.
 */

import { seenBefore } from "#shared/seen-before.ts";

/** Identity of a booking slot:
 * `${listingId}|${date}|${parentListingId}|${packageGroupId}`. Two rows with
 * the same slot would collide on the `listing_attendees` unique index. */
export const bookingSlotKey = (
  listingId: number,
  date: string | null | undefined,
  parentListingId = 0,
  packageGroupId = 0,
): string => `${listingId}|${date ?? ""}|${parentListingId}|${packageGroupId}`;

/** True when any two of the given lines target the same booking slot — which
 * the unique index would reject. Shared by the create and edit paths so the
 * slot identity is defined once. */
export const hasDuplicateBookingSlot = (
  lines: readonly {
    listingId: number;
    date?: string | null | undefined;
    parentListingId?: number | undefined;
    packageGroupId?: number | undefined;
  }[],
): boolean => {
  const alreadySeen = seenBefore();
  for (const line of lines) {
    const key = bookingSlotKey(
      line.listingId,
      line.date,
      line.parentListingId ?? 0,
      line.packageGroupId ?? 0,
    );
    if (alreadySeen(key)) return true;
  }
  return false;
};

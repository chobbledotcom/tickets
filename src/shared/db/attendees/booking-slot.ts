/**
 * The single definition of "which row" a listing line targets:
 * `(listing_id, date, parent_listing_id, package_group_id)`, which for one
 * attendee picks out exactly one row of the `listing_attendees` unique index.
 *
 * `parentListingId` keeps the same child chosen under two parents as two rows.
 * `packageGroupId` keeps the same listing booked through two overlapping
 * packages as one row per path. A 0 in either mirrors the DB default.
 *
 * Dependency-free, so form validation and the DB write layer can both dedupe on
 * it without dragging in the rest of the DB layer.
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

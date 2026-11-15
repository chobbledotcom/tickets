/** Assertions over attendee booking rows: one row per booking line, so a
 *  multi-booking attendee never collapses to a single row. */

import { expect } from "@std/expect";

/** Assert `rows` hold one booking line per listing in `listingIds`, in any
 *  order — a multi-booking attendee keeps every line, not one per attendee. */
export const expectBookingRowsForListings = (
  rows: readonly { listing_id: number }[],
  listingIds: readonly number[],
): void => {
  const actual = rows.map((row) => row.listing_id).toSorted();
  expect(actual).toHaveLength(listingIds.length);
  expect(actual).toEqual([...listingIds].toSorted());
};

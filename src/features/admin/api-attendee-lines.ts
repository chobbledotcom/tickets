/**
 * The booking lines an API update leaves the attendee with. The body names the
 * complete set, as the admin Edit tab does. A line that matches a stored row
 * keeps that row's identity, so the edit changes the row in place. Any other
 * line is a new row. A stored row that no line names is removed. Pure
 * data-in/data-out.
 */

import type { DesiredListingLine } from "#db/attendee-types.ts";
import type { ExistingLine } from "#db/attendees/atomic-update.ts";
import { dateToStartEnd } from "#db/attendees/capacity/range.ts";
import type { ApiLine } from "./api-attendees-parse.ts";

/** True when the stored row books the line's listing on the line's day. */
const sameSlot = (line: ApiLine, row: ExistingLine): boolean => {
  const { startAt } = dateToStartEnd(line.date, line.durationDays);
  return (
    row.booking.listing_id === line.listing.id &&
    row.booking.start_at === startAt
  );
};

/** One desired line: the matched row's identity, or a new row. */
const desiredLine = (
  line: ApiLine,
  row: ExistingLine | undefined,
): DesiredListingLine => ({
  date: line.date,
  durationDays: line.durationDays,
  exists: row !== undefined,
  key: row?.key ?? "",
  listingId: line.listing.id,
  packageGroupId: row?.booking.package_group_id ?? 0,
  parentListingId: row?.booking.parent_listing_id ?? 0,
  quantity: line.quantity,
});

/** Pairs each line with the stored row it changes. A line first claims the
 *  row on its own listing and day. A line that moved day claims a row of the
 *  same listing when it is the only line and the only free row for it. */
const pairLines = (
  lines: ApiLine[],
  existing: ExistingLine[],
): Map<ApiLine, ExistingLine> => {
  const paired = new Map<ApiLine, ExistingLine>();
  const free = (listingId: number): ExistingLine[] =>
    existing.filter(
      (row) =>
        row.booking.listing_id === listingId &&
        ![...paired.values()].includes(row),
    );
  for (const line of lines) {
    const row = free(line.listing.id).find((candidate) =>
      sameSlot(line, candidate),
    );
    if (row !== undefined) paired.set(line, row);
  }
  for (const line of lines) {
    if (paired.has(line)) continue;
    const moved = lines.filter(
      (other) => !paired.has(other) && other.listing.id === line.listing.id,
    );
    const rows = free(line.listing.id);
    if (moved.length === 1 && rows.length === 1) paired.set(line, rows[0]!);
  }
  return paired;
};

/** The lines of an update that names `lines`, in the order it names them. */
export const namedLines = (
  lines: ApiLine[],
  existing: ExistingLine[],
): DesiredListingLine[] => {
  const paired = pairLines(lines, existing);
  return lines.map((line) => desiredLine(line, paired.get(line)));
};

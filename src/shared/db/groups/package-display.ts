/**
 * How a booking shows the package that it was sold under: the name of the
 * package, and whether the package hides its members.
 */

import type { TxScope } from "#db/client.ts";
import { readExists, readRows } from "#db/read.ts";
import { existsOn } from "#db/record-table.ts";
import { among, equal, greaterThan } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";

/** Package-group display info for grouping a booking's lines under the package
 * name on tickets/emails. */
export type PackageDisplay = { name: string; hideListings: boolean };

/** The sold booking rows that hold the package id of this group. */
const soldPackageLines = (groupId: number) =>
  from(tables.listing_attendees)
    .where({ package_group_id: groupId })
    .where((line) => greaterThan(line.quantity, 0));

/** Whether any sold booking still holds this group's package id. */
export const hasPackageBookings = (groupId: number): Promise<boolean> =>
  readExists(soldPackageLines(groupId));

/** The same check on the open write transaction of the group. A checkout can
 *  commit after the first check. This second check then rolls the change
 *  back, so the hidden member names stay hidden. */
export const hasPackageBookingsTx = (
  tx: TxScope,
  groupId: number,
): Promise<boolean> => existsOn(tx, soldPackageLines(groupId));

/** The package display of each id that names a package. An id can repeat or
 * be 0. One read gives every display. The ticket view uses them to show the
 * rows of one package as one card. An attendee with a package booking and a
 * plain booking, for example after a merge, then shows no hidden member. */
export const getPackageDisplaysByIds = async (
  groupIds: readonly number[],
): Promise<Map<number, PackageDisplay>> => {
  const packageGroups = await readRows(
    from(tables.groups)
      .where((group) => [
        among(
          group.id,
          [...new Set(groupIds)].filter((groupId) => groupId > 0),
        ),
        equal(group.is_package, 1),
      ])
      .pick("id", "hide_package_listings", "name"),
  );
  return new Map(
    packageGroups.map((group) => [
      group.id,
      {
        hideListings: group.hide_package_listings,
        name: group.name,
      },
    ]),
  );
};

/** The package displays behind a set of booked rows — each row's attendee names
 * its persisted `package_group_id` (0 on a plain row, matching no package).
 * Shared by the ticket view, the wallet lookup, and the email renderer, which
 * all carry `{ attendee, listing }` row shapes. */
export const packageDisplaysForRows = (
  rows: ReadonlyArray<{ attendee: { package_group_id: number } }>,
): Promise<Map<number, PackageDisplay>> =>
  getPackageDisplaysByIds(rows.map((row) => row.attendee.package_group_id));

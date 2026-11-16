/**
 * How a booking shows the package that it was sold under: the name of the
 * package, and whether the package hides its members.
 */

import { resultRows, type TxScope } from "#db/client.ts";
import { readExists, readRows } from "#db/read.ts";
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

/** Transaction-local recheck: whether any sold booking still holds this
 *  group's package id. Used inside the group write transaction so a checkout
 *  that commits between a request-level sold-hidden check and the write rolls
 *  the un-packaging back rather than revealing concealed member names. */
export const hasPackageBookingsTx = async (
  tx: TxScope,
  groupId: number,
): Promise<boolean> =>
  resultRows(await tx.execute(soldPackageLines(groupId).probe())).length > 0;

/** The package displays for a set of (possibly repeated or zero)
 * `package_group_id`s — only ids naming a live package appear in the map. Lets
 * the ticket view collapse each token's package rows into one card per package,
 * so an attendee holding both a package booking and a standalone one (e.g. after
 * an attendee merge) doesn't fall back to per-row cards that leak a hidden member.
 * Groups are resolved together from their shared cache. */
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

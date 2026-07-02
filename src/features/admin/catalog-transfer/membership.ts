/**
 * Group-membership read/write helpers used only by catalog import/export.
 *
 * Kept out of `#shared/db/groups.ts` so the transfer feature owns its own
 * membership plumbing: exporting a listing's memberships, and (re)creating a
 * membership row — with its package override, quantity, and per-day overrides —
 * for a freshly-imported listing or group.
 */

import type { TxScope } from "#shared/db/client.ts";
import { queryAll } from "#shared/db/client.ts";
import { groupDayPriceStatements } from "#shared/db/listing-prices.ts";
import type { DayPrices, GroupListing } from "#shared/types.ts";

/** Every group a listing belongs to, with this listing's per-package override
 * and quantity — the membership facet a catalog export captures for one listing.
 * A `null` `package_price` means "no override"; `quantity` defaults to 1. */
export const getListingGroupMemberships = (
  listingId: number,
): Promise<GroupListing[]> =>
  queryAll<GroupListing>(
    "SELECT group_id, listing_id, package_price, quantity FROM group_listings WHERE listing_id = ? ORDER BY group_id ASC",
    [listingId],
  );

/** One membership to (re)create on catalog import: which listing joins which
 * group, with its package override, quantity, and per-day overrides. */
export type ImportedMembership = {
  groupId: number;
  listingId: number;
  packagePrice: number | null;
  quantity: number;
  dayPrices: DayPrices;
};

/** Insert ONE membership row (with its package override + quantity) plus that
 * member's `group_day` per-day overrides, inside an existing write transaction —
 * the catalog-import writer for a freshly-created listing or group. Targeted (it
 * never deletes), so importing a listing into an already-populated package can't
 * disturb the group's other members. Shared by both import directions so a
 * listing joining its groups and a group gaining its members write memberships
 * identically. */
export const addGroupMembershipTx = async (
  tx: TxScope,
  membership: ImportedMembership,
): Promise<void> => {
  await tx.execute({
    args: [
      membership.groupId,
      membership.listingId,
      membership.packagePrice,
      membership.quantity,
    ],
    sql: "INSERT INTO group_listings (group_id, listing_id, package_price, quantity) VALUES (?, ?, ?, ?)",
  });
  // Reuse the package-save group_day builder, but drop its leading full-group
  // DELETE (`.slice(1)`): a fresh member's overrides are inserted targeted, so
  // importing into an already-populated package can't wipe the other members'.
  const dayStatements = groupDayPriceStatements(membership.groupId, [
    { dayPrices: membership.dayPrices, listingId: membership.listingId },
  ]).slice(1);
  for (const stmt of dayStatements) await tx.execute(stmt);
};

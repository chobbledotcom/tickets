/**
 * The sale state of one group's member listings: how many members the group
 * holds and how many of them are active. The group page's Actions tab reads
 * it to offer only the switch that changes something.
 */

import { requireOne } from "#db/client.ts";
import { sql } from "#db/sql.ts";

export type GroupSaleState = {
  readonly activeCount: number;
  readonly listingCount: number;
};

/** Read a group's member count and how many members are active. No listing
 * row is read, so nothing is decrypted. A group with no members reports zero
 * for both. */
export const getGroupSaleState = async (
  groupId: number,
): Promise<GroupSaleState> => {
  const row = await requireOne<{
    active_count: number;
    listing_count: number;
  }>(
    sql`SELECT COUNT(listing.id) AS listing_count,
            COALESCE(SUM(listing.active), 0) AS active_count
       FROM group_listings AS groupListing
       JOIN listings AS listing ON listing.id = groupListing.listing_id
      WHERE groupListing.group_id = ${groupId}`,
  );
  return { activeCount: row.active_count, listingCount: row.listing_count };
};

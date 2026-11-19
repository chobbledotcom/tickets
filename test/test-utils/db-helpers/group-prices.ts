/** The stored price overrides a group holds on its member listings. */

import { queryAll } from "#db/client.ts";
import { sql } from "#db/sql.ts";

/** One group's price override rows for one listing, as stored. */
export const groupOverrideRows = (
  listingId: number,
  groupId: number,
): Promise<{ unit_price: number }[]> =>
  queryAll<{ unit_price: number }>(
    sql`SELECT unit_price FROM listing_prices WHERE listing_id = ${listingId} AND price_type = 'group' AND price_id = ${String(groupId)}`,
  );

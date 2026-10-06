/** Listing deletion and owned-row cleanup. */

import { executeBatch, type SqlStatement, type TxScope } from "#db/client.ts";
import { clearImageUsesForItemStatement, imageUseTargets } from "#db/images.ts";
import { clearItemEdgesStatement } from "#db/site-page-items.ts";
import { sitePageItemTargets } from "#shared/site-pages/target.ts";

/** Delete one listing and its listing-owned relationships in one batch. The
 *  batch runs on the caller's transaction when it runs inside one, and as its
 *  own batch otherwise. */
export const deleteListing = async (
  listingId: number,
  tx?: TxScope,
): Promise<void> => {
  const statements: SqlStatement[] = [
    {
      args: [listingId],
      sql: "DELETE FROM listing_attendees WHERE listing_id = ?",
    },
    {
      args: [listingId],
      sql: "DELETE FROM listing_questions WHERE listing_id = ?",
    },
    {
      args: [listingId],
      sql: "DELETE FROM listing_attribute_options WHERE listing_id = ?",
    },
    {
      args: [listingId],
      sql: "DELETE FROM listing_parents WHERE parent_listing_id = ?1 OR child_listing_id = ?1",
    },
    {
      args: [listingId],
      sql: "DELETE FROM group_listings WHERE listing_id = ?",
    },
    clearItemEdgesStatement(sitePageItemTargets.of("listing")(listingId)),
    clearImageUsesForItemStatement(imageUseTargets.of("listing")(listingId)),
    { args: [listingId], sql: "DELETE FROM activity_log WHERE listing_id = ?" },
    {
      args: [listingId],
      sql: "DELETE FROM listing_prices WHERE listing_id = ?",
    },
    { args: [listingId], sql: "DELETE FROM listings WHERE id = ?" },
  ];
  await (tx === undefined ? executeBatch(statements) : tx.batch(statements));
};

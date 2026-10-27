/** Listing deletion and owned-row cleanup. */

import { executeBatch, type SqlStatement, type TxScope } from "#db/client.ts";
import { clearImageUsesForItemStatement, imageUseTargets } from "#db/images.ts";
import { noteDeleteStatement } from "#db/notes/queries.ts";
import { numberedStatement } from "#db/numbered-statement.ts";
import { clearItemEdgesStatement } from "#db/site-page-items.ts";
import { sitePageItemTargets } from "#shared/site-pages/target.ts";

/** Delete one listing and its listing-owned relationships in one batch. The
 *  batch runs on the caller's transaction when it runs inside one, and as its
 *  own batch otherwise. The listing's notes go with it: a note names the
 *  record it is about by entity_type + entity_id, so it cannot ride a plain
 *  listing_id delete. */
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
    numberedStatement(
      (bind) =>
        `DELETE FROM listing_parents WHERE parent_listing_id = ${bind(listingId)} OR child_listing_id = ${bind(listingId)}`,
    ),
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
    noteDeleteStatement("listing", { args: [listingId], sql: "?" }),
    { args: [listingId], sql: "DELETE FROM listings WHERE id = ?" },
  ];
  await (tx === undefined ? executeBatch(statements) : tx.batch(statements));
};

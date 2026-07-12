/** Listing deletion and owned-row cleanup. */

import { executeBatch } from "#shared/db/client.ts";
import { clearImageUsesForItemStatement } from "#shared/db/images.ts";
import { clearItemEdgesStatement } from "#shared/db/site-page-items.ts";

/** Delete one listing and its listing-owned relationships in one batch. */
export const deleteListing = async (listingId: number): Promise<void> => {
  await executeBatch([
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
      args: [listingId, listingId],
      sql: "DELETE FROM listing_parents WHERE parent_listing_id = ? OR child_listing_id = ?",
    },
    {
      args: [listingId],
      sql: "DELETE FROM group_listings WHERE listing_id = ?",
    },
    clearItemEdgesStatement("listing", listingId),
    clearImageUsesForItemStatement("listing", listingId),
    { args: [listingId], sql: "DELETE FROM activity_log WHERE listing_id = ?" },
    {
      args: [listingId],
      sql: "DELETE FROM listing_prices WHERE listing_id = ?",
    },
    { args: [listingId], sql: "DELETE FROM listings WHERE id = ?" },
  ]);
};

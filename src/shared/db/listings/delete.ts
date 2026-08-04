/** Listing deletion and owned-row cleanup. */

import { executeBatch } from "#shared/db/client.ts";
import {
  clearImageUsesForItemStatement,
  imageUseTargets,
} from "#shared/db/images.ts";
import { clearItemEdgesStatement } from "#shared/db/site-page-items.ts";
import { sitePageItemTargets } from "#shared/site-pages/target.ts";

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
  ]);
};

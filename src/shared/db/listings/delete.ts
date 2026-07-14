/** Listing deletion and owned-row cleanup. */

import { OPEN_CHECKOUT_STAGE_SQL } from "#shared/db/checkout-stage-state.ts";
import { executeBatch } from "#shared/db/client.ts";
import { clearImageUsesForItemStatement } from "#shared/db/images.ts";
import { clearItemEdgesStatement } from "#shared/db/site-page-items.ts";

/** Delete one listing and its listing-owned relationships in one batch. */
export const deleteListing = async (listingId: number): Promise<void> => {
  await executeBatch([
    {
      args: [listingId],
      // Keep the rows of an attendee whose checkout is still mid-payment. The
      // delete guard (listingDeleteError) blocks a delete while a pending
      // checkout exists, but it is a preflight: a stage inserted in the window
      // between that read and this delete would otherwise have its booking rows
      // cascaded away, stranding the paid order on an empty staged record when
      // the payment lands. Preserving the (quantity-0) rows keeps that order
      // whole; the checkout resolves or the prune removes the attendee outright.
      sql: `DELETE FROM listing_attendees
             WHERE listing_id = ?
               AND attendee_id NOT IN (
                  SELECT attendee_id FROM checkout_stages
                   WHERE state ${OPEN_CHECKOUT_STAGE_SQL}
               )`,
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

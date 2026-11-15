/** Listing deletion and owned-row cleanup. */

import { executeBatch, type TxScope } from "#db/client.ts";
import { deleteById, deleteFrom } from "#db/delete-row.ts";
import { clearItemReferencesStatements } from "#db/item-references.ts";
import { noteDeleteStatement } from "#db/notes/queries.ts";
import { type SqlStatement, sql } from "#db/sql.ts";

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
    deleteFrom("listing_attendees", { listing_id: listingId }),
    deleteFrom("listing_questions", { listing_id: listingId }),
    deleteFrom("listing_attribute_options", { listing_id: listingId }),
    sql`DELETE FROM listing_parents WHERE parent_listing_id = ${listingId} OR child_listing_id = ${listingId}`,
    deleteFrom("group_listings", { listing_id: listingId }),
    ...clearItemReferencesStatements("listing", listingId),
    deleteFrom("activity_log", { listing_id: listingId }),
    deleteFrom("listing_prices", { listing_id: listingId }),
    noteDeleteStatement("listing", sql`${listingId}`),
    deleteById("listings", listingId),
  ];
  await (tx === undefined ? executeBatch(statements) : tx.batch(statements));
};

/** Listing deletion and owned-row cleanup. */

import { executeBatch, type TxScope } from "#db/client.ts";
import { clearItemReferencesStatements } from "#db/item-references.ts";
import { noteDeleteStatement } from "#db/notes/queries.ts";
import { equal, or } from "#db/select/expression.ts";
import { tables } from "#db/select/tables.ts";
import { type SqlStatement, sql } from "#db/sql.ts";
import { deleteFrom } from "#db/write.ts";

/** Delete one listing and its listing-owned relationships in one batch. The
 *  batch runs on the caller's transaction when it runs inside one, and as its
 *  own batch otherwise. The listing's notes go with it: a note names the
 *  record it is about by entity_type + entity_id, so it cannot ride a plain
 *  listing_id delete. */
export const deleteListing = async (
  listingId: number,
  tx?: TxScope,
): Promise<void> => {
  const ofListing = { listing_id: listingId };
  const statements: SqlStatement[] = [
    deleteFrom(tables.listing_attendees).where(ofListing),
    deleteFrom(tables.listing_questions).where(ofListing),
    deleteFrom(tables.listing_attribute_options).where(ofListing),
    deleteFrom(tables.listing_parents).where((link) =>
      or(
        equal(link.parent_listing_id, listingId),
        equal(link.child_listing_id, listingId),
      ),
    ),
    deleteFrom(tables.group_listings).where(ofListing),
    ...clearItemReferencesStatements("listing", listingId),
    deleteFrom(tables.activity_log).where(ofListing),
    deleteFrom(tables.listing_prices).where(ofListing),
    noteDeleteStatement("listing", sql`${listingId}`),
    deleteFrom(tables.listings).where({ id: listingId }),
  ];
  await (tx === undefined ? executeBatch(statements) : tx.batch(statements));
};

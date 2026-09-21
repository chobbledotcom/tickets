/** The `group_listings` link table: both directions of which listings sit in
 * which groups. A link row means the group holds that listing; groups read one
 * side, listing records read the other, so the table homes apart from both. */

import { linkTableSide } from "#db/link-table.ts";
import { requiredMapValue } from "#fp";

/** The listing ids in a group, and the reverse listing-to-groups side. */
export const groupListings = linkTableSide(
  "group_listings",
  "group_id",
  "listing_id",
);
export const listingGroups = {
  ...linkTableSide("group_listings", "listing_id", "group_id"),
  /** Read one of this side's guaranteed batch entries. */
  idsFor: (
    idsByListing: ReadonlyMap<number, number[]>,
    listingId: number,
  ): number[] =>
    requiredMapValue(
      idsByListing,
      listingId,
      "Missing listing group membership",
    ),
};

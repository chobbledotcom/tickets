/** The `group_listings` link table: both directions of which listings sit in
 * which groups. A link row means the group holds that listing. Groups read one
 * side, listing records read the other, so the table homes apart from both. */

import { linkTableSide } from "#db/link-table.ts";
import { among, type Condition } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import type { Node } from "#db/select/shape.ts";
import { tables } from "#db/select/tables.ts";
import { requiredMapValue } from "#fp";

/** The listing ids in a group, and the reverse listing-to-groups side. */
export const groupListings = linkTableSide(
  tables.group_listings,
  "groupId",
  "listingId",
);
export const listingGroups = {
  ...linkTableSide(tables.group_listings, "listingId", "groupId"),
  /** Read one of this side's guaranteed batch entries. */
  idsFor: (
    idsByListing: ReadonlyMap<number, number[]>,
    listingId: number,
  ): number[] => requiredMapValue(idsByListing, listingId),
};

/** The read of the groups among `ids` where `also` holds. */
export const groupsAmong = (
  ids: readonly number[],
  also: (group: Node<"groups">) => Condition,
) => from(tables.groups).where((group) => [among(group.id, ids), also(group)]);

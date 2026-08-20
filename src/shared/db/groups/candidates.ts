/** The listings a group's "add listings" form can offer. */

import { LISTING_ORDER_SQL } from "#db/listings/select.ts";
import { rawListingsTable } from "#db/listings/table.ts";
import { settings } from "#db/settings.ts";
import { notInSubquery } from "#db/where-clauses.ts";
import { resolveListingDefaults } from "#shared/listing-defaults.ts";
import type { SortableListing } from "#types";

/** A candidate listing for the form: enough to sort it, name it, and show
 * whether it is active. The form shows nothing else, so this read skips the
 * whole listing record — no money, day-price or image subqueries, and no
 * encrypted columns beyond the name. Its availability values are the effective
 * ones, so it sorts the same way a full listing record does. */
export type GroupListingCandidate = SortableListing & { active: boolean };

const candidateColumns = rawListingsTable.read.pick([
  "id",
  "name",
  "active",
  "date",
  "listing_type",
  "bookable_days",
  "duration_days",
  "minimum_days_before",
  "maximum_days_after",
  // The form sorts daily listings by their next bookable date, which reads the
  // three availability fields above — all inheritable, so the row carries the
  // inheritance flag and the site settings are applied before it is returned.
  "use_defaults",
]);

/**
 * Listings that are NOT already in the given group. Membership is many-to-many,
 * so a listing already in another group is still a valid candidate here; only
 * this group's current members are excluded.
 */
export const getListingsNotInGroup = async (
  groupId: number,
): Promise<GroupListingCandidate[]> => {
  const rows = await candidateColumns.many(
    {},
    {
      alias: "listing",
      order: LISTING_ORDER_SQL.created_desc,
      where: notInSubquery("listing.id", {
        args: [groupId],
        sql: "SELECT groupListing.listing_id FROM group_listings AS groupListing WHERE groupListing.group_id = ?",
      }),
    },
  );
  return rows.map((row) => {
    // The flag has done its job once the settings are applied; leaving it on the
    // candidate would invite a second, pointless overlay.
    const { use_defaults: _resolved, ...candidate } = resolveListingDefaults(
      row,
      settings.listingDefaults,
      settings.features.logistics,
    );
    return candidate;
  });
};

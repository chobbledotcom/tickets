/** The listings a group's "add listings" form can offer. */

import { LISTING_ORDER_SQL } from "#db/listings/select.ts";
import { readRows } from "#db/read.ts";
import { equal, notInQuery } from "#db/select/expression.ts";
import { from } from "#db/select/query.ts";
import { tables } from "#db/select/tables.ts";
import { settings } from "#db/settings.ts";
import {
  resolveListingDate,
  resolveListingDefaults,
} from "#shared/listing-defaults.ts";
import type { SortableListing } from "#types";

/** A candidate listing for the form: enough to sort it, name it, show
 *  whether it is active. The form shows nothing else, so this read skips the
 *  whole listing record — no money, day-price or image subqueries, and no
 *  encrypted columns beyond the name. Its availability values are the
 *  effective ones, so it sorts the same way a full listing record does. */
export type GroupListingCandidate = SortableListing & {
  active: boolean;
};

const CANDIDATE_COLUMNS = [
  "id",
  "name",
  "active",
  "date",
  "listingType",
  "bookableDays",
  "customisableDays",
  "durationDays",
  "minimumDaysBefore",
  "maximumDaysAfter",
  "sortOrder",
  // The form sorts daily listings by their next bookable date, which reads the
  // three availability fields above — all inheritable, so the row carries the
  // inheritance flag and the site settings are applied before it is returned.
  "useDefaults",
] as const;

/**
 * Listings that are NOT already in the given group. Membership is many-to-many,
 * so a listing already in another group is still a valid candidate here; only
 * this group's current members are excluded.
 */
export const getListingsNotInGroup = async (
  groupId: number,
): Promise<GroupListingCandidate[]> => {
  const memberIds = from(tables.group_listings)
    .where((member) => equal(member.groupId, groupId))
    .values((member) => member.listingId);
  const rows = await readRows(
    from(tables.listings)
      .where((listing) => notInQuery(listing.id, memberIds))
      .orderBy(() => [LISTING_ORDER_SQL.created_desc])
      .pick(...CANDIDATE_COLUMNS),
  );
  return rows.map((row) => {
    // The flag has done its job once the settings are applied; leaving it on the
    // candidate would invite a second, pointless overlay.
    const { useDefaults: _resolved, ...candidate } = resolveListingDefaults(
      resolveListingDate(row),
      settings.listingDefaults,
      settings.features.logistics,
    );
    return candidate;
  });
};

/**
 * Group ticket context and routing
 */

import { notFoundResponse } from "#routes/response.ts";
import {
  computeGroupSlugIndex,
  getActiveListingsByGroupId,
  getGroupBySlugIndex,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { sortListings } from "#shared/sort-listings.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import { renderTicketFlow } from "./ticket-submit.ts";
import type { AsyncHandler } from "./types.ts";

/** Load group by slug and its active listings, return 404 if empty */
const withActiveGroupListingsBySlug = async (
  slug: string,
  handler: AsyncHandler<[Group, ListingWithCount[]]>,
): Promise<Response> => {
  const slugIndex = await computeGroupSlugIndex(slug);
  const group = await getGroupBySlugIndex(slugIndex);
  if (!group) return notFoundResponse();

  const [listings, holidays] = await Promise.all([
    getActiveListingsByGroupId(group.id),
    getActiveHolidays(),
  ]);
  const sorted = sortListings(listings, holidays);
  return sorted.length === 0 ? notFoundResponse() : handler(group, sorted);
};

/** Handle group ticket page by slug. With `mode: "calculate"` a POST prices the
 * group booking as a quote instead of completing it. */
export const handleGroupTicketBySlug = (
  request: Request,
  slug: string,
  mode?: "calculate",
): Promise<Response> =>
  withActiveGroupListingsBySlug(slug, (group, listings) =>
    renderTicketFlow(request, [slug], {
      group,
      ...(mode !== undefined ? { mode } : {}),
    })(listings),
  );

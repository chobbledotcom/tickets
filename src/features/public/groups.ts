/**
 * Group ticket context and routing
 */

import { notFoundResponse } from "#routes/response.ts";
import {
  computeGroupSlugIndex,
  getGroupBySlugIndex,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { sortListings } from "#shared/sort-listings.ts";
import type { Group, ListingWithCount } from "#shared/types.ts";
import { getVisibleGroupMembers, groupBookable } from "./discovery.ts";
import { renderTicketFlow } from "./ticket-submit.ts";
import type { AsyncHandler } from "./types.ts";

/** A group resolved with its buyer-visible active listings. */
type GroupWithListings = { group: Group; listings: ListingWithCount[] };

/** Load a group by slug with its buyer-visible active listings, or null when
 * the slug is unknown or the group has none. A non-package group never exposes
 * a hidden package's members, so a regular group made only of them reads as
 * empty rather than leaking them. A package is all-or-nothing: a saved or
 * directly-typed /ticket/<package> URL must not sell an incomplete or sold-out
 * bundle when a member was deactivated or the bundle no longer fits, even
 * though /listings and the group QR already hide it — apply the SAME gate they
 * use. A regular group is left to render its sold-out members as before. */
const loadActiveGroupListingsBySlug = async (
  slug: string,
): Promise<GroupWithListings | null> => {
  const slugIndex = await computeGroupSlugIndex(slug);
  const group = await getGroupBySlugIndex(slugIndex);
  if (!group) return null;

  const [visible, holidays] = await Promise.all([
    getVisibleGroupMembers(group),
    getActiveHolidays(),
  ]);
  const sorted = sortListings(visible, holidays);
  if (sorted.length === 0) return null;
  if (group.is_package && !(await groupBookable(group, visible))) {
    return null;
  }
  return { group, listings: sorted };
};

/** Load group by slug and its buyer-visible active listings, return 404 if
 * empty ({@link loadActiveGroupListingsBySlug}). */
const withActiveGroupListingsBySlug = async (
  slug: string,
  handler: AsyncHandler<[Group, ListingWithCount[]]>,
): Promise<Response> => {
  const loaded = await loadActiveGroupListingsBySlug(slug);
  return loaded ? handler(loaded.group, loaded.listings) : notFoundResponse();
};

/** Load a live, BOOKABLE package group by slug with its visible active members,
 * or null (unknown slug, not a package, or the bundle no longer fits) — the
 * JSON API's data-shaped twin of the /ticket/<group-slug> gate. */
export const loadBookablePackageBySlug = async (
  slug: string,
): Promise<GroupWithListings | null> => {
  const loaded = await loadActiveGroupListingsBySlug(slug);
  return loaded?.group.is_package ? loaded : null;
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

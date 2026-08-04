/**
 * Group ticket context and routing
 */

import { compact, requiredMapValue, uniqueBy } from "#fp";
import { notFoundResponse } from "#routes/response.ts";
import {
  computeGroupSlugIndex,
  getGroupBySlugIndex,
  groupListings,
  groups,
  readGroupMembersWith,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { sortListings } from "#shared/sort-listings.ts";
import type { Group, Holiday, ListingWithCount } from "#shared/types.ts";
import { getVisibleGroupMembers, groupBookable } from "./group-liveness.ts";
import { renderTicketFlow } from "./ticket-submit.ts";

/** A group resolved with its buyer-visible active listings. */
export type GroupWithListings = {
  group: Group;
  listings: ListingWithCount[];
};

/** Build a by-slug group loader: resolve the slug to its group (null for an
 * unknown slug), then hand the group to the given loader. The one place every
 * public group page turns a slug into a group. */
const groupListingsLoader =
  (load: (group: Group) => Promise<GroupWithListings | null>) =>
  async (slug: string): Promise<GroupWithListings | null> => {
    const group = await getGroupBySlugIndex(await computeGroupSlugIndex(slug));
    return group === null ? null : load(group);
  };

/** Load a group by slug with its buyer-visible active listings, or null when
 * the slug is unknown or the group has none. A non-package group never exposes
 * a hidden package's members, so a regular group made only of them reads as
 * empty rather than leaking them. A package is all-or-nothing: a saved or
 * directly-typed /ticket/<package> URL must not sell an incomplete or sold-out
 * bundle when a member was deactivated or the bundle no longer fits, even
 * though /listings and the group QR already hide it — apply the SAME gate they
 * use. A regular group is left to render its sold-out members as before. */
const loadActiveGroupListingsBySlug = groupListingsLoader(async (group) => {
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
});

/** Load group by slug and its buyer-visible active listings, return 404 if
 * empty ({@link loadActiveGroupListingsBySlug}). */
const withActiveGroupListingsBySlug = async (
  slug: string,
  handler: ResponseHandler<[group: Group, listings: ListingWithCount[]]>,
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

/** Load the COMPLETE package group behind each cart slug, in slug order, with
 * null for a slug that names no live complete package (unknown slug, not a
 * package, no members, or a member was deactivated — an incomplete bundle must
 * never sell partially). Unlike the single `/ticket/<group>` gate this does NOT
 * require the bundle to still fit: a cart renders a sold-out package as a
 * dimmed section so the rest of the cart still books, mirroring the order
 * gallery's sold-out cards.
 *
 * Every slug's group, members, membership, and the holiday list are read
 * together, so a long cart URL costs a fixed handful of reads instead of four
 * per slug — enough to exhaust the request's subrequest budget on its own. */
export const loadCartPackagesBySlugs = async (
  slugs: readonly string[],
): Promise<(GroupWithListings | null)[]> => {
  const noPackages = slugs.map(() => null);
  if (slugs.length === 0) return noPackages;
  const slugIndices = await Promise.all(slugs.map(computeGroupSlugIndex));
  const bySlug = await groups.cache.getByKeys(slugIndices);
  const packages = uniqueBy((group: Group) => group.id)(
    compact(bySlug).filter((group) => group.is_package),
  );
  if (packages.length === 0) return noPackages;
  const { members: membersByGroup, more } = await readGroupMembersWith(
    packages,
    (groupIds) =>
      Promise.all([groupListings.getIdsByKeys(groupIds), getActiveHolidays()]),
    true,
  );
  const [memberIdsByGroup, holidays] = more;
  const completeById = new Map(
    packages.map((group) => [
      group.id,
      completePackageListings(
        group,
        requiredMapValue(membersByGroup, group.id, "Missing package members"),
        requiredMapValue(
          memberIdsByGroup,
          group.id,
          "Missing package membership",
        ),
        holidays,
      ),
    ]),
  );
  return bySlug.map((group) =>
    group === null ? null : (completeById.get(group.id) ?? null),
  );
};

/** The package's members, sorted for display, when the bundle is complete —
 * every member row still resolves to an active listing. Null otherwise. */
const completePackageListings = (
  group: Group,
  members: readonly ListingWithCount[],
  allMemberIds: readonly number[],
  holidays: Holiday[],
): GroupWithListings | null =>
  members.length === 0 || members.length < allMemberIds.length
    ? null
    : { group, listings: sortListings([...members], holidays) };

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

/** The group page's two membership forms: the posts that add listings to one
 * group and take them back out of it. Both run through the one shared
 * membership write, and both send the operator back to the group's page. */

/* jscpd:ignore-start -- imports */
import { logActivity } from "#db/activity-log.ts";
import {
  assignListingsToGroup,
  removeListingsFromGroup,
} from "#db/groups/membership/package-writes.ts";
import { packageMembersError } from "#db/groups.ts";
import { getListingsWithCountsByIds } from "#db/listings/records.ts";
import { compact } from "#fp";
import { t } from "#i18n";
import { groupFormPost } from "#routes/admin/group-form-post.ts";
import { CONTENT_FORM } from "#routes/auth.ts";
import { redirect } from "#routes/response.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { entityReturnPath } from "#shared/admin-pages.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { xCount } from "#shared/count-text.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Group, ListingWithCount } from "#types";

/* jscpd:ignore-end */

/** Validate package-only rules that rely on the group settings loaded for the form. */
const packageListingError = async (
  group: Group,
  listings: ListingWithCount[],
): Promise<string | null> => {
  if (group.is_package) {
    const packageError = await packageMembersError(
      listings,
      group.hide_package_listings,
    );
    if (packageError) return packageError;
  }
  return null;
};

/** The `listing_ids` checkbox values both membership forms send. */
const listingIdsFromForm = (form: FormParams): number[] =>
  form
    .getAll("listing_ids")
    .map(Number)
    .filter((n) => n > 0);

/** Where a refused membership write sends the operator back to: the group's
 * own page, or the groups list when the group itself went missing between the
 * loaded page and the write — its own page would then answer 404. */
const refusedWriteTarget = (groupPath: string, error: string): string =>
  error === t("error.selected_group_deleted")
    ? adminPattern("groups")
    : groupPath;

/** The tail both membership posts share: run the write, flash its refusal or
 * its success, and the operator lands back on the group's page either way.
 * The gate matches the group edit form's — editors change memberships through
 * the listing form already, so they reach both posts here too. */
const membershipPost = (
  write: MembershipChange,
  done: () => string,
): TypedRouteHandler<"POST /admin/groups/:id"> =>
  groupFormPost(async (group, form) => {
    const groupPath = entityReturnPath(adminPattern("groups"), group.id);
    const listingIds = listingIdsFromForm(form);
    if (listingIds.length === 0) return redirect(groupPath, done(), true);
    const error = await write(group, listingIds);
    return error === null
      ? redirect(groupPath, done(), true)
      : redirect(refusedWriteTarget(groupPath, error), error, false);
  }, CONTENT_FORM);

/** What one membership verb does with the chosen listings: run its write and
 * answer the flash message it refused with, or null when the group changed. */
type MembershipChange = (
  group: Group,
  listingIds: number[],
) => Promise<string | null>;

/** Run one membership write, then say what it did in the activity log. */
const writeAndLog = async (
  write: Promise<string | null>,
  log: string,
): Promise<string | null> => {
  const error = await write;
  if (error) return error;
  await logActivity(log);
  return null;
};

/** Add the chosen listings to the group: package rules first, then the shared
 * membership write. */
const addListings: MembershipChange = async (group, listingIds) => {
  const listings = compact(await getListingsWithCountsByIds(listingIds));
  const packageError = await packageListingError(group, listings);
  if (packageError) return packageError;
  return writeAndLog(
    assignListingsToGroup(listingIds, group.id),
    `${xCount(listings.length)} listings added to group '${group.name}'`,
  );
};

/** Take the chosen listings out of the group — the same membership diff the
 * listing form's own checkboxes run. */
const removeListings: MembershipChange = (group, listingIds) =>
  writeAndLog(
    removeListingsFromGroup(listingIds, group.id),
    `${xCount([...new Set(listingIds)].length)} listings removed from group '${group.name}'`,
  );

/** Handle POST /admin/groups/:id/add-listings - assign ungrouped listings to group */
export const handleAddListingsToGroup = membershipPost(addListings, () =>
  t("success.listings_added_to_group"),
);

/** Handle POST /admin/groups/:id/remove-listings - take member listings out
 * of the group. */
export const handleRemoveListingsFromGroup = membershipPost(
  removeListings,
  () => t("success.listings_removed_from_group"),
);

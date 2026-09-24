/** The group page's two membership forms: the post that adds listings to one
 * group, and the typed-name confirmation that takes them back out of it. */

/* jscpd:ignore-start -- imports */
import { logActivity } from "#db/activity-log.ts";
import {
  assignListingsToGroup,
  removeListingsFromGroup,
} from "#db/groups/membership/package-writes.ts";
import { getGroupById, packageMembersError } from "#db/groups.ts";
import { getListingsWithCountsByIds } from "#db/listings/records.ts";
import { compact } from "#fp";
import { t } from "#i18n";
import { createVerifiedFormRoute } from "#routes/admin/confirmation.ts";
import { contentRecordPage } from "#routes/admin/content-record.ts";
import { groupFormPost } from "#routes/admin/group-form-post.ts";
import { CONTENT_FORM } from "#routes/auth.ts";
import {
  errorRedirect,
  htmlResponse,
  redirect,
  redirectResponse,
} from "#routes/response.ts";
import { entityReturnPath } from "#shared/admin-pages.ts";
import { adminPattern } from "#shared/admin-surface.ts";
import { xCount } from "#shared/count-text.ts";
import { adminGroupRemoveListingsPage } from "#templates/admin/groups/remove-listings.tsx";
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

/** The chosen listing ids: checkbox values, or one comma-joined hidden field. */
const listingIdsFrom = (values: readonly string[]): number[] =>
  [...new Set(values)]
    .flatMap((value) => value.split(","))
    .map(Number)
    .filter((n) => n > 0);

/** The members the selection names, or an empty list when it names none. */
const selectedMembers = async (
  values: readonly string[],
): Promise<ListingWithCount[]> =>
  compact(await getListingsWithCountsByIds(listingIdsFrom(values)));

/** Where a refused membership write sends the operator next: the group's own
 * page, or the groups list when the group itself went missing. */
const refusedWriteTarget = (groupPath: string, error: string): string =>
  error === t("error.selected_group_deleted")
    ? adminPattern("groups")
    : groupPath;

const groupPathOf = (groupId: number): string =>
  entityReturnPath(adminPattern("groups"), groupId);

/** Handle POST /admin/groups/:id/add-listings - assign ungrouped listings to group */
export const handleAddListingsToGroup = groupFormPost(async (group, form) => {
  const groupPath = groupPathOf(group.id);
  const listingIds = listingIdsFrom(form.getAll("listing_ids"));
  if (listingIds.length === 0) {
    return redirect(groupPath, t("success.listings_added_to_group"), true);
  }
  const listings = await selectedMembers(form.getAll("listing_ids"));
  const packageError = await packageListingError(group, listings);
  if (packageError) return redirect(groupPath, packageError, false);
  // The write re-checks the selection's own rows, so a listing deleted since
  // the page rendered refuses the whole batch.
  const writeError = await assignListingsToGroup(listingIds, group.id);
  if (writeError) {
    const target = refusedWriteTarget(groupPath, writeError);
    return redirect(target, writeError, false);
  }
  await logActivity(
    `${xCount(listings.length)} listings added to group '${group.name}'`,
  );
  return redirect(groupPath, t("success.listings_added_to_group"), true);
}, CONTENT_FORM);

/** Handle GET /admin/groups/:id/remove-listings — the confirmation page. The
 * Overview form submits its selection here by query string. */
export const handleRemoveListingsGet = (
  request: Request,
  { id }: { id: number },
): Promise<Response> =>
  contentRecordPage(request, id, getGroupById, async (group, session) => {
    const listings = await selectedMembers(
      new URL(request.url).searchParams.getAll("listing_ids"),
    );
    if (listings.length === 0) return redirectResponse(groupPathOf(group.id));
    return htmlResponse(
      adminGroupRemoveListingsPage({ group, listings }, session),
    );
  });

/** Handle POST /admin/groups/:id/remove-listings — the confirmed removal. */
export const handleRemoveListingsPost = createVerifiedFormRoute<
  { id: number },
  Group
>({
  actionLabel: "removal",
  auth: CONTENT_FORM,
  identifier: (group) => group.name,
  identifierLabel: t("groups.name_label"),
  loadContext: ({ id }) => getGroupById(id),
  // The mismatch lands the operator back on the group's page: the confirmation
  // page's state lives in the query string, which an error redirect drops.
  mismatchRedirect: ({ id }) => groupPathOf(id),
  onConfirm: async ({ context: group, form }) => {
    const listingIds = listingIdsFrom(form.getAll("listing_ids"));
    const writeError = await removeListingsFromGroup(listingIds, group.id);
    if (writeError) {
      const target = refusedWriteTarget(groupPathOf(group.id), writeError);
      return errorRedirect(target, writeError);
    }
    await logActivity(
      `${xCount(listingIds.length)} listings removed from group '${group.name}'`,
    );
    return redirect(
      groupPathOf(group.id),
      t("success.listings_removed_from_group"),
      true,
    );
  },
});

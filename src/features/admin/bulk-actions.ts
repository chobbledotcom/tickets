/**
 * Bulk actions for groups.
 *
 * Provides a landing page listing available bulk operations for a group's
 * listings, and per-action form + handler pairs. The first action is
 * "Duplicate Group": create a new group and clone every listing into it,
 * applying a shared find/replace on the listing name and a date shift
 * derived from two reference dates.
 */

import { t } from "#i18n";
import { createVerifiedFormRoute } from "#routes/admin/confirmation.ts";
import {
  generateUniqueGroupSlug,
  groupFormPost,
  withGroup,
} from "#routes/admin/groups.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import {
  applyNameReplacement,
  computeDayOffset,
  shiftUtcIsoByDays,
} from "#shared/bulk-replace.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { executeBatch } from "#shared/db/client.ts";
import {
  cloneGroupMembershipStatement,
  getGroupBySlugIndex,
  getGroupPackagePrices,
  getListingsByGroupId,
  groupsTable,
  setGroupListingsActive,
} from "#shared/db/groups.ts";
import {
  getGroupDayPrices,
  groupDayPriceStatements,
  syncListingPricesForIds,
} from "#shared/db/listing-prices.ts";
import {
  getStoredListingWithCount,
  type ListingInput,
  listingsTable,
} from "#shared/db/listings.ts";
import { getFlash } from "#shared/flash-context.ts";
import {
  buildDuplicateListingInput,
  deactivationOrphanedAddOnError,
} from "#shared/listings-actions.ts";
import { sortListings } from "#shared/sort-listings.ts";
import type { AdminSession, Group, ListingWithCount } from "#shared/types.ts";
import {
  adminBulkActionsPage,
  adminDeactivateGroupPage,
  adminDuplicateGroupPage,
  adminReactivateGroupPage,
} from "#templates/admin/bulk-actions.tsx";
import { remapDuplicatedGroupEdges } from "./listings-parents.ts";

/** Render a bulk-actions sub-page for an authenticated group detail view. */
const groupListingsPage =
  (
    render: (
      group: Group,
      listings: ListingWithCount[],
      session: AdminSession,
      error?: string,
    ) => string,
  ): TypedRouteHandler<"GET /admin/groups/:id/bulk-actions"> =>
  (request, { id }) =>
    requireSessionOr(request, (session) =>
      withGroup(id)(async (group) => {
        const listings = sortListings(await getListingsByGroupId(group.id), []);
        const flash = getFlash();
        return htmlResponse(render(group, listings, session, flash.error));
      }),
    );

/** GET /admin/groups/:id/bulk-actions */
const handleBulkActionsGet = groupListingsPage(adminBulkActionsPage);

/** GET /admin/groups/:id/bulk-actions/duplicate */
const handleDuplicateGroupGet = groupListingsPage(adminDuplicateGroupPage);

/** GET /admin/groups/:id/bulk-actions/deactivate */
const handleDeactivateGroupGet = groupListingsPage(adminDeactivateGroupPage);

/** GET /admin/groups/:id/bulk-actions/reactivate */
const handleReactivateGroupGet = groupListingsPage(adminReactivateGroupPage);

/** Factory for group-level bulk toggle handlers (deactivate/reactivate). */
const groupTogglePost = (opts: { active: boolean; action: string }) =>
  createVerifiedFormRoute<{ id: number }, Group>({
    actionLabel: `${opts.action}ion`,
    identifier: (group) => group.name,
    identifierLabel: "Group name",
    loadContext: ({ id }) => groupsTable.findById(id),
    mismatchRedirect: (group) =>
      `/admin/groups/${group.id}/bulk-actions/${opts.action}`,
    onConfirm: async ({ context: group }) => {
      // A bulk DEACTIVATE marks every group member inactive at once, which can
      // orphan a child-scoped opt-in add-on rescued only by those members'
      // pages. Run the same shared guard the single-listing/API paths use,
      // with all members' ids marked inactive together, and block before the
      // batch UPDATE (parents.md Fix 5). Reactivation can only add pages.
      if (!opts.active) {
        const members = await getListingsByGroupId(group.id);
        const error = await deactivationOrphanedAddOnError(
          new Set(members.map((listing) => listing.id)),
        );
        if (error) {
          return errorRedirect(
            `/admin/groups/${group.id}/bulk-actions/${opts.action}`,
            error,
          );
        }
      }
      const affected = await setGroupListingsActive(group.id, opts.active);
      await logActivity(
        `Group '${group.name}' ${opts.action}d (${affected} listing(s))`,
      );
      return redirect(
        `/admin/groups/${group.id}`,
        `Group ${opts.action}d (${affected} listing(s))`,
        true,
      );
    },
  });

/** POST /admin/groups/:id/bulk-actions/deactivate */
const handleDeactivateGroupPost = groupTogglePost({
  action: "deactivate",
  active: false,
});

/** POST /admin/groups/:id/bulk-actions/reactivate */
const handleReactivateGroupPost = groupTogglePost({
  action: "reactivate",
  active: true,
});

/** POST /admin/groups/:id/bulk-actions/duplicate */
const handleDuplicateGroupPost = groupFormPost(async (group, form) => {
  const formUrl = `/admin/groups/${group.id}/bulk-actions/duplicate`;
  const newName = form.getString("new_name").trim();
  if (!newName) {
    return errorRedirect(formUrl, "New group name is required");
  }

  const nameFind = form.getString("name_find");
  const nameReplace = form.getString("name_replace");
  const dateFind = form.getString("date_find");
  const dateReplace = form.getString("date_replace");
  const dayOffset = computeDayOffset(dateFind, dateReplace);

  const listings = await getListingsByGroupId(group.id);
  const { slug, slugIndex } = await generateUniqueGroupSlug();
  // Build every clone's input up front — the reads (stored re-read + a fresh
  // random slug) don't belong inside the write transaction, and the clone is
  // taken from each listing's *stored* values, not the resolved view, so a
  // duplicate made while a default is set doesn't bake that default into the
  // new row (matching the single-listing edit/duplicate path).
  const cloneInputs: { sourceId: number; input: ListingInput }[] = [];
  for (const listing of listings) {
    const stored = (await getStoredListingWithCount(listing.id))!;
    cloneInputs.push({
      input: await buildDuplicateListingInput(stored, {
        closesAt: shiftUtcIsoByDays(stored.closes_at ?? "", dayOffset),
        date: shiftUtcIsoByDays(stored.date, dayOffset),
        name: applyNameReplacement(stored.name, nameFind, nameReplace),
      }),
      sourceId: listing.id,
    });
  }
  const memberBySource = new Map(
    (await getGroupPackagePrices(group.id)).map((row) => [row.listing_id, row]),
  );

  // The group row, its cloned listings, and their membership rows (each carrying
  // the source's package price/quantity so a package duplicates identically) all
  // land in ONE batch — atomic, a single round-trip, and clear of the
  // interactive-transaction round-trip guard regardless of how many listings the
  // group has. Memberships resolve the new group and clone by the slug_index each
  // was just inserted with, so no per-row id read is needed. Parent/child edges
  // are remapped after the batch commits, since they read the new clone rows.
  const groupInsert = await groupsTable.insertStatement!({
    description: group.description,
    hidden: group.hidden,
    hidePackageListings: group.hide_package_listings,
    isPackage: group.is_package,
    maxAttendees: group.max_attendees,
    name: newName,
    slug,
    slugIndex,
    termsAndConditions: group.terms_and_conditions,
  });
  const cloneInserts = await Promise.all(
    cloneInputs.map(({ input }) => listingsTable.insertStatement!(input)),
  );
  const membershipInserts = cloneInputs.map(({ sourceId, input }) => {
    // Every clone was just read as a member of the source group, so it always
    // has a group_listings row whose price/quantity the clone copies.
    const source = memberBySource.get(sourceId)!;
    return cloneGroupMembershipStatement({
      groupSlugIndex: slugIndex,
      listingSlugIndex: input.slugIndex,
      packagePrice: source.package_price,
      quantity: source.quantity,
    });
  });
  await executeBatch([groupInsert, ...cloneInserts, ...membershipInserts]);

  // Resolve the freshly-inserted ids by their (unique) slug_index for the redirect
  // and the edge remap — two reads, not one per clone.
  const newGroupId = (await getGroupBySlugIndex(slugIndex))!.id;
  const idBySlugIndex = new Map(
    (await getListingsByGroupId(newGroupId)).map((l) => [l.slug_index, l.id]),
  );
  // The clones were inserted via insertStatement in the batch above, bypassing
  // the listingsTable wrapper, so sync their listing_prices rows explicitly —
  // otherwise a priced clone has no matching price rows until it is edited.
  await syncListingPricesForIds([...idBySlugIndex.values()]);
  const idMap = new Map(
    cloneInputs.map(({ sourceId, input }) => [
      sourceId,
      idBySlugIndex.get(input.slugIndex)!,
    ]),
  );
  // The members' per-day package overrides can't be batch-copied like the flat
  // price/quantity (their `group_day` price_ids embed the group id, and the new
  // group's id only exists after the batch), so rewrite them here keyed to the
  // NEW group and each source member's clone.
  const sourceDayPrices = await getGroupDayPrices(group.id);
  await executeBatch(
    groupDayPriceStatements(
      newGroupId,
      [...sourceDayPrices].map(([sourceId, byDay]) => ({
        dayPrices: Object.fromEntries(byDay),
        listingId: idMap.get(sourceId)!,
      })),
    ),
  );

  // A cloned parent whose remapped edge set fails re-validation is left gateless
  // rather than written; surface those as a warning flash (mirroring the
  // single-listing duplicate's "but: …" behaviour) instead of silently
  // reporting success while producing a gateless standalone clone.
  const edgeErrors = await remapDuplicatedGroupEdges(idMap);

  await logActivity(
    `Group '${group.name}' duplicated to '${newName}' with ${listings.length} listing(s)`,
  );

  const success = `Duplicated '${group.name}' to '${newName}' (${listings.length} listing(s))`;
  if (edgeErrors.length > 0) {
    return redirect(
      `/admin/groups/${newGroupId}`,
      t("listings_table.group_duplicate_children_dropped", {
        reason: edgeErrors.join("; "),
        success,
      }),
      false,
    );
  }
  return redirect(`/admin/groups/${newGroupId}`, success, true);
});

/** Bulk actions routes */
export const bulkActionsRoutes = defineRoutes({
  "GET /admin/groups/:id/bulk-actions": handleBulkActionsGet,
  "GET /admin/groups/:id/bulk-actions/deactivate": handleDeactivateGroupGet,
  "GET /admin/groups/:id/bulk-actions/duplicate": handleDuplicateGroupGet,
  "GET /admin/groups/:id/bulk-actions/reactivate": handleReactivateGroupGet,
  "POST /admin/groups/:id/bulk-actions/deactivate": handleDeactivateGroupPost,
  "POST /admin/groups/:id/bulk-actions/duplicate": handleDuplicateGroupPost,
  "POST /admin/groups/:id/bulk-actions/reactivate": handleReactivateGroupPost,
});

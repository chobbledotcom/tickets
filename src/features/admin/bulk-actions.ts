/* jscpd:ignore-start */
import { identity, mapById, requiredMapValue } from "#fp";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";

/* jscpd:ignore-end */
/**
 * Bulk actions for groups.
 *
 * Provides a landing page listing available bulk operations for a group's
 * listings, and per-action form + handler pairs. The first action is
 * "Duplicate Group": create a new group and clone every listing into it.
 * The clone applies a shared find/replace on the listing name and a date
 * shift derived from two reference dates.
 */

import { logActivity } from "#db/activity-log.ts";
import { executeBatch, withTransaction } from "#db/client.ts";
import { groupListings } from "#db/groups/table.ts";
import {
  cloneGroupMembershipStatement,
  generateUniqueGroupSlug,
  getGroupBySlugIndex,
  getGroupPackagePrices,
  getListingsByGroupId,
  groups,
  setGroupListingsActive,
} from "#db/groups.ts";
import { syncListingPricesForIds } from "#db/listing-price-sync.ts";
import {
  dayCountPriceStatements,
  getGroupDayPrices,
  groupDayPriceStatements,
  groupFlatPriceStatements,
} from "#db/listing-prices.ts";
import {
  getStoredListingsWithCountsByIds,
  listingsTable,
} from "#db/listings/records.ts";
import {
  catalogNameLengthError,
  isNameTakenAnywhere,
  normalizeEntityName,
} from "#db/name-registry.ts";
/* jscpd:ignore-start */
import { t } from "#i18n";
import { createVerifiedFormRoute } from "#routes/admin/confirmation.ts";
import { groupFormPost } from "#routes/admin/group-form-post.ts";
import { groupConfirmBase } from "#routes/admin/group-listing-forms.ts";
import { withGroup } from "#routes/admin/groups.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { errorRedirect, htmlResponse, redirect } from "#routes/response.ts";
import { deactivationOrphanedAddOnError } from "#shared/add-on-reachability.ts";
import {
  applyNameReplacement,
  computeDayOffset,
  shiftUtcIsoByDays,
} from "#shared/bulk-replace.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { xCount } from "#shared/count-text.ts";
import { getFlash } from "#shared/flash-context.ts";
import { buildDuplicateListingInput } from "#shared/listings-actions.ts";
import { sitePlanMemberError } from "#shared/package-membership.ts";
import { requireValue } from "#shared/required-value.ts";
import { sortListings } from "#shared/sort-listings.ts";
import {
  adminBulkActionsPage,
  adminDeactivateGroupPage,
  adminDuplicateGroupPage,
  adminReactivateGroupPage,
} from "#templates/admin/bulk-actions.tsx";
import type { AdminSession, Group, ListingWithCount } from "#types";
import { remapDuplicatedGroupEdges } from "./listings-parents.ts";

/* jscpd:ignore-end */

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

const handleBulkActionsGet = groupListingsPage(adminBulkActionsPage);

const handleDuplicateGroupGet = groupListingsPage(adminDuplicateGroupPage);

const handleDeactivateGroupGet = groupListingsPage(adminDeactivateGroupPage);

const handleReactivateGroupGet = groupListingsPage(adminReactivateGroupPage);

const groupTogglePost = (opts: { active: boolean; action: string }) => {
  const pageUrl = (group: Group) =>
    `/admin/groups/${group.id}/bulk-actions/${opts.action}`;
  return createVerifiedFormRoute<{ id: number }, Group>({
    actionLabel: `${opts.action}ion`,
    ...groupConfirmBase(pageUrl),
    onConfirm: async ({ context: group }) => {
      // A bulk DEACTIVATE marks every group member inactive at once, which can
      // orphan a child-scoped opt-in add-on rescued only by those members'
      // pages. The guard reads through the write transaction, so the second of
      // two page-removing writes sees the first and is refused. Reactivation
      // can only add pages.
      const outcome = await withTransaction(async (tx) => {
        const refusal = opts.active
          ? null
          : await deactivationOrphanedAddOnError(
              new Set(await groupListings.getIds(group.id, tx)),
              tx,
            );
        return refusal === null
          ? {
              affected: await setGroupListingsActive(group.id, opts.active, tx),
            }
          : { refusal };
      });
      if ("refusal" in outcome) {
        return errorRedirect(pageUrl(group), outcome.refusal);
      }
      const { affected } = outcome;
      await logActivity(
        `Group '${group.name}' ${opts.action}d (${xCount(affected)} listings)`,
      );
      return redirect(
        `/admin/groups/${group.id}`,
        t(
          opts.active
            ? "bulk_actions.group_reactivated"
            : "bulk_actions.group_deactivated",
          { count: xCount(affected) },
        ),
        true,
      );
    },
  });
};

const handleDeactivateGroupPost = groupTogglePost({
  action: "deactivate",
  active: false,
});

const handleReactivateGroupPost = groupTogglePost({
  action: "reactivate",
  active: true,
});

/** The first generated name that breaks the cross-entity name invariant. The
 * name belongs to the new group or one of the clones and is already used by
 * another listing/group or duplicated within this batch. Returns null when
 * every name is unique. The batch insert below bypasses the create-path
 * validators, so the rules the form/API enforce are re-checked here. A blank
 * find/replace otherwise clones names verbatim and later makes name-based
 * catalog imports ambiguous. */
const firstDuplicateNameError = async (
  newGroupName: string,
  cloneInputs: readonly { input: ListingInput }[],
): Promise<string | null> => {
  const seen = new Set<string>();
  const names = [newGroupName, ...cloneInputs.map(({ input }) => input.name)];
  for (const name of names) {
    // The length rule is re-checked for the same reason as the uniqueness
    // rule: the batch insert bypasses the validators the form and API run.
    // One over-long clone name breaks Square checkouts like any other.
    const lengthError = catalogNameLengthError(name);
    if (lengthError) return lengthError;
    const key = normalizeEntityName(name);
    if (seen.has(key)) {
      return t("fields.validation.duplicate_clone_names", { name });
    }
    seen.add(key);
    if (await isNameTakenAnywhere(name)) {
      return t("fields.validation.clone_name_taken", { name });
    }
  }
  return null;
};

const handleDuplicateGroupPost = groupFormPost(async (group, form) => {
  const formUrl = `/admin/groups/${group.id}/bulk-actions/duplicate`;
  const newName = form.getString("new_name").trim();
  if (!newName) {
    return errorRedirect(formUrl, t("bulk_actions.new_name_required"));
  }

  const nameFind = form.getString("name_find");
  const nameReplace = form.getString("name_replace");
  const dateFind = form.getString("date_find");
  const dateReplace = form.getString("date_replace");
  const dayOffset = computeDayOffset(dateFind, dateReplace);

  const listings = await getListingsByGroupId(group.id);
  const storedById = mapById(identity<ListingWithCount>)(
    await getStoredListingsWithCountsByIds(
      listings.map((listing) => listing.id),
    ),
  );
  const { slug, slugIndex } = await generateUniqueGroupSlug();
  // Build every clone's input up front. The reads (stored re-read + a fresh
  // random slug) do not belong inside the write transaction. The clone is
  // taken from each listing's *stored* values, not the resolved view. A
  // duplicate made while a default is set therefore does not bake that
  // default into the new row (matching the single-listing edit/duplicate path).
  const cloneInputs = await Promise.all(
    listings.map(async (listing) => {
      const stored = requiredMapValue(
        storedById,
        listing.id,
        `Stored listing missing for ${listing.id}`,
      );
      return {
        input: await buildDuplicateListingInput(stored, {
          closesAt: shiftUtcIsoByDays(stored.closes_at ?? "", dayOffset),
          date: shiftUtcIsoByDays(stored.date, dayOffset),
          name: applyNameReplacement(stored.name, nameFind, nameReplace),
        }),
        sourceId: listing.id,
      };
    }),
  );
  // Reject before any write if the new group name or a clone name collides
  // (with an existing entity or another clone) — upholding the name invariant.
  const nameError = await firstDuplicateNameError(newName, cloneInputs);
  if (nameError) return errorRedirect(formUrl, nameError);
  // The clone batch bypasses the membership validators, so refuse the whole
  // duplication here. A clone of a built-site plan lands inside the new
  // group, a row no save path can create.
  const sitePlanClone = cloneInputs.find(({ input }) => input.assignBuiltSite);
  if (sitePlanClone) {
    return errorRedirect(
      formUrl,
      sitePlanMemberError(sitePlanClone.input.name),
    );
  }

  const memberBySource = new Map(
    (await getGroupPackagePrices(group.id)).map((row) => [row.listing_id, row]),
  );

  // The group row, its cloned listings, and their membership rows all land in
  // ONE batch: atomic, a single round-trip. Each membership row carries the
  // source's package price/quantity so a package duplicates identically. The
  // batch clears the interactive-transaction round-trip guard regardless of
  // how many listings the group has. Memberships resolve the new group and
  // clone by the slug_index each was just inserted with, so no per-row id
  // read is needed. Parent/child edges are remapped after the batch commits,
  // since they read the new clone rows.
  const groupInsert = await groups.table.insertStatement!({
    description: group.description,
    hidden: group.hidden,
    hidePackageListings: group.hide_package_listings,
    isPackage: group.is_package,
    maxAttendees: group.max_attendees,
    name: newName,
    showHiddenListings: group.show_hidden_listings,
    slug,
    slugIndex,
    termsAndConditions: group.terms_and_conditions,
  });
  const cloneInserts = await Promise.all(
    cloneInputs.map(({ input }) => listingsTable.insertStatement!(input)),
  );
  const membershipInserts = cloneInputs.map(({ sourceId, input }) => {
    // Every clone was just read as a member of the source group, so it always
    // has a group_listings row whose quantity the clone copies. The flat price
    // override lives in listing_prices and is rewritten to the new group below.
    const source = memberBySource.get(sourceId)!;
    return cloneGroupMembershipStatement({
      groupSlugIndex: slugIndex,
      listingSlugIndex: input.slugIndex,
      quantity: source.quantity,
    });
  });
  await executeBatch([groupInsert, ...cloneInserts, ...membershipInserts]);

  // Resolve the freshly-inserted ids by their (unique) slug_index for the redirect
  // and the edge remap — two reads, not one per clone.
  const duplicated = requireValue(
    await getGroupBySlugIndex(slugIndex),
    `Group with slug index ${slugIndex} does not exist`,
  );
  const newGroupId = duplicated.id;
  const idBySlugIndex = new Map(
    (await getListingsByGroupId(newGroupId)).map((l) => [l.slug_index, l.id]),
  );
  // The clones above went through insertStatement in the batch, and this
  // bypasses the listingsTable wrapper. Sync their `base` price rows
  // explicitly, or a priced clone has no matching base row until it is edited.
  await syncListingPricesForIds([...idBySlugIndex.values()]);
  const idMap = new Map(
    cloneInputs.map(({ sourceId, input }) => [
      sourceId,
      idBySlugIndex.get(input.slugIndex)!,
    ]),
  );
  // The clones' own per-day-count prices are no longer a column, so the raw
  // insert did not carry them. Write each clone's day_count rows from the day
  // prices its duplicate input carried over from the source.
  if (cloneInputs.length > 0) {
    await executeBatch(
      cloneInputs.flatMap(({ sourceId, input }) =>
        dayCountPriceStatements(idMap.get(sourceId)!, input.dayPrices),
      ),
    );
  }
  // The members' package price overrides cannot be batch-copied like the
  // quantity: their `group`/`group_day` price_ids embed the group id. The
  // new group's id only exists after the batch. Rewrite them here, keyed to
  // the NEW group and each source member's clone.
  const sourceDayPrices = await getGroupDayPrices(group.id);
  await executeBatch([
    ...groupFlatPriceStatements(
      newGroupId,
      [...memberBySource].map(([sourceId, row]) => ({
        listingId: idMap.get(sourceId)!,
        price: row.package_price,
      })),
    ),
    ...groupDayPriceStatements(
      newGroupId,
      [...sourceDayPrices].map(([sourceId, byDay]) => ({
        dayPrices: Object.fromEntries(byDay),
        listingId: idMap.get(sourceId)!,
      })),
    ),
  ]);
  await executeBatch(
    cloneInputs.map(({ sourceId }) => ({
      args: [idMap.get(sourceId)!, sourceId],
      sql: `INSERT INTO listing_attribute_options (listing_id, option_id)
            SELECT ?, option_id FROM listing_attribute_options WHERE listing_id = ?`,
    })),
  );

  // A cloned parent whose remapped edge set fails re-validation is left gateless
  // rather than written. Surface those as a warning flash (mirroring the
  // single-listing duplicate's "but: …" behaviour) instead of silently
  // reporting success while producing a gateless standalone clone.
  const edgeErrors = await remapDuplicatedGroupEdges(idMap);

  await logActivity(
    `Group '${group.name}' duplicated to '${newName}' with ${xCount(listings.length)} listings`,
  );

  const success = `Duplicated '${group.name}' to '${newName}' (${xCount(listings.length)} listings)`;
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

export const adminHandlers = defineRoutes({
  "GET /admin/groups/:id/bulk-actions": handleBulkActionsGet,
  "GET /admin/groups/:id/bulk-actions/deactivate": handleDeactivateGroupGet,
  "GET /admin/groups/:id/bulk-actions/duplicate": handleDuplicateGroupGet,
  "GET /admin/groups/:id/bulk-actions/reactivate": handleReactivateGroupGet,
  "POST /admin/groups/:id/bulk-actions/deactivate": handleDeactivateGroupPost,
  "POST /admin/groups/:id/bulk-actions/duplicate": handleDuplicateGroupPost,
  "POST /admin/groups/:id/bulk-actions/reactivate": handleReactivateGroupPost,
});

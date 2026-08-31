/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import { entityTabRoutes } from "#routes/admin/route-tables.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";

/**
 * Admin group management routes. Each route declares its own audience in
 * `admin-surface/areas.ts`, so the roles differ across this file: an editor
 * reaches the list and the record page, but only staff may delete.
 */

import { hmacHash } from "#crypto/hashing.ts";
import { logActivity } from "#db/activity-log.ts";
import { executeBatch } from "#db/client.ts";
import {
  assignListingsToGroup,
  readPackageFlagsTxOrNull,
  writePackageMembersTx,
} from "#db/groups/membership.ts";
import {
  generateUniqueGroupSlug,
  getGroupById,
  getListingsByGroupId,
  groups,
  hasPackageBookings,
  isGroupSlugTaken,
  packageMembersError,
  resetGroupListings,
} from "#db/groups.ts";
import { clearImageUsesForItemStatement, imageUseTargets } from "#db/images.ts";
import { getListingsWithCountsByIds } from "#db/listings/records.ts";
import { isNameTakenAnywhere } from "#db/name-registry.ts";
import { clearItemEdgesStatement } from "#db/site-page-items.ts";
import { compact } from "#fp";
import { t } from "#i18n";
import { createCrudHandlers } from "#routes/admin/crud-handlers.ts";
import { redirect } from "#routes/response.ts";
import { entityReturnPath } from "#shared/admin-pages.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { projectCatalogFields } from "#shared/catalog-fields/definition.ts";
import {
  type GroupInput,
  groupCatalogFields,
  type PackageMemberInput,
} from "#shared/catalog-fields/fields.ts";
import {
  GROUP_DEMO_FIELDS,
  wrapResourceForDemo,
} from "#shared/demo/overrides.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import { sitePageItemTargets } from "#shared/site-pages/target.ts";
import { normalizeSlug } from "#shared/slug.ts";
import { parseOptionalMinorUnits } from "#shared/validation/money.ts";
import { adminGroupDeletePage } from "#templates/admin/groups/delete.tsx";
import { adminGroupNewPage } from "#templates/admin/groups/form.tsx";
import { adminGroupsPage } from "#templates/admin/groups/list.tsx";
import {
  type GroupCreateFormValues,
  type GroupFormValues,
  getGroupCreateForm,
  getGroupForm,
} from "#templates/fields/group.ts";
import type { DayPrices, Group, ListingWithCount } from "#types";
import { withEntityLoader } from "./entity-handlers.ts";
import { withGroupOrNull } from "./find-group.ts";
import { groupPage } from "./group-page.ts";
import { createItemImageHandlers } from "./item-images.ts";

/* jscpd:ignore-end */

/** Shared shape of the group validators: an error message, or null when valid.
 * `id` is the group being edited (absent on create). */
type GroupValidator = (
  input: GroupInput,
  id?: number,
) => Promise<string | null>;

/** Validate that a group's slug is not already in use */
const validateGroupSlug: GroupValidator = async (input, id) => {
  const taken = await isGroupSlugTaken(input.slug, id);
  return taken ? t("error.slug_in_use_group") : null;
};

/** Reject marking a group as a package when any current member can't be packaged
 * (see {@link packageMembersError}) — including hiding a package whose member
 * gates children. A falsy `isPackage` is always fine. Returns a member-naming
 * error message, or null when valid. */
const validatePackageCompatibility = async (
  groupId: number,
  isPackage: boolean | undefined,
  hideListings: boolean | undefined,
): Promise<string | null> => {
  if (!isPackage) return null;
  return packageMembersError(await getListingsByGroupId(groupId), hideListings);
};

/** Error when the group is a HIDDEN package with sold tickets. Booking rows
 * keep its `package_group_id`, and a stale id resolves to NO package display —
 * existing /t tickets and confirmation emails would fall back to per-member
 * cards/rows, revealing the member names the hide flag concealed. Un-packaging
 * or deleting such a group is rejected until the operator clears the hide flag
 * first (an explicit reveal); a VISIBLE package still un-groups freely. */
export const soldHiddenPackageError = (id: number): Promise<string | null> =>
  withGroupOrNull(id, async (group) => {
    if (!group.is_package || !group.hide_package_listings) return null;
    return (await hasPackageBookings(id))
      ? t("error.sold_hidden_package")
      : null;
  });

/** Combined validation: slug uniqueness plus the package invariant. On create
 * (`id` undefined) the group has no members yet, so only the slug is checked.
 * Deleting or un-packaging a package with sold tickets is allowed for a
 * VISIBLE package: the group's items are simply un-grouped — the booking rows'
 * stored `package_group_id` stops resolving, and existing tickets fall back to
 * per-member cards. A HIDDEN sold package must not take that fall-back path
 * ({@link soldHiddenPackageError}). */
export const validateGroupWithPackage: GroupValidator = async (input, id) => {
  // A group name must be unique across BOTH groups and listings (create and edit
  // alike), mirroring the listing-side check so the two share one namespace.
  const nameTaken = await isNameTakenAnywhere(
    input.name,
    id === undefined ? undefined : { id: Number(id), kind: "group" },
  );
  if (nameTaken) return t("error.name_in_use");
  const slugError = await validateGroupSlug(input, id);
  if (slugError) return slugError;
  if (id === undefined) return null;
  if (!input.isPackage) {
    const hiddenError = await soldHiddenPackageError(Number(id));
    if (hiddenError) return hiddenError;
  }
  return validatePackageCompatibility(
    id,
    input.isPackage,
    input.hidePackageListings,
  );
};

/** Parse one package-price input to minor units. A blank, non-numeric, or
 * negative value is `null` — "no override; use the listing's own price" — so a
 * typo can't fail the save or store a negative override. An explicit `0` is a
 * real value: the listing is FREE within this package, distinct from "no
 * override". {@link parseOptionalMinorUnits} is exactly this optional-field
 * shape (blank ⇒ unset, never a real 0) and enforces the whole-string,
 * currency-decimal rule, so a typo like `12abc`/`1,50` falls back to no
 * override rather than a partial `12`/`1`. */
const parsePackagePrice = (raw: string): number | null =>
  parseOptionalMinorUnits(raw);

/** Parse one package-quantity input. A blank, non-numeric, or sub-1 value
 * defaults to 1 (a package always includes at least one of each member). The
 * whole string must be digits: unlike `parseInt` (which accepts a leading
 * prefix), a typo like `2abc` or `1e3` defaults to 1 rather than parsing a
 * partial 2/1. */
const parsePackageQuantity = (raw: string): number => {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return 1;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) && n >= 1 ? n : 1;
};

/** The per-listing `package_day_price_<listingId>_<n>` inputs folded into each
 * listing's day-price override map. A blank, non-numeric, or negative input
 * contributes nothing — "no override for that span; use the listing's own day
 * price" — while an explicit `0` makes the span free in this package, matching
 * {@link parsePackagePrice}'s rules for the flat override. */
const parseMemberDayPrices = (
  keys: ReadonlySet<string>,
  form: FormParams,
): Map<number, DayPrices> => {
  const byListing = new Map<number, DayPrices>();
  for (const key of keys) {
    const match = /^package_day_price_(\d+)_(\d+)$/.exec(key);
    if (!match) continue;
    const price = parsePackagePrice(form.getString(key));
    if (price === null) continue;
    const listingId = Number(match[1]);
    const savedDayPrices = byListing.get(listingId);
    const dayPrices = savedDayPrices === undefined ? {} : savedDayPrices;
    dayPrices[Number(match[2])] = price;
    byListing.set(listingId, dayPrices);
  }
  return byListing;
};

/** Read the per-listing `package_price_<id>` / `package_qty_<id>` /
 * `package_day_price_<id>_<n>` inputs from the edit form into one member entry
 * per listing whose price input is present. */
const parsePackageMembers = (form: FormParams): PackageMemberInput[] => {
  const members: PackageMemberInput[] = [];
  const keys = new Set(form.keys());
  const dayPricesByListing = parseMemberDayPrices(keys, form);
  for (const key of keys) {
    const match = /^package_price_(\d+)$/.exec(key);
    if (!match) continue;
    const listingId = Number(match[1]);
    const savedDayPrices = dayPricesByListing.get(listingId);
    members.push({
      dayPrices: savedDayPrices === undefined ? {} : savedDayPrices,
      listingId,
      price: parsePackagePrice(form.getString(key)),
      quantity: parsePackageQuantity(
        form.getString(`package_qty_${listingId}`),
      ),
    });
  }
  return members;
};

/** Shared fields from group form values */
const sharedGroupFields = (values: GroupCreateFormValues) =>
  projectCatalogFields(groupCatalogFields, "form", values);

/** Extract group input from create form values (auto-generates slug) */
const extractGroupCreateInput = async (
  values: GroupCreateFormValues,
): Promise<GroupInput> => {
  const { slug, slugIndex } = await generateUniqueGroupSlug();
  return { ...sharedGroupFields(values), slug, slugIndex };
};

/** Extract group input from edit form values (uses provided slug). */
const extractGroupEditInput = async (
  values: GroupFormValues,
): Promise<GroupInput> => {
  const slug = normalizeSlug(values.slug);
  return {
    ...sharedGroupFields(values),
    slug,
    slugIndex: await hmacHash(slug),
  };
};

/** Delete a group and reset its listings to ungrouped */
export const deleteGroup = async (id: InValue) => {
  const groupId = Number(id);
  await resetGroupListings(groupId);
  // Clear site-page membership edges atomically with the group row: a failed
  // delete must never leave a page pointing at a still-present group, nor strip
  // edges from a group that survives.
  await executeBatch([
    clearItemEdgesStatement(sitePageItemTargets.of("group")(groupId)),
    clearImageUsesForItemStatement(imageUseTargets.of("group")(groupId)),
    { args: [groupId], sql: "DELETE FROM groups WHERE id = ?" },
  ]);
};

/** Shared CRUD handler config. `renderEdit` is omitted because the edit page
 * needs the group's listings and package prices — the entity page's Edit tab
 * loads those (`loadGroupEditPanel`), and the edit POST stays generic. After
 * create/edit, staff land on the group detail page; editors can't open it (it
 * decrypts attendee PII), so they return to the group edit form instead — a
 * successful save never bounces them to a forbidden page. */
const crudConfig = {
  deleteGuard: (_group: Group, id: number) => soldHiddenPackageError(id),
  getAll: () => groups.cache.getAll(),
  getName: (g: Group) => g.name,
  getRowPath: (g: Group) => entityReturnPath(adminPattern("groups"), g.id),
  list: "groups",
  renderDelete: adminGroupDeletePage,
  renderList: adminGroupsPage,
  renderNew: adminGroupNewPage,
  singular: "Group",
} as const;

/** Groups resource for REST create operations (auto-generated slug). Validates
 * with {@link validateGroupWithPackage} so a new group's name uniqueness is
 * enforced on create too; the package checks it runs are no-ops on create (the
 * group has no members yet) and the auto-generated slug is already unique. */
/** Config shared by both group resources: the same table, name field, delete
 * hook and package validation — the create/edit variants differ only in which
 * fields they accept and how they read the form. */
const groupResourceBase = {
  nameField: "name",
  onDelete: deleteGroup,
  table: groups.table,
  validate: validateGroupWithPackage,
} as const;

const groupsCreateResource = defineNamedResource({
  ...groupResourceBase,
  form: getGroupCreateForm(),
  toInput: extractGroupCreateInput,
});

/** Groups resource for REST update operations (user-provided slug). Validates
 *  the package invariant and writes the dynamic overrides via afterWrite, so the
 *  generic CRUD edit route handles packages without a bespoke handler.
 *  `afterWrite` reads the `package_price_<id>` / `package_qty_<id>` inputs from
 *  the raw form, clears all overrides when the group is not a package, and
 *  rechecks the sold-hidden invariant so a checkout that committed between the
 *  request-level check and this write rolls the change back. */
const groupsResource = defineNamedResource({
  ...groupResourceBase,
  afterWrite: (tx, id, input, form, flags) =>
    writePackageMembersTx(
      tx,
      id,
      flags,
      input,
      input.isPackage ? parsePackageMembers(form) : [],
    ),
  form: getGroupForm(),
  readState: readPackageFlagsTxOrNull,
  toInput: extractGroupEditInput,
});

// The two bundles differ only in which resource writes the row: creating a
// group generates its slug, editing one does not. Each route takes its own
// roles from its declaration, so editors reach the create and edit routes
// while the destructive delete stays staff-only, from one bundle.
const create = createCrudHandlers({
  ...crudConfig,
  operations: wrapResourceForDemo(groupsCreateResource, GROUP_DEMO_FIELDS),
});
const crud = createCrudHandlers({
  ...crudConfig,
  operations: wrapResourceForDemo(groupsResource, GROUP_DEMO_FIELDS),
});

/** Look up group by id, return 404 if not found */
export const withGroup = withEntityLoader((id: number) => getGroupById(id));

/**
 * POST handler factory: CSRF-validated form + loaded group.
 * Callers receive the group and the parsed form; a missing session or
 * missing group short-circuits with the appropriate response.
 */
export const groupFormPost = (
  handler: ResponseHandler<[group: Group, form: FormParams]>,
): TypedRouteHandler<"POST /admin/groups/:id"> =>
  createAuthedHandler<{ id: number }, Group>({
    handle: ({ context, form }) => handler(context, form),
    loadContext: ({ id }) => getGroupById(id),
  });

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

/** Handle POST /admin/groups/:id/add-listings - assign ungrouped listings to group */
const handleAddListingsToGroup = groupFormPost(async (group, form) => {
  const groupPath = entityReturnPath(adminPattern("groups"), group.id);
  const listingIds = form
    .getAll("listing_ids")
    .map(Number)
    .filter((n) => n > 0);
  if (listingIds.length > 0) {
    const listings = compact(await getListingsWithCountsByIds(listingIds));
    const packageError = await packageListingError(group, listings);
    if (packageError) {
      return redirect(groupPath, packageError, false);
    }
    const existingListingIds = listings.map((listing) => listing.id);
    const typeError = await assignListingsToGroup(listingIds, group.id);
    if (typeError) {
      // Another operator can delete the group between the load above and this
      // write, and the group's own page would then answer 404, so a group that
      // went missing sends the operator back to the list instead.
      const target =
        typeError === t("error.selected_group_deleted")
          ? adminPattern("groups")
          : groupPath;
      return redirect(target, typeError, false);
    }
    await logActivity(
      `${existingListingIds.length} listing(s) added to group '${group.name}'`,
    );
  }
  return redirect(groupPath, t("success.listings_added_to_group"), true);
});

const groupImageHandlers = createItemImageHandlers({
  disabledPath: (id) => `/admin/groups/${id}/edit`,
  itemType: "group",
  load: (id) => getGroupById(id),
  nameOf: (group) => group.name,
  path: (id) => `/admin/groups/${id}/images`,
});

/** Group routes */
export const adminHandlers = defineRoutes({
  "GET /admin/groups": crud.listGet,

  // The detail + edit pages are one tabbed entity page now: `/admin/groups/:id`
  // is its Overview, `/admin/groups/:id/:tab` its other tabs (attendees, edit,
  // actions). Per-tab authorization lives in the page definition (group-page.ts);
  // literal sub-routes below (add-listings, and delete/export/bulk-actions in
  // their own files) are matched ahead of the `:tab` wildcard. The edit POST is
  // still the generic CRUD route — groupsResource handles package prices + the
  // invariant via validate/afterWrite.
  ...entityTabRoutes(adminPattern("group"), groupPage),
  "GET /admin/groups/:id/delete": crud.deleteGet,
  // Create uses the auto-generated-slug resource.
  "GET /admin/groups/new": create.newGet,
  "POST /admin/groups": create.createPost,
  "POST /admin/groups/:id/add-listings": handleAddListingsToGroup,
  "POST /admin/groups/:id/delete": crud.deletePost,
  "POST /admin/groups/:id/edit": crud.editPost,
  "POST /admin/groups/:id/images": groupImageHandlers.set,
  "POST /admin/groups/:id/images/upload": groupImageHandlers.upload,
});

/**
 * Admin group management routes - accessible to owners and managers
 */

import { compact } from "#fp";
import { t } from "#i18n";
import {
  createContentCrudHandlers,
  createCrudHandlers,
} from "#routes/admin/owner-crud.ts";
import { redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { groupReturnPath } from "#shared/admin-paths.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { executeBatch, type TxScope } from "#shared/db/client.ts";
import {
  assignListingsToGroup,
  computeGroupSlugIndex,
  type GroupInput,
  getListingsByGroupId,
  groups,
  hasPackageBookings,
  isGroupSlugTaken,
  type PackageMemberInput,
  resetGroupListings,
  setGroupPackageMembers,
  validateGroupListingType,
} from "#shared/db/groups.ts";
import { clearImageUsesForItemStatement } from "#shared/db/images.ts";
import { edgeIdsTouchingMany } from "#shared/db/listing-parents.ts";
import { getListing } from "#shared/db/listings.ts";
import { isNameTakenAnywhere } from "#shared/db/name-registry.ts";
import { clearItemEdgesStatement } from "#shared/db/site-page-items.ts";
import { GROUP_DEMO_FIELDS, wrapResourceForDemo } from "#shared/demo.ts";
import type { FormParams } from "#shared/form-data.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import { generateUniqueSlug, normalizeSlug } from "#shared/slug.ts";
import type {
  AdminSession,
  DayPrices,
  Group,
  ListingType,
} from "#shared/types.ts";
import { parseOptionalMinorUnits } from "#shared/validation/money.ts";
import {
  adminGroupDeletePage,
  adminGroupNewPage,
  adminGroupsPage,
} from "#templates/admin/groups.tsx";
import {
  type GroupCreateFormValues,
  type GroupFormValues,
  getGroupCreateFields,
  getGroupFields,
} from "#templates/fields.ts";
import { withEntityLoader } from "./entity-handlers.ts";
import { groupPage } from "./group-page.ts";
import { createItemImageHandlers } from "./item-images.ts";

/** Generate a unique group slug, retrying on collision */
export const generateUniqueGroupSlug = () =>
  generateUniqueSlug(computeGroupSlugIndex, isGroupSlugTaken);

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

/** A package prices each member individually and the buyer picks a single
 * package quantity, so every member needs an operator-set price: only
 * `can_pay_more` listings (price chosen by the buyer at booking time) cannot be
 * packaged. Daily and customisable-day members are fine — the group invariant
 * (see validateGroupListingType) keeps a group's members homogeneous, so a
 * dated package books every member from one shared date/day-count selector. */
const isPackageable = (listing: {
  listing_type: ListingType;
  customisable_days: boolean;
  can_pay_more: boolean;
}): boolean => !listing.can_pay_more;

/** Whether a listing can be a package member (see {@link isPackageable} for the
 * pricing rule). A member that is itself another listing's add-on CHILD can
 * never be packaged — a package member is only sold as part of its bundle. A
 * member that gates its own children (is a PARENT) is fine on a VISIBLE package
 * (the package page renders its child selector like any parent row) but not on
 * a hidden one, where members are collapsed to the package name and a child
 * selector would leak them. */
const isPackageableMember = (
  listing: {
    id: number;
    listing_type: ListingType;
    customisable_days: boolean;
    can_pay_more: boolean;
  },
  edges: { childIds: number[]; parentIds: number[] },
  // Undefined (an input that omitted the flag) reads as "not hidden".
  hideListings: boolean | undefined,
): boolean => {
  if (!isPackageable(listing)) return false;
  if (edges.parentIds.length > 0) return false;
  return !(hideListings && edges.childIds.length > 0);
};

/** Whether every listing can be a package member, judged against ONE batched
 * edge load (two queries for the whole member list, never per member). */
export const allPackageableMembers = async (
  listings: readonly Parameters<typeof isPackageableMember>[0][],
  hideListings: boolean | undefined,
): Promise<boolean> => {
  const edges = await edgeIdsTouchingMany(listings.map((l) => l.id));
  return listings.every((listing) =>
    isPackageableMember(listing, edges.get(listing.id)!, hideListings),
  );
};

/** Reject marking a group as a package when any current member can't be packaged
 * (see {@link isPackageableMember}) — including hiding a package whose member
 * gates children. A falsy `isPackage` is always fine. Returns an error message,
 * or null when valid. */
const validatePackageCompatibility = async (
  groupId: number,
  isPackage: boolean | undefined,
  hideListings: boolean | undefined,
): Promise<string | null> => {
  if (!isPackage) return null;
  const listings = await getListingsByGroupId(groupId);
  return (await allPackageableMembers(listings, hideListings))
    ? null
    : t("error.package_incompatible_listing");
};

/** Error when the group is a HIDDEN package with sold tickets. Booking rows
 * keep its `package_group_id`, and a stale id resolves to NO package display —
 * existing /t tickets and confirmation emails would fall back to per-member
 * cards/rows, revealing the member names the hide flag concealed. Un-packaging
 * or deleting such a group is rejected until the operator clears the hide flag
 * first (an explicit reveal); a VISIBLE package still un-groups freely. */
export const soldHiddenPackageError = async (
  id: number,
): Promise<string | null> => {
  const group = await groups.table.findById(id);
  if (!group?.is_package || !group.hide_package_listings) return null;
  return (await hasPackageBookings(id)) ? t("error.sold_hidden_package") : null;
};

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
    const dayPrices = byListing.get(listingId) ?? {};
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
    members.push({
      dayPrices: dayPricesByListing.get(listingId) ?? {},
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
const sharedGroupFields = (values: GroupCreateFormValues) => ({
  description: values.description,
  hidden: values.hidden === "1",
  hidePackageListings: values.hide_package_listings === "1",
  isPackage: values.is_package === "1",
  maxAttendees: values.max_attendees ?? 0,
  name: values.name,
  termsAndConditions: values.terms_and_conditions,
});

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
    slugIndex: await computeGroupSlugIndex(slug),
  };
};

/** Delete a group and reset its listings to ungrouped */
export const deleteGroup = async (
  id: Parameters<typeof groups.table.findById>[0],
) => {
  const groupId = Number(id);
  await resetGroupListings(groupId);
  // Clear site-page membership edges atomically with the group row: a failed
  // delete must never leave a page pointing at a still-present group, nor strip
  // edges from a group that survives.
  await executeBatch([
    clearItemEdgesStatement("group", groupId),
    clearImageUsesForItemStatement("group", groupId),
    { args: [groupId], sql: "DELETE FROM groups WHERE id = ?" },
  ]);
};

/** Shared CRUD handler config. `renderEdit` is omitted because the edit page
 * needs the group's listings and package prices — those are loaded by the custom
 * {@link handleGroupEditGet} route (the edit POST stays generic). After
 * create/edit, staff land on the group detail page; editors can't open it (it
 * decrypts attendee PII), so they return to the group edit form instead — a
 * successful save never bounces them to a forbidden page. */
const crudConfig = {
  deleteGuard: (_group: Group, id: number) => soldHiddenPackageError(id),
  getAll: () => groups.cache.getAll(),
  getName: (g: Group) => g.name,
  getRowPath: (g: Group, session: AdminSession) =>
    groupReturnPath(session.adminLevel, g.id),
  listPath: "/admin/groups",
  renderDelete: adminGroupDeletePage,
  renderList: adminGroupsPage,
  renderNew: adminGroupNewPage,
  singular: "Group",
} as const;

/** Groups resource for REST create operations (auto-generated slug). Validates
 * with {@link validateGroupWithPackage} so a new group's name uniqueness is
 * enforced on create too; the package checks it runs are no-ops on create (the
 * group has no members yet) and the auto-generated slug is already unique. */
const groupsCreateResource = defineNamedResource({
  fields: getGroupCreateFields(),
  nameField: "name",
  onDelete: deleteGroup,
  table: groups.table,
  toInput: extractGroupCreateInput,
  validate: validateGroupWithPackage,
});

/** Persist the group's per-listing package overrides (price + quantity) after
 * the row is saved, reading the dynamic `package_price_<id>` / `package_qty_<id>`
 * inputs from the raw form. When the group is not (or no longer) a package,
 * every override is cleared back to price 0 / quantity 1. */
const writeGroupPackageMembers = (
  tx: TxScope,
  id: number,
  input: GroupInput,
  form: FormParams,
) =>
  setGroupPackageMembers(
    id,
    input.isPackage ? parsePackageMembers(form) : [],
    tx,
  );

/** Groups resource for REST update operations (user-provided slug). Validates
 * the package invariant and writes the dynamic overrides via afterWrite, so the
 * generic CRUD edit route handles packages without a bespoke handler. */
const groupsResource = defineNamedResource({
  afterWrite: writeGroupPackageMembers,
  fields: getGroupFields(),
  nameField: "name",
  onDelete: deleteGroup,
  table: groups.table,
  toInput: extractGroupEditInput,
  validate: validateGroupWithPackage,
});

// Editors may create/edit groups, so list/new/create/edit use content-gated
// handlers; group deletion is destructive and stays staff-only, so its routes
// come from a staff CRUD below.
const contentCreate = createContentCrudHandlers({
  ...crudConfig,
  resource: wrapResourceForDemo(groupsCreateResource, GROUP_DEMO_FIELDS),
});
const content = createContentCrudHandlers({
  ...crudConfig,
  resource: wrapResourceForDemo(groupsResource, GROUP_DEMO_FIELDS),
});
const staffCrud = createCrudHandlers({
  ...crudConfig,
  resource: wrapResourceForDemo(groupsResource, GROUP_DEMO_FIELDS),
});

/** Look up group by id, return 404 if not found */
export const withGroup = withEntityLoader(groups.table.findById);

/**
 * POST handler factory: CSRF-validated form + loaded group.
 * Callers receive the group and the parsed form; a missing session or
 * missing group short-circuits with the appropriate response.
 */
export const groupFormPost = (
  handler: (group: Group, form: FormParams) => Response | Promise<Response>,
): TypedRouteHandler<"POST /admin/groups/:id"> =>
  createAuthedHandler<{ id: number }, Group>({
    handle: ({ context, form }) => handler(context, form),
    loadContext: ({ id }) => groups.table.findById(id),
  });

/** Validate that all listing types match the group; returns error message or
 * null. When the group is a package, also reject listings that can't be packaged
 * (see {@link isPackageableMember}). */
const validateListingTypesForGroup = async (
  group: Group,
  listingIds: number[],
): Promise<string | null> => {
  const listings = compact(
    await Promise.all(listingIds.map((listingId) => getListing(listingId))),
  );
  for (const listing of listings) {
    const typeError = await validateGroupListingType(
      group.id,
      listing.listing_type,
      listing.customisable_days,
    );
    if (typeError) return typeError;
  }
  if (
    group.is_package &&
    !(await allPackageableMembers(listings, group.hide_package_listings))
  ) {
    return t("error.package_incompatible_listing");
  }
  return null;
};

/** Handle POST /admin/groups/:id/add-listings - assign ungrouped listings to group */
const handleAddListingsToGroup = groupFormPost(async (group, form) => {
  const listingIds = form
    .getAll("listing_ids")
    .map(Number)
    .filter((n) => n > 0);
  if (listingIds.length > 0) {
    const typeError = await validateListingTypesForGroup(group, listingIds);
    if (typeError) {
      return redirect(`/admin/groups/${group.id}`, typeError, false);
    }
    await assignListingsToGroup(listingIds, group.id);
    await logActivity(
      `${listingIds.length} listing(s) added to group '${group.name}'`,
    );
  }
  return redirect(
    `/admin/groups/${group.id}`,
    t("success.listings_added_to_group"),
    true,
  );
});

const groupImageHandlers = createItemImageHandlers({
  disabledPath: (id) => `/admin/groups/${id}/edit`,
  itemType: "group",
  load: groups.table.findById,
  nameOf: (group) => group.name,
  path: (id) => `/admin/groups/${id}/images`,
});

/** Group routes */
export const groupsRoutes = {
  // List/new/create/edit are content-gated (editors included)…
  ...content.routes,
  // …but group deletion stays staff-only — override the content delete routes.
  ...staffCrud.deleteRoutes,
  // Create uses the auto-generated-slug resource.
  "GET /admin/groups/new": contentCreate.newGet,
  "POST /admin/groups": contentCreate.createPost,
  ...defineRoutes({
    // The detail + edit pages are one tabbed entity page now: `/admin/groups/:id`
    // is its Overview, `/admin/groups/:id/:tab` its other tabs (attendees, edit,
    // actions). Per-tab authorization lives in the page definition (group-page.ts);
    // literal sub-routes below (add-listings, and delete/export/bulk-actions in
    // their own files) are matched ahead of the `:tab` wildcard. The edit POST is
    // still the generic CRUD route — groupsResource handles package prices + the
    // invariant via validate/afterWrite.
    "GET /admin/groups/:id": (request, { id }) =>
      groupPage.renderTab(request, id, ""),
    "GET /admin/groups/:id/:tab": (request, { id, tab }) =>
      groupPage.renderTab(request, id, tab),
    "POST /admin/groups/:id/add-listings": handleAddListingsToGroup,
    "POST /admin/groups/:id/images": groupImageHandlers.set,
    "POST /admin/groups/:id/images/upload": groupImageHandlers.upload,
  }),
};

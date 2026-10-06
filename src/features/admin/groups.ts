/* jscpd:ignore-start */
import type { InValue } from "@libsql/client";
import { entityTabRoutes } from "#routes/admin/route-tables.ts";
import { defineRoutes } from "#routes/router.ts";
import { adminPattern } from "#shared/admin-surface.ts";

/**
 * Admin group management routes. Each route declares its own audience in
 * `admin-surface/areas.ts`, so the roles differ across this file. An editor
 * reaches the list and the record page. Only staff can delete.
 */

import { hmacHash } from "#crypto/hashing.ts";
import { executeBatch } from "#db/client.ts";
import {
  readPackageFlagsTxOrNull,
  writePackageMembersTx,
} from "#db/groups/membership/package-writes.ts";
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
import {
  catalogNameLengthError,
  isNameTakenAnywhere,
} from "#db/name-registry.ts";
import { clearItemEdgesStatement } from "#db/site-page-items.ts";
import { t } from "#i18n";
import { createCrudHandlers } from "#routes/admin/crud-handlers.ts";
import {
  handleAddListingsToGroup,
  handleRemoveListingsGet,
  handleRemoveListingsPost,
} from "#routes/admin/group-listing-forms.ts";
import { entityReturnPath } from "#shared/admin-pages.ts";
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
import {
  isValidMemberQuantity,
  wholeNumberValue,
} from "#shared/groups/package-member-values.ts";
import { defineResource } from "#shared/rest/resource.ts";
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
import type { DayPrices, Group } from "#types";
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

const validateGroupSlug: GroupValidator = async (input, id) => {
  const taken = await isGroupSlugTaken(input.slug, id);
  return taken ? t("error.slug_in_use_group") : null;
};

/** Reject marking a group as a package when a current member cannot be packaged
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
 * keep its `package_group_id`, and a stale id resolves to NO package display.
 * Existing /t tickets and confirmation emails fall back to per-member
 * cards/rows and reveal the member names the hide flag concealed. Un-packaging
 * or deleting such a group is rejected until the operator clears the hide flag
 * first (an explicit reveal). A VISIBLE package still un-groups freely. */
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
 * VISIBLE package: the group's items are un-grouped. The booking rows'
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
  const nameLengthError = catalogNameLengthError(input.name);
  if (nameLengthError) return nameLengthError;
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

/** Parse one package-price input to minor units. The form-level validation
 *  ({@link validatePackageMemberForm}) has already refused a non-numeric or
 *  negative value, so only a blank input falls through to `null` — "no
 *  override; use the listing's own price". An explicit `0` is a real value:
 *  the listing is FREE within this package, distinct from "no override".
 *  {@link parseOptionalMinorUnits} is exactly this optional-field shape
 *  (blank ⇒ unset, never a real 0) and enforces the whole-string,
 *  currency-decimal rule. */
const parsePackagePrice = (raw: string): number | null =>
  parseOptionalMinorUnits(raw);

/** Parse one package-quantity input. The form-level validation
 *  ({@link validatePackageMemberForm}) has already refused a non-digit or
 *  sub-1 value. A blank input is the one legal "no override" form, and a
 *  package always includes at least one of each member. */
const parsePackageQuantity = (raw: string): number => {
  const quantity = wholeNumberValue(raw.trim());
  return quantity ?? 1;
};

/** The per-listing `package_day_price_<listingId>_<n>` inputs folded into
 * each listing's day-price override map. The form-level validation
 * ({@link validatePackageMemberForm}) has already refused a non-numeric or
 * negative input. A blank input contributes nothing: no override for that
 * span, and the listing keeps its own day price. An explicit `0` makes the
 * span free in this package, matching {@link parsePackagePrice}. */
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

// The package-member form fields are dynamic: one price and quantity pair
// per member listing, keyed by listing id. The static form schema cannot
// declare them. The save's form-level validation walks them and refuses the
// first malformed one in plain words. Before this check the parse silently
// defaulted a malformed value. A junk price became "no override". A junk
// quantity became 1. A junk day price was dropped.
const PACKAGE_PRICE_KEY = /^package_price_(\d+)$/;
const PACKAGE_QTY_KEY = /^package_qty_(\d+)$/;
const PACKAGE_DAY_PRICE_KEY = /^package_day_price_(\d+)_(\d+)$/;

/** The rule one package day-price field must satisfy: the day count the key
 *  names is a positive safe integer, and the price parses. The API day-price
 *  map applies the same rule to its keys. Kept as a named function so the
 *  coverage run attributes it beside the other member rules. */
const validMemberDayPrice = (raw: string, key: string): boolean => {
  const day = wholeNumberValue(PACKAGE_DAY_PRICE_KEY.exec(key)?.[2] ?? "");
  return day !== null && day >= 1 && parsePackagePrice(raw) !== null;
};

/** One member override field family: how to recognise its keys, the rule a
 *  typed value must satisfy, and the message a broken value reports. The
 *  rule sees the whole key. The day-price family checks the day count it
 *  names, the same rule the API day-price map applies to its keys. */
const MEMBER_FORM_FIELDS: readonly {
  key: RegExp;
  message: string;
  valid: (raw: string, key: string) => boolean;
}[] = [
  {
    key: PACKAGE_QTY_KEY,
    message: "error.package_member_quantity",
    valid: (raw) => {
      const quantity = wholeNumberValue(raw);
      return quantity !== null && isValidMemberQuantity(quantity);
    },
  },
  {
    key: PACKAGE_PRICE_KEY,
    message: "error.package_member_price",
    valid: (raw) => parsePackagePrice(raw) !== null,
  },
  {
    key: PACKAGE_DAY_PRICE_KEY,
    message: "error.package_member_day_price",
    valid: validMemberDayPrice,
  },
];

/** The strict form check the package routes run before their parse. Every
 *  package_price_, package_qty_, and package_day_price_ field must hold a
 *  value the member rules accept. Blank stays legal and means "no
 *  override". Returns the first error message, or null. */
export const validatePackageMemberForm = (form: FormParams): string | null => {
  // Turning the package off must always succeed: a malformed leftover member
  // input is about to be discarded, so it cannot block the save.
  if (form.getString("is_package") !== "1") return null;
  for (const [key, raw] of form.entries()) {
    const field = MEMBER_FORM_FIELDS.find((entry) => entry.key.test(key));
    if (field === undefined) continue;
    if (raw.trim() === "") continue;
    if (!field.valid(raw, key)) return t(field.message);
  }
  return null;
};

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

const sharedGroupFields = (values: GroupCreateFormValues) =>
  projectCatalogFields(groupCatalogFields, "form", values);

const extractGroupCreateInput = async (
  values: GroupCreateFormValues,
): Promise<GroupInput> => {
  const { slug, slugIndex } = await generateUniqueGroupSlug();
  return { ...sharedGroupFields(values), slug, slugIndex };
};

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

export const deleteGroup = async (id: InValue) => {
  const groupId = Number(id);
  await resetGroupListings(groupId);
  // Clear site-page membership edges atomically with the group row. A failed
  // delete must never leave a page pointing at a still-present group, nor
  // strip edges from a group that survives.
  await executeBatch([
    clearItemEdgesStatement(sitePageItemTargets.of("group")(groupId)),
    clearImageUsesForItemStatement(imageUseTargets.of("group")(groupId)),
    { args: [groupId], sql: "DELETE FROM groups WHERE id = ?" },
  ]);
};

/** Shared CRUD handler config. `renderEdit` is omitted because the edit page
 * needs the group's listings and package prices. The entity page's Edit tab
 * loads those (`loadGroupEditPanel`), and the edit POST stays generic. After
 * create/edit, staff land on the group detail page. Editors cannot open it (it
 * decrypts attendee PII), so they return to the group edit form instead. A
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
 * enforced on create too. The package checks it runs are no-ops on create (the
 * group has no members yet) and the auto-generated slug is already unique. */
/** Config shared by both group resources: the same table, delete hook and
 * package validation. The variants accept and read different form fields. */
const groupResourceBase = {
  onDelete: deleteGroup,
  table: groups.table,
  validate: validateGroupWithPackage,
  validateForm: validatePackageMemberForm,
} as const;

const groupsCreateResource = defineResource({
  ...groupResourceBase,
  form: getGroupCreateForm(),
  toInput: extractGroupCreateInput,
});

/** Groups resource for REST update operations (user-provided slug). Validates
 *  the package invariant and writes the dynamic overrides via afterWrite, so the
 *  generic CRUD edit route handles packages without a bespoke handler.
 *  `afterWrite` reads the `package_price_<id>` / `package_qty_<id>` inputs
 *  from the raw form and clears all overrides when the group is not a
 *  package. It rechecks the sold-hidden invariant. A checkout that committed
 *  between the request-level check and this write rolls the change back. */
const groupsResource = defineResource({
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
// roles from its declaration. Editors reach the create and edit routes, while
// the destructive delete stays staff-only, from one bundle.
const create = createCrudHandlers({
  ...crudConfig,
  operations: wrapResourceForDemo(groupsCreateResource, GROUP_DEMO_FIELDS),
});
const crud = createCrudHandlers({
  ...crudConfig,
  operations: wrapResourceForDemo(groupsResource, GROUP_DEMO_FIELDS),
});

export const withGroup = withEntityLoader((id: number) => getGroupById(id));

const groupImageHandlers = createItemImageHandlers({
  disabledPath: (id) => `/admin/groups/${id}/edit`,
  itemType: "group",
  load: (id) => getGroupById(id),
  nameOf: (group) => group.name,
  path: (id) => `/admin/groups/${id}/images`,
});

export const adminHandlers = defineRoutes({
  "GET /admin/groups": crud.listGet,

  // The detail + edit pages are one tabbed entity page now: `/admin/groups/:id`
  // is its Overview, `/admin/groups/:id/:tab` its other tabs (attendees, edit,
  // actions). Per-tab authorization lives in the page definition (group-page.ts).
  // Literal sub-routes below (add-listings, and delete/export/bulk-actions in
  // their own files) are matched ahead of the `:tab` wildcard. The edit POST is
  // still the generic CRUD route — groupsResource handles package prices + the
  // invariant via validate/afterWrite.
  ...entityTabRoutes(adminPattern("group"), groupPage),
  "GET /admin/groups/:id/delete": crud.deleteGet,
  "GET /admin/groups/:id/remove-listings": handleRemoveListingsGet,
  // Create uses the auto-generated-slug resource.
  "GET /admin/groups/new": create.newGet,
  "POST /admin/groups": create.createPost,
  "POST /admin/groups/:id/add-listings": handleAddListingsToGroup,
  "POST /admin/groups/:id/delete": crud.deletePost,
  "POST /admin/groups/:id/edit": crud.editPost,
  "POST /admin/groups/:id/images": groupImageHandlers.set,
  "POST /admin/groups/:id/images/upload": groupImageHandlers.upload,
  "POST /admin/groups/:id/remove-listings": handleRemoveListingsPost,
});

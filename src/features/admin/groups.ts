/**
 * Admin group management routes - accessible to owners and managers
 */

import { map } from "#fp";
import { t } from "#i18n";
import { createCrudHandlers } from "#routes/admin/owner-crud.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { toMinorUnits } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { decryptAttendees } from "#shared/db/attendees.ts";
import {
  assignListingsToGroup,
  computeGroupSlugIndex,
  type GroupInput,
  getAllGroups,
  getGroupPackagePrices,
  getListingsByGroupId,
  getUngroupedListings,
  groupsTable,
  isGroupSlugTaken,
  type PackagePriceInput,
  resetGroupListings,
  setGroupPackagePrices,
  validateGroupListingType,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { getAttendeesByListingIds, getListing } from "#shared/db/listings.ts";
import { loadAttendeeQuestionData } from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { GROUP_DEMO_FIELDS, wrapResourceForDemo } from "#shared/demo.ts";
import { getFlash } from "#shared/flash-context.ts";
import type { FormParams } from "#shared/form-data.ts";
import { defineNamedResource } from "#shared/rest/resource.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { generateUniqueSlug, normalizeSlug } from "#shared/slug.ts";
import { sortListings } from "#shared/sort-listings.ts";
import {
  type AdminSession,
  type Attendee,
  type Group,
  isPaidListing,
} from "#shared/types.ts";
import {
  adminGroupDeletePage,
  adminGroupDetailPage,
  adminGroupEditPage,
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

/** A package prices each member individually, so its listings must have a single
 * fixed price — `customisable_days` and `can_pay_more` listings, whose price is
 * chosen at booking time, cannot be packaged. */
const isPackageable = (listing: {
  customisable_days: boolean;
  can_pay_more: boolean;
}): boolean => !listing.customisable_days && !listing.can_pay_more;

/** Reject marking a group as a package when any current member can't be packaged
 * (see {@link isPackageable}). A falsy `isPackage` is always fine. Returns an
 * error message, or null when valid. */
const validatePackageCompatibility = async (
  groupId: number,
  isPackage: boolean | undefined,
): Promise<string | null> => {
  if (!isPackage) return null;
  const listings = await getListingsByGroupId(groupId);
  return listings.every(isPackageable)
    ? null
    : t("error.package_incompatible_listing");
};

/** Combined validation: slug uniqueness plus the package invariant. On create
 * (`id` undefined) the group has no members yet, so only the slug is checked. */
export const validateGroupWithPackage: GroupValidator = async (input, id) => {
  const slugError = await validateGroupSlug(input, id);
  if (slugError) return slugError;
  if (id === undefined) return null;
  return validatePackageCompatibility(id, input.isPackage);
};

/** Read the per-listing `package_price_<id>` inputs from the edit form. A blank
 * input means price 0 — "no override; use the listing's own price". */
const parsePackagePrices = (form: FormParams): PackagePriceInput[] => {
  const prices: PackagePriceInput[] = [];
  for (const key of new Set(form.keys())) {
    const match = /^package_price_(\d+)$/.exec(key);
    if (!match) continue;
    const raw = form.getString(key);
    prices.push({
      listingId: Number(match[1]),
      price: raw === "" ? 0 : toMinorUnits(Number.parseFloat(raw)),
    });
  }
  return prices;
};

/** Shared fields from group form values */
const sharedGroupFields = (values: GroupCreateFormValues) => ({
  description: values.description,
  hidden: values.hidden === "1",
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
  id: Parameters<typeof groupsTable.findById>[0],
) => {
  await resetGroupListings(Number(id));
  await groupsTable.deleteById(id);
};

/** Shared CRUD handler config. `renderEdit` is omitted because the edit page
 * needs the group's listings and package prices — those are loaded by the
 * custom {@link handleGroupEditGet} route (the edit POST stays generic). */
const crudConfig = {
  getAll: getAllGroups,
  getName: (g: Group) => g.name,
  getRowPath: (g: Group) => `/admin/groups/${g.id}`,
  listPath: "/admin/groups",
  renderDelete: adminGroupDeletePage,
  renderList: adminGroupsPage,
  renderNew: adminGroupNewPage,
  singular: "Group",
} as const;

/** Groups resource for REST create operations (auto-generated slug) */
const groupsCreateResource = defineNamedResource({
  fields: getGroupCreateFields(),
  nameField: "name",
  onDelete: deleteGroup,
  table: groupsTable,
  toInput: extractGroupCreateInput,
});

/** Persist the group's per-listing package prices after the row is saved,
 * reading the dynamic `package_price_<id>` inputs from the raw form. When the
 * group is not (or no longer) a package, every override is cleared to 0. */
const writeGroupPackagePrices = (
  group: Group,
  input: GroupInput,
  form: FormParams,
) =>
  setGroupPackagePrices(
    group.id,
    input.isPackage ? parsePackagePrices(form) : [],
  );

/** Groups resource for REST update operations (user-provided slug). Validates
 * the package invariant and writes the dynamic price overrides via afterWrite,
 * so the generic CRUD edit route handles packages without a bespoke handler. */
const groupsResource = defineNamedResource({
  afterWrite: writeGroupPackagePrices,
  fields: getGroupFields(),
  nameField: "name",
  onDelete: deleteGroup,
  table: groupsTable,
  toInput: extractGroupEditInput,
  validate: validateGroupWithPackage,
});

const crudCreate = createCrudHandlers({
  ...crudConfig,
  resource: wrapResourceForDemo(groupsCreateResource, GROUP_DEMO_FIELDS),
});
const crud = createCrudHandlers({
  ...crudConfig,
  resource: wrapResourceForDemo(groupsResource, GROUP_DEMO_FIELDS),
});

/** Look up group by id, return 404 if not found */
export const withGroup = withEntityLoader(groupsTable.findById);

/** Build a session-guarded GET handler that loads the group by id and hands it,
 * with the session, to `render`. Shared by the detail and edit-form pages. */
const groupPage =
  (render: (group: Group, session: AdminSession) => Promise<Response>) =>
  (request: Request, id: number): Promise<Response> =>
    requireSessionOr(request, (session) =>
      withGroup(id)((group) => render(group, session)),
    );

/** Handle GET /admin/groups/:id/edit — the edit form with the per-listing
 * package price table pre-filled from the group's current overrides. */
const handleGroupEditGet: TypedRouteHandler<"GET /admin/groups/:id/edit"> = (
  request,
  { id },
) =>
  groupPage(async (group, session) => {
    const listings = await getListingsByGroupId(id);
    const prices = await getGroupPackagePrices(id);
    // Only real overrides (price > 0) go in the map; members without one show a
    // blank input that falls back to the listing's base price.
    const priceMap = new Map(
      prices
        .filter((row) => row.package_price > 0)
        .map((row) => [row.listing_id, row.package_price] as const),
    );
    return htmlResponse(
      adminGroupEditPage(group, listings, priceMap, session, getFlash().error),
    );
  })(request, id);

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
    loadContext: ({ id }) => groupsTable.findById(id),
  });

/** Handle GET /admin/groups/:id - group detail page */
const handleGroupDetail: TypedRouteHandler<"GET /admin/groups/:id"> = (
  request,
  { id },
) =>
  groupPage(async (group, session) => {
    const [listings, ungroupedListings, holidays] = await Promise.all([
      getListingsByGroupId(id),
      getUngroupedListings(),
      getActiveHolidays(),
    ]);
    const sortedListings = sortListings(listings, holidays);
    const listingIds = map((e: { id: number }) => e.id)(sortedListings);
    let attendees: Attendee[] = [];
    let phonePrefix: string | undefined;
    if (listingIds.length > 0) {
      const privateKey = await requireRequestPrivateKey();
      const hasPaidListing = sortedListings.some(isPaidListing);
      const [rawAttendees, prefix] = await Promise.all([
        getAttendeesByListingIds(listingIds),
        Promise.resolve(settings.phonePrefix),
      ]);
      attendees = await decryptAttendees(
        rawAttendees,
        privateKey,
        hasPaidListing,
      );
      phonePrefix = prefix;
    }
    const allowedDomain = getEffectiveDomain();
    const flash = getFlash();
    const questionData = await loadAttendeeQuestionData(
      listingIds,
      attendees.map((a) => a.id),
      await requireRequestPrivateKey(),
    );

    return htmlResponse(
      adminGroupDetailPage(
        group,
        sortedListings,
        sortListings(ungroupedListings, holidays),
        attendees,
        session,
        allowedDomain,
        phonePrefix,
        flash.success,
        questionData,
        flash.error,
      ),
    );
  })(request, id);

/** Validate that all listing types match the group; returns error message or
 * null. When the group is a package, also reject listings that can't be packaged
 * (customisable-day or pay-what-you-want listings — see {@link isPackageable}). */
const validateListingTypesForGroup = async (
  groupId: number,
  listingIds: number[],
  isPackage: boolean,
): Promise<string | null> => {
  for (const listingId of listingIds) {
    const listing = await getListing(listingId);
    if (listing) {
      const typeError = await validateGroupListingType(
        groupId,
        listing.listing_type,
        listing.customisable_days,
      );
      if (typeError) return typeError;
      if (isPackage && !isPackageable(listing)) {
        return t("error.package_incompatible_listing");
      }
    }
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
    const typeError = await validateListingTypesForGroup(
      group.id,
      listingIds,
      group.is_package,
    );
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

/** Group routes */
export const groupsRoutes = {
  ...crud.routes,
  // Override: create uses auto-generated slug, detail has custom page
  "GET /admin/groups/new": crudCreate.newGet,
  "POST /admin/groups": crudCreate.createPost,
  ...defineRoutes({
    "GET /admin/groups/:id": handleGroupDetail,
    // Custom edit GET so the per-listing package-price table is loaded and
    // pre-filled. The edit POST is the generic CRUD route — groupsResource
    // handles package prices + the invariant via validate/afterWrite.
    "GET /admin/groups/:id/edit": handleGroupEditGet,
    "POST /admin/groups/:id/add-listings": handleAddListingsToGroup,
  }),
};

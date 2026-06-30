/**
 * Admin group management routes - accessible to owners and managers
 */

import { map } from "#fp";
import { t } from "#i18n";
import {
  createContentCrudHandlers,
  createCrudHandlers,
} from "#routes/admin/owner-crud.ts";
import { requireContentOr, requireSessionOr } from "#routes/auth.ts";
import {
  getVisibleGroupMembers,
  groupBookable,
} from "#routes/public/discovery.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { groupReturnPath } from "#shared/admin-paths.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { parseNonNegativeMinorUnits } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { decryptAttendees } from "#shared/db/attendees.ts";
import type { TxScope } from "#shared/db/client.ts";
import {
  assignListingsToGroup,
  computeGroupSlugIndex,
  type GroupInput,
  getAllGroups,
  getGroupPackagePrices,
  getListingsByGroupId,
  getUngroupedListings,
  groupsTable,
  hiddenPackageHasBookings,
  isGroupSlugTaken,
  type PackageMemberInput,
  resetGroupListings,
  setGroupPackageMembers,
  validateGroupListingType,
} from "#shared/db/groups.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import { hasParentChildEdge } from "#shared/db/listing-parents.ts";
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
  type ListingType,
  type ListingWithCount,
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

/** A package prices each member individually and the buyer picks a single
 * package quantity, so every member must be a plain standard listing with a
 * single fixed price: daily listings (date-driven), `customisable_days`, and
 * `can_pay_more` listings (price chosen at booking time) cannot be packaged. */
const isPackageable = (listing: {
  listing_type: ListingType;
  customisable_days: boolean;
  can_pay_more: boolean;
}): boolean =>
  listing.listing_type === "standard" &&
  !listing.customisable_days &&
  !listing.can_pay_more;

/** Whether a listing can be a package member: a plain standard listing (see
 * {@link isPackageable}) that is not part of any parent/child relationship. */
const isPackageableMember = async (listing: {
  id: number;
  listing_type: ListingType;
  customisable_days: boolean;
  can_pay_more: boolean;
}): Promise<boolean> =>
  isPackageable(listing) && !(await hasParentChildEdge(listing.id));

/** Reject marking a group as a package when any current member can't be packaged
 * (see {@link isPackageableMember}). A falsy `isPackage` is always fine. Returns
 * an error message, or null when valid. */
const validatePackageCompatibility = async (
  groupId: number,
  isPackage: boolean | undefined,
): Promise<string | null> => {
  if (!isPackage) return null;
  const listings = await getListingsByGroupId(groupId);
  for (const listing of listings) {
    if (!(await isPackageableMember(listing))) {
      return t("error.package_incompatible_listing");
    }
  }
  return null;
};

/** The error shown when a change would orphan a hidden package's sold tickets:
 * deleting the group or clearing its `is_package` flag would stop the booking
 * rows' stored id resolving to a hidden package, falling their tickets back to
 * the individual members it concealed. Null when the group isn't a hidden
 * package with bookings (see {@link hiddenPackageHasBookings}); a non-hidden
 * package never leaks, and revealing the members first — clearing the hide flag
 * while keeping `is_package` — is the operator's sanctioned escape hatch. */
const concealedPackageBookingError = async (
  groupId: number,
): Promise<string | null> =>
  (await hiddenPackageHasBookings(groupId))
    ? t("error.hidden_package_has_bookings")
    : null;

/** Block deleting a hidden package that has sold tickets (see
 * {@link concealedPackageBookingError}). Wired as the group CRUD's delete guard
 * on both the admin form and the JSON API. */
export const guardGroupDelete = (group: Group): Promise<string | null> =>
  concealedPackageBookingError(group.id);

/** Combined validation: slug uniqueness plus the package invariant. On create
 * (`id` undefined) the group has no members yet, so only the slug is checked.
 * On update, un-packaging (clearing `is_package`) is blocked while the group is
 * a hidden package with sold tickets, for the same reason deletion is. */
export const validateGroupWithPackage: GroupValidator = async (input, id) => {
  const slugError = await validateGroupSlug(input, id);
  if (slugError) return slugError;
  if (id === undefined) return null;
  const compatError = await validatePackageCompatibility(id, input.isPackage);
  if (compatError) return compatError;
  if (input.isPackage) return null;
  return concealedPackageBookingError(id);
};

/** Parse one package-price input to minor units. A blank, non-numeric, or
 * negative value is `null` — "no override; use the listing's own price" — so a
 * typo can't fail the save or store a negative override. An explicit `0` is a
 * real value: the listing is FREE within this package, distinct from "no
 * override". {@link parseNonNegativeMinorUnits} enforces the whole-string-numeric
 * rule, so a typo like `12abc`/`1,50` falls back to no override rather than a
 * partial `12`/`1`. */
const parsePackagePrice = (raw: string): number | null =>
  parseNonNegativeMinorUnits(raw);

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

/** Read the per-listing `package_price_<id>` / `package_qty_<id>` inputs from
 * the edit form into one member entry per listing whose price input is present. */
const parsePackageMembers = (form: FormParams): PackageMemberInput[] => {
  const members: PackageMemberInput[] = [];
  for (const key of new Set(form.keys())) {
    const match = /^package_price_(\d+)$/.exec(key);
    if (!match) continue;
    const listingId = Number(match[1]);
    members.push({
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
  id: Parameters<typeof groupsTable.findById>[0],
) => {
  await resetGroupListings(Number(id));
  await groupsTable.deleteById(id);
};

/** Shared CRUD handler config. `renderEdit` is omitted because the edit page
 * needs the group's listings and package prices — those are loaded by the custom
 * {@link handleGroupEditGet} route (the edit POST stays generic). After
 * create/edit, staff land on the group detail page; editors can't open it (it
 * decrypts attendee PII), so they return to the group edit form instead — a
 * successful save never bounces them to a forbidden page. */
const crudConfig = {
  getAll: getAllGroups,
  getName: (g: Group) => g.name,
  getRowPath: (g: Group, session: AdminSession) =>
    groupReturnPath(session.adminLevel, g.id),
  guardDelete: guardGroupDelete,
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
  table: groupsTable,
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
export const withGroup = withEntityLoader(groupsTable.findById);

/** Build a GET handler (guarded by `requireSession`) that loads the group by id
 * and hands it, with the session, to `render`. The edit form is content-gated
 * (editors included); the detail page stays staff-only (it decrypts PII). */
const groupPage =
  (
    requireSession: typeof requireSessionOr,
    render: (group: Group, session: AdminSession) => Promise<Response>,
  ) =>
  (request: Request, id: number): Promise<Response> =>
    requireSession(request, (session) =>
      withGroup(id)((group) => render(group, session)),
    );

/** Handle GET /admin/groups/:id/edit — the edit form with the per-listing
 * package price table pre-filled from the group's current overrides. */
const handleGroupEditGet: TypedRouteHandler<"GET /admin/groups/:id/edit"> = (
  request,
  { id },
) =>
  groupPage(requireContentOr, async (group, session) => {
    const listings = await getListingsByGroupId(id);
    const rows = await getGroupPackagePrices(id);
    // listing id → saved per-unit price + per-package quantity, to pre-fill the
    // members table. A null price renders blank (no override); an explicit 0
    // renders as 0 (free in the package).
    const members = new Map(
      rows.map(
        (row) =>
          [
            row.listing_id,
            { price: row.package_price, quantity: row.quantity },
          ] as const,
      ),
    );
    return htmlResponse(
      adminGroupEditPage(group, listings, members, session, getFlash().error),
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

/** Whether a group's roster has any paid attendee data to decrypt. A package
 * member can carry a `package_price` override while its own `unit_price` is 0,
 * so it's paid in practice; treat any positive override as paid (alongside the
 * usual {@link isPaidListing} checks) so the roster decrypts payment fields. */
const groupHasPaidListing = async (
  group: Group,
  listings: ListingWithCount[],
): Promise<boolean> => {
  if (listings.some(isPaidListing)) return true;
  if (!group.is_package) return false;
  const rows = await getGroupPackagePrices(group.id);
  // Only a positive override charges money; a null (no override → base price,
  // already covered above) or an explicit free (0) adds no revenue.
  return rows.some((row) => (row.package_price ?? 0) > 0);
};

/** Handle GET /admin/groups/:id - group detail page */
const handleGroupDetail: TypedRouteHandler<"GET /admin/groups/:id"> = (
  request,
  { id },
) =>
  groupPage(requireSessionOr, async (group, session) => {
    const [listings, ungroupedListings, holidays] = await Promise.all([
      getListingsByGroupId(id),
      getUngroupedListings(),
      getActiveHolidays(),
    ]);
    const sortedListings = sortListings(listings, holidays);
    const listingIds = map((e: { id: number }) => e.id)(sortedListings);
    let attendees: Attendee[] = [];
    let phonePrefix: string | undefined;
    // Package-aware: an override-priced package charges via package_price even
    // when its member listings are free, so this (not listings.some(isPaid))
    // decides whether the roster decrypts payment fields AND whether the detail
    // page shows the revenue row.
    const hasPaidListing = await groupHasPaidListing(group, sortedListings);
    const privateKey = await requireRequestPrivateKey();
    if (listingIds.length > 0) {
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
      privateKey,
    );
    // The group's public /ticket/<group> page 404s for a package whose bundle is
    // incomplete or sold out, so suppress its admin share/QR/embed links then.
    // A non-package group always renders (it shows sold-out members), so it stays
    // shareable.
    const shareable =
      !group.is_package ||
      (await groupBookable(group, await getVisibleGroupMembers(group)));

    return htmlResponse(
      adminGroupDetailPage(
        group,
        sortedListings,
        sortListings(ungroupedListings, holidays),
        attendees,
        session,
        allowedDomain,
        hasPaidListing,
        shareable,
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
      if (isPackage && !(await isPackageableMember(listing))) {
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
  // List/new/create/edit are content-gated (editors included)…
  ...content.routes,
  // …but group deletion stays staff-only — override the content delete routes.
  ...staffCrud.deleteRoutes,
  // Create uses the auto-generated-slug resource; detail has a custom page.
  "GET /admin/groups/new": contentCreate.newGet,
  "POST /admin/groups": contentCreate.createPost,
  ...defineRoutes({
    // Detail decrypts attendee PII and add-listings is staff group management —
    // both stay on the default staff gate (editors are excluded).
    "GET /admin/groups/:id": handleGroupDetail,
    // Custom edit GET so the per-listing package-price table is loaded and
    // pre-filled. The edit POST is the generic CRUD route — groupsResource
    // handles package prices + the invariant via validate/afterWrite.
    "GET /admin/groups/:id/edit": handleGroupEditGet,
    "POST /admin/groups/:id/add-listings": handleAddListingsToGroup,
  }),
};

/**
 * Admin group management routes - accessible to owners and managers
 */

import { map } from "#fp";
import { t } from "#i18n";
import {
  createContentCrudHandlers,
  createCrudHandlers,
} from "#routes/admin/owner-crud.ts";
import { requireSessionOr } from "#routes/auth.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes, type TypedRouteHandler } from "#routes/router.ts";
import { groupReturnPath } from "#shared/admin-paths.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { decryptAttendees } from "#shared/db/attendees.ts";
import {
  assignListingsToGroup,
  computeGroupSlugIndex,
  type GroupInput,
  getAllGroups,
  getListingsByGroupId,
  getUngroupedListings,
  groupsTable,
  isGroupSlugTaken,
  resetGroupListings,
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

/** Validate that a group's slug is not already in use */
export const validateGroupSlug = async (
  input: GroupInput,
  id?: number,
): Promise<string | null> => {
  const taken = await isGroupSlugTaken(input.slug, id);
  return taken ? t("error.slug_in_use_group") : null;
};

/** Shared fields from group form values */
const sharedGroupFields = (values: GroupCreateFormValues) => ({
  description: values.description,
  hidden: values.hidden === "1",
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

/** Extract group input from edit form values (uses provided slug) */
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

/** Shared CRUD handler config. After create/edit, staff land on the group detail
 * page; editors can't open it (it decrypts attendee PII), so they return to the
 * group edit form instead — a successful save never bounces them to a forbidden
 * page. */
const crudConfig = {
  getAll: getAllGroups,
  getName: (g: Group) => g.name,
  getRowPath: (g: Group, session: AdminSession) =>
    groupReturnPath(session.adminLevel, g.id),
  listPath: "/admin/groups",
  renderDelete: adminGroupDeletePage,
  renderEdit: adminGroupEditPage,
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

/** Groups resource for REST update operations (user-provided slug) */
const groupsResource = defineNamedResource({
  fields: getGroupFields(),
  nameField: "name",
  onDelete: deleteGroup,
  table: groupsTable,
  toInput: extractGroupEditInput,
  validate: validateGroupSlug,
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
  requireSessionOr(request, (session) =>
    withGroup(id)(async (group) => {
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
    }),
  );

/** Validate that all listing types match the group; returns error message or null */
const validateListingTypesForGroup = async (
  groupId: number,
  listingIds: number[],
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
    const typeError = await validateListingTypesForGroup(group.id, listingIds);
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
    "POST /admin/groups/:id/add-listings": handleAddListingsToGroup,
  }),
};

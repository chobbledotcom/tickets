/**
 * Admin group management routes - owner only
 */

import { map } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import { decryptAttendeesForTable } from "#lib/db/attendees.ts";
import { getAllowedDomain } from "#lib/config.ts";
import { getAttendeesByEventIds } from "#lib/db/events.ts";
import { mergeEventFields } from "#lib/event-fields.ts";
import {
  assignEventsToGroup,
  computeGroupSlugIndex,
  getAllGroups,
  getEventsByGroupId,
  getUngroupedEvents,
  groupsTable,
  isGroupSlugTaken,
  resetGroupEvents,
  type GroupInput,
} from "#lib/db/groups.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import { getPhonePrefixFromDb } from "#lib/db/settings.ts";
import { defineNamedResource } from "#lib/rest/resource.ts";
import { generateUniqueSlug, normalizeSlug } from "#lib/slug.ts";
import { sortEvents } from "#lib/sort-events.ts";
import type { Attendee, Group } from "#lib/types.ts";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { requirePrivateKey } from "#routes/admin/utils.ts";
import { defineRoutes } from "#routes/router.ts";
import type { TypedRouteHandler } from "#routes/router.ts";
import { getSearchParam, htmlResponse, orNotFound, redirectWithSuccess, requireOwnerOr, withOwnerAuthForm } from "#routes/utils.ts";
import {
  adminGroupDeletePage,
  adminGroupDetailPage,
  adminGroupEditPage,
  adminGroupNewPage,
  adminGroupsPage,
} from "#templates/admin/groups.tsx";
import { groupCreateFields, groupFields, type GroupCreateFormValues, type GroupFormValues } from "#templates/fields.ts";

/** Generate a unique group slug, retrying on collision */
const generateUniqueGroupSlug = () =>
  generateUniqueSlug(computeGroupSlugIndex, isGroupSlugTaken);

/** Extract group input from create form values (auto-generates slug) */
const extractGroupCreateInput = async (
  values: GroupCreateFormValues,
): Promise<GroupInput> => {
  const { slug, slugIndex } = await generateUniqueGroupSlug();
  return {
    name: values.name,
    slug,
    slugIndex,
    termsAndConditions: values.terms_and_conditions,
  };
};

/** Extract group input from edit form values (uses provided slug) */
const extractGroupEditInput = async (
  values: GroupFormValues,
): Promise<GroupInput> => {
  const slug = normalizeSlug(values.slug);
  return {
    name: values.name,
    slug,
    slugIndex: await computeGroupSlugIndex(slug),
    termsAndConditions: values.terms_and_conditions,
  };
};

/** Delete a group and reset its events to ungrouped */
const deleteGroup = async (id: Parameters<typeof groupsTable.findById>[0]) => {
  await resetGroupEvents(Number(id));
  await groupsTable.deleteById(id);
};

/** Shared CRUD handler config */
const crudConfig = {
  singular: "Group",
  listPath: "/admin/groups",
  getRowPath: (g: Group) => `/admin/group/${g.id}`,
  getAll: getAllGroups,
  renderList: adminGroupsPage,
  renderNew: adminGroupNewPage,
  renderEdit: adminGroupEditPage,
  renderDelete: adminGroupDeletePage,
  getName: (g: Group) => g.name,
  deleteConfirmError: "Group name does not match. Please type the exact name to confirm deletion.",
} as const;

/** Groups resource for REST create operations (auto-generated slug) */
const groupsCreateResource = defineNamedResource({
  table: groupsTable,
  fields: groupCreateFields,
  toInput: extractGroupCreateInput,
  nameField: "name",
  onDelete: deleteGroup,
});

/** Groups resource for REST update operations (user-provided slug) */
const groupsResource = defineNamedResource({
  table: groupsTable,
  fields: groupFields,
  toInput: extractGroupEditInput,
  nameField: "name",
  validate: async (input, id) => {
    const taken = await isGroupSlugTaken(input.slug, Number(id));
    return taken ? "Slug is already in use" : null;
  },
  onDelete: deleteGroup,
});

const crudCreate = createOwnerCrudHandlers({ ...crudConfig, resource: groupsCreateResource });
const crud = createOwnerCrudHandlers({ ...crudConfig, resource: groupsResource });

/** Look up group by id, return 404 if not found */
const withGroup = (
  id: number,
  handler: (group: Group) => Response | Promise<Response>,
): Promise<Response> => orNotFound(groupsTable.findById(id), handler);

/** Handle GET /admin/group/:id - group detail page */
const handleGroupDetail: TypedRouteHandler<"GET /admin/group/:id"> = (request, { id }) =>
  requireOwnerOr(request, (session) =>
    withGroup(id, async (group) => {
      const [events, ungroupedEvents, holidays] = await Promise.all([
        getEventsByGroupId(id),
        getUngroupedEvents(),
        getActiveHolidays(),
      ]);
      const sortedEvents = sortEvents(events, holidays);
      const eventIds = map((e: { id: number }) => e.id)(sortedEvents);
      let attendees: Attendee[] = [];
      let phonePrefix: string | undefined;
      if (eventIds.length > 0) {
        const privateKey = await requirePrivateKey(session);
        const fields = mergeEventFields(map((e: { fields: string }) => e.fields)(sortedEvents));
        const hasPaidEvent = sortedEvents.some((e) => e.unit_price > 0);
        const [rawAttendees, prefix] = await Promise.all([
          getAttendeesByEventIds(eventIds),
          getPhonePrefixFromDb(),
        ]);
        attendees = await decryptAttendeesForTable(rawAttendees, privateKey, fields, hasPaidEvent);
        phonePrefix = prefix;
      }
      const allowedDomain = getAllowedDomain();
      const successMessage = getSearchParam(request, "success") || undefined;
      return htmlResponse(adminGroupDetailPage(group, sortedEvents, sortEvents(ungroupedEvents, holidays), attendees, session, allowedDomain, phonePrefix, successMessage));
    }));

/** Handle POST /admin/group/:id/add-events - assign ungrouped events to group */
const handleAddEventsToGroup: TypedRouteHandler<"POST /admin/group/:id/add-events"> = (request, { id }) =>
  withOwnerAuthForm(request, (_session, form) =>
    withGroup(id, async (group) => {
      const eventIds = form.getAll("event_ids").map(Number).filter((n) => n > 0);
      if (eventIds.length > 0) {
        await assignEventsToGroup(eventIds, id);
        await logActivity(`${eventIds.length} event(s) added to group '${group.name}'`);
      }
      return redirectWithSuccess(`/admin/group/${id}`, "Events added to group");
    }));

/** Group routes */
export const groupsRoutes = defineRoutes({
  "GET /admin/groups": crud.listGet,
  "GET /admin/group/new": crudCreate.newGet,
  "POST /admin/group": crudCreate.createPost,
  "GET /admin/group/:id": handleGroupDetail,
  "GET /admin/group/:id/edit": (request, { id }) => crud.editGet(request, id),
  "POST /admin/group/:id/edit": (request, { id }) => crud.editPost(request, id),
  "GET /admin/group/:id/delete": (request, { id }) => crud.deleteGet(request, id),
  "POST /admin/group/:id/delete": (request, { id }) => crud.deletePost(request, id),
  "POST /admin/group/:id/add-events": handleAddEventsToGroup,
});

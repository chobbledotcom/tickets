/**
 * Admin group management routes - owner only
 */

import { logActivity } from "#lib/db/activityLog.ts";
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
import { defineNamedResource } from "#lib/rest/resource.ts";
import { normalizeSlug } from "#lib/slug.ts";
import type { Group } from "#lib/types.ts";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { defineRoutes } from "#routes/router.ts";
import { htmlResponse, notFoundResponse, redirect, requireOwnerOr, withOwnerAuthForm } from "#routes/utils.ts";
import {
  adminGroupDeletePage,
  adminGroupDetailPage,
  adminGroupEditPage,
  adminGroupNewPage,
  adminGroupsPage,
} from "#templates/admin/groups.tsx";
import { groupFields, type GroupFormValues } from "#templates/fields.ts";

/** Extract group input from validated form values */
const extractGroupInput = async (
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

/** Groups resource for REST create/update operations */
const groupsResource = defineNamedResource({
  table: groupsTable,
  fields: groupFields,
  toInput: extractGroupInput,
  nameField: "name",
  validate: async (input, id) => {
    const taken = await isGroupSlugTaken(input.slug, id ? Number(id) : undefined);
    return taken ? "Slug is already in use" : null;
  },
  onDelete: async (id) => {
    const groupId = Number(id);
    await resetGroupEvents(groupId);
    await groupsTable.deleteById(id);
  },
});

const crud = createOwnerCrudHandlers({
  singular: "Group",
  listPath: "/admin/groups",
  getRowPath: (g: Group) => `/admin/group/${g.id}`,
  getAll: getAllGroups,
  resource: groupsResource,
  renderList: adminGroupsPage,
  renderNew: adminGroupNewPage,
  renderEdit: adminGroupEditPage,
  renderDelete: adminGroupDeletePage,
  getName: (g) => g.name,
  deleteConfirmError: "Group name does not match. Please type the exact name to confirm deletion.",
});

/** Look up group by id, return 404 if not found */
const withGroupOr404 = async (
  id: number,
  handler: (group: Group) => Response | Promise<Response>,
): Promise<Response> => {
  const group = await groupsTable.findById(id);
  return group ? handler(group) : notFoundResponse();
};

/** Handle GET /admin/group/:id - group detail page */
const handleGroupDetail = (
  request: Request,
  { id }: { id: number },
): Promise<Response> =>
  requireOwnerOr(request, (session) =>
    withGroupOr404(id, async (group) => {
      const [events, ungroupedEvents] = await Promise.all([
        getEventsByGroupId(id),
        getUngroupedEvents(),
      ]);
      return htmlResponse(adminGroupDetailPage(group, events, ungroupedEvents, session));
    }));

/** Handle POST /admin/group/:id/add-events - assign ungrouped events to group */
const handleAddEventsToGroup = (
  request: Request,
  { id }: { id: number },
): Promise<Response> =>
  withOwnerAuthForm(request, (_session, form) =>
    withGroupOr404(id, async (group) => {
      const eventIds = form.getAll("event_ids").map(Number).filter((n) => n > 0);
      if (eventIds.length > 0) {
        await assignEventsToGroup(eventIds, id);
        await logActivity(`${eventIds.length} event(s) added to group '${group.name}'`);
      }
      return redirect(`/admin/group/${id}`);
    }));

/** Group routes */
export const groupsRoutes = defineRoutes({
  "GET /admin/groups": crud.listGet,
  "GET /admin/group/new": crud.newGet,
  "POST /admin/group": crud.createPost,
  "GET /admin/group/:id": handleGroupDetail,
  "GET /admin/group/:id/edit": (request, { id }) => crud.editGet(request, id),
  "POST /admin/group/:id/edit": (request, { id }) => crud.editPost(request, id),
  "GET /admin/group/:id/delete": (request, { id }) => crud.deleteGet(request, id),
  "POST /admin/group/:id/delete": (request, { id }) => crud.deletePost(request, id),
  "POST /admin/group/:id/add-events": handleAddEventsToGroup,
});

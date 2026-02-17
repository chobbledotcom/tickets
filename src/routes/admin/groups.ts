/**
 * Admin group management routes - owner only
 */

import {
  computeGroupSlugIndex,
  getAllGroups,
  groupsTable,
  isGroupSlugTaken,
  resetGroupEvents,
  type GroupInput,
} from "#lib/db/groups.ts";
import { defineNamedResource } from "#lib/rest/resource.ts";
import { normalizeSlug } from "#lib/slug.ts";
import { createOwnerCrudHandlers } from "#routes/admin/owner-crud.ts";
import { defineRoutes } from "#routes/router.ts";
import { adminGroupDeletePage, adminGroupEditPage, adminGroupNewPage, adminGroupsPage } from "#templates/admin/groups.tsx";
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
  getAll: getAllGroups,
  resource: groupsResource,
  renderList: adminGroupsPage,
  renderNew: adminGroupNewPage,
  renderEdit: adminGroupEditPage,
  renderDelete: adminGroupDeletePage,
  getName: (g) => g.name,
  deleteConfirmError: "Group name does not match. Please type the exact name to confirm deletion.",
});

/** Group routes */
export const groupsRoutes = defineRoutes({
  "GET /admin/groups": crud.listGet,
  "GET /admin/group/new": crud.newGet,
  "POST /admin/group": crud.createPost,
  "GET /admin/group/:id/edit": (request, { id }) => crud.editGet(request, id),
  "POST /admin/group/:id/edit": (request, { id }) => crud.editPost(request, id),
  "GET /admin/group/:id/delete": (request, { id }) => crud.deleteGet(request, id),
  "POST /admin/group/:id/delete": (request, { id }) => crud.deletePost(request, id),
});

/**
 * Admin JSON API routes for groups — accessible via API key or cookie+CSRF.
 */

import {
  deleteGroup,
  generateUniqueGroupSlug,
  validateGroupSlug,
} from "#routes/admin/groups.ts";
import {
  computeGroupSlugIndex,
  type GroupInput,
  getAllGroups,
  groupsTable,
} from "#shared/db/groups.ts";
import {
  type DeleteBody,
  defineCrudApi,
  parseUpdateName,
  parseUpdateSlug,
} from "#shared/rest/crud-api.ts";
import { normalizeSlug } from "#shared/slug.ts";
import type { Group } from "#shared/types.ts";

/** JSON body accepted by POST /api/admin/groups */
export type CreateGroupBody = {
  name: string;
  description?: string;
  max_attendees?: number;
  terms_and_conditions?: string;
  hidden?: boolean;
};

/** JSON body accepted by PUT /api/admin/groups/:groupId */
export type UpdateGroupBody = Partial<CreateGroupBody> & { slug?: string };

/** JSON body accepted by DELETE /api/admin/groups/:groupId */
export type DeleteGroupBody = DeleteBody;

/** Strip slug_index from response */
const STRIP_KEYS = ["slug_index"];

export const groupApiRoutes = defineCrudApi<Group, GroupInput>({
  getAll: getAllGroups,
  name: "groups",
  nameField: "name",
  onDelete: deleteGroup,
  singular: "Group",
  stripKeys: STRIP_KEYS,
  table: groupsTable,

  toCreateInput: async (body) => {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return { error: "name is required", ok: false };

    const { slug, slugIndex } = await generateUniqueGroupSlug();
    return {
      input: {
        description:
          typeof body.description === "string" ? body.description : "",
        hidden: body.hidden === true,
        maxAttendees:
          typeof body.max_attendees === "number" ? body.max_attendees : 0,
        name,
        slug,
        slugIndex,
        termsAndConditions:
          typeof body.terms_and_conditions === "string"
            ? body.terms_and_conditions
            : "",
      },
      ok: true,
    };
  },

  toUpdateInput: async (body, existing) => {
    const parsed = parseUpdateName(body, existing.name);
    if (!parsed.ok) return parsed;

    const { slug, slugIndex } = await parseUpdateSlug(
      body,
      existing.slug,
      normalizeSlug,
      computeGroupSlugIndex,
    );

    return {
      input: {
        description:
          body.description != null
            ? String(body.description)
            : existing.description,
        hidden:
          typeof body.hidden === "boolean" ? body.hidden : existing.hidden,
        maxAttendees:
          typeof body.max_attendees === "number"
            ? body.max_attendees
            : existing.max_attendees,
        name: parsed.name,
        slug,
        slugIndex,
        termsAndConditions:
          body.terms_and_conditions != null
            ? String(body.terms_and_conditions)
            : existing.terms_and_conditions,
      },
      ok: true,
    };
  },
  validate: validateGroupSlug,
});

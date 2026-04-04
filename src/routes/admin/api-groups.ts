/**
 * Admin JSON API routes for groups — accessible via API key or cookie+CSRF.
 */

import {
  computeGroupSlugIndex,
  type GroupInput,
  getAllGroups,
  groupsTable,
  isGroupSlugTaken,
} from "#lib/db/groups.ts";
import {
  type DeleteBody,
  defineCrudApi,
  parseUpdateName,
  parseUpdateSlug,
} from "#lib/rest/crud-api.ts";
import { normalizeSlug } from "#lib/slug.ts";
import type { Group } from "#lib/types.ts";
import { deleteGroup, generateUniqueGroupSlug } from "#routes/admin/groups.ts";

/** JSON body accepted by POST /api/admin/groups */
export type CreateGroupBody = {
  name: string;
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

/** Validate slug uniqueness */
const validateSlug = async (
  input: GroupInput,
  id?: number,
): Promise<string | null> => {
  const taken = await isGroupSlugTaken(input.slug, id);
  return taken ? "Slug is already in use" : null;
};

export const groupApiRoutes = defineCrudApi<Group, GroupInput>({
  name: "groups",
  singular: "Group",
  table: groupsTable,
  getAll: getAllGroups,
  nameField: "name",
  stripKeys: STRIP_KEYS,
  onDelete: deleteGroup,
  validate: validateSlug,

  toCreateInput: async (body) => {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return { ok: false, error: "name is required" };

    const { slug, slugIndex } = await generateUniqueGroupSlug();
    return {
      ok: true,
      input: {
        name,
        slug,
        slugIndex,
        termsAndConditions:
          typeof body.terms_and_conditions === "string"
            ? body.terms_and_conditions
            : "",
        maxAttendees:
          typeof body.max_attendees === "number" ? body.max_attendees : 0,
        hidden: body.hidden === true,
      },
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
      ok: true,
      input: {
        name: parsed.name,
        slug,
        slugIndex,
        termsAndConditions:
          body.terms_and_conditions != null
            ? String(body.terms_and_conditions)
            : existing.terms_and_conditions,
        maxAttendees:
          typeof body.max_attendees === "number"
            ? body.max_attendees
            : existing.max_attendees,
        hidden:
          typeof body.hidden === "boolean" ? body.hidden : existing.hidden,
      },
    };
  },
});

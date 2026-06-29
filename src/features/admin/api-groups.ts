/**
 * Admin JSON API routes for groups — accessible via API key or cookie+CSRF.
 */

import {
  deleteGroup,
  generateUniqueGroupSlug,
  validateGroupWithPackage,
} from "#routes/admin/groups.ts";
import {
  computeGroupSlugIndex,
  type GroupInput,
  getAllGroups,
  groupsTable,
  type PackagePriceInput,
  setGroupPackagePrices,
} from "#shared/db/groups.ts";
import {
  type DeleteBody,
  defineCrudApi,
  parseUpdateName,
  parseUpdateSlug,
} from "#shared/rest/crud-api.ts";
import { normalizeSlug } from "#shared/slug.ts";
import type { Group } from "#shared/types.ts";

/** A package price override in a JSON request body. */
export type PackagePriceBody = { listing_id: number; price: number };

/** JSON body accepted by POST /api/admin/groups */
export type CreateGroupBody = {
  name: string;
  description?: string;
  max_attendees?: number;
  terms_and_conditions?: string;
  hidden?: boolean;
  is_package?: boolean;
  package_prices?: PackagePriceBody[];
};

/** JSON body accepted by PUT /api/admin/groups/:groupId */
export type UpdateGroupBody = Partial<CreateGroupBody> & { slug?: string };

/** JSON body accepted by DELETE /api/admin/groups/:groupId */
export type DeleteGroupBody = DeleteBody;

/** Strip slug_index from response */
const STRIP_KEYS = ["slug_index"];

/**
 * Parse the optional `package_prices` array from a JSON body. Returns `undefined`
 * when the key is absent (partial update: leave existing overrides untouched),
 * or a validated list (invalid entries dropped) — an empty array clears them.
 */
const parsePackagePrices = (
  body: Record<string, unknown>,
): PackagePriceInput[] | undefined => {
  const raw = body.package_prices;
  if (!Array.isArray(raw)) return undefined;
  // Drop non-object entries (e.g. a `null` in the array) before reading fields,
  // so a malformed element can't throw; remaining junk is filtered out by the
  // value checks, matching the rest of this best-effort parser.
  return raw
    .filter(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null,
    )
    .map((item) => ({
      listingId: Number(item.listing_id),
      price: Number(item.price),
    }))
    .filter(
      (p) =>
        Number.isInteger(p.listingId) &&
        p.listingId > 0 &&
        Number.isInteger(p.price) &&
        p.price >= 0,
    );
};

/**
 * Persist package price overrides after a group write, with partial-update
 * semantics: clearing the group's package flag clears all overrides; an absent
 * `package_prices` leaves existing rows untouched; otherwise the rows are set.
 */
const writePackagePrices = async (
  id: number,
  input: GroupInput,
): Promise<void> => {
  if (input.isPackage === false) {
    await setGroupPackagePrices(id, []);
    return;
  }
  if (input.packagePrices === undefined) return;
  await setGroupPackagePrices(id, input.packagePrices);
};

export const groupApiRoutes = defineCrudApi<Group, GroupInput>({
  afterWrite: writePackagePrices,
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
        isPackage: body.is_package === true,
        maxAttendees:
          typeof body.max_attendees === "number" ? body.max_attendees : 0,
        name,
        packagePrices: parsePackagePrices(body),
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
        isPackage:
          typeof body.is_package === "boolean"
            ? body.is_package
            : existing.is_package,
        maxAttendees:
          typeof body.max_attendees === "number"
            ? body.max_attendees
            : existing.max_attendees,
        name: parsed.name,
        packagePrices: parsePackagePrices(body),
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
  validate: validateGroupWithPackage,
});

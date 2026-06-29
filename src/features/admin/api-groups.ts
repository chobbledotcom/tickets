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
  getGroupPackagePrices,
  getGroupPackagePricesByGroupIds,
  groupsTable,
  type PackageMemberInput,
  setGroupPackageMembers,
} from "#shared/db/groups.ts";
import {
  type DeleteBody,
  defineCrudApi,
  type ItemResult,
  type ParseResult,
  parseOptionalArray,
  parseUpdateName,
  parseUpdateSlug,
} from "#shared/rest/crud-api.ts";
import { normalizeSlug } from "#shared/slug.ts";
import type { Group, GroupListing } from "#shared/types.ts";

/** A package member override in a JSON request body. `quantity` defaults to 1. */
export type PackageMemberBody = {
  listing_id: number;
  price: number;
  quantity?: number;
};

/** JSON body accepted by POST /api/admin/groups */
export type CreateGroupBody = {
  name: string;
  description?: string;
  max_attendees?: number;
  terms_and_conditions?: string;
  hidden?: boolean;
  is_package?: boolean;
  hide_package_listings?: boolean;
  package_members?: PackageMemberBody[];
};

/** JSON body accepted by PUT /api/admin/groups/:groupId */
export type UpdateGroupBody = Partial<CreateGroupBody> & { slug?: string };

/** JSON body accepted by DELETE /api/admin/groups/:groupId */
export type DeleteGroupBody = DeleteBody;

/** Strip slug_index from response */
const STRIP_KEYS = ["slug_index"];

/** Parse one JSON package-member entry, failing closed on anything malformed
 * (rather than coercing `null`/junk into a real override that would clear a
 * member). `quantity` is optional and defaults to 1. */
const parsePackageMember = (item: unknown): ItemResult<PackageMemberInput> => {
  if (typeof item !== "object" || item === null) {
    return { error: "package_members entries must be objects" };
  }
  const { listing_id, price, quantity = 1 } = item as Record<string, unknown>;
  if (!Number.isInteger(listing_id) || (listing_id as number) <= 0) {
    return { error: "package_members listing_id must be a positive integer" };
  }
  if (!Number.isInteger(price) || (price as number) < 0) {
    return { error: "package_members price must be a non-negative integer" };
  }
  if (!Number.isInteger(quantity) || (quantity as number) < 1) {
    return { error: "package_members quantity must be a positive integer" };
  }
  return {
    value: {
      listingId: listing_id as number,
      price: price as number,
      quantity: quantity as number,
    },
  };
};

/**
 * Parse the optional `package_members` array from a JSON body. `undefined` when
 * the key is absent (partial update: leave existing overrides untouched); an
 * empty array clears them. Fails closed (see {@link parseOptionalArray}): any
 * malformed entry rejects the whole request rather than being dropped.
 */
const parsePackageMembers = (
  body: Record<string, unknown>,
): ParseResult<PackageMemberInput[] | undefined> =>
  parseOptionalArray(
    body.package_members,
    "package_members",
    parsePackageMember,
  );

/**
 * Persist package overrides after a group write, with partial-update semantics:
 * clearing the group's package flag clears all overrides; absent `package_members`
 * leaves existing rows untouched; otherwise the rows are set.
 */
const writePackageMembers = async (
  id: number,
  input: GroupInput,
): Promise<void> => {
  if (input.isPackage === false) {
    await setGroupPackageMembers(id, []);
    return;
  }
  if (input.packageMembers === undefined) return;
  await setGroupPackageMembers(id, input.packageMembers);
};

/** Map a stored membership row to the JSON `package_members` entry shape clients
 * PUT, so list and single-row hydration serialize members identically. */
const toMember = (m: GroupListing): PackageMemberBody => ({
  listing_id: m.listing_id,
  price: m.package_price,
  quantity: m.quantity,
});

export const groupApiRoutes = defineCrudApi<Group, GroupInput>({
  afterWrite: writePackageMembers,
  getAll: getAllGroups,
  // Hydrate a package group's member overrides onto every response so an API
  // client can read back the listing_id/price/quantity values it PUT and
  // round-trip the configuration. Non-package groups carry no members.
  // get/create/update hydrate the single written group; the list endpoint uses
  // the batched hydrateList below (one query for every package group).
  hydrate: async (row) =>
    row.is_package
      ? { package_members: (await getGroupPackagePrices(row.id)).map(toMember) }
      : {},
  // Only package groups appear in the map; non-package groups are absent, so the
  // CRUD list builder hydrates them to no extra fields.
  hydrateList: async (rows) => {
    const packageGroups = rows.filter((row) => row.is_package);
    const byGroup = await getGroupPackagePricesByGroupIds(
      packageGroups.map((row) => row.id),
    );
    return new Map(
      packageGroups.map((row) => [
        row.id,
        { package_members: (byGroup.get(row.id) ?? []).map(toMember) },
      ]),
    );
  },
  name: "groups",
  nameField: "name",
  onDelete: deleteGroup,
  singular: "Group",
  stripKeys: STRIP_KEYS,
  table: groupsTable,

  toCreateInput: async (body) => {
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name) return { error: "name is required", ok: false };

    // A brand-new group has no `group_listings` rows yet, so member overrides
    // have nothing to attach to — `setGroupPackageMembers` would silently drop
    // them all and return a 201 for an empty package. Reject up front: callers
    // create the group, assign listings, then PUT the overrides. The malformed
    // entry is still validated (and rejected) so the error names the field.
    if (body.package_members !== undefined) {
      const members = parsePackageMembers(body);
      if (!members.ok) return members;
      return {
        error:
          "package_members cannot be set on create; create the group, assign listings, then update it",
        ok: false,
      };
    }

    const { slug, slugIndex } = await generateUniqueGroupSlug();
    return {
      input: {
        description:
          typeof body.description === "string" ? body.description : "",
        hidden: body.hidden === true,
        hidePackageListings: body.hide_package_listings === true,
        isPackage: body.is_package === true,
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

    const members = parsePackageMembers(body);
    if (!members.ok) return members;

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
        hidePackageListings:
          typeof body.hide_package_listings === "boolean"
            ? body.hide_package_listings
            : existing.hide_package_listings,
        isPackage:
          typeof body.is_package === "boolean"
            ? body.is_package
            : existing.is_package,
        maxAttendees:
          typeof body.max_attendees === "number"
            ? body.max_attendees
            : existing.max_attendees,
        name: parsed.name,
        packageMembers: members.input,
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

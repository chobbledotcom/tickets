/**
 * Admin JSON API routes for groups — accessible via API key or cookie+CSRF.
 */

import {
  deleteGroup,
  generateUniqueGroupSlug,
  validateGroupWithPackage,
} from "#routes/admin/groups.ts";
import type { TxScope } from "#shared/db/client.ts";
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
  getGroupDayPrices,
  getGroupDayPricesByGroupIds,
} from "#shared/db/listing-prices.ts";
import {
  bodyBoolean,
  bodyNumber,
  bodyString,
  type DeleteBody,
  defineCrudApi,
  type ItemResult,
  type ParseResult,
  parseOptionalArray,
  parseUpdateName,
  parseUpdateSlug,
} from "#shared/rest/crud-api.ts";
import { normalizeSlug } from "#shared/slug.ts";
import type { DayPrices, Group, GroupListing } from "#shared/types.ts";

/** A package member override in a JSON request body. `price` is minor units:
 * `null` means no override (use the listing's own price), `0` means free in the
 * package, and a positive value overrides the price. `quantity` defaults to 1.
 * `day_prices` repriced spans for a customisable member (day count → per-unit
 * minor units); omitted/empty means every span charges the listing's own day
 * price, and a non-null flat `price` wins over the per-day entries. */
export type PackageMemberBody = {
  listing_id: number;
  price: number | null;
  quantity?: number;
  day_prices?: Record<string, number>;
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

/** Parse one JSON package-member entry, failing closed on anything malformed.
 * `price` is minor units: `null` (or absent) means no override, `0` means free
 * in the package, and a positive integer overrides the price. `quantity` is
 * optional and defaults to 1. */
/** Parse one member's optional `day_prices` object into a {@link DayPrices}
 * map, failing closed on anything malformed: keys must be positive whole day
 * counts and values non-negative integer minor units. `undefined` when absent. */
const parseMemberDayPrices = (
  raw: unknown,
): ItemResult<DayPrices | undefined> => {
  if (raw === undefined) return { value: undefined };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "package_members day_prices must be an object" };
  }
  const dayPrices: DayPrices = {};
  for (const [key, value] of Object.entries(raw)) {
    const days = Number(key);
    if (!/^\d+$/.test(key) || !Number.isInteger(days) || days < 1) {
      return {
        error: "package_members day_prices keys must be positive day counts",
      };
    }
    if (!Number.isInteger(value) || (value as number) < 0) {
      return {
        error:
          "package_members day_prices values must be non-negative integers",
      };
    }
    dayPrices[days] = value as number;
  }
  return { value: dayPrices };
};

const parsePackageMember = (item: unknown): ItemResult<PackageMemberInput> => {
  if (typeof item !== "object" || item === null) {
    return { error: "package_members entries must be objects" };
  }
  const {
    day_prices,
    listing_id,
    price = null,
    quantity = 1,
  } = item as Record<string, unknown>;
  if (!Number.isInteger(listing_id) || (listing_id as number) <= 0) {
    return { error: "package_members listing_id must be a positive integer" };
  }
  if (price !== null && (!Number.isInteger(price) || (price as number) < 0)) {
    return {
      error: "package_members price must be a non-negative integer or null",
    };
  }
  if (!Number.isInteger(quantity) || (quantity as number) < 1) {
    return { error: "package_members quantity must be a positive integer" };
  }
  const dayPrices = parseMemberDayPrices(day_prices);
  if ("error" in dayPrices) return dayPrices;
  return {
    value: {
      dayPrices: dayPrices.value ?? {},
      listingId: listing_id as number,
      price: price as number | null,
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
 * Persist package overrides in the group write's transaction, with
 * partial-update semantics: clearing the group's package flag clears all
 * overrides; absent `package_members` leaves existing rows untouched; otherwise
 * the rows are set.
 */
const writePackageMembers = async (
  tx: TxScope,
  id: number,
  input: GroupInput,
): Promise<void> => {
  if (input.isPackage === false) {
    await setGroupPackageMembers(id, [], tx);
    return;
  }
  if (input.packageMembers === undefined) return;
  await setGroupPackageMembers(id, input.packageMembers, tx);
};

/** Map a stored membership row (plus any per-day overrides) to the JSON
 * `package_members` entry shape clients PUT, so list and single-row hydration
 * serialize members identically and the configuration round-trips losslessly.
 * `day_prices` is only present when overrides exist. */
const toMember = (
  m: GroupListing,
  dayPrices: ReadonlyMap<number, number> | undefined,
): PackageMemberBody => ({
  listing_id: m.listing_id,
  price: m.package_price,
  quantity: m.quantity,
  ...(dayPrices && dayPrices.size > 0
    ? {
        day_prices: Object.fromEntries(
          [...dayPrices].map(([days, price]) => [String(days), price]),
        ),
      }
    : {}),
});

export const groupApiRoutes = defineCrudApi<Group, GroupInput>({
  afterWrite: writePackageMembers,
  getAll: getAllGroups,
  // Hydrate a package group's member overrides onto every response so an API
  // client can read back the listing_id/price/quantity values it PUT and
  // round-trip the configuration. Non-package groups carry no members.
  // get/create/update hydrate the single written group; the list endpoint uses
  // the batched hydrateList below (one query for every package group).
  hydrate: async (row) => {
    if (!row.is_package) return {};
    const [rows, dayPrices] = await Promise.all([
      getGroupPackagePrices(row.id),
      getGroupDayPrices(row.id),
    ]);
    return {
      package_members: rows.map((m) =>
        toMember(m, dayPrices.get(m.listing_id)),
      ),
    };
  },
  // Only package groups appear in the map; non-package groups are absent, so the
  // CRUD list builder hydrates them to no extra fields.
  hydrateList: async (rows) => {
    const packageGroups = rows.filter((row) => row.is_package);
    const groupIds = packageGroups.map((row) => row.id);
    const [byGroup, dayPricesByGroup] = await Promise.all([
      getGroupPackagePricesByGroupIds(groupIds),
      getGroupDayPricesByGroupIds(groupIds),
    ]);
    return new Map(
      packageGroups.map((row) => [
        row.id,
        {
          package_members: (byGroup.get(row.id) ?? []).map((m) =>
            toMember(m, dayPricesByGroup.get(row.id)?.get(m.listing_id)),
          ),
        },
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
        description: bodyString(body, "description", ""),
        hidden: bodyBoolean(body, "hidden", false),
        hidePackageListings: bodyBoolean(body, "hide_package_listings", false),
        isPackage: bodyBoolean(body, "is_package", false),
        maxAttendees: bodyNumber(body, "max_attendees", 0),
        name,
        slug,
        slugIndex,
        termsAndConditions: bodyString(body, "terms_and_conditions", ""),
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
        description: bodyString(body, "description", existing.description),
        hidden: bodyBoolean(body, "hidden", existing.hidden),
        hidePackageListings: bodyBoolean(
          body,
          "hide_package_listings",
          existing.hide_package_listings,
        ),
        isPackage: bodyBoolean(body, "is_package", existing.is_package),
        maxAttendees: bodyNumber(body, "max_attendees", existing.max_attendees),
        name: parsed.name,
        packageMembers: members.input,
        slug,
        slugIndex,
        termsAndConditions: bodyString(
          body,
          "terms_and_conditions",
          existing.terms_and_conditions,
        ),
      },
      ok: true,
    };
  },
  validate: validateGroupWithPackage,
});

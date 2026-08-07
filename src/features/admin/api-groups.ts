/**
 * Admin JSON API routes for groups — accessible via API key or cookie+CSRF.
 */

import { isNotNullish, requiredMapValue } from "#fp";
import {
  deleteGroup,
  soldHiddenPackageError,
  validateGroupWithPackage,
} from "#routes/admin/groups.ts";
import {
  type CatalogApiBody,
  isValidCatalogApiValue,
  projectCatalogFields,
} from "#shared/catalog-fields/definition.ts";
import {
  type GroupInput,
  groupCatalogFields,
  type PackageMemberInput,
} from "#shared/catalog-fields/fields.ts";
import { writePackageMembersTx } from "#shared/db/groups/membership.ts";
import {
  computeGroupSlugIndex,
  generateUniqueGroupSlug,
  groups,
  loadPackageMemberPricingByGroupIds,
} from "#shared/db/groups.ts";
import { defineCrudApi } from "#shared/rest/crud-api.ts";
import {
  type DeleteBody,
  parseOptionalArray,
  parseUpdateName,
  parseUpdateSlug,
  requireStrings,
} from "#shared/rest/crud-parsers.ts";
import {
  errorResult,
  okResult,
  parseOptionalResult,
  type Result,
} from "#shared/result.ts";
import { normalizeSlug } from "#shared/slug.ts";
import {
  buildDayPrices,
  type DayPrices,
  type Group,
  type GroupListing,
} from "#shared/types.ts";

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
  package_members?: PackageMemberBody[];
} & CatalogApiBody<typeof groupCatalogFields>;

/** JSON body accepted by PUT /api/admin/groups/:groupId */
export type UpdateGroupBody = Partial<CreateGroupBody> & { slug?: string };

/** JSON body accepted by DELETE /api/admin/groups/:groupId */
export type DeleteGroupBody = DeleteBody;

/** Parse one JSON package-member entry, failing closed on anything malformed.
 * `price` is minor units: `null` (or absent) means no override, `0` means free
 * in the package, and a positive integer overrides the price. `quantity` is
 * optional and defaults to 1. */
/** Parse one member's optional `day_prices` object into a {@link DayPrices}
 * map, failing closed on anything malformed: keys must be positive whole day
 * counts and values non-negative integer minor units. `undefined` when absent. */
const parseMemberDayPrices = (raw: unknown): Result<DayPrices | undefined> =>
  parseOptionalResult(raw, (value) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return errorResult("package_members day_prices must be an object");
    }
    const dayPrices = buildDayPrices(value, (key, price) => {
      const days = Number(key);
      if (!/^\d+$/.test(key) || !Number.isInteger(days) || days < 1) {
        return "package_members day_prices keys must be positive day counts";
      }
      if (!Number.isInteger(price) || (price as number) < 0) {
        return "package_members day_prices values must be non-negative integers";
      }
      return { days, price: price as number };
    });
    return typeof dayPrices === "string"
      ? errorResult(dayPrices)
      : okResult(dayPrices);
  });

const parsePackageMember = (item: unknown): Result<PackageMemberInput> => {
  if (typeof item !== "object" || item === null) {
    return errorResult("package_members entries must be objects");
  }
  const {
    day_prices,
    listing_id,
    price = null,
    quantity = 1,
  } = item as Record<string, unknown>;
  if (!Number.isInteger(listing_id) || (listing_id as number) <= 0) {
    return errorResult("package_members listing_id must be a positive integer");
  }
  if (price !== null && (!Number.isInteger(price) || (price as number) < 0)) {
    return errorResult(
      "package_members price must be a non-negative integer or null",
    );
  }
  if (!Number.isInteger(quantity) || (quantity as number) < 1) {
    return errorResult("package_members quantity must be a positive integer");
  }
  const dayPrices = parseMemberDayPrices(day_prices);
  if (!dayPrices.ok) return dayPrices;
  return okResult({
    dayPrices: dayPrices.value ?? {},
    listingId: listing_id as number,
    price: price as number | null,
    quantity: quantity as number,
  });
};

/**
 * Parse the optional `package_members` array from a JSON body. `undefined` when
 * the key is absent (partial update: leave existing overrides untouched); an
 * empty array clears them. Fails closed (see {@link parseOptionalArray}): any
 * malformed entry rejects the whole request rather than being dropped.
 */
const parsePackageMembers = (
  body: Record<string, unknown>,
): Result<PackageMemberInput[] | undefined> =>
  parseOptionalArray(
    body.package_members,
    "package_members",
    parsePackageMember,
  );

/**
 * Persist package overrides in the group write's transaction, with
 * partial-update semantics: clearing the group's package flag clears all
 * overrides; absent `package_members` leaves existing rows untouched; otherwise
 * the rows are set. Rechecks the sold-hidden invariant when un-packaging so a
 * checkout that committed between the request-level check and this write rolls
 * the change back rather than revealing concealed member names.
 */

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

const toGroupInput = async (
  body: Record<string, unknown>,
  existing: Group | null,
): Promise<Result<GroupInput>> => {
  const name = existing
    ? parseUpdateName(body, existing.name)
    : requireStrings(body, ["name"]);
  if (!name.ok) return name;
  const invalid = Object.values(groupCatalogFields).find((field) => {
    const value = body[field[0]];
    return (
      (Number(field[3]) & 1) !== 0 &&
      isNotNullish(value) &&
      !isValidCatalogApiValue(field, value)
    );
  });
  if (invalid) return errorResult(`${invalid[0]} has an invalid value`);
  const fields = projectCatalogFields(groupCatalogFields, "api", body);

  const members = parsePackageMembers(body);
  if (!members.ok) return members;
  if (!existing && members.value !== undefined) {
    return errorResult(
      "package_members cannot be set on create; create the group, assign listings, then update it",
    );
  }

  const slug = existing
    ? await parseUpdateSlug(
        body,
        existing.slug,
        normalizeSlug,
        computeGroupSlugIndex,
      )
    : await generateUniqueGroupSlug();
  return okResult({
    ...(existing
      ? projectCatalogFields(groupCatalogFields, "storedApi", existing)
      : {}),
    ...fields,
    ...slug,
    maxAttendees: fields.maxAttendees ?? existing?.max_attendees ?? 0,
    name: typeof name.value === "string" ? name.value : name.value.name,
    packageMembers: members.value,
  });
};

export const groupApiRoutes = defineCrudApi<Group, GroupInput>({
  afterWrite: (tx, id, input, existing) =>
    writePackageMembersTx(
      tx,
      id,
      existing,
      input,
      input.isPackage === false ? [] : input.packageMembers,
    ),
  getAll: () => groups.cache.getAll(),
  // Only package groups appear in the map; non-package groups hydrate to no
  // extra fields. Single-row responses use this same batch path with one row.
  hydrate: async (rows) => {
    const packageGroups = rows.filter((row) => row.is_package);
    const pricingByGroup = await loadPackageMemberPricingByGroupIds(
      packageGroups.map((row) => row.id),
    );
    return new Map(
      packageGroups.map((row) => {
        const pricing = requiredMapValue(
          pricingByGroup,
          row.id,
          "Missing package pricing",
        );
        return [
          row.id,
          {
            package_members: pricing.rows.map((member) =>
              toMember(member, pricing.dayPrices.get(member.listing_id)),
            ),
          },
        ];
      }),
    );
  },
  name: "groups",
  nameField: "name",
  onDelete: deleteGroup,
  singular: "Group",
  stripKeys: ["slug_index"],
  table: groups.table,

  toCreateInput: (body) => toGroupInput(body, null),
  toUpdateInput: toGroupInput,
  validate: validateGroupWithPackage,
  validateDelete: soldHiddenPackageError,
});

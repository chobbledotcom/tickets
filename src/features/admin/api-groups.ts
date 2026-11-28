/**
 * Admin JSON API routes for groups — accessible via API key or cookie+CSRF.
 */

import { hmacHash } from "#crypto/hashing.ts";
import type { PackageFlags } from "#db/groups/membership/package-writes.ts";
import {
  generateUniqueGroupSlug,
  loadPackageMemberPricingByGroupIds,
} from "#db/groups.ts";
import { requiredMapValue } from "#fp";
import type { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import { packageGroups } from "#shared/package-membership.ts";
import type {
  CreateGroupBody,
  PackageMemberBody,
  UpdateGroupBody,
} from "#shared/records/group-body.ts";
import {
  GROUP_FIELDS,
  type GroupInput,
  type PackageMemberInput,
} from "#shared/records/group-fields.ts";
import { groupRecord } from "#shared/records/groups.ts";
import { parseUpdateSlug } from "#shared/rest/crud-parsers.ts";
import { readOpenBody } from "#shared/rest/field-reads.ts";
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { recordApi } from "#shared/rest/record-api.ts";
import { errorResult, okResult, type Result } from "#shared/result.ts";
import { normalizeSlug } from "#shared/slug.ts";
import type { Group, GroupListing } from "#types";

// DELETE /api/admin/groups/:groupId takes the shared DeleteBody the
// crud-parsers module exports.

/** Map one validated member body to the group input shape. The schema checked
 *  every value, so this only renames the keys and the day-price map keys.
 *  Absent values take the same defaults as the stored columns. */
const toPackageMemberInput = (
  member: PackageMemberBody,
): PackageMemberInput => {
  // A day-price key arrives as JSON text. The table holds a day count.
  const dayPrices: Record<number, number> = {};
  for (const [days, price] of Object.entries(member.day_prices ?? {})) {
    dayPrices[Number(days)] = price;
  }
  return {
    dayPrices,
    listingId: member.listing_id,
    price: member.price ?? null,
    quantity: member.quantity ?? 1,
  };
};

/**
 * Persist package overrides in the group write's transaction, with
 * partial-update semantics. Clearing the group's package flag clears all
 * overrides. Absent `package_members` leaves existing rows untouched.
 * Otherwise the rows are set. Rechecks the sold-hidden invariant when
 * un-packaging. A checkout that committed between the request-level check and
 * this write then rolls the change back, rather than revealing concealed
 * member names.
 */

/** Map a stored membership row (plus any per-day overrides) to the JSON
 * `package_members` entry shape clients PUT. List and single-row hydration
 * then serialize members identically, and the configuration round-trips
 * losslessly. `day_prices` is only present when overrides exist. */
const toMember = (
  m: GroupListing,
  dayPrices: ReadonlyMap<number, number> | undefined,
): PackageMemberBody => ({
  listing_id: m.listingId,
  price: m.packagePrice,
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
  body: CreateGroupBody | UpdateGroupBody,
  existing: Group | null,
): Promise<Result<GroupInput>> => {
  const fields = readOpenBody(GROUP_FIELDS, body, existing);
  if (!fields.ok) return fields;

  // The body schema checked every member, and an absent list leaves the
  // stored overrides alone. An empty list clears them.
  const members = body.package_members?.map(toPackageMemberInput);
  if (!existing && members !== undefined) {
    return errorResult(
      "package_members cannot be set on create; create the group, assign listings, then update it",
    );
  }

  const slug = existing
    ? await parseUpdateSlug(body, existing.slug, normalizeSlug, hmacHash)
    : await generateUniqueGroupSlug();
  return okResult({
    ...fields.value,
    ...slug,
    packageMembers: members,
  });
};

export const groupApiRoutes = recordApi<
  typeof ADMIN_API_RESOURCES.groups,
  RecordShapeOf<Group, GroupInput, Group, PackageFlags | null>
>(groupRecord, {
  // Only package groups appear in the map. Non-package groups hydrate to no
  // extra fields. Single-row responses use this same batch path with one row.
  hydrate: async (rows) => {
    const pkgGroups = packageGroups(rows);
    const pricingByGroup = await loadPackageMemberPricingByGroupIds(
      pkgGroups.map((row) => row.id),
    );
    return new Map(
      pkgGroups.map((row) => {
        const pricing = requiredMapValue(pricingByGroup, row.id);
        return [
          row.id,
          {
            package_members: pricing.rows.map((member) =>
              toMember(member, pricing.dayPrices.get(member.listingId)),
            ),
          },
        ];
      }),
    );
  },
  stripKeys: ["slug_index"],
  toCreateInput: (body) => toGroupInput(body, null),
  toUpdateInput: toGroupInput,
});

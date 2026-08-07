/**
 * Groups table operations
 */

/* jscpd:ignore-start */
import * as v from "valibot";
import {
  flatMap,
  identity,
  mapById,
  mapNotNullish,
  mapParallel,
  requiredMapValue,
} from "#fp";
import { projectCatalogFields } from "#shared/catalog-fields/definition.ts";
import {
  type GroupInput,
  groupCatalogFields,
  type PackageMemberInput,
} from "#shared/catalog-fields/fields.ts";
import { decrypt, encrypt } from "#shared/crypto/encryption.ts";
import { hmacHash } from "#shared/crypto/hashing.ts";
import type { BlindIndex } from "#shared/crypto/sealed.ts";
import {
  execute,
  executeBatch,
  inPlaceholders,
  queryAll,
  rowExists,
  type SqlStatement,
  TransactionValidationError,
  type TxScope,
} from "#shared/db/client.ts";
import {
  cachedEntityTable,
  encryptedNameSchema,
  idAndEncryptedSlugSchema,
} from "#shared/db/common-schema.ts";
import { defineIdTable } from "#shared/db/define-id-table.ts";
import { validateListingGroupMembershipTx } from "#shared/db/groups/membership.ts";
import { linkTableSide } from "#shared/db/link-table.ts";
import { listingChildren, listingParents } from "#shared/db/listing-parents.ts";
import {
  getGroupDayPricesByGroupIds,
  groupDayPriceStatements,
  groupFlatPriceStatements,
  PRICE_TYPE_GROUP,
  PRICE_TYPE_GROUP_DAY,
  removeListingGroupPricesStatement,
} from "#shared/db/listing-prices.ts";
import { decryptListingWithCount } from "#shared/db/listings/records.ts";
import {
  type ListingRecordRow,
  listingReader,
} from "#shared/db/listings/select.ts";
import { envNameSource, rowsByIds } from "#shared/db/query.ts";
import { isSlugTakenAnywhere } from "#shared/db/slug-registry.ts";
import { equals, inList } from "#shared/db/where-clauses.ts";
import { packageMemberError } from "#shared/package-membership.ts";
import { generateUniqueSlug, type SlugWithIndex } from "#shared/slug.ts";
import type { Group, GroupListing, ListingWithCount } from "#shared/types.ts";
import { defineStoredJson } from "#shared/validation/stored-json.ts";

/* jscpd:ignore-end */

/** Groups are few, so the cache loads the whole set and answers by-id / by-slug
 * reads from it — same isolate-level TTL as the listings cache. */
const GROUPS_CACHE_TTL_MS = 30_000;
const groupIdsJson = defineStoredJson(
  v.array(v.pipe(v.number(), v.safeInteger(), v.minValue(1))),
);

/** Compute slug index from slug for blind index lookup */
export const computeGroupSlugIndex = (slug: string): Promise<BlindIndex> =>
  hmacHash(slug);

/** Raw groups table with CRUD operations */
const rawGroupsTable = defineIdTable<Group, GroupInput>("groups", {
  ...encryptedNameSchema(encrypt, decrypt),
  ...idAndEncryptedSlugSchema(encrypt, decrypt),
  ...projectCatalogFields(groupCatalogFields, "columns", {}),
});

const packageDisplayColumns = rawGroupsTable.read.pick([
  "id",
  "hide_package_listings",
  "name",
]);

/** Execute a query and decrypt the resulting group rows */
export const groups = cachedEntityTable<Group, GroupInput>(
  "groups",
  rawGroupsTable,
  {
    fetchAll: () => rawGroupsTable.read.many({}, { order: "id ASC" }),
    idOf: (g) => g.id,
    keyOf: (g) => g.slug_index,
    ttlMs: GROUPS_CACHE_TTL_MS,
  },
);

/** The listing ids in a group, and the reverse listing-to-groups side. */
export const groupListings = linkTableSide(
  "group_listings",
  "group_id",
  "listing_id",
);
export const listingGroups = {
  ...linkTableSide("group_listings", "listing_id", "group_id"),
  /** Read one of this side's guaranteed batch entries. */
  idsFor: (
    idsByListing: ReadonlyMap<number, number[]>,
    listingId: number,
  ): number[] =>
    requiredMapValue(
      idsByListing,
      listingId,
      "Missing listing group membership",
    ),
};

/** Every group keyed by id, from the request-cached set — the batched
 * alternative to one read per id when resolving or validating many groups
 * without tripping the N+1 read guard. */
export const getGroupsById = async (): Promise<Map<number, Group>> =>
  mapById(identity<Group>)(await groups.cache.getAll());

/** Narrow id → name map for every group (selects + decrypts only the name), for
 * pickers/labels that must not load the whole groups cache. */
export const getAllGroupNames = (): Promise<Map<number, string>> =>
  envNameSource("groups", "groupRecord").all();

/** Groups by id in one query, read straight from the table: a group about to be
 * shown, edited or acted on must be the stored row, not a cached copy that
 * another edge may already have changed. An id with no row is simply absent
 * from the map. */
export const getGroupsByIds = async (
  ids: readonly number[],
): Promise<Map<number, Group>> =>
  ids.length === 0
    ? new Map()
    : mapById(identity<Group>)(
        await rawGroupsTable.read.many(
          {},
          { where: inList("id", [...new Set(ids)]) },
        ),
      );

/** One stored group, through the shared many-group read. Null when no group has
 * that id. */
export const getGroupById = async (id: number): Promise<Group | null> =>
  (await getGroupsByIds([id])).get(id) ?? null;

/**
 * Get a single group by slug_index (from cache)
 */
export const getGroupBySlugIndex = (slugIndex: string): Promise<Group | null> =>
  groups.cache.getByKey(slugIndex);

/**
 * Check if a group slug is already in use.
 * Checks both listings and groups for cross-table uniqueness.
 */
export const isGroupSlugTaken = (
  slug: string,
  excludeGroupId?: number,
): Promise<boolean> =>
  isSlugTakenAnywhere(
    slug,
    excludeGroupId ? { id: excludeGroupId, table: "groups" } : undefined,
  );

/** Generate a unique group slug, retrying on collision. */
export const generateUniqueGroupSlug = (): Promise<SlugWithIndex<BlindIndex>> =>
  generateUniqueSlug(computeGroupSlugIndex, isGroupSlugTaken);

/**
 * Members of SEVERAL groups at once, keyed by group id — the batched form of the
 * single-group loaders for a multi-group surface. A page with many group leaves
 * would otherwise run one member query per group; this loads the join once and
 * the member listings once, then assembles each group's list in memory. Every
 * requested group id maps to an entry (empty when it has no matching member).
 * `activeOnly` keeps just active members (the site-page nav's liveness gate); the
 * default includes inactive members (the validators' group-compatibility read
 * for a listing that joins many groups, kept batched to stay under the N+1
 * guard).
 */
export const getListingsByGroupIds = async (
  groupIds: readonly number[],
  activeOnly = false,
): Promise<Map<number, ListingWithCount[]>> => {
  if (groupIds.length === 0) return new Map();
  type GroupListingRow = ListingRecordRow & { group_ids: string };
  type ListingGroups = { groupIds: number[]; member: ListingWithCount };
  const { sql, args } = listingReader.statement({
    order: "created_desc",
    where: { activeOnly, inGroups: [...groupIds] },
  });
  const rows = await queryAll<GroupListingRow>(sql, args);
  const listingsWithGroups: ListingGroups[] = await mapParallel(
    async (row: GroupListingRow): Promise<ListingGroups> => ({
      groupIds: groupIdsJson.read(
        row.group_ids,
        `group_listings.group_ids for listing ${row.id}`,
      ),
      member: await decryptListingWithCount(row),
    }),
  )(rows);
  const entries: Array<readonly [number, ListingWithCount]> = flatMap(
    ({ groupIds, member }: ListingGroups) =>
      groupIds.map((groupId) => [groupId, member] as const),
  )(listingsWithGroups);
  const entriesByGroup = Map.groupBy(entries, ([groupId]) => groupId);
  return new Map(
    groupIds.map((groupId) => [
      groupId,
      (entriesByGroup.get(groupId) ?? []).map(([, member]) => member),
    ]),
  );
};

/** Read several groups' members together with one more thing about the SAME
 * groups — their prices, their full membership, whatever the caller needs — in
 * one round of reads. A page hydrating many packages would otherwise pay a pair
 * of reads per package and eat the request's subrequest budget. `activeOnly`
 * has the meaning {@link getListingsByGroupIds} gives it, and is spelled out at
 * every call site — whether inactive members count is the caller's decision,
 * never a default. */
export const readGroupMembersWith = async <Extra>(
  groupList: readonly Group[],
  readMore: (groupIds: number[]) => Promise<Extra>,
  activeOnly: boolean,
): Promise<{ members: Map<number, ListingWithCount[]>; more: Extra }> => {
  const groupIds = groupList.map((group) => group.id);
  const [members, more] = await Promise.all([
    getListingsByGroupIds(groupIds, activeOnly),
    readMore(groupIds),
  ]);
  return { members, more };
};

/** One group's entry from the shared one-or-many membership query. */
type LoadGroupListings = (groupId: number) => Promise<ListingWithCount[]>;

const listingsInGroup =
  (activeOnly: boolean) =>
  async (groupId: number): Promise<ListingWithCount[]> =>
    requiredMapValue(
      await getListingsByGroupIds([groupId], activeOnly),
      groupId,
      "Missing group listing membership",
    );

export const getActiveListingsByGroupId: LoadGroupListings =
  listingsInGroup(true);

/** Does a group row exist? The add-item revalidation's single-row check — no
 * name decryption, never the whole table. */
export const groupExists = (id: number): Promise<boolean> =>
  rowExists("SELECT 1 FROM groups WHERE id = ? LIMIT 1", [id]);

/**
 * Get all listings in a group with attendee counts (including inactive).
 */
export const getListingsByGroupId: LoadGroupListings = listingsInGroup(false);

/** Whether any of the given group ids satisfies the extra SQL `condition`.
 * Empty input → false (no query). */
const anyGroupMatching = async (
  groupIds: readonly number[],
  condition: string,
): Promise<boolean> => {
  if (groupIds.length === 0) return false;
  return rowExists(
    `SELECT 1 FROM groups WHERE id IN (${inPlaceholders(
      groupIds,
    )}) AND ${condition} LIMIT 1`,
    [...groupIds],
  );
};

/** Whether any of the given group ids names a HIDDEN package group
 * (`hide_package_listings`). A hidden package collapses its members to the
 * package name on every buyer surface, so a member there can never gate its own
 * add-on children — the selector would name them. */
export const anyHiddenPackageGroup = (
  groupIds: readonly number[],
): Promise<boolean> =>
  anyGroupMatching(groupIds, "is_package = 1 AND hide_package_listings = 1");

/** Whether any of the given listings is a member of a package group. Empty
 * input → false (no query). Used to keep a package member from being turned into
 * another listing's required child (a package page can't render child edges). */
export const anyListingInPackageGroup = async (
  listingIds: readonly number[],
): Promise<boolean> => {
  if (listingIds.length === 0) return false;
  return rowExists(
    `SELECT 1
       FROM group_listings AS groupListing
       JOIN groups AS groupRow ON groupRow.id = groupListing.group_id
      WHERE groupListing.listing_id IN (${inPlaceholders(listingIds)})
        AND groupRow.is_package = 1
      LIMIT 1`,
    [...listingIds],
  );
};

/** Of the given listing ids, those that belong to a HIDDEN package — a package
 * group (`is_package = 1`) with `hide_package_listings = 1`. Buyers must never
 * meet these members standalone: the package name is the only public surface,
 * so every buyer-facing discovery/direct path drops them. */
export const getHiddenPackageMemberIds = async (
  listingIds: readonly number[],
): Promise<Set<number>> => {
  if (listingIds.length === 0) return new Set();
  const rows = await queryAll<{ listing_id: number }>(
    `SELECT DISTINCT groupListing.listing_id
       FROM group_listings AS groupListing
       JOIN groups AS groupRow ON groupRow.id = groupListing.group_id
      WHERE groupListing.listing_id IN (${inPlaceholders(listingIds)})
        AND groupRow.is_package = 1
        AND groupRow.hide_package_listings = 1`,
    [...listingIds],
  );
  return new Set(rows.map((r) => r.listing_id));
};

/** Whether a single listing is a HIDDEN package's member — the one-listing form
 * of `getHiddenPackageMemberIds`, for the buyer-facing guards (API lookup, QR
 * booking, standalone-page test) that ask this of one listing at a time. */
export const isHiddenPackageMember = async (
  listingId: number,
): Promise<boolean> => (await getHiddenPackageMemberIds([listingId])).size > 0;

/** The member-naming package error for the first listing in `listings` that
 * can't be a package member (pay-what-you-want, an add-on of another listing,
 * or — on a hidden package — a member gating its own children), or null when
 * every listing is a valid member. Judged against ONE batched edge load (two
 * queries for the whole member list, never one per member); the rules and
 * their messages live in the shared {@link packageMemberError}. The one place
 * every package save (group form, add-listings, listing form/API, catalog
 * import) turns an unpackageable member into its user-facing message. */
export const packageMembersError = async (
  listings: readonly { id: number; can_pay_more: boolean; name: string }[],
  hideListings: boolean | undefined,
): Promise<string | null> => {
  const listingIds = listings.map((listing) => listing.id);
  const [childrenByParent, parentsByChild] = await Promise.all([
    listingChildren.getIdsByKeys(listingIds),
    listingParents.getIdsByKeys(listingIds),
  ]);
  const blocked = mapNotNullish((listing: (typeof listings)[number]) =>
    packageMemberError(
      listing,
      {
        childIds: requiredMapValue(
          childrenByParent,
          listing.id,
          "Missing listing child edges",
        ),
        parentIds: requiredMapValue(
          parentsByChild,
          listing.id,
          "Missing listing parent edges",
        ),
      },
      hideListings,
    ),
  )(listings);
  return blocked[0] ?? null;
};

/** Package-group display info for grouping a booking's lines under the package
 * name on tickets/emails. */
export type PackageDisplay = { name: string; hideListings: boolean };

/** Whether any booking row is stamped with this package's group id — sold
 * tickets whose display (and hidden-member concealment) resolves through the
 * live package row. Refund placeholders (quantity 0) don't count. */
export const hasPackageBookings = (groupId: number): Promise<boolean> =>
  rowExists(
    `SELECT 1 FROM listing_attendees
      WHERE package_group_id = ? AND quantity > 0 LIMIT 1`,
    [groupId],
  );

/** The package displays for a set of (possibly repeated or zero)
 * `package_group_id`s — only ids naming a live package appear in the map. Lets
 * the ticket view collapse each token's package rows into one card per package,
 * so an attendee holding both a package booking and a standalone one (e.g. after
 * an attendee merge) doesn't fall back to per-row cards that leak a hidden member.
 * Groups are resolved together from their shared cache. */
export const getPackageDisplaysByIds = async (
  groupIds: readonly number[],
): Promise<Map<number, PackageDisplay>> => {
  const packageGroups = await packageDisplayColumns.many(
    {},
    {
      alias: "groupRecord",
      where: [
        ...inList(
          "groupRecord.id",
          [...new Set(groupIds)].filter((groupId) => groupId > 0),
        ),
        ...equals("groupRecord.is_package", 1),
      ],
    },
  );
  return new Map(
    packageGroups.map((group) => [
      group.id,
      {
        hideListings: group.hide_package_listings,
        name: group.name,
      },
    ]),
  );
};

/** The package displays behind a set of booked rows — each row's attendee names
 * its persisted `package_group_id` (0 on a plain row, matching no package).
 * Shared by the ticket view, the wallet lookup, and the email renderer, which
 * all carry `{ attendee, listing }` row shapes. */
export const packageDisplaysForRows = (
  rows: ReadonlyArray<{ attendee: { package_group_id: number } }>,
): Promise<Map<number, PackageDisplay>> =>
  getPackageDisplaysByIds(rows.map((row) => row.attendee.package_group_id));

/** One group_listings row for a DUPLICATED group, resolving both the new group
 * and the cloned listing by the slug_index each was just inserted with, so the
 * whole clone (group + listings + memberships) runs as one batch — one
 * round-trip, atomic, and clear of the interactive-transaction round-trip guard.
 * Carries the source member's per-package `quantity`; the flat price override
 * lives in `listing_prices` and is copied separately (keyed to the new group). */
export const cloneGroupMembershipStatement = (member: {
  groupSlugIndex: string;
  listingSlugIndex: string;
  quantity: number;
}): SqlStatement => ({
  args: [member.groupSlugIndex, member.listingSlugIndex, member.quantity],
  sql: `INSERT INTO group_listings (group_id, listing_id, quantity)
        SELECT (SELECT id FROM groups WHERE slug_index = ?),
               (SELECT id FROM listings WHERE slug_index = ?), ?`,
});

/**
 * Replace a listing's full set of group memberships (the listing-form
 * checkboxes). Rows for groups that remain are left untouched so their per-package
 * `quantity` (and the listing's `group`/`group_day` price overrides in
 * `listing_prices`, keyed by listing + group) survive; only newly-ticked groups
 * are inserted and unticked ones removed.
 */
/** The DELETE/INSERT statements to move a listing from its `current` group set to
 * the `desired` one, preserving the membership rows (and their `listing_prices`
 * overrides) for groups in both. Shared by {@link setListingGroups} (its own
 * batch) and {@link setListingGroupsTx} (on a caller's transaction) so they can't
 * drift. */
const listingGroupDiffStatements = (
  listingId: number,
  current: Set<number>,
  desired: Set<number>,
) => {
  const toRemove = [...current].filter((id) => !desired.has(id));
  const toAdd = [...desired].filter((id) => !current.has(id));
  const statements: SqlStatement[] = [];
  // Set-based DELETEs + multi-row INSERT — at most three statements regardless of
  // how many groups change, so the transactional path (setListingGroupsTx) stays
  // well under the interactive round-trip guard even for a large group selection.
  if (toRemove.length > 0) {
    statements.push({
      args: [listingId, ...toRemove],
      sql: `DELETE FROM group_listings WHERE listing_id = ? AND group_id IN (${inPlaceholders(
        toRemove,
      )})`,
    });
    // Drop the listing's package price overrides for the groups it is leaving —
    // they live in listing_prices, not on the membership row, so they'd otherwise
    // outlive the removal and resurrect on a re-add. Non-null: toRemove is
    // non-empty inside this branch.
    statements.push(removeListingGroupPricesStatement(listingId, toRemove)!);
  }
  if (toAdd.length > 0) {
    statements.push({
      args: toAdd.flatMap((groupId) => [groupId, listingId]),
      sql: `INSERT OR IGNORE INTO group_listings (group_id, listing_id) VALUES ${toAdd
        .map(() => "(?, ?)")
        .join(", ")}`,
    });
  }
  return statements;
};

/** Read the listing's current group set via `readCurrent`, diff it against the
 * wanted `groupIds`, and hand the change statements to `run` — the shared core
 * of the batch and transactional variants, so they can't drift. */
const applyListingGroupDiff = async (
  listingId: number,
  groupIds: number[],
  readCurrent: () => Promise<Set<number>>,
  run: (statements: SqlStatement[]) => Promise<void>,
): Promise<void> => {
  const statements = listingGroupDiffStatements(
    listingId,
    await readCurrent(),
    new Set(groupIds),
  );
  if (statements.length > 0) await run(statements);
};

/** Replace a listing's whole group set (the listing-form checkboxes). */
type SetListingGroups = (
  listingId: number,
  groupIds: number[],
) => Promise<void>;

export const setListingGroups: SetListingGroups = (listingId, groupIds) =>
  applyListingGroupDiff(
    listingId,
    groupIds,
    async () => new Set(await listingGroups.getIds(listingId)),
    executeBatch,
  );

/** Replace a listing's group memberships inside an existing write transaction,
 * so the change commits atomically with the listing row write (the admin API
 * create/update path). Mirrors {@link setListingGroups} but reads the current
 * set and runs each statement on the caller's `tx`. */
export const setListingGroupsTx = async (
  tx: TxScope,
  listingId: number,
  groupIds: number[],
  hasChildren?: boolean,
): Promise<void> => {
  const validation = await validateListingGroupMembershipTx(tx)(
    listingId,
    groupIds,
    hasChildren,
  );
  if (validation.listingMissing) return;
  if (validation.error) throw new TransactionValidationError(validation.error);
  await applyListingGroupDiff(
    listingId,
    groupIds,
    async () => new Set(await listingGroups.getIdsTx(tx, listingId)),
    async (statements) => {
      for (const stmt of statements) await tx.execute(stmt);
    },
  );
};

/**
 * Remove every listing from a group (used when the group is deleted), along with
 * the group's package price overrides — its flat `group` and per-day `group_day`
 * price rows key on the group id, so they'd otherwise outlive the deletion.
 */
export const resetGroupListings = async (groupId: number): Promise<void> => {
  await groupListings.clear(groupId);
  for (const stmt of [
    ...groupFlatPriceStatements(groupId, []),
    ...groupDayPriceStatements(groupId, []),
  ]) {
    await execute(stmt.sql, stmt.args);
  }
};

/** Correlated subquery projecting a membership row's flat package override from
 * the `group` dimension of `listing_prices` (the source of truth since the
 * `group_listings.package_price` column was retired). NULL when the member has no
 * override — exactly the old NULLable column's "charge the listing's own price".
 * `groupIdExpr` is the outer group id column (a `groupListing` alias is assumed). */
const groupFlatPriceSubquery = (groupIdExpr: string): string =>
  `(SELECT listingPrice.unit_price FROM listing_prices AS listingPrice
      WHERE listingPrice.listing_id = groupListing.listing_id
        AND listingPrice.price_type = '${PRICE_TYPE_GROUP}'
        AND listingPrice.price_id = CAST(${groupIdExpr} AS TEXT)) AS package_price`;

/**
 * Every membership row for a group, carrying its `package_price` override and
 * per-package `quantity`. A `null` `package_price` means "no override — use the
 * listing's own price", `0` means explicitly free in this package, and a
 * positive value overrides the price; `quantity` defaults to 1. The override is
 * read from the `group` dimension of `listing_prices`; `quantity` from the
 * membership row.
 */
export const getGroupPackagePrices = async (
  groupId: number,
): Promise<GroupListing[]> =>
  // A single group is the batched read with one id — a group with no
  // membership rows is absent from the map, i.e. it has no member rows.
  (await getGroupPackagePricesByGroupIds([groupId])).get(groupId) ?? [];

/** A package group's member rows projected into the two maps every consumer
 * needs (the booking flow, the webhook revalidation, the bookability gate, and
 * the test harness): `prices` keeps only members with a real override — a
 * positive price OR an explicit free `0`, dropping a `null` "no override" — while
 * `quantities` covers every member (default 1). Owning both here keeps the "what
 * counts as an override" rule in one place; callers destructure what they use. */
export const packageMemberMaps = (
  rows: readonly GroupListing[],
): { prices: Map<number, number>; quantities: Map<number, number> } => ({
  prices: new Map(
    rows.flatMap((row) =>
      row.package_price === null
        ? []
        : [[row.listing_id, row.package_price] as const],
    ),
  ),
  quantities: new Map(rows.map((row) => [row.listing_id, row.quantity])),
});

/** What a package charges for its members: the flat override + quantity maps
 * ({@link packageMemberMaps}) and each customisable member's per-day overrides.
 * The shape the booking page, the webhook payload, and the payment
 * revalidation all price from. */
export interface PackagePrices {
  dayPrices: Map<number, Map<number, number>>;
  prices: Map<number, number>;
  quantities: Map<number, number>;
}

/** A package group's full pricing state: what it charges, plus the membership
 * rows those charges were read from (which listings are in the bundle). */
export interface PackageMemberPricing extends PackagePrices {
  rows: GroupListing[];
}

/** The full pricing state of SEVERAL package groups, keyed by group id, in two
 * reads however many groups are asked for — an order that books many packages
 * would otherwise spend two round-trips per package and eat the request's
 * subrequest budget. Every requested group is present; one with no membership
 * rows reads as empty maps. */
export const loadPackageMemberPricingByGroupIds = async (
  groupIds: number[],
): Promise<Map<number, PackageMemberPricing>> => {
  const [rowsByGroup, dayPricesByGroup] = await Promise.all([
    getGroupPackagePricesByGroupIds(groupIds),
    getGroupDayPricesByGroupIds(groupIds),
  ]);
  return new Map(
    groupIds.map((groupId) => {
      const rows = rowsByGroup.get(groupId) ?? [];
      return [
        groupId,
        {
          ...packageMemberMaps(rows),
          dayPrices: requiredMapValue(
            dayPricesByGroup,
            groupId,
            "Missing package day prices",
          ),
          rows,
        },
      ];
    }),
  );
};

/** The membership rows for several groups in one query, keyed by group id, so a
 * list endpoint can hydrate every group's package members without a per-group
 * round-trip. Groups with no membership rows are absent from the map. */
export const getGroupPackagePricesByGroupIds = async (
  groupIds: number[],
): Promise<Map<number, GroupListing[]>> =>
  Map.groupBy(
    await rowsByIds<GroupListing>(
      groupIds,
      (placeholders) =>
        `SELECT groupListing.group_id, groupListing.listing_id,
            ${groupFlatPriceSubquery("groupListing.group_id")},
            groupListing.quantity
       FROM group_listings AS groupListing
      WHERE groupListing.group_id IN (${placeholders})
   ORDER BY groupListing.listing_id ASC`,
    ),
    (row) => row.group_id,
  );

/** The statement that copies a source listing's per-package `quantity` onto a
 * freshly-duplicated listing's membership rows, for every package group they
 * share. Without this a duplicated package member would join with quantity 1,
 * silently changing the bundle's contents. The flat price override lives in
 * `listing_prices` and is copied by {@link copyPackageMemberOverridesTx}.
 * Regular (non-package) shared groups carry no override, so they are untouched. */
const copyPackageOverridesStatement = (
  sourceListingId: number,
  newListingId: number,
) => ({
  args: [sourceListingId, newListingId, sourceListingId],
  sql: `UPDATE group_listings AS cloneMembership
        SET quantity = (
              SELECT sourceMembership.quantity FROM group_listings AS sourceMembership
               WHERE sourceMembership.group_id = cloneMembership.group_id AND sourceMembership.listing_id = ?)
      WHERE cloneMembership.listing_id = ?
        AND cloneMembership.group_id IN (
              SELECT groupListing.group_id
                FROM group_listings AS groupListing
               WHERE groupListing.listing_id = ?)
        AND cloneMembership.group_id IN (SELECT id FROM groups WHERE is_package = 1)`,
});

/** Copy the source's package overrides onto the duplicate's membership rows in
 * the SAME transaction that inserted them (the create write's `afterWrite`), so a
 * failure rolls the whole duplicate back rather than leaving a live member at the
 * default price. The flat `group` and per-day `group_day` price rows are copied
 * only for package groups the NEW listing actually joined (the duplicate form may
 * untick some of the source's groups) — scoping each source row's encoded group
 * to the clone's `group_listings`, exactly as the quantity copy does. Otherwise a
 * copied override for a non-joined group would lurk invisibly and resurrect the
 * source's price if the clone were later added to that package. */
export const copyPackageMemberOverridesTx = async (
  tx: TxScope,
  sourceListingId: number,
  newListingId: number,
): Promise<void> => {
  await tx.execute(
    copyPackageOverridesStatement(sourceListingId, newListingId),
  );
  await tx.execute({
    args: [
      newListingId,
      sourceListingId,
      PRICE_TYPE_GROUP,
      PRICE_TYPE_GROUP_DAY,
      newListingId,
    ],
    sql: `INSERT INTO listing_prices (listing_id, price_type, price_id, unit_price)
          SELECT ?, sourcePrice.price_type, sourcePrice.price_id, sourcePrice.unit_price
            FROM listing_prices AS sourcePrice
           WHERE sourcePrice.listing_id = ? AND sourcePrice.price_type IN (?, ?)
             AND EXISTS (
               SELECT 1 FROM group_listings AS groupListing
                WHERE groupListing.listing_id = ?
                  AND ((sourcePrice.price_type = '${PRICE_TYPE_GROUP}'
                          AND sourcePrice.price_id = CAST(groupListing.group_id AS TEXT))
                    OR (sourcePrice.price_type = '${PRICE_TYPE_GROUP_DAY}'
                          AND sourcePrice.price_id LIKE (groupListing.group_id || '/%')))
             )`,
  });
};

/** Reset-every-member-to-default-quantity statement (quantity 1). The flat price
 * overrides are cleared separately via {@link groupFlatPriceStatements}. */
const clearMembersStatement = (groupId: number) => ({
  args: [groupId],
  sql: "UPDATE group_listings SET quantity = 1 WHERE group_id = ?",
});

/** The single CASE-UPDATE that applies each valid member's `quantity`, resetting
 * every other member to the default (quantity 1) via the ELSE branch. One
 * statement regardless of size, staying clear of the round-trip guard. The flat
 * price overrides ride {@link groupFlatPriceStatements}, per-day overrides
 * {@link groupDayPriceStatements}. */
const memberQuantityStatement = (
  groupId: number,
  valid: PackageMemberInput[],
) => {
  const qtyCases = valid.map(() => " WHEN ? THEN ?").join("");
  const args: number[] = [];
  for (const { listingId, quantity } of valid) {
    args.push(listingId, quantity ?? 1);
  }
  args.push(groupId);
  return {
    args,
    sql: `UPDATE group_listings SET quantity = CASE listing_id ${qtyCases} ELSE 1 END WHERE group_id = ?`,
  };
};

/** Keep only the submitted members that are CURRENT members of the group, so a
 * stale or crafted id is ignored rather than wiping real overrides, and collapse
 * duplicate `listing_id` entries (last one wins). The JSON API accepts an array,
 * so a client can send the same member twice; the price-row builders emit one row
 * per entry, and two rows for the same (listing, group) would abort on the unique
 * index (the retired CASE-update `package_price` path silently took the last). */
const validMembers = (
  members: PackageMemberInput[],
  currentIds: Set<number>,
): PackageMemberInput[] => [
  ...new Map(
    members
      .filter((m) => currentIds.has(m.listingId))
      .map((m) => [m.listingId, m] as const),
  ).values(),
];

/**
 * Apply package-member overrides via the caller-supplied reader and runner, so
 * the batch and transactional variants share one decision tree. An explicit
 * empty array clears all overrides; a non-empty list that matches no current
 * member is a no-op (it isn't treated as "clear all"). Both the flat `group` and
 * per-day `group_day` price rows are full-replaced in the same pass
 * ({@link groupFlatPriceStatements} / {@link groupDayPriceStatements}) so the
 * price table always matches the members it was saved with.
 */
const applyPackageMembers = async (
  groupId: number,
  members: PackageMemberInput[],
  readCurrentIds: () => Promise<Set<number>>,
  run: (stmt: {
    args: (number | string | null)[];
    sql: string;
  }) => Promise<unknown>,
): Promise<void> => {
  const applyMembers = async (
    quantityStmt: { args: (number | string | null)[]; sql: string },
    priceMembers: PackageMemberInput[],
  ): Promise<void> => {
    await run(quantityStmt);
    for (const stmt of groupFlatPriceStatements(groupId, priceMembers)) {
      await run(stmt);
    }
    for (const stmt of groupDayPriceStatements(groupId, priceMembers)) {
      await run(stmt);
    }
  };
  if (members.length === 0) {
    await applyMembers(clearMembersStatement(groupId), []);
    return;
  }
  const valid = validMembers(members, await readCurrentIds());
  if (valid.length === 0) return;
  await applyMembers(memberQuantityStatement(groupId, valid), valid);
};

/** Set a group's package member overrides — the flat `group` price rows in
 * `listing_prices` plus the per-package `quantity` on the membership rows. Pass
 * `tx` to run inside an existing write transaction (the admin API update path, so the
 * overrides commit atomically with the group row write); omit it to run as the
 * function's own statements. See {@link applyPackageMembers} for the
 * partial-update rules. */
export const setGroupPackageMembers = (
  groupId: number,
  members: PackageMemberInput[],
  tx?: TxScope,
): Promise<void> =>
  applyPackageMembers(
    groupId,
    members,
    tx
      ? async () => new Set(await groupListings.getIdsTx(tx, groupId))
      : async () => new Set(await groupListings.getIds(groupId)),
    tx ? (stmt) => tx.execute(stmt) : (stmt) => execute(stmt.sql, stmt.args),
  );

/**
 * Set the `active` flag on every listing in a group.
 * Returns the number of listings affected.
 */
export const setGroupListingsActive = async (
  groupId: number,
  active: boolean,
): Promise<number> => {
  // Unaliased `id` (not IN_GROUP_SQL's `listing.id`) — this UPDATE has no table
  // alias, so SQLite would reject `listing.id` here.
  const result = await execute(
    `UPDATE listings SET active = ? WHERE id IN (
       SELECT groupListing.listing_id
         FROM group_listings AS groupListing
        WHERE groupListing.group_id = ?)`,
    [active ? 1 : 0, groupId],
  );
  return result.rowsAffected;
};

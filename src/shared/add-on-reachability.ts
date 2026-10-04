/**
 * The would-be-set add-on reachability guards: the checks that recompute a
 * whole listing set with a pending change applied — a save's group move, a
 * bulk deactivation, or the group page's removal — and refuse the ones that
 * would orphan a child-scoped add-on. The per-edge walker lives in
 * `listings-actions.ts`; these are the set-wide ones it cannot see.
 */

import type { TxScope } from "#db/client.ts";
import { listingGroups } from "#db/groups/table.ts";
import {
  firstTouchingEdgeError,
  getNonStandaloneChildIds,
  listingIdsWithLinks,
  listingParents,
} from "#db/listing-parents.ts";
import { getAllListings, getListingWithCount } from "#db/listings/records.ts";
import {
  childOnlyAddOnNameWithScopes,
  childUnreachableAddOnError,
  type ListingGroupMembership,
  listingIdsInGroups,
  type OptionalAddOns,
  optionalAddOnsWithScopes,
  reachablePageIds,
  toListingGroupMembership,
} from "#db/modifier-resolve.ts";
import { modifierGroups } from "#db/modifiers.ts";
import { t } from "#i18n";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";

/** The user-facing refusal a reachability guard returns, or null when the
 * change it judged is safe. */
export type GuardRefusal = Promise<string | null>;

/** The per-listing would-be change a guard applies to the in-memory listing
 * set: the save's group move or inactive state. One shape for every override
 * the reachability guards take. */
export type ListingOverride = (
  listing: ListingGroupMembership,
) => Partial<ListingGroupMembership>;

/** Every listing as a {@link ListingGroupMembership} with a per-listing override
 * applied — the would-be group set or inactive state the save is about to
 * commit. One membership lookup feeds both would-be reachability checks. An
 * optional transaction reads the listings and memberships through it, so a
 * guard inside a write transaction judges the rows that transaction sees
 * rather than the committed ones another save has already changed. */
export const listingsWithGroups = async (
  override: ListingOverride,
  tx?: TxScope,
): Promise<ListingGroupMembership[]> => {
  const all = await getAllListings(tx);
  const membership = await listingGroups.getIdsByKeys(
    all.map((l) => l.id),
    tx,
  );
  return all.map((listing) => {
    const member = toListingGroupMembership(listing, membership);
    return { ...member, ...override(member) };
  });
};

/** The would-be base both save-time reachability walks read: every listing
 * with the save's group move applied, its non-standalone child ids, and the
 * add-on scopes resolved against that moved set. One build reads each table
 * once, so a heavy save's two walks do not repeat the reads inside the write
 * transaction. `addOns` resolves on the first walk that needs it. */
export type WouldBeReachabilityBase = {
  addOns: () => Promise<OptionalAddOns>;
  listings: ListingGroupMembership[];
  nonStandalone: Set<number>;
};

const wouldBeReachabilityBase = async (
  groupOverride: ListingOverride,
  tx?: TxScope,
): Promise<WouldBeReachabilityBase> => {
  const listings = await listingsWithGroups(groupOverride, tx);
  const nonStandalone = await getNonStandaloneChildIds(
    listings.map((l) => l.id),
    tx,
  );
  let addOns: OptionalAddOns | null = null;
  return {
    addOns: async () => (addOns ??= await resolveWouldBeAddOns(listings, tx)),
    listings,
    nonStandalone,
  };
};

/**
 * Run the shared child-scoped-add-on reachability over a would-be listing set:
 * apply `override` (a save's inactive/group-move state) to the in-memory
 * listings, then treat `forceSuppressed` ids as non-standalone children even
 * when the DB still reads them otherwise (a just-cleared `bookable_alone` flag,
 * which the pending save hasn't committed yet). Being in the suppressed set also
 * drops those ids from the reachable pages. Returns the first orphaned add-on's
 * error, or null. Shared by the deactivation and false-transition guards so
 * their reachability computation can't drift. A pre-built `base` carries the
 * group move and the reads behind it, so the caller's walk reuses them; the
 * override then only adds what the base cannot know (an active-flag change).
 * The optional transaction keeps every read of the walk inside the caller's
 * write transaction, so the second of two concurrent page-removing writes sees
 * the first one's rows and refuses.
 */
export const orphanedAddOnOverWouldBe = async (
  override: ListingOverride,
  forceSuppressed: readonly number[] = [],
  tx?: TxScope,
  base?: WouldBeReachabilityBase,
): GuardRefusal => {
  const wouldBe = base
    ? base.listings.map((listing) => ({ ...listing, ...override(listing) }))
    : await listingsWithGroups(override, tx);
  const childIds = base
    ? new Set(base.nonStandalone)
    : await getNonStandaloneChildIds(
        wouldBe.map((l) => l.id),
        tx,
      );
  for (const id of forceSuppressed) childIds.add(id);
  return firstChildUnreachableAddOnForListings(
    wouldBe,
    childIds,
    base ? await base.addOns() : await resolveWouldBeAddOns(wouldBe, tx),
  );
};

/** The add-on reachability check a listing save runs when it drops a group
 * (the group-only case of the listing form's untick guard): a member leaving a
 * group can be the only page a child-scoped add-on is reachable from.
 * `wouldBeGroups` holds each leaving listing's complete remaining group set,
 * and one walk judges all of them at once, however many were selected. Used
 * by the group page's remove form, so it cannot orphan an add-on the listing
 * edit form would have refused to untick. */
export const groupLeavingOrphanedAddOnError = (
  wouldBeGroups: ReadonlyMap<number, readonly number[]>,
  tx?: TxScope,
): GuardRefusal =>
  orphanedAddOnOverWouldBe(
    (listing) => {
      const groupIds = wouldBeGroups.get(listing.id);
      return groupIds === undefined ? {} : { groupIds: [...groupIds] };
    },
    [],
    tx,
  );

/** Re-checks every add-on with ALL the targets inactive at once: one rescued
 * only by several group members together is still caught. Deactivation only —
 * an activation can only add reachable pages. */
export const deactivationOrphanedAddOnError = async (
  inactiveIds: ReadonlySet<number>,
  tx?: TxScope,
): GuardRefusal => {
  // Deactivation does not clear bookable_alone, so a flagged child's stored row
  // still reads `bookable_alone = 1` and getNonStandaloneChildIds keeps excluding
  // it from the suppressed set — yet taking its page offline removes the only
  // surface a child-only add-on could sell from. Force every deactivated flagged
  // child (a child of some parent whose flag is still set) into the suppressed
  // set, matching the edit-save path's untick guard.
  const ids = [...inactiveIds];
  const childLinks = await listingParents.getIdsByKeys(ids, tx);
  const childIds = listingIdsWithLinks(childLinks);
  const base = await wouldBeReachabilityBase(() => ({}), tx);
  // Apply the would-be inactive state of every target listing to the in-memory set.
  return orphanedAddOnOverWouldBe(
    (listing) => (inactiveIds.has(listing.id) ? { active: false } : {}),
    [...childIds].filter((id) => !base.nonStandalone.has(id)),
    tx,
    base,
  );
};

/** A {@link GroupScopeResolver} that expands each group-scoped modifier against
 * an in-memory listing set, so a caller can test reachability under a listing's
 * would-be `group_id` (which the live `modifier_groups`→`listings` join would
 * not yet reflect). It maps each modifier's linked group ids to the supplied
 * listings' ids via {@link listingIdsInGroups}. */
const inMemoryGroupScopeResolver =
  (allListings: ListingGroupMembership[], tx?: TxScope) =>
  async (groupScopedIds: number[]) => {
    const groupLinks = await modifierGroups.getIdsByKeys(groupScopedIds, tx);
    return new Map(
      [...groupLinks].map(([id, groupIds]) => [
        id,
        listingIdsInGroups(groupIds, allListings),
      ]),
    );
  };

/** The would-be add-on set: scopes resolved against in-memory listings, with
 * every scope read through the optional transaction. The one way a caller
 * resolves the set, so a multi-edge save reads it once. */
export const resolveWouldBeAddOns = (
  allListings: ListingGroupMembership[],
  tx?: TxScope,
) => optionalAddOnsWithScopes(inMemoryGroupScopeResolver(allListings, tx), tx);

/**
 * Like {@link childOnlyAddOnName}, but judging against add-on scopes the
 * caller already resolved for its would-be listing set (via
 * {@link resolveWouldBeAddOns}), so a save walking several edges reads the
 * scopes once instead of per edge.
 */
export const childOnlyAddOnNameForListings = (
  childId: number,
  parentPageListingIds: readonly number[],
  { optional, scopes }: OptionalAddOns,
): string | null =>
  childOnlyAddOnNameWithScopes(
    { optional, scopes },
    childId,
    parentPageListingIds,
  );

export const firstChildUnreachableAddOnForListings = (
  allListings: ListingGroupMembership[],
  childListingIds: Set<number>,
  { optional, scopes }: OptionalAddOns,
): string | null => {
  const reachable = reachablePageIds(allListings, childListingIds);
  for (const modifier of optional) {
    const error = childUnreachableAddOnError(
      {
        active: modifier.active,
        name: modifier.name,
        scope: scopes.get(modifier.id)!,
        trigger: modifier.trigger,
      },
      childListingIds,
      reachable,
    );
    if (error) return error;
  }
  return null;
};

/** The first child-only add-on the listing's edges would orphan under its
 * would-be `group_id`, or null. Reuses the same reachability helper the edge/
 * modifier saves use, judged against the would-be base the save's walks share.
 * The listing is checked both as a parent (its children, against its own page
 * id `[id]`) and as a child (under each parent's page id `[parentId]`). An
 * optional transaction keeps the walk's reads inside the caller's write
 * transaction. */
const orphanedAddOnAfterChange = async (
  id: number,
  base: WouldBeReachabilityBase,
  tx?: TxScope,
): GuardRefusal => {
  // The scopes resolve once on the first edge that asks, and the lost-page
  // walk reuses that resolution — per-edge resolution would hit the
  // transaction's statement guard.
  let addOns: OptionalAddOns | null = null;
  const resolveAddOns = async (): Promise<OptionalAddOns> =>
    (addOns ??= await base.addOns());
  // Each touching edge is a (suppressed child, parent page id) pair: as a parent
  // of each child the page is self (`id`) and the suppressed child is the other
  // endpoint; as a child under each parent the page is the parent and self is the
  // suppressed child.
  return firstTouchingEdgeError(
    id,
    async ({ self, otherId }) => {
      const childId = self === "parent" ? otherId : id;
      const pageId = self === "parent" ? id : otherId;
      // A flagged child rescues any add-on via its own page, so skip the block.
      if (!base.nonStandalone.has(childId)) return null;
      const addOn = childOnlyAddOnNameForListings(
        childId,
        [pageId],
        await resolveAddOns(),
      );
      return addOn
        ? t("listings_table.children_err_child_addon_save", { addon: addOn })
        : null;
    },
    tx,
  );
};

/** True when the save takes this listing out of a group it is currently in.
 * Losing a group can strip the page out of a group-scoped add-on's reach even
 * while the page itself stays live. */
const leavesAGroup = async (
  existingId: number,
  wouldBeGroupIds: readonly number[],
  tx?: TxScope,
): Promise<boolean> =>
  (await listingGroups.getIds(existingId, tx)).some(
    (groupId) => !wouldBeGroupIds.includes(groupId),
  );

/**
 * Three transitions take away a page that can rescue a child-scoped add-on: a
 * deactivation, an unset of "can be booked by itself" on a child, and a group
 * removal. The last is the subtle one, because an edge-less page has no
 * touching edge, so the edge walk never sees the move.
 *
 * Each re-runs the guard over the save's PENDING state. The stored row still
 * reads `bookable_alone = 1` until the save commits, so a flagged child with
 * parents is forced into the suppressed set by hand. The optional transaction
 * keeps every read inside the caller's write transaction.
 */
const lostPageOrphanedAddOn = async (
  input: ListingInput,
  existingId: number,
  base: WouldBeReachabilityBase,
  tx?: TxScope,
): Promise<string | null> => {
  const deactivating = input.active === false;
  const clearingFlag = input.bookableAlone === false;
  const mayStripPage = deactivating || clearingFlag;
  const existing = mayStripPage
    ? await getListingWithCount(existingId, tx)
    : null;
  const flaggedChildWithParents =
    existing?.bookable_alone === true &&
    (await listingParents.getIds(existingId, tx)).length > 0;
  // Both listing-save entry points always resolve groupIds to an array (the
  // form via parseGroupIds, the JSON API via `groups.input ?? existingGroupIds`),
  // so it is defined here, matching the create path's `input.groupIds!` writer.
  const wouldBeGroupIds = input.groupIds!;
  const stripsOwnPage = deactivating || flaggedChildWithParents;
  if (
    !stripsOwnPage &&
    !(await leavesAGroup(existingId, wouldBeGroupIds, tx))
  ) {
    return null;
  }
  const override = (
    listing: ListingGroupMembership,
  ): Partial<ListingGroupMembership> =>
    listing.id === existingId
      ? { active: !deactivating, groupIds: wouldBeGroupIds }
      : {};
  return orphanedAddOnOverWouldBe(
    override,
    flaggedChildWithParents ? [existingId] : [],
    tx,
    base,
  );
};

/**
 * The add-on reachability half of a listing update, run as the row write's
 * `checkTx` guard: both checks read the listings, memberships, child links,
 * and modifier scopes through the open write transaction, so the second of two
 * serialized page-removing saves sees the first one's rows and is refused.
 * Both walks share one would-be base — the group-moved listing set, its
 * non-standalone children, and the add-on scopes — so a heavy save reads each
 * table once and stays clear of the transaction's statement guard. Creates
 * never run it (no edges yet, and a fresh listing rescues nothing).
 */
export const listingSaveOrphanedAddOnTx = async (
  tx: TxScope,
  existingId: number,
  input: ListingInput,
): GuardRefusal => {
  const base = await wouldBeReachabilityBase(
    (listing) =>
      listing.id === existingId ? { groupIds: input.groupIds ?? [] } : {},
    tx,
  );
  const edgeError = await orphanedAddOnAfterChange(existingId, base, tx);
  if (edgeError) return edgeError;
  return lostPageOrphanedAddOn(input, existingId, base, tx);
};

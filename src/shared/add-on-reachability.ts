/**
 * The add-on reachability guards recompute the listing set with a pending
 * change applied: a listing save, a bulk deactivation, or the group page's
 * removal. They refuse the change when it orphans a child-scoped add-on.
 */

import { resultRows, type TxScope } from "#db/client.ts";
import { listingGroups } from "#db/groups/table.ts";
import {
  firstTouchingEdgeError,
  getNonStandaloneChildIds,
  listingIdsWithLinks,
  listingParents,
} from "#db/listing-parents.ts";
import { getAllListings } from "#db/listings/records.ts";
import { rawListingsTable } from "#db/listings/table.ts";
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
import { once } from "#fp";
import { t } from "#i18n";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { requireValue } from "#shared/required-value.ts";

/** The user-facing refusal a reachability guard returns, or null when the
 * change it judged is safe. */
type GuardRefusal = Promise<string | null>;

/** The group sets a change gives some listings, by listing id. A
 * listing absent from the map keeps its current groups. */
type WouldBeGroups = ReadonlyMap<number, readonly number[]>;

const listingStateColumns = rawListingsTable.read.pick(["id", "active"]);
const bookableAloneColumn = rawListingsTable.read.pick(["bookable_alone"]);

/** Each listing's id and active flag. Inside a write transaction, the two
 * columns are read through it, because the cache can be stale there. */
const listingStates = async (
  tx?: TxScope,
): Promise<{ active: boolean; id: number }[]> =>
  tx === undefined
    ? getAllListings()
    : listingStateColumns.readAll(
        resultRows(await tx.execute(listingStateColumns.statement())),
      );

/** The listing set a guard judges, with the reads behind it: every
 * listing with its pending groups, the non-standalone child ids, and the
 * add-on scopes. The scopes resolve against those groups. `addOns` reads on
 * first use. */
type WouldBeBase = {
  addOns: () => Promise<OptionalAddOns>;
  listings: ListingGroupMembership[];
  nonStandalone: Set<number>;
};

const wouldBeBase = async (
  wouldBeGroups: WouldBeGroups,
  tx?: TxScope,
): Promise<WouldBeBase> => {
  const states = await listingStates(tx);
  const membership = await listingGroups.getIdsByKeys(
    states.map((listing) => listing.id),
    tx,
  );
  const listings = states.map((state) => {
    const listing = toListingGroupMembership(state, membership);
    const groupIds = wouldBeGroups.get(listing.id);
    return groupIds === undefined
      ? listing
      : { ...listing, groupIds: [...groupIds] };
  });
  const nonStandalone = await getNonStandaloneChildIds(
    listings.map((listing) => listing.id),
    tx,
  );
  return {
    addOns: once(() => resolveWouldBeAddOns(listings, tx)),
    listings,
    nonStandalone,
  };
};

/**
 * Run the shared child-scoped-add-on reachability over a pending base, with
 * the `inactiveIds` listings taken offline. The `forceSuppressed` ids count as
 * non-standalone children even when the database still reads them otherwise
 * (a just-cleared `bookable_alone` flag the pending save has not committed).
 * Being suppressed also drops those ids from the reachable pages. Returns the
 * first orphaned add-on's error, or null.
 */
const orphanedAddOnOverWouldBe = async (
  base: WouldBeBase,
  inactiveIds: ReadonlySet<number>,
  forceSuppressed: readonly number[],
): GuardRefusal => {
  const wouldBe = base.listings.map((listing) =>
    inactiveIds.has(listing.id) ? { ...listing, active: false } : listing,
  );
  const childIds = new Set([...base.nonStandalone, ...forceSuppressed]);
  return firstChildUnreachableAddOnForListings(
    wouldBe,
    childIds,
    await base.addOns(),
  );
};

/** The add-on reachability check a listing save runs when it drops a group:
 * the group-only case of the listing form's untick guard. A member leaving a
 * group can be the only page a child-scoped add-on is reachable from.
 * `wouldBeGroups` holds each leaving listing's complete remaining group set,
 * and one walk judges all of them at once, however many were selected. Used
 * by the group page's remove form, so it cannot orphan an add-on the listing
 * edit form refuses to untick. */
export const groupLeavingOrphanedAddOnError = async (
  wouldBeGroups: WouldBeGroups,
  tx?: TxScope,
): GuardRefusal =>
  orphanedAddOnOverWouldBe(await wouldBeBase(wouldBeGroups, tx), new Set(), []);

/** Re-checks every add-on with ALL the targets inactive at once: one rescued
 * only by several group members together is still caught. Deactivation only —
 * an activation can only add reachable pages. */
export const deactivationOrphanedAddOnError = async (
  inactiveIds: ReadonlySet<number>,
  tx?: TxScope,
): GuardRefusal => {
  // Deactivation does not clear bookable_alone, so a flagged child's stored row
  // still reads `bookable_alone = 1` and getNonStandaloneChildIds keeps
  // excluding it from the suppressed set. Yet taking its page offline removes
  // the only surface a child-only add-on can sell from. Force every deactivated
  // flagged child (a child whose own `bookable_alone` flag is still set) into the
  // suppressed set, matching the edit-save path's untick guard.
  const childLinks = await listingParents.getIdsByKeys([...inactiveIds], tx);
  const childIds = listingIdsWithLinks(childLinks);
  const base = await wouldBeBase(new Map(), tx);
  return orphanedAddOnOverWouldBe(
    base,
    inactiveIds,
    [...childIds].filter((id) => !base.nonStandalone.has(id)),
  );
};

/** A {@link GroupScopeResolver} that expands each group-scoped modifier against
 * an in-memory listing set, so a caller can test reachability under a listing's
 * pending `group_id`. The live `modifier_groups`→`listings` join does not
 * reflect that pending id yet. It maps each modifier's linked group ids to the
 * supplied listings' ids via {@link listingIdsInGroups}. */
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
 * caller already resolved for its pending listing set (via
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

const firstChildUnreachableAddOnForListings = (
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

/** One listing save as both guard walks see it: the open transaction, the
 * saved listing, its would-be groups, and the would-be base, read on first
 * use. */
type ListingSave = {
  base: () => Promise<WouldBeBase>;
  existingId: number;
  input: ListingInput;
  tx: TxScope;
  wouldBeGroupIds: readonly number[];
};

/** The first child-only add-on the listing's edges orphan under its
 * pending groups, or null. The listing is checked both as a parent (its
 * children, against its own page id) and as a child (under each parent's
 * page id). The base is read only when an edge exists. */
const orphanedAddOnAfterChange = ({
  base,
  existingId,
  tx,
}: ListingSave): GuardRefusal =>
  // Each touching edge is a (suppressed child, parent page id) pair: as a parent
  // of each child the page is self and the suppressed child is the other
  // endpoint; as a child under each parent the page is the parent and self is the
  // suppressed child.
  firstTouchingEdgeError(
    existingId,
    async ({ self, otherId }) => {
      const childId = self === "parent" ? otherId : existingId;
      const pageId = self === "parent" ? existingId : otherId;
      const { addOns, nonStandalone } = await base();
      // A flagged child rescues any add-on via its own page, so skip the block.
      if (!nonStandalone.has(childId)) return null;
      const addOn = childOnlyAddOnNameForListings(
        childId,
        [pageId],
        await addOns(),
      );
      return addOn
        ? t("listings_table.children_err_child_addon_save", { addon: addOn })
        : null;
    },
    tx,
  );

/** True when the save takes this listing out of a group it is currently in.
 * Losing a group can strip the page out of a group-scoped add-on's reach even
 * while the page itself stays live. */
const leavesAGroup = async ({
  existingId,
  tx,
  wouldBeGroupIds,
}: ListingSave): Promise<boolean> =>
  (await listingGroups.getIds(existingId, tx)).some(
    (groupId) => !wouldBeGroupIds.includes(groupId),
  );

/** Whether the listing is a child whose stored row reads "can be booked by
 * itself". */
const isFlaggedChild = async ({
  existingId,
  tx,
}: ListingSave): Promise<boolean> =>
  (
    await bookableAloneColumn.readAll(
      resultRows(
        await tx.execute(bookableAloneColumn.statement({ id: existingId })),
      ),
    )
  ).some((row) => row.bookable_alone) &&
  (await listingParents.getIds(existingId, tx)).length > 0;

/**
 * Three transitions take away a page that can rescue a child-scoped add-on: a
 * deactivation, an unset of "can be booked by itself" on a child, and a group
 * removal. The last is the subtle one, because an edge-less page has no
 * touching edge, so the edge walk never sees the move.
 *
 * Each re-runs the guard over the save's PENDING state. The stored row still
 * reads `bookable_alone = 1` until the save commits, so a flagged child with
 * parents is forced into the suppressed set by hand.
 */
const lostPageOrphanedAddOn = async (save: ListingSave): GuardRefusal => {
  const deactivating = save.input.active === false;
  const mayStripPage = deactivating || save.input.bookableAlone === false;
  const flaggedChildWithParents = mayStripPage && (await isFlaggedChild(save));
  if (
    !deactivating &&
    !flaggedChildWithParents &&
    !(await leavesAGroup(save))
  ) {
    return null;
  }
  return orphanedAddOnOverWouldBe(
    await save.base(),
    new Set(deactivating ? [save.existingId] : []),
    flaggedChildWithParents ? [save.existingId] : [],
  );
};

/**
 * The add-on reachability half of a listing update, run as the row write's
 * `checkTx` guard: every read goes through the open write transaction, so the
 * second of two serialized page-removing saves sees the first one's rows and
 * is refused. Both walks share one would-be base, read only when a walk needs
 * it, so a plain edit reads no listing set. Creates never run it (no edges
 * yet, and a fresh listing rescues nothing).
 */
export const listingSaveOrphanedAddOnTx = async (
  tx: TxScope,
  existingId: number,
  input: ListingInput,
): GuardRefusal => {
  // Both update entry points resolve the would-be groups: the form from its
  // checkboxes, the JSON API from the stored set when `group_ids` is absent.
  const wouldBeGroupIds = requireValue(
    input.groupIds,
    `Listing ${existingId} update carries no would-be group ids`,
  );
  const save: ListingSave = {
    base: once(() => wouldBeBase(new Map([[existingId, wouldBeGroupIds]]), tx)),
    existingId,
    input,
    tx,
    wouldBeGroupIds,
  };
  const edgeError = await orphanedAddOnAfterChange(save);
  if (edgeError) return edgeError;
  return lostPageOrphanedAddOn(save);
};

/**
 * Shared listing business logic used by both admin HTML routes and JSON API.
 *
 * These functions encapsulate validation, deletion, and state changes
 * so that the route handlers remain thin response formatters.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  getGroupIdsByListingIds,
  getGroupsById,
  getListingsByGroupIds,
  groupListingTypeError,
} from "#shared/db/groups.ts";
import {
  edgeIdsTouching,
  edgeIncompatibilityAfterChange,
  firstTouchingEdgeError,
  getChildListingIds,
  getNonStandaloneChildIds,
  listingParents,
} from "#shared/db/listing-parents.ts";
import { deleteListing } from "#shared/db/listings/delete.ts";
import {
  getAllListings,
  getListingWithCount,
  isSlugTaken,
  listingsTable,
} from "#shared/db/listings/records.ts";
import {
  computeSlugIndex,
  type ListingInput,
} from "#shared/db/listings/table.ts";
import {
  childOnlyAddOnNameForListings,
  firstChildUnreachableAddOnForListings,
  type ListingGroupMembership,
  toListingGroupMembership,
} from "#shared/db/modifier-resolve.ts";
import { isNameTakenAnywhere } from "#shared/db/name-registry.ts";
import type { EdgeListing } from "#shared/listing-parents-rules.ts";
import {
  packageMemberBlock,
  packageMemberBlockError,
} from "#shared/package-membership.ts";
import { generateUniqueSlug } from "#shared/slug.ts";
import { deleteListingAttachmentFile } from "#shared/storage.ts";
import {
  type DayPricedListing,
  type Group,
  type Listing,
  type ListingWithCount,
  normalizeDurationDays,
} from "#shared/types.ts";
import { validateSafeServerFetchUrl } from "#shared/url-safety.ts";

/** Generate a unique listing slug, retrying on collision */
export const generateUniqueListingSlug = (excludeListingId?: number) =>
  generateUniqueSlug(computeSlugIndex, (slug) =>
    isSlugTaken(slug, excludeListingId),
  );

/** Validate max_price is at least unit_price + 100 cents */
const validateMaxPrice = (input: ListingInput): string | null => {
  const minPrice = (input.unitPrice ?? 0) + 100;
  return input.maxPrice < minPrice
    ? `Maximum price must be at least ${formatCurrency(
        100,
      )} more than the ticket price`
    : null;
};

/** An async listing check that may depend on the update target's id (undefined
 * on create), returning a user-facing error or null. */
type ListingUpdateCheck = (
  input: ListingInput,
  existingId: number | undefined,
) => Promise<string | null>;

/** Validate each selected group exists, the listing type is compatible with that
 * group's other members, and — for package groups — the listing is a plain
 * standard listing with a single fixed price (not daily, customisable-days, or
 * pay-what-you-want). The package check mirrors the group-side invariant so the
 * listing form/API can't smuggle an incompatible listing into a package. */
/** The package-membership error for a listing joining `group`, or null when the
 * group isn't a package or the listing is a valid member. A package member may
 * not be priced by the buyer, may never itself be another listing's add-on
 * CHILD (it is only sold as part of its bundle), and may gate its own children
 * only on a VISIBLE package — a hidden package collapses members to the package
 * name, so a member's child selector would leak them. Shares the rule with the
 * group-side save via {@link packageMemberBlock}. (Brand-new child edges
 * submitted on the same write are caught before the row commits in the API's
 * prepareChildEdges.) */
const packageMembershipError = async (
  group: Group,
  name: string,
  canPayMore: boolean,
  existingId: number | undefined,
): Promise<string | null> => {
  if (!group.is_package) return null;
  // Pay-what-you-want is decided by the listing alone — no edge read needed.
  if (canPayMore) return packageMemberBlockError(name, "pay_more");
  // A create has no edges yet; only an existing listing can be an add-on child
  // or gate its own children.
  if (existingId === undefined) return null;
  const block = packageMemberBlock(
    { can_pay_more: false },
    await edgeIdsTouching(existingId),
    group.hide_package_listings,
  );
  return block ? packageMemberBlockError(name, block) : null;
};

const validateListingGroup: ListingUpdateCheck = async (input, existingId) => {
  const groupIds = input.groupIds ?? [];
  if (groupIds.length === 0) return null;
  // Only pay-what-you-want pricing is package-incompatible: a package needs an
  // operator-set price per member. Daily/customisable members are packageable
  // (the group keeps members homogeneous, sharing one date/day-count selector).
  const incompatibleByType = input.canPayMore ?? false;
  // Batch the per-group reads so a listing that joins many groups (e.g. a
  // catalog import of a listing exported from a group-heavy site) stays under
  // the N+1 read guard: one cached groups load plus one sibling query for all
  // referenced groups, then the compatibility check runs in memory per group.
  const groupsById = await getGroupsById();
  const siblingsByGroup = await getListingsByGroupIds(groupIds);
  for (const groupId of groupIds) {
    const group = groupsById.get(groupId);
    if (!group) return "Selected group does not exist";

    const typeError = groupListingTypeError(
      // getListingsByGroupIds seeds an entry (possibly empty) for every id it is
      // asked about, and we iterate those same ids, so the lookup always resolves.
      siblingsByGroup.get(groupId)!,
      // The DB column defaults to "standard" when omitted (e.g. a JSON API
      // create that sends group_ids but no listing_type), so validate against
      // that default rather than passing undefined and reading every standard
      // group as a type mismatch.
      input.listingType ?? "standard",
      input.customisableDays ?? false,
      existingId ?? 0,
    );
    if (typeError) return typeError;

    const packageError = await packageMembershipError(
      group,
      input.name,
      incompatibleByType,
      existingId,
    );
    if (packageError) return packageError;
  }
  return null;
};

/**
 * Validate the customisable-days configuration: when enabled, a listing must
 * offer at least one priced day count within [1, duration_days] and cannot also
 * allow pay-what-you-want (the two pricing models are mutually exclusive).
 */
const validateCustomisableDays = (input: ListingInput): string | null => {
  if (!input.customisableDays) return null;
  if (input.canPayMore) {
    return "Customisable days cannot be combined with Allow Pay More";
  }
  const max = normalizeDurationDays(input.durationDays ?? 1);
  const counts = Object.keys(input.dayPrices ?? {})
    .map(Number)
    .filter((n) => n >= 1 && n <= max);
  return counts.length === 0
    ? "Set a price for at least one day count (1 up to the maximum days)"
    : null;
};

/** Validate renewal-tier configuration (months-per-unit and assigned site). */
const validateRenewalConfig = (input: ListingInput): string | null => {
  if ((input.monthsPerUnit ?? 0) > 0 && !(input.purchaseOnly && input.hidden)) {
    return "Months per unit requires No Check-In and Hidden to be enabled";
  }
  if (input.assignBuiltSite && (input.initialSiteMonths ?? 0) <= 0) {
    return "Initial site months is required when a site is assigned.";
  }
  return null;
};

/** The day-count pricing fields of a listing form input, each optional field
 * defaulted the way the form layer does. Shared by the edge-compatibility shape
 * and the catalog import's member-price check so the defaults never drift. */
export const dayPriceFieldsFromInput = (
  input: ListingInput,
): DayPricedListing => ({
  customisable_days: input.customisableDays ?? false,
  day_prices: input.dayPrices ?? {},
  duration_days: normalizeDurationDays(input.durationDays ?? 1),
});

/** Project a (possibly partial) listing form input onto the edge-compatibility
 * shape for the row it would become, defaulting each optional field as the form
 * layer does. */
export const listingInputToEdge = (
  input: ListingInput,
  id: number,
): EdgeListing => ({
  ...dayPriceFieldsFromInput(input),
  id,
  listing_type: input.listingType ?? "standard",
  months_per_unit: input.monthsPerUnit ?? 0,
  name: input.name,
});

/** The first child-only add-on the listing's edges would orphan under its
 * would-be `group_id`, or null. Reuses the same reachability helper the edge/
 * modifier saves use, resolved against an in-memory listing set with this
 * listing's group move applied (the live `modifier_groups`→`listings` join can't
 * see the pending change). The listing is checked both as a
 * parent (its children, against its own page id `[id]`) and as a child (under
 * each parent's page id `[parentId]`). */
/** Every listing as a {@link ListingGroupMembership} with a per-listing override
 * applied — the would-be group set or inactive state the save is about to
 * commit. One membership lookup feeds both would-be reachability checks. */
const listingsWithGroups = async (
  override: (listing: ListingWithCount) => Partial<ListingGroupMembership>,
): Promise<ListingGroupMembership[]> => {
  const all = await getAllListings();
  const membership = await getGroupIdsByListingIds(all.map((l) => l.id));
  return all.map((listing) => ({
    ...toListingGroupMembership(listing, membership),
    ...override(listing),
  }));
};

const orphanedAddOnAfterChange = async (
  id: number,
  wouldBeGroupIds: number[],
): Promise<string | null> => {
  // Apply this listing's would-be group set to the in-memory listing set, so a
  // group-scoped add-on resolves against the move the save is about to make.
  // (Built eagerly; the shared traversal short-circuits before `check` runs when
  // the listing has no edges, so a no-edge save reads it but never queries scopes.)
  const allListings = await listingsWithGroups((listing) =>
    listing.id === id ? { groupIds: wouldBeGroupIds } : {},
  );
  // A `bookable_alone` child serves its own booking page, so an edge onto it never
  // dead-ends a child-scoped add-on: only NON-standalone children are suppressed.
  const nonStandalone = await getNonStandaloneChildIds(
    allListings.map((l) => l.id),
  );
  // Each touching edge is a (suppressed child, parent page id) pair: as a parent
  // of each child the page is self (`id`) and the suppressed child is the other
  // endpoint; as a child under each parent the page is the parent and self is the
  // suppressed child.
  return firstTouchingEdgeError(id, async ({ self, otherId }) => {
    const childId = self === "parent" ? otherId : id;
    const pageId = self === "parent" ? id : otherId;
    // A flagged child rescues any add-on via its own page, so skip the block.
    if (!nonStandalone.has(childId)) return null;
    const addOn = await childOnlyAddOnNameForListings(
      childId,
      [pageId],
      allListings,
    );
    return addOn
      ? t("listings_table.children_err_child_addon_save", { addon: addOn })
      : null;
  });
};

/**
 * Block a DEACTIVATION (of one listing, or a whole group at once) that would
 * leave a child-scoped opt-in add-on a dead end — reachable only through a
 * suppressed child once the would-be-inactive listings stop serving a public
 * page (generalised to a SET for the group-bulk path).
 *
 * The edge-touching re-check ({@link orphanedAddOnAfterChange}) only walks edges
 * that touch a listing, so it MISSES the case here: a deactivated listing may
 * have no parent/child edge of its own — it is just an ordinary page whose scope
 * happens to include a child-scoped add-on, keeping that add-on reachable. So
 * re-run the reachability for EVERY active opt-in add-on against an in-memory
 * listing set with ALL the target listings marked inactive AT ONCE (so an add-on
 * rescued only by several group members going inactive together is still caught);
 * if any add-on is then reachable only through a suppressed child, block the
 * deactivation. Contained: only opt-in add-ons are scanned (the shared
 * {@link firstChildUnreachableAddOnForListings} core), never unrelated modifiers.
 *
 * Callers only invoke this for DEACTIVATION — activating or leaving a listing
 * active can only ADD reachable pages, never orphan an add-on.
 */
/**
 * Run the shared child-scoped-add-on reachability over a would-be listing set:
 * apply `override` (a save's inactive/group-move state) to the in-memory
 * listings, then treat `forceSuppressed` ids as non-standalone children even
 * when the DB still reads them otherwise (a just-cleared `bookable_alone` flag,
 * which the pending save hasn't committed yet). Being in the suppressed set also
 * drops those ids from the reachable pages. Returns the first orphaned add-on's
 * error, or null. Shared by the deactivation and false-transition guards so
 * their reachability computation can't drift.
 */
const orphanedAddOnOverWouldBe = async (
  override: (listing: ListingWithCount) => Partial<ListingGroupMembership>,
  forceSuppressed: readonly number[] = [],
): Promise<string | null> => {
  const wouldBe = await listingsWithGroups(override);
  const childIds = await getNonStandaloneChildIds(wouldBe.map((l) => l.id));
  for (const id of forceSuppressed) childIds.add(id);
  return firstChildUnreachableAddOnForListings(wouldBe, childIds);
};

export const deactivationOrphanedAddOnError = async (
  inactiveIds: ReadonlySet<number>,
): Promise<string | null> => {
  // Deactivation does not clear bookable_alone, so a flagged child's stored row
  // still reads `bookable_alone = 1` and getNonStandaloneChildIds keeps excluding
  // it from the suppressed set — yet taking its page offline removes the only
  // surface a child-only add-on could sell from. Force every deactivated flagged
  // child (a child of some parent whose flag is still set) into the suppressed
  // set, matching the edit-save path's strippedPageOrphanedAddOn.
  const ids = [...inactiveIds];
  const childIds = await getChildListingIds(ids);
  const nonStandalone = await getNonStandaloneChildIds([...childIds]);
  const flaggedChildren = [...childIds].filter((id) => !nonStandalone.has(id));
  // Apply the would-be inactive state of every target listing to the in-memory set.
  return orphanedAddOnOverWouldBe(
    (listing) => (inactiveIds.has(listing.id) ? { active: false } : {}),
    flaggedChildren,
  );
};

/**
 * Re-check add-on reachability when a listing save STRIPS a page that could
 * rescue a child-scoped opt-in add-on: a deactivation (`active` → false), or
 * clearing "can be booked by itself" on a child (true → false), which removes the
 * child's own booking page. Both can leave an add-on that only that page kept
 * reachable a dead end, so both re-run the shared reachability guard over the
 * save's PENDING state — the edited listing at its would-be group set (so a
 * group-scoped add-on for a group the same save is joining is resolved correctly)
 * and, when deactivating, inactive. Either transition leaves the stored row
 * reading `bookable_alone = 1` until the save commits, so a flagged child with
 * parents is forced into the suppressed set by hand — whether the page is lost to
 * a cleared flag or to a deactivation. Inert unless the save deactivates, or
 * clears the flag for a listing that is a child.
 */
const strippedPageOrphanedAddOn = async (
  input: ListingInput,
  existingId: number,
): Promise<string | null> => {
  const deactivating = input.active === false;
  const clearingFlag = input.bookableAlone === false;
  // Either transition strips a child's OWN booking page: clearing the flag turns
  // it non-standalone, deactivating takes its page offline. In both cases the
  // stored row still reads `bookable_alone = 1`, so getNonStandaloneChildIds
  // treats the child as a live standalone seller and excludes it from the
  // suppressed set — meaning an add-on only its page could offer would pass. So
  // load the row and, when it is a flagged child with parents, force it into the
  // suppressed set by hand (a deactivation needs this just as much as a clear).
  const mayStripPage = deactivating || clearingFlag;
  const existing = mayStripPage ? await getListingWithCount(existingId) : null;
  const flaggedChildWithParents =
    existing?.bookable_alone === true &&
    (await listingParents.getIds(existingId)).length > 0;
  if (!deactivating && !(clearingFlag && flaggedChildWithParents)) return null;
  // Both listing-save entry points always resolve groupIds to an array — the
  // form via parseGroupIds, the JSON API via `groups.input ?? existingGroupIds` —
  // so it is defined here (matching the create path's `input.groupIds!` writer).
  const wouldBeGroupIds = input.groupIds!;
  const override = (
    listing: ListingWithCount,
  ): Partial<ListingGroupMembership> =>
    listing.id === existingId
      ? { active: !deactivating, groupIds: wouldBeGroupIds }
      : {};
  return orphanedAddOnOverWouldBe(
    override,
    flaggedChildWithParents ? [existingId] : [],
  );
};

/**
 * On an update, re-validate every parent/child edge touching this listing
 * against its would-be field values *and* its would-be `group_id`, so a
 * type/duration/renewal change can't leave a persisted edge the booking gate
 * can't honour, and a group change can't orphan a group-scoped add-on that the
 * edge's child suppresses. Also re-check add-on reachability when the
 * save DEACTIVATES this listing (the edge-touching walk above misses a
 * no-edge page that is the only one rescuing a child-scoped add-on). No-op for
 * creates (no edges yet, and a fresh listing rescues nothing).
 */
const validateListingEdges: ListingUpdateCheck = async (input, existingId) => {
  if (existingId === undefined) return null;
  const fieldError = await edgeIncompatibilityAfterChange(
    listingInputToEdge(input, existingId),
  );
  if (fieldError) return fieldError;
  const orphanError = await orphanedAddOnAfterChange(
    existingId,
    input.groupIds ?? [],
  );
  if (orphanError) return orphanError;
  return strippedPageOrphanedAddOn(input, existingId);
};

/** Validate listing input (slug uniqueness on update, group, max price, listing type) */
export const validateListingInput = async (
  input: ListingInput,
  existingId?: number,
): Promise<string | null> => {
  // A listing name must be unique across BOTH listings and groups (create and
  // edit alike), so the catalog can be referenced by name for import/export.
  const nameTaken = await isNameTakenAnywhere(
    input.name,
    existingId === undefined ? undefined : { id: existingId, kind: "listing" },
  );
  if (nameTaken) return t("error.name_in_use");
  if (existingId !== undefined) {
    const taken = await isSlugTaken(input.slug, existingId);
    if (taken) return t("error.slug_in_use");
  }
  if (input.canPayMore) {
    const maxPriceError = validateMaxPrice(input);
    if (maxPriceError) return maxPriceError;
  }
  const customisableError = validateCustomisableDays(input);
  if (customisableError) return customisableError;
  const groupError = await validateListingGroup(input, existingId);
  if (groupError) return groupError;
  // A type/duration/renewal edit can break an existing parent/child edge the
  // booking gate then can't date or price — re-check every touching edge against
  // the would-be fields and block the save (web form and admin JSON API alike).
  const edgeError = await validateListingEdges(input, existingId);
  if (edgeError) return edgeError;

  return (
    validateSafeServerFetchUrl(
      input.thankYouUrl,
      "Thank you URL must be a public https:// domain",
    ) ??
    validateSafeServerFetchUrl(
      input.webhookUrl,
      "Webhook URL must be a public https:// domain",
    ) ??
    validateRenewalConfig(input)
  );
};

/**
 * Block a DELETE that would leave a child-scoped opt-in add-on a dead end —
 * reachable only through a suppressed child once the deleted listing stops
 * serving a public page. The delete path prunes the listing's
 * parent/child edges but otherwise bypasses the reachability guard the
 * deactivate paths run, so deleting the only active non-child page in a
 * child-scoped add-on's scope would orphan it.
 *
 * A deleted listing no longer serves a page (exactly like a deactivated one), so
 * this reuses the same shared guard ({@link deactivationOrphanedAddOnError}) with
 * the deleted id in the would-be-removed set — the booking-page reachability is
 * computed against the active, non-child listings, and a deleted listing drops
 * out of that set just as a deactivated one does. Returns the error to surface,
 * or null when the delete is safe.
 */
export const deleteOrphanedAddOnError = (
  listingId: number,
): Promise<string | null> =>
  deactivationOrphanedAddOnError(new Set([listingId]));

/**
 * Delete a listing: clean up its attachment, remove DB links, log activity.
 * Returns the listing that was deleted (for response formatting).
 */
export const performListingDelete = async (
  listing: ListingWithCount,
): Promise<void> => {
  await deleteListingAttachmentFile(listing, "listing deletion");
  await deleteListing(listing.id);
  await logActivity(
    `Listing '${listing.name}' deleted (${listing.attendee_count} attendee(s) removed)`,
  );
};

/**
 * Build an `ListingInput` from an existing listing, with optional overrides.
 *
 * Uses the table's `rowToInput` to carry every column across — no manual
 * snake_case→camelCase translation. A fresh unique slug is generated so
 * the returned input is safe to insert. Attachment URLs are cleared because
 * they reference files owned by the source listing.
 * Callers can override any field (e.g. `name`, `date`, `groupId`) via
 * `overrides`.
 */
export const buildDuplicateListingInput = async (
  source: Listing,
  overrides: Partial<ListingInput> = {},
): Promise<ListingInput> => ({
  ...(listingsTable.rowToInput(source, ["created"]) as ListingInput),
  // `day_prices` isn't a physical column (it projects from listing_prices), so
  // rowToInput can't carry it — pass the source's day prices through explicitly
  // so a duplicate keeps its per-day-count pricing (the write path persists it as
  // day_count rows). An override may still replace it.
  dayPrices: source.day_prices,
  ...(await generateUniqueListingSlug()),
  attachmentName: "",
  attachmentUrl: "",
  ...overrides,
});

/**
 * The outcome of {@link toggleListingActive}: the updated listing, an
 * already-in-state no-op, or a guard error (a deactivation that would orphan a
 * child-scoped add-on). Callers map each case to their own response shape.
 */
export type ToggleActiveResult =
  | { updated: ListingWithCount }
  | { noChange: true }
  | { error: string };

/**
 * Toggle listing active state, log activity, and return the updated listing.
 *
 * A DEACTIVATION runs the same orphaned-add-on guard the HTML deactivate route
 * uses ({@link deactivationOrphanedAddOnError}), so the JSON API toggle can't
 * orphan a child-scoped add-on the HTML route would block. Reactivation is
 * unguarded (it only ADDS a reachable page). Returns `{ noChange }` when the
 * listing is already in the target state.
 */
export const toggleListingActive = async (
  listingId: number,
  listing: ListingWithCount,
  active: boolean,
): Promise<ToggleActiveResult> => {
  if (listing.active === active) return { noChange: true };
  if (!active) {
    const error = await deactivationOrphanedAddOnError(new Set([listingId]));
    if (error) return { error };
  }
  await listingsTable.update(listingId, { active });
  const verb = active ? "reactivated" : "deactivated";
  await logActivity(`Listing '${listing.name}' ${verb}`, listingId);
  return { updated: (await getListingWithCount(listingId))! };
};

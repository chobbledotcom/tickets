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
  anyListingInPackageGroup,
  getGroupIdsByListingIds,
  groupsTable,
  packageMemberEdgesOk,
  validateGroupListingType,
} from "#shared/db/groups.ts";
import {
  edgeIncompatibilityAfterChange,
  firstTouchingEdgeError,
  getChildListingIds,
  getParentIds,
} from "#shared/db/listing-parents.ts";
import {
  computeSlugIndex,
  deleteListing,
  getAllListings,
  getListingWithCount,
  isSlugTaken,
  type ListingInput,
  listingsTable,
} from "#shared/db/listings.ts";
import {
  childOnlyAddOnNameForListings,
  firstChildUnreachableAddOnForListings,
  type ListingGroupMembership,
  toListingGroupMembership,
} from "#shared/db/modifier-resolve.ts";
import type { EdgeListing } from "#shared/listing-parents-rules.ts";
import { generateUniqueSlug } from "#shared/slug.ts";
import { deleteListingStorageFiles } from "#shared/storage.ts";
import {
  type Group,
  isPackageableListing,
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
 * group isn't a package or the listing is a valid member. A package member must
 * be a plain standard listing (not daily/pay-more/customisable) AND have
 * package-compatible edges — not a child of anything, and at most one packageable
 * child it auto-includes (Stage 0; see {@link packageMemberEdgesOk}), mirroring
 * the group-side invariant. (Brand-new child edges submitted on the same write
 * are caught before the row commits in the API's prepareChildEdges.) */
const packageMembershipError = async (
  group: Group,
  incompatibleByType: boolean,
  existingId: number | undefined,
): Promise<string | null> => {
  if (!group.is_package) return null;
  if (incompatibleByType) return t("error.package_incompatible_listing");
  if (existingId !== undefined && !(await packageMemberEdgesOk(existingId))) {
    return t("error.package_incompatible_listing");
  }
  return null;
};

const validateListingGroup: ListingUpdateCheck = async (input, existingId) => {
  const incompatibleByType =
    (input.listingType ?? "standard") !== "standard" ||
    (input.canPayMore ?? false) ||
    (input.customisableDays ?? false);
  for (const groupId of input.groupIds ?? []) {
    const group = await groupsTable.findById(groupId);
    if (!group) return "Selected group does not exist";

    const typeError = await validateGroupListingType(
      groupId,
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

/** Project a (possibly partial) listing form input onto the edge-compatibility
 * shape for the row it would become, defaulting each optional field as the form
 * layer does. */
export const listingInputToEdge = (
  input: ListingInput,
  id: number,
): EdgeListing => ({
  customisable_days: input.customisableDays ?? false,
  day_prices: input.dayPrices ?? {},
  duration_days: normalizeDurationDays(input.durationDays ?? 1),
  id,
  listing_type: input.listingType ?? "standard",
  months_per_unit: input.monthsPerUnit ?? 0,
  name: input.name,
});

/** The first child-only add-on the listing's edges would orphan under its
 * would-be `group_id`, or null. Reuses the same reachability helper the edge/
 * modifier saves use, resolved against an in-memory listing set with this
 * listing's group move applied (the live `modifier_groups`→`listings` join can't
 * see the pending change — parents.md Fix 4). The listing is checked both as a
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
  // Each touching edge is a (suppressed child, parent page id) pair: as a parent
  // of each child the page is self (`id`) and the suppressed child is the other
  // endpoint; as a child under each parent the page is the parent and self is the
  // suppressed child.
  return firstTouchingEdgeError(id, async ({ self, otherId }) => {
    const childId = self === "parent" ? otherId : id;
    const pageId = self === "parent" ? id : otherId;
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
 * page (parents.md Fix 5; generalised to a SET for the group-bulk path).
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
export const deactivationOrphanedAddOnError = async (
  inactiveIds: ReadonlySet<number>,
): Promise<string | null> => {
  // Apply the would-be inactive state of every target listing to the in-memory set.
  const wouldBe = await listingsWithGroups((listing) =>
    inactiveIds.has(listing.id) ? { active: false } : {},
  );
  const childIds = await getChildListingIds(wouldBe.map((l) => l.id));
  return firstChildUnreachableAddOnForListings(wouldBe, childIds);
};

const deactivationOrphanedAddOn = async (
  input: ListingInput,
  existingId: number,
): Promise<string | null> => {
  if (input.active !== false) return null;
  return deactivationOrphanedAddOnError(new Set([existingId]));
};

/**
 * Whether a type edit would strand a package member-parent's auto-included
 * child: the child (`existingId`) is becoming non-packageable
 * (`wouldBePackageable` false) while it is offered under a parent that is itself
 * a package member. The child rides inside a flat package page only while it
 * stays a plain standard fixed-price listing; turning it daily,
 * customisable-days, or pay-what-you-want would leave the package unable to
 * price or lay it out. The member-side break (editing the parent itself) is
 * caught by {@link packageMembershipError} via the parent's group set; this
 * catches the other side — editing the CHILD, which carries no package group of
 * its own.
 */
const packageChildBecomesUnpackageable = async (
  existingId: number,
  wouldBePackageable: boolean,
): Promise<boolean> => {
  if (wouldBePackageable) return false;
  const parentIds = await getParentIds(existingId);
  return parentIds.length > 0 && anyListingInPackageGroup(parentIds);
};

/**
 * On an update, re-validate every parent/child edge touching this listing
 * against its would-be field values *and* its would-be `group_id`, so a
 * type/duration/renewal change can't leave a persisted edge the booking gate
 * can't honour, and a group change can't orphan a group-scoped add-on that the
 * edge's child suppresses (Fix 4). Also re-check add-on reachability when the
 * save DEACTIVATES this listing (Fix 5 — the edge-touching walk above misses a
 * no-edge page that is the only one rescuing a child-scoped add-on). A package
 * member-parent's child must also stay packageable ({@link packageChildTypeError}).
 * No-op for creates (no edges yet, and a fresh listing rescues nothing).
 */
const validateListingEdges: ListingUpdateCheck = async (input, existingId) => {
  if (existingId === undefined) return null;
  const fieldError = await edgeIncompatibilityAfterChange(
    listingInputToEdge(input, existingId),
  );
  if (fieldError) return fieldError;
  const wouldBePackageable = isPackageableListing({
    can_pay_more: input.canPayMore ?? false,
    customisable_days: input.customisableDays ?? false,
    listing_type: input.listingType ?? "standard",
  });
  if (await packageChildBecomesUnpackageable(existingId, wouldBePackageable)) {
    return t("error.package_incompatible_listing");
  }
  const orphanError = await orphanedAddOnAfterChange(
    existingId,
    input.groupIds ?? [],
  );
  if (orphanError) return orphanError;
  return deactivationOrphanedAddOn(input, existingId);
};

/** Validate listing input (slug uniqueness on update, group, max price, listing type) */
export const validateListingInput = async (
  input: ListingInput,
  existingId?: number,
): Promise<string | null> => {
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
 * serving a public page (parents.md Fix 2). The delete path prunes the listing's
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
 * Delete an listing: clean up images/attachments, remove from DB, log activity.
 * Returns the listing that was deleted (for response formatting).
 */
export const performListingDelete = async (
  listing: ListingWithCount,
): Promise<void> => {
  await deleteListingStorageFiles(listing, "listing deletion");
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
 * the returned input is safe to insert. Image and attachment URLs are
 * cleared because they reference files owned by the source listing.
 * Callers can override any field (e.g. `name`, `date`, `groupId`) via
 * `overrides`.
 */
export const buildDuplicateListingInput = async (
  source: Listing,
  overrides: Partial<ListingInput> = {},
): Promise<ListingInput> => ({
  ...(listingsTable.rowToInput(source, ["created"]) as ListingInput),
  ...(await generateUniqueListingSlug()),
  attachmentName: "",
  attachmentUrl: "",
  imageUrl: "",
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

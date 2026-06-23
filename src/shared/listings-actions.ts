/**
 * Shared listing business logic used by both admin HTML routes and JSON API.
 *
 * These functions encapsulate validation, deletion, and state changes
 * so that the route handlers remain thin response formatters.
 */

import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { groupsTable, validateGroupListingType } from "#shared/db/groups.ts";
import {
  edgeIncompatibilityAfterChange,
  firstTouchingEdgeError,
  getChildListingIds,
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
} from "#shared/db/modifier-resolve.ts";
import type { EdgeListing } from "#shared/listing-parents-rules.ts";
import { generateUniqueSlug } from "#shared/slug.ts";
import { deleteListingStorageFiles } from "#shared/storage.ts";
import {
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

/** Validate selected group existence and listing type compatibility. */
const validateListingGroup: ListingUpdateCheck = async (input, existingId) => {
  if (!input.groupId || input.groupId === 0) return null;

  const group = await groupsTable.findById(input.groupId);
  if (!group) return "Selected group does not exist";

  return validateGroupListingType(
    input.groupId,
    input.listingType!,
    input.customisableDays ?? false,
    existingId ?? 0,
  );
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
const orphanedAddOnAfterChange = async (
  id: number,
  wouldBeGroupId: number,
): Promise<string | null> => {
  // Apply this listing's would-be group_id to the in-memory listing set, so a
  // group-scoped add-on resolves against the move the save is about to make.
  // (Built eagerly; the shared traversal short-circuits before `check` runs when
  // the listing has no edges, so a no-edge save reads it but never queries scopes.)
  const allListings = (await getAllListings()).map((listing) =>
    listing.id === id ? { ...listing, group_id: wouldBeGroupId } : listing,
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
  const allListings = await getAllListings();
  // Apply the would-be inactive state of every target listing to the in-memory set.
  const wouldBe = allListings.map((listing) =>
    inactiveIds.has(listing.id) ? { ...listing, active: false } : listing,
  );
  const childIds = await getChildListingIds(allListings.map((l) => l.id));
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
 * On an update, re-validate every parent/child edge touching this listing
 * against its would-be field values *and* its would-be `group_id`, so a
 * type/duration/renewal change can't leave a persisted edge the booking gate
 * can't honour, and a group change can't orphan a group-scoped add-on that the
 * edge's child suppresses (Fix 4). Also re-check add-on reachability when the
 * save DEACTIVATES this listing (Fix 5 — the edge-touching walk above misses a
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
    input.groupId ?? 0,
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

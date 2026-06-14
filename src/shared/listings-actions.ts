/**
 * Shared listing business logic used by both admin HTML routes and JSON API.
 *
 * These functions encapsulate validation, deletion, and state changes
 * so that the route handlers remain thin response formatters.
 */

import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { groupsTable, validateGroupListingType } from "#shared/db/groups.ts";
import {
  computeSlugIndex,
  deleteListing,
  getListingWithCount,
  isSlugTaken,
  type ListingInput,
  listingsTable,
} from "#shared/db/listings.ts";
import { generateUniqueSlug } from "#shared/slug.ts";
import { deleteListingStorageFiles } from "#shared/storage.ts";
import type { Listing, ListingWithCount } from "#shared/types.ts";

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

/** Validate selected group existence and listing type compatibility. */
const validateListingGroup = async (
  input: ListingInput,
  existingId: number | undefined,
): Promise<string | null> => {
  if (!input.groupId || input.groupId === 0) return null;

  const group = await groupsTable.findById(input.groupId);
  if (!group) return "Selected group does not exist";

  return validateGroupListingType(
    input.groupId,
    input.listingType!,
    existingId ?? 0,
  );
};

/** Validate listing input (slug uniqueness on update, group, max price, listing type) */
export const validateListingInput = async (
  input: ListingInput,
  existingId?: number,
): Promise<string | null> => {
  if (existingId !== undefined) {
    const taken = await isSlugTaken(input.slug, existingId);
    if (taken) return "Slug is already in use by another listing";
  }
  if (input.canPayMore) {
    const maxPriceError = validateMaxPrice(input);
    if (maxPriceError) return maxPriceError;
  }
  const groupError = await validateListingGroup(input, existingId);
  if (groupError) return groupError;

  if ((input.monthsPerUnit ?? 0) > 0 && !(input.purchaseOnly && input.hidden)) {
    return "Months per unit requires Purchase Only and Hidden to be enabled";
  }
  if (input.assignBuiltSite && (input.initialSiteMonths ?? 0) <= 0) {
    return "Initial site months is required when a site is assigned.";
  }
  return null;
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
 * Toggle listing active state, log activity, and return the updated listing.
 * Returns null if the listing is already in the target state.
 */
export const toggleListingActive = async (
  listingId: number,
  listing: ListingWithCount,
  active: boolean,
): Promise<ListingWithCount | null> => {
  if (listing.active === active) return null;
  await listingsTable.update(listingId, { active });
  const verb = active ? "reactivated" : "deactivated";
  await logActivity(`Listing '${listing.name}' ${verb}`, listingId);
  return (await getListingWithCount(listingId))!;
};

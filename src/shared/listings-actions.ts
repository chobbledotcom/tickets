/**
 * Shared listing business logic used by both admin HTML routes and JSON API.
 *
 * These functions encapsulate validation, deletion, and state changes
 * so that the route handlers remain thin response formatters.
 */

import { t } from "#i18n";
import { isListingParentsEnabled } from "#shared/config.ts";
import { formatCurrency } from "#shared/currency.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { groupsTable, validateGroupListingType } from "#shared/db/groups.ts";
import { edgeIncompatibilityAfterChange } from "#shared/db/listing-parents.ts";
import {
  computeSlugIndex,
  deleteListing,
  getListingWithCount,
  isSlugTaken,
  type ListingInput,
  listingsTable,
} from "#shared/db/listings.ts";
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

/**
 * On an update (and only when the parents feature is enabled), re-validate every
 * parent/child edge touching this listing against its would-be field values, so
 * a type/duration/renewal change can't leave a persisted edge the booking gate
 * can't honour. No-op for creates (no edges yet) and when the flag is off.
 */
const validateListingEdges: ListingUpdateCheck = (input, existingId) =>
  existingId === undefined || !isListingParentsEnabled()
    ? Promise.resolve(null)
    : edgeIncompatibilityAfterChange(listingInputToEdge(input, existingId));

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

/**
 * Shared listing business logic used by both admin HTML routes and JSON API.
 *
 * These functions encapsulate validation, deletion, and state changes
 * so that the route handlers remain thin response formatters.
 */

/* jscpd:ignore-start -- imports */
import { hmacHash } from "#crypto/hashing.ts";
import type { BlindIndex } from "#crypto/sealed.ts";
import { logActivity } from "#db/activity-log.ts";
import { resultRows, type TxScope, withTransaction } from "#db/client.ts";
import { checkGroupListingSettings } from "#db/groups/homogeneity.ts";
import { getGroupsById, getListingsByGroupIds } from "#db/groups.ts";
import {
  edgeIncompatibilityAfterChange,
  listingChildren,
  listingParents,
} from "#db/listing-parents.ts";
import { syncListingPrices } from "#db/listing-price-sync.ts";
import { deleteListing } from "#db/listings/delete.ts";
import {
  getListingWithCount,
  isSlugTaken,
  listingsTable,
} from "#db/listings/records.ts";
import {
  catalogNameLengthError,
  isNameTakenAnywhere,
} from "#db/name-registry.ts";
import { firstProblem, requiredMapValue } from "#fp";
import { t } from "#i18n";
import { deactivationOrphanedAddOnError } from "#shared/add-on-reachability.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import { formatCurrency } from "#shared/currency.ts";
import {
  dayPriceFieldsFromInput,
  listingInputToEdge,
} from "#shared/listing-edge.ts";
import {
  packageMemberError,
  planInGroupError,
  planRuleError,
} from "#shared/package-membership.ts";
import { parseUpdateSlug } from "#shared/rest/crud-parsers.ts";
import { generateUniqueSlug, normalizeSlug } from "#shared/slug.ts";
import { deleteListingAttachmentFile } from "#shared/storage.ts";
import { validateSafeServerFetchUrl } from "#shared/url-safety.ts";
import {
  availableDayCounts,
  type Group,
  type Listing,
  type ListingWithCount,
} from "#types";
/* jscpd:ignore-end */

/** Generate a unique listing slug, retrying on collision */
export const generateUniqueListingSlug = (excludeListingId?: number) =>
  generateUniqueSlug(hmacHash, (slug) => isSlugTaken(slug, excludeListingId));

/** Parse an update body's optional slug with the listing slug rules: normalise
 * it and recompute its lookup index. A body without a slug keeps the existing
 * one. */
export const parseUpdatedListingSlug = (
  body: Record<string, unknown>,
  existingSlug: string,
): Promise<{
  slug: string;
  slugIndex: BlindIndex;
}> => parseUpdateSlug(body, existingSlug, normalizeSlug, hmacHash);

/** Validate max_price is at least unit_price + 100 cents */
const validateMaxPrice = (input: ListingInput): string | null => {
  const minPrice = (input.unitPrice ?? 0) + 100;
  return input.maxPrice < minPrice
    ? `Maximum price must be at least ${formatCurrency(
        100,
      )} more than the ticket price`
    : null;
};

/** An async listing check that can depend on the update target's id (undefined
 * on create), returning a user-facing error or null. */
type ListingUpdateCheck = (
  input: ListingInput,
  existingId: number | undefined,
) => Promise<string | null>;

/** Validate each selected group exists. The listing type must be compatible
 * with that group's other members. A package member is a plain standard
 * listing with one fixed price: not daily, not customisable-days, not
 * pay-what-you-want. The package check mirrors the group-side invariant so the
 * listing form/API can't smuggle an incompatible listing into a package. */
/** The package-membership error for a listing joining `group`, or null when the
 * group isn't a package or the listing is a valid member. A package member
 * must not be priced by the buyer or be another listing's add-on. It can gate
 * children only on a VISIBLE package. A hidden package collapses members to
 * the package name. A member's child selector would leak them. Shares the
 * rules with the group-side save via {@link packageMemberError}. (Brand-new
 * child edges submitted on the same write are caught before the row commits
 * in the API's prepareChildEdges.) */
const packageMembershipError = async (
  group: Group,
  name: string,
  canPayMore: boolean,
  existingId: number | undefined,
): Promise<string | null> => {
  if (!group.is_package) return null;
  // A create has no edges yet, and pay-what-you-want is decided by the listing
  // alone — either way the rules run without an edge read.
  const [childIds, parentIds] =
    existingId === undefined || canPayMore
      ? [[], []]
      : await Promise.all([
          listingChildren.getIds(existingId),
          listingParents.getIds(existingId),
        ]);
  return packageMemberError(
    { can_pay_more: canPayMore, name },
    { childIds, parentIds },
    group.hide_package_listings,
  );
};

const validateListingGroup: ListingUpdateCheck = async (input, existingId) => {
  const groupIds = input.groupIds ?? [];
  if (groupIds.length === 0) return null;
  const planRule = planInGroupError(input.assignBuiltSite, input.name);
  if (planRule) return planRule;
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
  return firstProblem(async (groupId: number): Promise<string | null> => {
    const checked = checkGroupListingSettings(
      groupsById.get(groupId),
      () =>
        requiredMapValue(
          siblingsByGroup,
          groupId,
          "Missing group listing membership",
        ),
      // The DB column defaults to "standard" when omitted (e.g. a JSON API
      // create that sends group_ids but no listing_type), so validate against
      // that default rather than passing undefined and reading every standard
      // group as a type mismatch.
      {
        customisable_days: input.customisableDays ?? false,
        id: existingId ?? 0,
        listing_type: input.listingType ?? "standard",
      },
      existingId ?? 0,
    );
    if (!checked.ok) return checked.error;

    return packageMembershipError(
      checked.group,
      input.name,
      incompatibleByType,
      existingId,
    );
  })(groupIds);
};

/**
 * Validate the customisable-days configuration: when enabled, a listing must
 * offer at least one priced day count within [1, duration_days] and cannot also
 * allow pay-what-you-want (the two pricing models are mutually exclusive).
 */
const validateCustomisableDays = (input: ListingInput): string | null => {
  if (!input.customisableDays) return null;
  if (input.canPayMore) {
    return t("error.customisable_days_with_pay_more");
  }
  // The priced day counts within range are exactly what availableDayCounts
  // derives, so reuse the normalized day-price fields rather than recomputing
  // the same filter here.
  return availableDayCounts(dayPriceFieldsFromInput(input)).length === 0
    ? "Set a price for at least one day count (1 up to the maximum days)"
    : null;
};

/** Validate renewal-tier configuration (months-per-unit and assigned site). */
const validateRenewalConfig = (input: ListingInput): string | null => {
  if ((input.monthsPerUnit ?? 0) > 0 && !(input.purchaseOnly && input.hidden)) {
    return t("error.months_per_unit_needs_flags");
  }
  // A plan is never also a renewal tier — renewal completion would double-grant.
  return planRuleError(input.assignBuiltSite, [
    [(input.initialSiteMonths ?? 0) <= 0, "error.initial_site_months_required"],
    [(input.monthsPerUnit ?? 0) > 0, "error.assign_built_site_not_tier"],
  ]);
};

/**
 * Re-validate every parent/child edge touching this listing against its would-be
 * field values, so a type/duration/renewal change can't leave a persisted edge
 * the booking gate can't honour. No-op for creates (no edges yet). The add-on
 * reachability half of the save runs later, inside the row write's transaction
 * (see {@link listingSaveOrphanedAddOnTx}).
 */
const validateListingEdges: ListingUpdateCheck = async (input, existingId) => {
  if (existingId === undefined) return null;
  return edgeIncompatibilityAfterChange(listingInputToEdge(input, existingId));
};

/** The listing name's own checks. It must be unique across BOTH listings and
 *  groups (create and edit alike), so the catalog can be referenced by name
 *  for import/export. Its length is capped by the shared catalog-name rule —
 *  see {@link catalogNameLengthError}. */
const listingNameError = async (
  name: string,
  existingId?: number,
): Promise<string | null> => {
  const nameTaken = await isNameTakenAnywhere(
    name,
    existingId === undefined ? undefined : { id: existingId, kind: "listing" },
  );
  if (nameTaken) return t("error.name_in_use");
  return catalogNameLengthError(name);
};

/** Validate a listing's minimum quantity. It must hold with the per-order
 *  maximum: a whole number of at least 1, and at most that maximum. An absent
 *  maximum on a create stores 1, so an absent minimum pairs with it. */
const validateMinQuantity = (input: ListingInput): string | null => {
  const minimum = input.minQuantity;
  if (minimum === undefined) return null;
  // The API projection type-checks the value as a number only, so a fractional
  // body value arrives here and refuses like any other non-quantity.
  if (!Number.isInteger(minimum) || minimum < 1) {
    return t("error.listing_min_quantity_whole");
  }
  return minimum > (input.maxQuantity ?? 1)
    ? t("error.listing_min_quantity_above_max")
    : null;
};

/** Validate listing input (slug uniqueness on update, group, max price, listing type) */
export const validateListingInput = async (
  input: ListingInput,
  existingId?: number,
): Promise<string | null> => {
  const nameError = await listingNameError(input.name, existingId);
  if (nameError) return nameError;
  if (existingId !== undefined) {
    const taken = await isSlugTaken(input.slug, existingId);
    if (taken) return t("error.slug_in_use");
  }
  const minError = validateMinQuantity(input);
  if (minError) return minError;
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
 * A deleted listing no longer serves a page, exactly like a deactivated one,
 * so this reuses {@link deactivationOrphanedAddOnError} with the deleted id in
 * the would-be-removed set.
 */
export const deleteOrphanedAddOnError = (
  listingId: number,
  tx?: TxScope,
): Promise<string | null> =>
  deactivationOrphanedAddOnError(new Set([listingId]), tx);

/**
 * Run one guarded lifecycle write: the orphaned-add-on guard and the write
 * share one write transaction, so no concurrent write can land between the
 * check and the write. Returns the guard's refusal, or null when the write
 * committed.
 */
export const guardedListingWrite = async (
  guard: (tx: TxScope) => Promise<string | null>,
  write: (tx: TxScope) => Promise<void>,
): Promise<string | null> =>
  withTransaction(async (tx) => {
    const refusal = await guard(tx);
    if (refusal !== null) return refusal;
    await write(tx);
    return null;
  });

/**
 * Delete a listing under the orphaned-add-on guard: the guard and the DB
 * deletes share one write transaction, then the attachment file goes and the
 * deletion is logged. The file follows the commit, so a failed database delete
 * cannot leave a live listing pointing at an already-removed file. Returns the
 * guard's refusal, or null when the delete committed.
 */
export const performListingDelete = async (
  listing: ListingWithCount,
): Promise<string | null> => {
  const refusal = await guardedListingWrite(
    (tx) => deleteOrphanedAddOnError(listing.id, tx),
    (tx) => deleteListing(listing.id, tx),
  );
  if (refusal !== null) return refusal;
  await deleteListingAttachmentFile(listing, "listing deletion");
  await logActivity(
    `Listing '${listing.name}' deleted (${listing.attendee_count} attendee(s) removed)`,
  );
  return null;
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

/** Whether the listing's stored state already matches the wanted one. The
 *  page and the JSON API share this one rule. Each surface keeps its own
 *  message for it. */
export const listingAlreadyInState = (
  listingActive: boolean,
  wantedActive: boolean,
): boolean => listingActive === wantedActive;

/**
 * Toggle listing active state, log activity, and return the updated listing.
 *
 * A DEACTIVATION runs the same orphaned-add-on guard the HTML deactivate route
 * uses ({@link deactivationOrphanedAddOnError}), so the JSON API toggle can't
 * orphan a child-scoped add-on the HTML route would block. The guard and the
 * write share one transaction, so a concurrent write cannot land between them.
 * Reactivation is unguarded (it only ADDS a reachable page). Returns
 * `{ noChange }` when the listing is already in the target state.
 */
export const toggleListingActive = async (
  listingId: number,
  listing: ListingWithCount,
  active: boolean,
): Promise<ToggleActiveResult> => {
  const outcome = await withTransaction(
    async (tx): Promise<ToggleActiveResult | null> => {
      // The stored state decides, not the loaded row: a replica lag can leave
      // the row stale, and deciding noChange from it would skip the very
      // write the operator asked for.
      const [row] = resultRows<{ active: number }>(
        await tx.execute({
          args: [listingId],
          sql: "SELECT listing.active FROM listings AS listing WHERE listing.id = ?",
        }),
      );
      // The listing vanished under a concurrent delete. There is nothing to
      // toggle.
      if (row === undefined || listingAlreadyInState(row.active === 1, active)) {
        return { noChange: true };
      }
      if (!active) {
        const refusal = await deactivationOrphanedAddOnError(
          new Set([listingId]),
          tx,
        );
        if (refusal !== null) return { error: refusal };
      }
      // Every table on the transactional write path carries updateStatement
      // (see crud-api.ts), so the toggle's row write joins the guard's tx.
      await tx.execute(
        await listingsTable.updateStatement!(listingId, { active }),
      );
      return null;
    },
  );
  if (outcome !== null) return outcome;
  await syncListingPrices(listingId);
  const verb = active ? "reactivated" : "deactivated";
  await logActivity(`Listing '${listing.name}' ${verb}`, listingId);
  return { updated: (await getListingWithCount(listingId))! };
};

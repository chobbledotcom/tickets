/**
 * The listing record: its table, its one write rule, and its lifecycle hooks.
 * The HTML form routes and the JSON API both read this declaration. Each door
 * supplies its own join writes as a per-call plan.
 */

import { syncListingPrices } from "#db/listing-price-sync.ts";
import {
  getAllListings,
  getListingWithCount,
  getListingWithCountPrimary,
  listingsTable,
} from "#db/listings/records.ts";
import { ADMIN_API_RESOURCES } from "#shared/admin-api-resources.ts";
import type { ListingInput } from "#shared/catalog-fields/fields.ts";
import {
  refuseUndatedListingSwitch,
  validateListingInput,
} from "#shared/listings-actions.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import type { RecordRule, RecordShapeOf } from "#shared/rest/record.ts";
import { errorResult, okResult } from "#shared/result.ts";
import type { Listing, ListingWithCount } from "#types";

/** The prices and the recurring plan that the saved row will hold. A save
 *  that leaves one out keeps the stored value. */
const savedListingInput = (
  input: ListingInput,
  stored: Listing | null,
): ListingInput =>
  stored === null
    ? input
    : {
        ...input,
        recurringInterval: input.recurringInterval ?? stored.recurring_interval,
        recurringPrice: input.recurringPrice ?? stored.recurring_price,
        unitPrice: input.unitPrice ?? stored.unit_price,
      };

/** Judge the row as the save leaves it, and write the input as it came. */
const listingRule: RecordRule<ListingInput, Listing> = async (
  input,
  stored,
) => {
  const error = await validateListingInput(
    savedListingInput(input, stored),
    stored?.id,
  );
  return error === null ? okResult(input) : errorResult(error);
};

export const listingRecord = defineNamedRowRecord<
  RecordShapeOf<Listing, ListingInput, ListingWithCount>
>()({
  activityName: "Listing",
  afterCommit: syncListingPrices,
  api: ADMIN_API_RESOURCES.listings,
  // The listing delete, deactivate, and reactivate routes are staff-only, the
  // same audience the dashboard's lifecycle controls declare.
  checkTx: refuseUndatedListingSwitch,
  getAll: getAllListings,
  linkActivityToRow: true,
  load: getListingWithCount,
  loadAfterWrite: getListingWithCountPrimary,
  logAfterCommit: true,
  rule: listingRule,
  surface: { deleteDestination: "listingDelete", list: "listings" },
  table: listingsTable,
});

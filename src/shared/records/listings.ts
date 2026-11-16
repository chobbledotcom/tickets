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
import {
  refuseUndatedListingSwitch,
  validateListingInput,
} from "#shared/listings-actions.ts";
import type { ListingInput } from "#shared/records/listing-fields.ts";
import { defineNamedRowRecord } from "#shared/rest/named-record.ts";
import type { RecordRule, RecordShapeOf } from "#shared/rest/record.ts";
import { ruleFromValidator } from "#shared/rest/record-command.ts";
import type { Listing, ListingWithCount } from "#types";

/** The recurring plan that the saved row will hold. A save with
 *  Subscriptions off leaves the plan out, and the row keeps the stored one. */
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
      };

/** Judge the row as the save leaves it, and write the input as it came. */
const listingRule: RecordRule<ListingInput, Listing> = (input, stored) =>
  ruleFromValidator<ListingInput, Listing>((_, id) =>
    validateListingInput(savedListingInput(input, stored), id),
  )(input, stored);

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

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
import type { RecordShapeOf } from "#shared/rest/record.ts";
import { ruleFromValidator } from "#shared/rest/record-command.ts";
import type { Listing, ListingWithCount } from "#types";

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
  rule: ruleFromValidator(validateListingInput),
  surface: { deleteDestination: "listingDelete", list: "listings" },
  table: listingsTable,
});

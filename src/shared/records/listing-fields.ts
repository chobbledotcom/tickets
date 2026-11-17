/** The listing fields. The stored row, the write input, and the table columns
 *  derive from this one list. So do the API check and read, the form read,
 *  and the catalogue transfer. The listing pages keep their own form. */

import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import type { CatalogInput } from "#shared/records/catalog-input.ts";
import type {
  FieldSpecs,
  KeyAccess,
  OptionalFieldsInput,
} from "#shared/rest/field-specs.ts";

/* jscpd:ignore-start -- a list of field records, not code */
export const LISTING_FIELDS = [
  // Only staff change the bookable state.
  { default: true, key: "active", kind: "switch", lockedFor: ["editor"] },
  { feature: "builder", key: "assignBuiltSite", kind: "switch" },
  // A child listing with this switch on keeps its own booking page, catalog
  // entry, and API eligibility. Off, it exists only as a foldable add-on.
  { key: "bookableAlone", kind: "switch" },
  {
    default: VALID_DAY_NAMES,
    key: "bookableDays",
    kind: "weekdays",
  },
  { key: "canPayMore", kind: "switch" },
  { key: "closesAt", kind: "optionalDatetime" },
  { key: "customisableDays", kind: "switch" },
  { key: "date", kind: "datetime" },
  { key: "dayPrices", kind: "dayPrices" },
  { key: "description", kind: "privateText" },
  { default: 1, key: "durationDays", kind: "durationDays" },
  { default: "email", key: "fields", kind: "contactFields" },
  { key: "hidden", kind: "switch" },
  {
    default: 0,
    feature: "builder",
    key: "initialSiteMonths",
    kind: "count",
    min: 0,
  },
  {
    default: "standard",
    key: "listingType",
    kind: "listingType",
  },
  { key: "location", kind: "privateText" },
  { key: "maxAttendees", kind: "count", min: 1, required: true },
  { default: 90, key: "maximumDaysAfter", kind: "count", min: 0 },
  { default: 0, key: "maxPrice", kind: "price" },
  { default: 1, key: "maxQuantity", kind: "count", min: 1 },
  { default: 1, key: "minimumDaysBefore", kind: "count", min: 0 },
  // The smallest quantity above none that one purchase can book.
  { default: 1, key: "minQuantity", kind: "count", min: 1 },
  {
    default: 0,
    feature: "builder",
    key: "monthsPerUnit",
    kind: "count",
    min: 0,
  },
  { key: "name", kind: "name", required: true },
  { key: "nonTransferable", kind: "switch" },
  { key: "purchaseOnly", kind: "switch" },
  // A subscription offer: the recurring price each period, and its interval.
  // A price of 0 with no interval means the listing takes no subscriptions.
  {
    default: "",
    feature: "subscriptions",
    key: "recurringInterval",
    kind: "recurringInterval",
  },
  {
    default: 0,
    feature: "subscriptions",
    key: "recurringPrice",
    kind: "price",
  },
  { key: "thankYouUrl", kind: "privateText" },
  { default: 0, key: "unitPrice", kind: "price" },
  // On, the fields the operator's listing defaults cover follow the settings
  // live instead of this row's own values.
  // This switch also changes the webhook that a listing uses.
  { key: "useDefaults", kind: "switch", lockedFor: ["editor"] },
  // On (with logistics enabled), the listing is dropped off and collected, so
  // its attendees carry logistics agents.
  { feature: "logistics", key: "usesLogistics", kind: "switch" },
  // The registration webhook posts full attendee personal data to this URL.
  {
    key: "webhookUrl",
    kind: "privateText",
    lockedFor: ["demo", "editor"],
  },
] as const satisfies FieldSpecs;
/* jscpd:ignore-end */

/** The body keys of a listing write that link other records. They are not
 *  columns, so no field kind reads them. Each one carries the same access
 *  rule as a field. Only an owner assigns attribute options. */
export const LISTING_LINK_KEYS = [
  {
    feature: "attributes",
    key: "attributeOptionIds",
    lockedFor: ["nonOwner"],
  },
  { key: "childListingIds" },
  { key: "groupIds" },
] as const satisfies readonly KeyAccess[];

/** Every key of a listing write that carries an access rule. */
export const LISTING_WRITE_KEYS: readonly KeyAccess[] = [
  ...LISTING_FIELDS,
  ...LISTING_LINK_KEYS,
];

/** Listing input fields for create/update (camelCase). */
export interface ListingInput
  extends CatalogInput,
    Omit<OptionalFieldsInput<typeof LISTING_FIELDS>, "name"> {
  /** The attachment pair, which the upload routes write. */
  attachmentName?: string | undefined;
  attachmentUrl?: string | undefined;
  /** Transient selected attribute option ids. The listing_attribute_options
   * table stores them. */
  attributeOptionIds?: number[] | undefined;
  /** Transient group membership that the write submits. The group_listings table
   * stores it. An absent set leaves the stored links untouched. */
  groupIds?: number[] | undefined;
  maxAttendees: number;
  maxPrice: number;
  /** The group set every validator judges: the membership as it stands after
   * the write. The JSON API update sets it — the stored set when the body
   * omits group_ids. Paths that submit the whole picture (form, create,
   * import) leave it unset, and validators fall back to groupIds. */
  wouldBeGroupIds?: number[];
}

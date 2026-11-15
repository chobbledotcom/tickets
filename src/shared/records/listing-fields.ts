/** The listing fields. The stored row, the write input, and the table columns
 *  derive from this one list. So do the API check and read, the form read,
 *  and the catalogue transfer. The listing pages keep their own form. */

import { VALID_DAY_NAMES } from "#shared/day-names.ts";
import type { CatalogInput } from "#shared/records/catalog-input.ts";
import type {
  FieldSpecs,
  OptionalFieldsInput,
} from "#shared/rest/field-specs.ts";

/* jscpd:ignore-start -- a list of field records, not code */
export const LISTING_FIELDS = [
  // Only staff change the bookable state.
  { default: true, key: "active", kind: "switch", lockedFor: ["editor"] },
  { feature: "builder", key: "assign_built_site", kind: "switch" },
  // A child listing with this switch on keeps its own booking page, catalog
  // entry, and API eligibility. Off, it exists only as a foldable add-on.
  { key: "bookable_alone", kind: "switch" },
  {
    default: VALID_DAY_NAMES,
    key: "bookable_days",
    kind: "weekdays",
  },
  { key: "can_pay_more", kind: "switch" },
  { key: "closes_at", kind: "optionalDatetime" },
  { key: "customisable_days", kind: "switch" },
  { key: "date", kind: "datetime" },
  { key: "day_prices", kind: "dayPrices" },
  { key: "description", kind: "privateText" },
  { default: 1, key: "duration_days", kind: "durationDays" },
  { default: "email", key: "fields", kind: "contactFields" },
  { key: "hidden", kind: "switch" },
  {
    default: 0,
    feature: "builder",
    key: "initial_site_months",
    kind: "count",
    min: 0,
  },
  {
    default: "standard",
    key: "listing_type",
    kind: "listingType",
  },
  { key: "location", kind: "privateText" },
  { key: "max_attendees", kind: "count", min: 1, required: true },
  { default: 90, key: "maximum_days_after", kind: "count", min: 0 },
  { default: 0, key: "max_price", kind: "price" },
  { default: 1, key: "max_quantity", kind: "count", min: 1 },
  { default: 1, key: "minimum_days_before", kind: "count", min: 0 },
  // The smallest quantity above none that one purchase can book.
  { default: 1, key: "min_quantity", kind: "count", min: 1 },
  {
    default: 0,
    feature: "builder",
    key: "months_per_unit",
    kind: "count",
    min: 0,
  },
  { key: "name", kind: "name", required: true },
  { key: "non_transferable", kind: "switch" },
  { key: "purchase_only", kind: "switch" },
  { key: "thank_you_url", kind: "privateText" },
  { default: 0, key: "unit_price", kind: "price" },
  // On, the fields the operator's listing defaults cover follow the settings
  // live instead of this row's own values.
  // This switch also changes the webhook that a listing uses.
  { key: "use_defaults", kind: "switch", lockedFor: ["editor"] },
  // On (with logistics enabled), the listing is dropped off and collected, so
  // its attendees carry logistics agents.
  { feature: "logistics", key: "uses_logistics", kind: "switch" },
  // The registration webhook posts full attendee personal data to this URL.
  {
    key: "webhook_url",
    kind: "privateText",
    lockedFor: ["demo", "editor"],
  },
] as const satisfies FieldSpecs;
/* jscpd:ignore-end */

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

/** The group fields. The stored row, the write input, and the table columns
 *  derive from this one list. So do the API check and read, the form read,
 *  and the catalogue transfer. The group pages keep their own form. */

import type { CatalogInput } from "#shared/records/catalog-input.ts";
import type {
  FieldSpecs,
  OptionalFieldsInput,
} from "#shared/rest/field-specs.ts";
import type { DayPrices } from "#types";

/* jscpd:ignore-start -- a list of field records, not code */
export const GROUP_FIELDS = [
  { key: "description", kind: "privateText" },
  { key: "hidden", kind: "switch" },
  // On (for a package), the member listings are hidden from buyers, tickets,
  // and confirmation emails. Only admins see the breakdown.
  { key: "hidePackageListings", kind: "switch" },
  // On, the group is a bookable package: its members can carry price
  // overrides and fixed quantities for each package.
  { key: "isPackage", kind: "switch" },
  { default: 0, key: "maxAttendees", kind: "count", min: 0 },
  { key: "name", kind: "name", required: true },
  // On, one group scan checks in every member listing the ticket holds.
  { key: "scanChecksInAllListings", kind: "switch" },
  // On, the group's booking page also offers hidden member listings. Off, a
  // hidden member is bookable only through its direct link. A package keeps
  // its members either way.
  { default: true, key: "showHiddenListings", kind: "switch" },
  { key: "termsAndConditions", kind: "privateText" },
] as const satisfies FieldSpecs;
/* jscpd:ignore-end */

/** A package member's price, quantity, and per-day overrides. */
export interface PackageMemberInput {
  dayPrices?: DayPrices | undefined;
  listingId: number;
  /** `null` uses the listing price. `0` makes this member free. */
  price: number | null;
  /** The units one package grants of this member. The write statement lifts a
   *  missing value to one unit. */
  quantity?: number;
}

/** Group input fields for create/update (camelCase). */
export interface GroupInput
  extends CatalogInput,
    Omit<OptionalFieldsInput<typeof GROUP_FIELDS>, "name"> {
  /** Absent leaves existing package rows untouched. An empty array clears them. */
  packageMembers?: PackageMemberInput[] | undefined;
}

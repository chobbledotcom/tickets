/**
 * Lightweight listing field parsing - no heavy dependencies.
 * Shared by client bundle (admin.ts) and server code.
 */

import { commaParts } from "#shared/split.ts";
import {
  CONTACT_FIELDS,
  type ContactField,
  isContactField,
  type ListingFields,
} from "#types";

/** Parse a comma-separated fields string into individual ContactField names */
export const parseListingFields = (fields: ListingFields): ContactField[] =>
  commaParts(fields).filter(isContactField);

/** Ensure "email" is included in an listing fields setting */
export const withRequiredEmail = (fields: ListingFields): ListingFields => {
  const parsed = parseListingFields(fields);
  return parsed.includes("email") ? fields : ["email", ...parsed].join(",");
};

/**
 * Determine which contact fields to collect for multiple listings.
 * Returns the union of all field settings, sorted by canonical CONTACT_FIELDS order.
 */
export const mergeListingFields = (
  fieldSettings: ListingFields[],
): ListingFields => {
  if (fieldSettings.length === 0) return "";
  const allFields = new Set<string>();
  for (const setting of fieldSettings) {
    for (const f of parseListingFields(setting)) {
      allFields.add(f);
    }
  }
  return CONTACT_FIELDS.filter((f) => allFields.has(f)).join(",");
};

/** The merged contact-fields setting for a page's listings: every listing's
 * own setting, folded into one. Takes anything with a listing that names its
 * contact fields, so this module stays free of booking-model imports. */
export const getTicketFieldsSetting = (
  listings: ReadonlyArray<{ listing: { fields: ListingFields } }>,
): ListingFields => mergeListingFields(listings.map((e) => e.listing.fields));

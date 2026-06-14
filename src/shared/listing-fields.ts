/**
 * Lightweight listing field parsing - no heavy dependencies.
 * Shared by client bundle (admin.ts) and server code.
 */

import {
  CONTACT_FIELDS,
  type ContactField,
  isContactField,
  type ListingFields,
} from "#shared/types.ts";

/** Parse a comma-separated fields string into individual ContactField names */
export const parseListingFields = (fields: ListingFields): ContactField[] =>
  fields
    ? fields
        .split(",")
        .map((f) => f.trim())
        .filter(isContactField)
    : [];

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

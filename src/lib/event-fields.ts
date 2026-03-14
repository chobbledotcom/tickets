/**
 * Lightweight event field parsing - no heavy dependencies.
 * Shared by client bundle (admin.ts) and server code.
 */

import { CONTACT_FIELDS, isContactField, type ContactField, type EventFields } from "#lib/types.ts";

/** Parse a comma-separated fields string into individual ContactField names */
export const parseEventFields = (fields: EventFields): ContactField[] =>
  fields
    ? fields.split(",").map((f) => f.trim()).filter(isContactField)
    : [];

/**
 * Determine which contact fields to collect for multiple events.
 * Returns the union of all field settings, sorted by canonical CONTACT_FIELDS order.
 */
export const mergeEventFields = (fieldSettings: EventFields[]): EventFields => {
  if (fieldSettings.length === 0) return "email";
  const allFields = new Set<string>();
  for (const setting of fieldSettings) {
    for (const f of parseEventFields(setting)) {
      allFields.add(f);
    }
  }
  return CONTACT_FIELDS.filter((f) => allFields.has(f)).join(",");
};

/**
 * Demo-mode form overrides: which fields get sample values, and the helpers
 * that swap submitted values for samples when demo mode is on.
 */

import { isDemoMode } from "#shared/demo/mode.ts";
import {
  DEMO_ADDRESSES,
  DEMO_EMAILS,
  DEMO_GROUP_DESCRIPTIONS,
  DEMO_GROUP_NAMES,
  DEMO_HOLIDAY_NAMES,
  DEMO_LISTING_DESCRIPTIONS,
  DEMO_LISTING_LOCATIONS,
  DEMO_LISTING_NAMES,
  DEMO_NAMES,
  DEMO_PAGE_TEXT,
  DEMO_PHONES,
  DEMO_SERVICING_NAMES,
  DEMO_SPECIAL_INSTRUCTIONS,
  DEMO_TERMS,
  DEMO_WEBSITE_TITLES,
  randomChoice,
} from "#shared/demo/samples.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { FieldValues } from "#shared/forms.tsx";
import type { NamedResource } from "#shared/rest/resource.ts";

/** Maps form field names to arrays of possible demo values */
export type DemoFieldMap = Record<string, readonly string[]>;

/** Attendee PII fields */
export const ATTENDEE_DEMO_FIELDS: DemoFieldMap = {
  address: DEMO_ADDRESSES,
  email: DEMO_EMAILS,
  name: DEMO_NAMES,
  phone: DEMO_PHONES,
  special_instructions: DEMO_SPECIAL_INSTRUCTIONS,
};

/** Servicing-event fields — name only, and a servicing reason rather than a
 * person's name, so demo mode doesn't turn "Boiler Service" into "Bob Smith". */
export const SERVICING_DEMO_FIELDS: DemoFieldMap = {
  name: DEMO_SERVICING_NAMES,
};

/** Listing metadata fields */
export const LISTING_DEMO_FIELDS: DemoFieldMap = {
  description: DEMO_LISTING_DESCRIPTIONS,
  location: DEMO_LISTING_LOCATIONS,
  name: DEMO_LISTING_NAMES,
};

/** Group name and description fields */
export const GROUP_DEMO_FIELDS: DemoFieldMap = {
  description: DEMO_GROUP_DESCRIPTIONS,
  name: DEMO_GROUP_NAMES,
};

/** Holiday name field */
export const HOLIDAY_DEMO_FIELDS: DemoFieldMap = {
  name: DEMO_HOLIDAY_NAMES,
};

/** Site homepage fields */
export const SITE_HOME_DEMO_FIELDS: DemoFieldMap = {
  homepage_text: DEMO_PAGE_TEXT,
  website_title: DEMO_WEBSITE_TITLES,
};

/** Attendee Logistics tab fields: the address is masked like the attendee
 * form's, and the pinned latitude/longitude are cleared outright — an exact
 * real-world location is PII even beside a masked address. */
export const LOGISTICS_DEMO_FIELDS: DemoFieldMap = {
  address: DEMO_ADDRESSES,
  lat: [""],
  lng: [""],
};

/** Site contact page fields */
export const SITE_CONTACT_DEMO_FIELDS: DemoFieldMap = {
  contact_page_text: DEMO_PAGE_TEXT,
};

/** Terms and conditions field */
export const TERMS_DEMO_FIELDS: DemoFieldMap = {
  terms_and_conditions: DEMO_TERMS,
};

/**
 * Replace form field values with demo data when demo mode is active.
 * Only replaces fields that are present and non-empty in the form.
 * Mutates and returns the same URLSearchParams for chaining.
 */
export const applyDemoOverrides = (
  form: FormParams,
  mapping: DemoFieldMap,
): FormParams => {
  if (!isDemoMode()) return form;
  for (const [field, values] of Object.entries(mapping)) {
    if (form.has(field) && form.get(field) !== "") {
      form.set(field, randomChoice(values));
    }
  }
  return form;
};

/** Wrap a named resource so create/update apply demo overrides to the form */
export const wrapResourceForDemo = <R, I, V extends FieldValues = FieldValues>(
  resource: NamedResource<R, I, V>,
  mapping: DemoFieldMap,
): NamedResource<R, I, V> => ({
  ...resource,
  create: (form) => resource.create(applyDemoOverrides(form, mapping)),
  update: (id, form) => resource.update(id, applyDemoOverrides(form, mapping)),
});

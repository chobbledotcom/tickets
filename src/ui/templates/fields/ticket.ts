/**
 * Ticket (public booking) and contact form fields.
 *
 * Tickets always have a name; the rest of the contact fields are driven by a
 * listing's `fields` setting (a comma-separated list of contact field names).
 * When a paid listing uses Square, email is forced on because Square requires
 * an email per checkout — `withRequiredEmail` upgrades the parsed list.
 */

import { CONFIG_KEYS, settings } from "#db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import type { Field } from "#shared/forms/field.ts";
import { validateForm } from "#shared/forms/validation.ts";
import {
  parseListingFields,
  withRequiredEmail,
} from "#shared/listing-fields.ts";
import { renderAddressLookupPanel } from "#templates/components/address-lookup.tsx";
import {
  MAX_ADDRESS_LENGTH,
  MAX_SPECIAL_INSTRUCTIONS_LENGTH,
  validateAddress,
  validateEmail,
  validatePhone,
  validateSpecialInstructions,
} from "#templates/fields/validators.ts";
import type { ContactField, ContactInfo, ListingFields } from "#types";

/** Typed values from the public ticket form (field presence varies by listing config). */
export type TicketFormValues = {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  special_instructions: string | null;
};

/** Re-exported for callers that build ticket values then derive contact info. */
export type { ContactInfo };

/** Name field shown on all ticket forms */
const nameField: Field = {
  autocomplete: "name",
  label: "Your Name",
  name: "name",
  required: true,
  type: "text",
};

/** Email field for ticket forms */
const emailField: Field = {
  autocomplete: "email",
  label: "Your Email",
  name: "email",
  required: true,
  type: "email",
  validate: validateEmail,
};

/**
 * HTML `pattern` attribute for the phone input. Browsers compile `pattern` with
 * the RegExp `v` flag, under which an unescaped `(` `)` inside a character class
 * is a syntax error — so the parens are escaped. Shared between the ticket
 * phone field and the admin attendee form so the two can't drift.
 */
export const PHONE_INPUT_PATTERN = "[+\\d][\\d\\s\\-\\(\\)]{5,}";

/**
 * HTML `pattern` attribute for the subdomain input (a DNS label). Escaped for
 * the same `v`-flag reason (a literal `-` in a character class must be escaped).
 */
export const SUBDOMAIN_INPUT_PATTERN = "[a-z0-9]([a-z0-9\\-]{0,61}[a-z0-9])?";

/** Phone field for ticket forms */
const phoneField: Field = {
  autocomplete: "tel",
  label: "Your Phone Number",
  name: "phone",
  pattern: PHONE_INPUT_PATTERN,
  required: true,
  title:
    "Phone number (digits, spaces, hyphens, parentheses, optional leading +)",
  type: "text",
  validate: validatePhone,
};

/** Address field for ticket forms (textarea) */
const addressField: Field = {
  autocomplete: "street-address",
  label: "Your Address",
  maxlength: MAX_ADDRESS_LENGTH,
  name: "address",
  required: true,
  type: "textarea",
  validate: validateAddress,
};

/** Special instructions field for ticket forms (textarea) */
const specialInstructionsField: Field = {
  label: "Special Instructions",
  maxlength: MAX_SPECIAL_INSTRUCTIONS_LENGTH,
  name: "special_instructions",
  required: true,
  type: "textarea",
  validate: validateSpecialInstructions,
};

/** Map of contact field names to their Field definitions */
const contactFieldMap: Record<ContactField, Field> = {
  address: addressField,
  email: emailField,
  phone: phoneField,
  special_instructions: specialInstructionsField,
};

/** Stubbable API for testing */
export const fieldsApi = { getSettingCached: settings.getCachedRaw };

/**
 * Give the address field its postcode search panel when a lookup provider is
 * configured (no provider ⇒ the plain textarea, unchanged).
 */
const withAddressLookup = (field: Field): Field => {
  const panel = renderAddressLookupPanel();
  return panel ? { ...field, beforeHtml: panel } : field;
};

/** Resolve one contact field, attaching the address search panel. */
const resolveContactField = (name: ContactField): Field =>
  name === "address"
    ? withAddressLookup(contactFieldMap[name])
    : contactFieldMap[name];

/**
 * Get ticket form fields based on listing fields setting.
 * Always includes name. Adds contact fields based on the comma-separated setting.
 * When isPaid is true and Square is the active provider, email is always included
 * because Square requires an email address for checkout.
 * The address field carries the postcode search panel (always editable) when a
 * lookup provider is configured.
 */
export const getTicketFields = (
  fields: ListingFields,
  isPaid: boolean,
): Field[] => {
  const effective =
    isPaid &&
    fieldsApi.getSettingCached(CONFIG_KEYS.PAYMENT_PROVIDER) === "square"
      ? withRequiredEmail(fields)
      : fields;
  const parsed = parseListingFields(effective);
  return [nameField, ...parsed.map(resolveContactField)];
};

/** Validate ticket fields, mapping validation failure to a response via onError */
export const tryValidateTicketFields = (
  form: FormParams,
  fieldsSetting: ListingFields,
  onError: (message: string) => Response,
  isPaid: boolean,
): TicketFormValues | Response => {
  const result = validateForm<TicketFormValues>(
    form,
    getTicketFields(fieldsSetting, isPaid),
  );
  return result.valid ? result.values : onError(result.error);
};

/** Extract contact details from validated ticket form values */
export const extractContact = (values: TicketFormValues): ContactInfo => ({
  address: values.address || "",
  email: values.email || "",
  name: values.name,
  phone: values.phone || "",
  special_instructions: values.special_instructions || "",
});

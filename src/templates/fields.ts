/**
 * Form field definitions and typed value interfaces for all forms
 */

import { t } from "#i18n";
import { formatCurrency } from "#lib/currency.ts";
import { DAY_NAMES } from "#lib/dates.ts";
import { CONFIG_KEYS, getSettingCached } from "#lib/db/settings.ts";
import {
  mergeEventFields,
  parseEventFields,
  withRequiredEmail,
} from "#lib/event-fields.ts";
import type { FormParams } from "#lib/form-data.ts";
import { type Field, validateForm } from "#lib/forms.tsx";
import {
  formatBytes,
  MAX_ATTACHMENT_SIZE,
  MAX_IMAGE_SIZE,
} from "#lib/limits.ts";
import { normalizeSlug, validateSlug } from "#lib/slug.ts";
import { isValidDatetime } from "#lib/timezone.ts";
import {
  type AdminLevel,
  type ContactField,
  type ContactInfo,
  type EventFields,
  type EventType,
  isContactField,
  isEventType,
} from "#lib/types.ts";

// ---------------------------------------------------------------------------
// Typed form value interfaces
//
// Each interface describes the shape returned by validateForm<T>() for a
// specific set of field definitions.  Required text fields produce `string`,
// optional text fields produce `string` (empty string when absent),
// required number fields produce `number`, and optional number fields
// produce `number | null`.
// ---------------------------------------------------------------------------

/** Typed values from event form validation */
export type EventFormValues = {
  name: string;
  description: string;
  date: string;
  location: string;
  max_attendees: number;
  max_quantity: number;
  fields: EventFields | "";
  unit_price: string;
  closes_at: string;
  thank_you_url: string;
  webhook_url: string;
  event_type: EventType | "";
  bookable_days: string;
  minimum_days_before: number | null;
  maximum_days_after: number | null;
  non_transferable: string;
  group_id: string;
  can_pay_more: string;
  max_price: string;
  hidden: string;
};

/** Typed values from event edit form (includes slug) */
export type EventEditFormValues = EventFormValues & {
  slug: string;
};

/** Typed values from group create form validation (no slug - auto-generated) */
export type GroupCreateFormValues = {
  name: string;
  terms_and_conditions: string;
  max_attendees: number | null;
};

/** Typed values from group edit form validation (includes slug) */
export type GroupFormValues = {
  name: string;
  slug: string;
  terms_and_conditions: string;
  max_attendees: number | null;
};

/** Typed values from ticket form (field presence varies by event config) */
export type TicketFormValues = {
  name: string;
  email: string | null;
  phone: string | null;
  address: string | null;
  special_instructions: string | null;
};

/** Typed values from admin add-attendee form */
export type AddAttendeeFormValues = TicketFormValues & {
  quantity: number;
  date: string;
};

/** Typed values from login form */
export type LoginFormValues = {
  username: string;
  password: string;
};

/** Typed values from setup form */
export type SetupFormValues = {
  admin_username: string;
  admin_password: string;
  admin_password_confirm: string;
};

/** Typed values from change password form */
export type ChangePasswordFormValues = {
  current_password: string;
  new_password: string;
  new_password_confirm: string;
};

/** Typed values from Stripe key form */
export type StripeKeyFormValues = {
  stripe_secret_key: string;
};

/** Typed values from Square access token form */
export type SquareTokenFormValues = {
  square_access_token: string;
  square_location_id: string;
};

/** Typed values from Square webhook form */
export type SquareWebhookFormValues = {
  square_webhook_signature_key: string;
};

/** Typed values from invite user form */
export type InviteUserFormValues = {
  username: string;
  admin_level: AdminLevel;
};

/** Typed values from join (set password) form */
export type JoinFormValues = {
  password: string;
  password_confirm: string;
};

/**
 * Validate URL is safe (https or relative path, no javascript: etc.)
 */
const validateSafeUrl = (value: string): string | null => {
  // Allow relative URLs starting with /
  if (value.startsWith("/")) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return t("error.url_https");
    }
    return null;
  } catch {
    return t("error.url_invalid");
  }
};

/**
 * Validate price is non-negative
 */
const validateNonNegativePrice = (value: string): string | null => {
  const num = Number.parseFloat(value);
  if (Number.isNaN(num) || num < 0) {
    return t("error.price_negative");
  }
  return null;
};

/**
 * Validate email format
 */
export const validateEmail = (value: string): string | null => {
  // Basic email format check - more permissive than strict RFC but catches common issues
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(value)) {
    return t("error.email_invalid");
  }
  return null;
};

/**
 * Validate phone number format
 */
export const validatePhone = (value: string): string | null => {
  // Allow digits, spaces, hyphens, parentheses, plus sign
  const phoneRegex = /^[+\d][\d\s\-()]{5,}$/;
  if (!phoneRegex.test(value)) {
    return t("error.phone_invalid");
  }
  return null;
};

/** Validate username format: alphanumeric, hyphens, underscores, 2-32 chars */
export const validateUsername = (value: string): string | null => {
  if (value.length < 2) return t("error.username_min");
  if (value.length > 32) return t("error.username_max");
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    return t("error.username_chars");
  }
  return null;
};

/** Base username field shared across login and invite forms */
const usernameFieldBase: Field = {
  name: "username",
  label: t("login.username"),
  type: "text",
  required: true,
};

/**
 * Login form field definitions
 */
export const loginFields: Field[] = [
  { ...usernameFieldBase, autocomplete: "username" },
  {
    name: "password",
    label: t("login.password"),
    type: "password",
    required: true,
    autocomplete: "current-password",
  },
];

/** Validate event fields setting (comma-separated contact field names) */
const validateEventFields = (value: string): string | null => {
  const parts = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v);
  for (const part of parts) {
    if (!isContactField(part)) {
      return t("error.contact_field_invalid", { field: part });
    }
  }
  return null;
};

/** Validate event type setting */
const validateEventType = (value: string): string | null => {
  if (!isEventType(value)) {
    return t("error.event_type_invalid");
  }
  return null;
};

/** Valid day names for bookable_days (Monday-first for display) */
export const VALID_DAY_NAMES = [...DAY_NAMES.slice(1), DAY_NAMES[0]!];

/** Check if a string is a valid day name */
const isValidDayName = (s: string): boolean =>
  (VALID_DAY_NAMES as readonly string[]).includes(s);

/** Split a comma-separated string into trimmed, non-empty tokens */
export const splitCsv = (value: string): string[] =>
  value
    .split(",")
    .map((d) => d.trim())
    .filter((d) => d);

/** Validate bookable days (comma-separated day names) */
export const validateBookableDays = (value: string): string | null => {
  const days = splitCsv(value);
  if (days.length === 0) return t("error.day_required");
  for (const day of days) {
    if (!isValidDayName(day)) {
      return t("error.day_invalid", { day, days: VALID_DAY_NAMES.join(", ") });
    }
  }
  return null;
};

/** Shared formatting hint linking to the admin guide */
export const FORMATTING_HINT =
  '<a href="/admin/guide#text-formatting">Formatting help</a>';

/** Max length for event description */
const MAX_DESCRIPTION_LENGTH = 256;

/** Validate description length */
const validateDescription = (value: string): string | null =>
  value.length > MAX_DESCRIPTION_LENGTH ? t("error.description_length") : null;

/** Validate a datetime value is parseable */
const validateDatetime = (value: string): string | null =>
  isValidDatetime(value) ? null : t("error.datetime_invalid");

/**
 * Event form field definitions (shared between create and edit)
 */
export const eventFields: Field[] = [
  {
    name: "name",
    label: t("fields.event.name"),
    type: "text",
    required: true,
    placeholder: t("fields.event.name_placeholder"),
    hint: t("fields.event.name_hint"),
  },
  {
    name: "event_type",
    label: t("fields.event.type"),
    type: "select",
    hint: t("fields.event.type_hint"),
    options: [
      { value: "standard", label: t("fields.event.type_standard") },
      { value: "daily", label: t("fields.event.type_daily") },
    ],
    validate: validateEventType,
  },
  {
    name: "description",
    label: t("fields.event.description"),
    type: "text",
    placeholder: t("fields.event.description_placeholder"),
    hint: t("fields.event.description_hint"),
    hintHtml: FORMATTING_HINT,
    maxlength: MAX_DESCRIPTION_LENGTH,
    validate: validateDescription,
  },
  {
    name: "date",
    label: t("fields.event.date"),
    type: "datetime",
    hint: t("fields.event.date_hint"),
    validate: validateDatetime,
  },
  {
    name: "location",
    label: t("fields.event.location"),
    type: "text",
    placeholder: t("fields.event.location_placeholder"),
    hint: t("fields.event.location_hint"),
  },
  {
    name: "max_attendees",
    label: t("fields.event.max_attendees"),
    type: "number",
    required: true,
    min: 1,
    hint: t("fields.event.max_attendees_hint"),
  },
  {
    name: "max_quantity",
    label: t("fields.event.max_quantity"),
    type: "number",
    required: true,
    min: 1,
    hint: t("fields.event.max_quantity_hint"),
  },
  {
    name: "bookable_days",
    label: t("fields.event.bookable_days"),
    type: "checkbox-group",
    hint: t("fields.event.bookable_days_hint"),
    options: VALID_DAY_NAMES.map((d) => ({ value: d, label: d })),
    validate: validateBookableDays,
  },
  {
    name: "minimum_days_before",
    label: t("fields.event.min_days_notice"),
    type: "number",
    min: 0,
    hint: t("fields.event.min_days_notice_hint"),
  },
  {
    name: "maximum_days_after",
    label: t("fields.event.max_days_ahead"),
    type: "number",
    min: 0,
    hint: t("fields.event.max_days_ahead_hint"),
  },
  {
    name: "fields",
    label: t("fields.event.contact_fields"),
    type: "checkbox-group",
    hint: t("fields.event.contact_fields_hint"),
    options: [
      { value: "email", label: t("fields.event.contact_email") },
      { value: "phone", label: t("fields.event.contact_phone") },
      { value: "address", label: t("fields.event.contact_address") },
      {
        value: "special_instructions",
        label: t("fields.event.contact_special"),
      },
    ],
    validate: validateEventFields,
  },
  {
    name: "unit_price",
    label: t("fields.event.price"),
    type: "text",
    inputmode: "decimal",
    placeholder: t("fields.event.price_placeholder"),
    validate: validateNonNegativePrice,
  },
  {
    name: "can_pay_more",
    label: t("fields.event.allow_pay_more"),
    type: "checkbox-group",
    hint: t("fields.event.allow_pay_more_hint"),
    options: [{ value: "1", label: t("fields.event.allow_pay_more_label") }],
  },
  {
    name: "max_price",
    label: t("fields.event.max_price"),
    type: "text",
    inputmode: "decimal",
    placeholder: t("fields.event.max_price_placeholder"),
    defaultValue: "100.00",
    get hint() {
      return t("fields.event.max_price_hint", { amount: formatCurrency(100) });
    },
    validate: validateNonNegativePrice,
  },
  {
    name: "closes_at",
    label: t("fields.event.registration_closes"),
    type: "datetime",
    hint: t("fields.event.registration_closes_hint"),
    validate: validateDatetime,
  },
  {
    name: "thank_you_url",
    label: t("fields.event.thank_you_url"),
    type: "url",
    placeholder: "https://example.com/thank-you",
    hint: t("fields.event.thank_you_url_hint"),
    validate: validateSafeUrl,
  },
  {
    name: "webhook_url",
    label: t("fields.event.webhook_url"),
    type: "url",
    placeholder: "https://example.com/webhook",
    hint: t("fields.event.webhook_url_hint"),
    validate: validateSafeUrl,
  },
  {
    name: "non_transferable",
    label: t("fields.event.non_transferable"),
    type: "select",
    hint: t("fields.event.non_transferable_hint"),
    options: [
      { value: "", label: t("common.no") },
      { value: "1", label: t("common.yes") },
    ],
  },
  {
    name: "hidden",
    label: t("fields.event.hidden"),
    type: "checkbox-group",
    hint: t("fields.event.hidden_hint"),
    options: [{ value: "1", label: t("fields.event.hidden_label") }],
  },
];

/** Validate date format (YYYY-MM-DD) */
export const validateDate = (value: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return t("error.date_format_invalid");
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return t("error.date_invalid");
  return null;
};

/**
 * Holiday form field definitions
 */
export const holidayFields: Field[] = [
  {
    name: "name",
    label: t("holidays.fields.name"),
    type: "text",
    required: true,
    placeholder: t("holidays.fields.name_placeholder"),
  },
  {
    name: "start_date",
    label: t("holidays.fields.start_date"),
    type: "date",
    required: true,
    validate: validateDate,
  },
  {
    name: "end_date",
    label: t("holidays.fields.end_date"),
    type: "date",
    required: true,
    hint: t("holidays.fields.end_date_hint"),
    validate: validateDate,
  },
];

/** Image upload field for event forms (appended when storage is enabled) */
export const imageField: Field = {
  name: "image",
  label: t("fields.event.image", { size: formatBytes(MAX_IMAGE_SIZE) }),
  type: "file",
  accept: "image/jpeg,image/png,image/gif,image/webp",
};

/** Attachment upload field for event forms (appended when storage is enabled) */
export const attachmentField: Field = {
  name: "attachment",
  label: t("fields.event.attachment", {
    size: formatBytes(MAX_ATTACHMENT_SIZE),
  }),
  type: "file",
};

/** Slug field for event/group edit pages */
export const slugField: Field = {
  name: "slug",
  label: t("fields.event.slug"),
  type: "text",
  required: true,
  hint: t("fields.event.slug_hint"),
  validate: (value: string) => validateSlug(normalizeSlug(value)),
};

/** Group selection field (validated even when rendered manually) */
export const groupIdField: Field = {
  name: "group_id",
  label: t("fields.event.group"),
  type: "text",
};

/** Max attendees field for group forms */
const groupMaxAttendeesField: Field = {
  name: "max_attendees",
  label: t("groups.fields.max_attendees"),
  type: "number",
  hint: t("groups.fields.max_attendees_hint"),
};

/** Group form fields for creation (no slug - auto-generated) */
export const groupCreateFields: Field[] = [
  {
    name: "name",
    label: t("groups.fields.name"),
    type: "text",
    required: true,
    placeholder: t("groups.fields.name_placeholder"),
  },
  groupMaxAttendeesField,
  {
    name: "terms_and_conditions",
    label: t("groups.fields.terms"),
    type: "textarea",
    hint: t("groups.fields.terms_hint"),
    hintHtml: FORMATTING_HINT,
  },
];

/** Group form field definitions (edit - includes slug) */
export const groupFields: Field[] = [
  groupCreateFields[0]!,
  slugField,
  groupCreateFields[1]!,
  groupCreateFields[2]!,
];

/** Name field shown on all ticket forms */
const nameField: Field = {
  name: "name",
  label: t("public.ticket.your_name"),
  type: "text",
  required: true,
  autocomplete: "name",
};

/** Email field for ticket forms */
const emailField: Field = {
  name: "email",
  label: t("public.ticket.your_email"),
  type: "email",
  required: true,
  autocomplete: "email",
  validate: validateEmail,
};

/** Phone field for ticket forms */
const phoneField: Field = {
  name: "phone",
  label: t("public.ticket.your_phone"),
  type: "text",
  required: true,
  autocomplete: "tel",
  validate: validatePhone,
};

/** Max length for address field (must fit in payment metadata) */
const MAX_ADDRESS_LENGTH = 250;

/** Validate address length */
export const validateAddress = (value: string): string | null =>
  value.length > MAX_ADDRESS_LENGTH ? t("error.address_length") : null;

/** Address field for ticket forms (textarea) */
const addressField: Field = {
  name: "address",
  label: t("public.ticket.your_address"),
  type: "textarea",
  required: true,
  autocomplete: "street-address",
  validate: validateAddress,
};

/** Max length for special instructions field (must fit in payment metadata) */
const MAX_SPECIAL_INSTRUCTIONS_LENGTH = 250;

/** Validate special instructions length */
export const validateSpecialInstructions = (value: string): string | null =>
  value.length > MAX_SPECIAL_INSTRUCTIONS_LENGTH
    ? t("error.special_instructions_length")
    : null;

/** Special instructions field for ticket forms (textarea) */
const specialInstructionsField: Field = {
  name: "special_instructions",
  label: t("public.ticket.special_instructions"),
  type: "textarea",
  required: true,
  validate: validateSpecialInstructions,
};

/** Map of contact field names to their Field definitions */
const contactFieldMap: Record<ContactField, Field> = {
  email: emailField,
  phone: phoneField,
  address: addressField,
  special_instructions: specialInstructionsField,
};

export { mergeEventFields, parseEventFields };

/** Stubbable API for testing */
export const fieldsApi = { getSettingCached };

/**
 * Get ticket form fields based on event fields setting.
 * Always includes name. Adds contact fields based on the comma-separated setting.
 * When isPaid is true and Square is the active provider, email is always included
 * because Square requires an email address for checkout.
 */
export const getTicketFields = (
  fields: EventFields,
  isPaid: boolean,
): Field[] => {
  const effective =
    isPaid &&
    fieldsApi.getSettingCached(CONFIG_KEYS.PAYMENT_PROVIDER) === "square"
      ? withRequiredEmail(fields)
      : fields;
  const parsed = parseEventFields(effective);
  return [nameField, ...parsed.map((f) => contactFieldMap[f])];
};

/** Validate ticket fields, mapping validation failure to a response via onError */
export const tryValidateTicketFields = (
  form: FormParams,
  fieldsSetting: EventFields,
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
  name: values.name,
  email: values.email || "",
  phone: values.phone || "",
  address: values.address || "",
  special_instructions: values.special_instructions || "",
});

/** Quantity field for admin add-attendee form */
const addAttendeeQuantityField: Field = {
  name: "quantity",
  label: t("admin.attendees.edit.quantity"),
  type: "number",
  required: true,
  min: 1,
};

/** Date field for admin add-attendee form (daily events only) */
const addAttendeeDateField: Field = {
  name: "date",
  label: t("admin.attendee_table.col.date"),
  type: "date",
  required: true,
  validate: validateDate,
};

/**
 * Get admin add-attendee form fields based on event config.
 * Includes contact fields (name + email/phone per setting), quantity,
 * and a date field for daily events.
 */
export const getAddAttendeeFields = (
  fields: EventFields,
  isDaily: boolean,
): Field[] => {
  const result = [...getTicketFields(fields, false), addAttendeeQuantityField];
  if (isDaily) result.push(addAttendeeDateField);
  return result;
};

/**
 * Setup form field definitions
 * Note: Stripe keys are now configured via environment variables
 */
export const setupFields: Field[] = [
  {
    name: "admin_username",
    label: t("fields.setup.username"),
    type: "text",
    required: true,
    hint: t("fields.setup.username_hint"),
    autocomplete: "username",
    validate: validateUsername,
  },
  {
    name: "admin_password",
    label: t("fields.setup.password"),
    type: "password",
    required: true,
    hint: t("fields.setup.password_hint"),
    autocomplete: "new-password",
  },
  {
    name: "admin_password_confirm",
    label: t("fields.setup.confirm_password"),
    type: "password",
    required: true,
    autocomplete: "new-password",
  },
];

/**
 * Change password form field definitions
 */
export const changePasswordFields: Field[] = [
  {
    name: "current_password",
    label: t("password.current"),
    type: "password",
    required: true,
    autocomplete: "current-password",
  },
  {
    name: "new_password",
    label: t("password.new"),
    type: "password",
    required: true,
    hint: t("password.new_hint"),
    autocomplete: "new-password",
  },
  {
    name: "new_password_confirm",
    label: t("password.confirm"),
    type: "password",
    required: true,
    autocomplete: "new-password",
  },
];

/**
 * Stripe key settings form field definitions
 */
export const stripeKeyFields: Field[] = [
  {
    name: "stripe_secret_key",
    label: t("fields.stripe.secret_key"),
    type: "password",
    required: true,
    placeholder: t("fields.stripe.secret_key_placeholder"),
    hint: t("fields.stripe.secret_key_hint"),
  },
];

/**
 * Square access token and location form field definitions
 */
export const squareAccessTokenFields: Field[] = [
  {
    name: "square_access_token",
    label: t("fields.square.access_token"),
    type: "password",
    required: true,
    placeholder: "EAAAl...",
    hint: t("fields.square.access_token_hint"),
  },
  {
    name: "square_location_id",
    label: t("fields.square.location_id"),
    type: "text",
    required: true,
    placeholder: "L...",
    hint: t("fields.square.location_id_hint"),
  },
];

/**
 * Square webhook settings form field definitions
 */
export const squareWebhookFields: Field[] = [
  {
    name: "square_webhook_signature_key",
    label: t("fields.square.webhook_key"),
    type: "password",
    required: true,
    hint: t("fields.square.webhook_key_hint"),
  },
];

/**
 * Invite user form field definitions
 */
export const inviteUserFields: Field[] = [
  {
    ...usernameFieldBase,
    hint: t("users.invite_fields.username_hint"),
    validate: validateUsername,
  },
  {
    name: "admin_level",
    label: t("users.invite_fields.role"),
    type: "select",
    required: true,
    options: [
      { value: "manager", label: t("users.invite_fields.role_manager") },
      { value: "owner", label: t("users.invite_fields.role_owner") },
    ],
  },
];

/**
 * Join (set password) form field definitions
 */
export const joinFields: Field[] = [
  {
    name: "password",
    label: t("join.set_password.password"),
    type: "password",
    required: true,
    hint: t("join.set_password.min_chars"),
    autocomplete: "new-password",
  },
  {
    name: "password_confirm",
    label: t("join.set_password.confirm_password"),
    type: "password",
    required: true,
    autocomplete: "new-password",
  },
];

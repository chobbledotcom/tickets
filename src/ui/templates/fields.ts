/**
 * Form field definitions and typed value interfaces for all forms
 */

import * as v from "valibot";
import { t } from "#i18n";
import { formatCurrency } from "#shared/currency.ts";
import { DAY_NAMES } from "#shared/dates.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import type { FormParams } from "#shared/form-data.ts";
import { type Field, validateForm } from "#shared/forms.tsx";
import {
  formatBytes,
  MAX_ATTACHMENT_SIZE,
  MAX_IMAGE_SIZE,
  MAX_TEXTAREA_LENGTH,
} from "#shared/limits.ts";
import {
  mergeListingFields,
  parseListingFields,
  withRequiredEmail,
} from "#shared/listing-fields.ts";
import { normalizeSlug, validateSlug } from "#shared/slug.ts";
import { isValidDatetime } from "#shared/timezone.ts";
import {
  type AdminLevel,
  type ContactField,
  type ContactInfo,
  isContactField,
  isListingType,
  type ListingFields,
  type ListingType,
  MAX_DURATION_DAYS,
} from "#shared/types.ts";
import { validateSafeServerFetchUrl } from "#shared/url-safety.ts";
import { isIsoDate } from "#shared/validation/date.ts";
import { EmailFormatSchema } from "#shared/validation/email.ts";

// ---------------------------------------------------------------------------
// Typed form value interfaces
//
// Each interface describes the shape returned by validateForm<T>() for a
// specific set of field definitions.  Required text fields produce `string`,
// optional text fields produce `string` (empty string when absent),
// required number fields produce `number`, and optional number fields
// produce `number | null`.
// ---------------------------------------------------------------------------

/** Typed values from listing form validation */
export type ListingFormValues = {
  name: string;
  description: string;
  date: string;
  location: string;
  max_attendees: number;
  max_quantity: number;
  fields: ListingFields | "";
  unit_price: string;
  closes_at: string;
  thank_you_url: string;
  webhook_url: string;
  listing_type: ListingType | "";
  bookable_days: string;
  minimum_days_before: number | null;
  maximum_days_after: number | null;
  duration_days: number | null;
  customisable_days: string;
  non_transferable: string;
  group_id: string;
  can_pay_more: string;
  max_price: string;
  hidden: string;
  purchase_only: string;
  assign_built_site: string;
  months_per_unit: string;
  initial_site_months: string;
};

/** Typed values from listing edit form (includes slug) */
export type ListingEditFormValues = ListingFormValues & {
  slug: string;
};

export type ListingAggregateFormValues = {
  booked_quantity: number;
  tickets_count: number;
};

/** Typed values from group create form validation (no slug - auto-generated) */
export type GroupCreateFormValues = {
  name: string;
  description: string;
  terms_and_conditions: string;
  max_attendees: number | null;
  hidden: string;
};

/** Typed values from group edit form validation (includes slug) */
export type GroupFormValues = GroupCreateFormValues & {
  slug: string;
};

/** Typed values from ticket form (field presence varies by listing config) */
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
  day_count: string;
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

/** Typed values from SumUp settings form */
export type SumupFormValues = {
  sumup_api_key: string;
  sumup_merchant_code: string;
};

/** Typed values from invite user form */
export type InviteUserFormValues = {
  username: string;
  admin_level: AdminLevel;
};

/**
 * Validate a user-saved URL that must point at a public https:// domain.
 */
const validateHttpsDomainUrl = (value: string): string | null =>
  validateSafeServerFetchUrl(value, t("fields.validation.url_https"));

/**
 * Validate price is non-negative
 */
const validateNonNegativePrice = (value: string): string | null => {
  const num = Number.parseFloat(value);
  if (Number.isNaN(num) || num < 0) {
    return t("fields.validation.price_min");
  }
  return null;
};

const validateNonNegativeInteger =
  (label: string) =>
  (value: string): string | null => {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0
      ? null
      : `${label} must be 0 or greater`;
  };

/**
 * Validate email format
 */
export const validateEmail = (value: string): string | null =>
  v.safeParse(EmailFormatSchema, value).success
    ? null
    : t("fields.validation.email");

/**
 * Validate phone number format
 */
const PhoneSchema = v.pipe(
  v.string(),
  // Allow digits, spaces, hyphens, parentheses, plus sign
  v.regex(/^[+\d][\d\s\-()]{5,}$/),
);

export const validatePhone = (value: string): string | null =>
  v.safeParse(PhoneSchema, value).success ? null : t("fields.validation.phone");

/** Validate username format: alphanumeric, hyphens, underscores, 2-32 chars */
const UsernameSchema = v.pipe(
  v.string(),
  v.minLength(2, () => t("fields.validation.username_min")),
  v.maxLength(32, () => t("fields.validation.username_max")),
  v.regex(/^[a-zA-Z0-9_-]+$/, () => t("fields.validation.username_chars")),
  v.check(
    (s) => !s.startsWith("-") && !s.startsWith("_"),
    () => t("fields.validation.username_start"),
  ),
);

export const validateUsername = (value: string): string | null => {
  const result = v.safeParse(UsernameSchema, value, { abortPipeEarly: true });
  return result.success ? null : result.issues[0].message;
};

/** Base username field shared across login and invite forms */
const getUsernameFieldBase = (): Field => ({
  label: t("common.username"),
  maxlength: 32,
  minlength: 2,
  name: "username",
  pattern: "[a-zA-Z0-9_-]+",
  required: true,
  title: t("fields.login.username_title"),
  type: "text",
});

/** Validate listing fields setting (comma-separated contact field names) */
const validateListingFields = (value: string): string | null => {
  const parts = value
    .split(",")
    .map((v) => v.trim())
    .filter((v) => v);
  for (const part of parts) {
    if (!isContactField(part)) {
      return t("fields.validation.invalid_contact_field", { part });
    }
  }
  return null;
};

/** Validate listing type setting */
const validateListingType = (value: string): string | null => {
  if (!isListingType(value)) {
    return t("fields.validation.listing_type");
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
  if (days.length === 0) return t("fields.validation.days_required");
  for (const day of days) {
    if (!isValidDayName(day)) {
      return t("fields.validation.invalid_day", {
        day,
        valid: VALID_DAY_NAMES.join(", "),
      });
    }
  }
  return null;
};

/** Shared formatting hint linking to the admin guide */
export const FORMATTING_HINT =
  '<a href="/admin/guide#text-formatting" target="_blank" rel="noopener">Formatting help</a>';

/** Validate description length */
const DescriptionSchema = v.pipe(v.string(), v.maxLength(MAX_TEXTAREA_LENGTH));
const validateDescription = (value: string): string | null =>
  v.safeParse(DescriptionSchema, value).success
    ? null
    : t("fields.validation.description_max", { max: MAX_TEXTAREA_LENGTH });

/** Validate a datetime value is parseable */
const validateDatetime = (value: string): string | null =>
  isValidDatetime(value) ? null : t("fields.validation.datetime");

/** Build a "hidden" visibility checkbox field for a listing or group. */
const buildHiddenField = (kind: "Listing" | "Group"): Field => ({
  hint:
    kind === "Listing"
      ? t("fields.listing.hidden_hint")
      : t("fields.listing.hidden_hint_group"),
  label:
    kind === "Listing"
      ? t("fields.listing.hidden")
      : t("fields.listing.hidden_group"),
  name: "hidden",
  options: [{ label: t("fields.listing.hidden_label"), value: "1" }],
  type: "checkbox-group",
});

/**
 * Login form field definitions (per-request builder)
 */
export const getLoginFields = (): Field[] => [
  { ...getUsernameFieldBase(), autocomplete: "username" },
  {
    autocomplete: "current-password",
    label: t("fields.login.password"),
    name: "password",
    required: true,
    type: "password",
  },
];

/**
 * Listing form field definitions (per-request builder, shared between create and edit)
 */
export const getListingFields = (): Field[] => [
  {
    hint: t("fields.listing.name_hint"),
    label: t("fields.listing.name"),
    name: "name",
    placeholder: t("fields.listing.name_placeholder"),
    required: true,
    type: "text",
  },
  {
    hint: t("fields.listing.type_hint"),
    label: t("fields.listing.type"),
    name: "listing_type",
    options: [
      { label: t("fields.listing.type_standard"), value: "standard" },
      { label: t("fields.listing.type_daily"), value: "daily" },
    ],
    type: "select",
    validate: validateListingType,
  },
  {
    hint: t("fields.listing.description_hint_field"),
    hintHtml: FORMATTING_HINT,
    label: t("fields.listing.description"),
    markdown: true,
    maxlength: MAX_TEXTAREA_LENGTH,
    name: "description",
    placeholder: t("fields.listing.description_placeholder"),
    type: "textarea",
    validate: validateDescription,
  },
  {
    hint: t("fields.listing.date_hint"),
    label: t("fields.listing.date"),
    name: "date",
    type: "datetime",
    validate: validateDatetime,
  },
  {
    hint: t("fields.listing.location_hint"),
    label: t("fields.listing.location"),
    name: "location",
    placeholder: t("fields.listing.location_placeholder"),
    type: "text",
  },
  {
    hint: t("fields.listing.max_attendees_hint"),
    label: t("fields.listing.max_attendees"),
    min: 1,
    name: "max_attendees",
    required: true,
    type: "number",
  },
  {
    hint: t("fields.listing.max_quantity_hint"),
    label: t("fields.listing.max_quantity"),
    min: 1,
    name: "max_quantity",
    required: true,
    type: "number",
  },
  {
    hint: t("fields.listing.bookable_days_hint"),
    label: t("fields.listing.bookable_days"),
    name: "bookable_days",
    options: VALID_DAY_NAMES.map((d) => ({ label: d, value: d })),
    type: "checkbox-group",
    validate: validateBookableDays,
  },
  {
    hint: t("fields.listing.min_days_notice_hint"),
    label: t("fields.listing.min_days_notice"),
    min: 0,
    name: "minimum_days_before",
    type: "number",
  },
  {
    hint: t("fields.listing.max_days_ahead_hint"),
    label: t("fields.listing.max_days_ahead"),
    min: 0,
    name: "maximum_days_after",
    type: "number",
  },
  {
    hint: t("fields.listing.duration_days_hint"),
    label: t("fields.listing.duration_days"),
    max: MAX_DURATION_DAYS,
    min: 1,
    name: "duration_days",
    type: "number",
    validate: (value: string): string | null => {
      // validateSingleField only calls this when the value is non-empty, so
      // the empty-string case never reaches here.
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        return t("fields.validation.duration_whole");
      }
      if (parsed < 1) return t("fields.validation.duration_min");
      if (parsed > MAX_DURATION_DAYS) {
        return t("fields.validation.duration_max", { max: MAX_DURATION_DAYS });
      }
      return null;
    },
  },
  {
    hint: t("fields.listing.customisable_days_hint"),
    label: t("fields.listing.customisable_days"),
    name: "customisable_days",
    options: [
      { label: t("fields.listing.customisable_days_label"), value: "1" },
    ],
    type: "checkbox-group",
  },
  {
    hint: t("fields.listing.contact_fields_hint"),
    hintHtml: t("fields.listing.contact_fields_hint_html"),
    label: t("fields.listing.contact_fields"),
    name: "fields",
    options: [
      { label: t("common.email"), value: "email" },
      { label: t("fields.listing.contact_phone"), value: "phone" },
      { label: t("common.address"), value: "address" },
      {
        label: t("common.special_instructions"),
        value: "special_instructions",
      },
    ],
    type: "checkbox-group",
    validate: validateListingFields,
  },
  {
    inputmode: "decimal",
    label: t("fields.listing.price"),
    name: "unit_price",
    pattern: "\\d+(\\.\\d{1,2})?",
    placeholder: t("fields.listing.price_placeholder"),
    title: t("fields.listing.price_title"),
    type: "text",
    validate: validateNonNegativePrice,
  },
  {
    hint: t("fields.listing.allow_pay_more_hint"),
    label: t("fields.listing.allow_pay_more"),
    name: "can_pay_more",
    options: [{ label: t("fields.listing.allow_pay_more_label"), value: "1" }],
    type: "checkbox-group",
  },
  {
    defaultValue: "100.00",
    hint: t("fields.listing.max_price_hint", { amount: formatCurrency(100) }),
    inputmode: "decimal",
    label: t("fields.listing.max_price"),
    name: "max_price",
    pattern: "\\d+(\\.\\d{1,2})?",
    placeholder: t("fields.listing.max_price_placeholder"),
    title: t("fields.listing.max_price_title"),
    type: "text",
    validate: validateNonNegativePrice,
  },
  {
    hint: t("fields.listing.registration_closes_hint"),
    label: t("fields.listing.registration_closes"),
    name: "closes_at",
    type: "datetime",
    validate: validateDatetime,
  },
  {
    hint: t("fields.listing.thank_you_url_hint"),
    label: t("fields.listing.thank_you_url"),
    name: "thank_you_url",
    placeholder: "https://example.com/thank-you",
    type: "url",
    validate: validateHttpsDomainUrl,
  },
  {
    hint: t("fields.listing.webhook_url_hint"),
    label: t("fields.listing.webhook_url"),
    name: "webhook_url",
    placeholder: "https://example.com/webhook",
    type: "url",
    validate: validateHttpsDomainUrl,
  },
  {
    hint: t("fields.listing.non_transferable_hint"),
    label: t("fields.listing.non_transferable"),
    name: "non_transferable",
    options: [
      { label: t("fields.listing.non_transferable_no"), value: "" },
      { label: t("fields.listing.non_transferable_yes"), value: "1" },
    ],
    type: "select",
  },
  buildHiddenField("Listing"),
  {
    hint: t("fields.listing.purchase_only_hint"),
    label: t("fields.listing.purchase_only"),
    name: "purchase_only",
    options: [{ label: t("fields.listing.purchase_only_label"), value: "1" }],
    type: "checkbox-group",
  },
];

/**
 * "Needs logistics" listing toggle. Only assembled into the listing form when
 * the logistics feature is enabled (see the listing page builders); attendees
 * of a logistics listing carry start and end agents.
 */
export const logisticsField: Field = {
  hint: "Handled by an agent at the customer's location. Attendees gain start and end agent selectors (e.g. delivery/collection, set-up/teardown, or pickup/drop-off).",
  label: "Needs logistics",
  name: "uses_logistics",
  options: [{ label: "Assign agents to this listing's bookings", value: "1" }],
  type: "checkbox-group",
};

export const getMonthsPerUnitField = (): Field => ({
  hint: t("fields.listing.months_per_unit_hint"),
  label: t("fields.listing.months_per_unit"),
  max: 24,
  min: 0,
  name: "months_per_unit",
  type: "number",
});

export const getInitialSiteMonthsField = (): Field => ({
  hint: t("fields.listing.initial_site_months_hint"),
  label: t("fields.listing.initial_site_months"),
  max: 120,
  min: 0,
  name: "initial_site_months",
  type: "number",
});

/** Validate date format (YYYY-MM-DD) */
export const validateDate = (value: string): string | null =>
  isIsoDate(value) ? null : t("fields.validation.date");

/**
 * Holiday form field definitions (per-request builder)
 */
export const getHolidayFields = (): Field[] => [
  {
    label: t("fields.holiday.name"),
    name: "name",
    placeholder: t("fields.holiday.name_placeholder"),
    required: true,
    type: "text",
  },
  {
    label: t("fields.holiday.start_date"),
    name: "start_date",
    required: true,
    type: "date",
    validate: validateDate,
  },
  {
    hint: t("fields.holiday.end_date_hint"),
    label: t("fields.holiday.end_date"),
    name: "end_date",
    required: true,
    type: "date",
    validate: validateDate,
  },
];

/**
 * Logistics agent form field definitions
 */
export const logisticsAgentFields: Field[] = [
  {
    label: "Agent Name",
    name: "name",
    placeholder: "Van 1",
    required: true,
    type: "text",
  },
];

/**
 * Built site form field definitions (per-request builder)
 */
export const getBuiltSiteFields = (): Field[] => [
  {
    label: t("fields.built_site.name"),
    name: "name",
    placeholder: t("fields.built_site.name_placeholder"),
    required: true,
    type: "text",
  },
  {
    label: t("fields.built_site.bunny_url"),
    name: "bunny_url",
    placeholder: t("fields.built_site.bunny_url_placeholder"),
    required: true,
    type: "url",
    validate: validateHttpsDomainUrl,
  },
  {
    label: t("fields.built_site.db_url"),
    name: "db_url",
    placeholder: t("fields.built_site.db_url_placeholder"),
    type: "url",
  },
  {
    label: t("fields.built_site.db_token"),
    name: "db_token",
    placeholder: t("fields.built_site.db_token_placeholder"),
    type: "password",
  },
  {
    label: t("fields.built_site.bunny_script_id"),
    name: "bunny_script_id",
    placeholder: t("fields.built_site.bunny_script_id_placeholder"),
    type: "text",
  },
  {
    hint: t("fields.built_site.assignable_hint"),
    label: t("fields.built_site.assignable"),
    name: "assignable",
    options: [{ label: t("fields.built_site.assignable_label"), value: "1" }],
    type: "checkbox-group",
  },
];

/** Field for assign_built_site on listings (conditionally shown when CAN_BUILD_SITES is enabled) */
export const getAssignBuiltSiteField = (): Field => ({
  hint: t("fields.listing.assign_built_site_hint"),
  label: t("fields.listing.assign_built_site"),
  name: "assign_built_site",
  options: [{ label: t("fields.listing.assign_built_site_label"), value: "1" }],
  type: "checkbox-group",
});

/** Image upload field for listing forms (appended when storage is enabled) */
export const getImageField = (): Field => ({
  accept: "image/jpeg,image/png,image/gif,image/webp",
  label: t("fields.listing.image", { size: formatBytes(MAX_IMAGE_SIZE) }),
  name: "image",
  type: "file",
});

/** Attachment upload field for listing forms (appended when storage is enabled) */
export const getAttachmentField = (): Field => ({
  label: t("fields.listing.attachment", {
    size: formatBytes(MAX_ATTACHMENT_SIZE),
  }),
  name: "attachment",
  type: "file",
});

/** Slug field for listing/group edit pages */
export const getSlugField = (): Field => ({
  hint: t("fields.listing.slug_hint_field"),
  label: t("common.slug"),
  name: "slug",
  pattern: "[a-z0-9_-]+",
  required: true,
  title: t("fields.listing.slug_title"),
  type: "text",
  validate: (value: string) => validateSlug(normalizeSlug(value)),
});

/** Group selection field (validated even when rendered manually) */
export const getGroupIdField = (): Field => ({
  label: t("terms.group"),
  name: "group_id",
  type: "text",
});

/** Max attendees field for group forms */
const getGroupMaxAttendeesField = (): Field => ({
  hint: t("fields.group.max_attendees_hint"),
  label: t("fields.group.max_attendees"),
  name: "max_attendees",
  type: "number",
});

/** Group description field */
const getGroupDescriptionField = (): Field => ({
  hint: t("fields.group.description_hint"),
  hintHtml: FORMATTING_HINT,
  label: t("fields.listing.description"),
  markdown: true,
  maxlength: MAX_TEXTAREA_LENGTH,
  name: "description",
  placeholder: t("fields.listing.description_placeholder"),
  type: "textarea",
  validate: validateDescription,
});

/** Group form fields for creation (no slug - auto-generated) */
export const getGroupCreateFields = (): Field[] => {
  const groupHiddenField = buildHiddenField("Group");
  return [
    {
      label: t("fields.group.name"),
      name: "name",
      placeholder: t("fields.group.name_placeholder"),
      required: true,
      type: "text",
    },
    getGroupDescriptionField(),
    getGroupMaxAttendeesField(),
    {
      hint: t("fields.group.terms_hint"),
      hintHtml: FORMATTING_HINT,
      label: t("fields.group.terms"),
      markdown: true,
      maxlength: MAX_TEXTAREA_LENGTH,
      name: "terms_and_conditions",
      type: "textarea",
      validate: (value: string) =>
        value.length > MAX_TEXTAREA_LENGTH
          ? t("fields.validation.terms_max", { max: MAX_TEXTAREA_LENGTH })
          : null,
    },
    groupHiddenField,
  ];
};

/** Group form field definitions (edit - includes slug) */
export const getGroupFields = (): Field[] => {
  const creates = getGroupCreateFields();
  return [
    creates[0]!,
    getSlugField(),
    creates[1]!,
    creates[2]!,
    creates[3]!,
    buildHiddenField("Group"),
  ];
};

/** Form values for the modifier create/edit form. */
export type ModifierFormValues = {
  name: string;
  calc_kind: string;
  direction: string;
  calc_value: number;
  trigger: string;
  code: string;
  scope: string;
  min_subtotal: number;
  min_visits: number;
  stock: number | null;
  active: string;
};

export type ModifierAggregateFormValues = {
  total_uses: number;
  usage_count: number;
};

const aggregateIntegerField = (name: string, label: string): Field => ({
  label,
  min: 0,
  name,
  parse: Number,
  required: true,
  type: "number",
  validate: validateNonNegativeInteger(label),
});

export const listingAggregateFields: Field[] = [
  aggregateIntegerField("booked_quantity", t("fields.listing.booked_quantity")),
  aggregateIntegerField("tickets_count", t("fields.listing.tickets_count")),
];

export const modifierAggregateFields: Field[] = [
  aggregateIntegerField("total_uses", t("fields.modifier.total_uses")),
  aggregateIntegerField("usage_count", t("fields.modifier.usage_count")),
];

export type AnswerAggregateFormValues = {
  times_selected: number;
};

export const answerAggregateFields: Field[] = [
  aggregateIntegerField("times_selected", t("fields.answer.times_selected")),
];

/** Modifier form fields (same for create and edit — no slug). */
export const modifierFields: Field[] = [
  {
    label: "Name",
    name: "name",
    placeholder: "Early bird",
    required: true,
    type: "text",
  },
  {
    defaultValue: "fixed",
    label: "Type",
    name: "calc_kind",
    options: [
      { label: "Fixed amount", value: "fixed" },
      { label: "Percentage", value: "percent" },
      { label: "Multiplier", value: "multiply" },
    ],
    type: "select",
  },
  {
    defaultValue: "charge",
    label: "Direction",
    name: "direction",
    options: [
      { label: "Charge (adds to the price)", value: "charge" },
      { label: "Discount (reduces the price)", value: "discount" },
    ],
    type: "select",
  },
  {
    hint: "Fixed: an amount in your currency. Percentage: e.g. 10 for 10%. Multiplier: e.g. 1.5. Direction is ignored for multipliers (the factor sets it).",
    inputmode: "decimal",
    label: "Value",
    name: "calc_value",
    // Required, so `validateSingleField` rejects empty input before `parse`
    // runs; `parse` therefore only ever sees a value the validator accepted.
    parse: (value: string) => Number.parseFloat(value),
    required: true,
    type: "text",
    validate: (value: string) =>
      Number.isFinite(Number.parseFloat(value)) ? null : "Enter a valid number",
  },
  {
    defaultValue: "automatic",
    hint: "When this applies. Promo codes are entered by the buyer at checkout; optional add-ons are chosen by the buyer; question answers apply when the buyer picks a linked answer (choose the answers on the edit page after saving).",
    label: "Trigger",
    name: "trigger",
    options: [
      { label: "Automatic (always)", value: "automatic" },
      { label: "Promo code", value: "code" },
      { label: "Optional add-on", value: "optional" },
      { label: "Question answer", value: "answer" },
    ],
    type: "select",
  },
  {
    hint: "The code buyers enter at checkout. Required for promo-code modifiers; ignored otherwise.",
    label: "Promo code",
    name: "code",
    placeholder: "SUMMER20",
    type: "text",
  },
  {
    defaultValue: "all",
    hint: "Which items this applies to. For specific listings or groups, choose the listings/groups on the edit page after saving.",
    label: "Applies to",
    name: "scope",
    options: [
      { label: "The whole order", value: "all" },
      { label: "Specific listings", value: "listings" },
      { label: "Listings in specific groups", value: "groups" },
    ],
    type: "select",
  },
  {
    hint: "Only apply when the order subtotal is at least this amount (in your currency). Leave blank for no minimum.",
    inputmode: "decimal",
    label: "Minimum order (optional)",
    name: "min_subtotal",
    // Optional: blank means no minimum (0). A provided value must be a
    // non-negative number; `validateSingleField` only runs `validate` when the
    // field is non-empty, and `parse` maps blank to 0.
    parse: (value: string) => (value ? Number.parseFloat(value) : 0),
    type: "text",
    validate: (value: string) => {
      const n = Number.parseFloat(value);
      return Number.isFinite(n) && n >= 0
        ? null
        : "Minimum order must be a positive number";
    },
  },
  {
    hint: "Only apply to a returning customer with at least this many previous bookings. 0 (or blank) applies to everyone; 1 means seen at least once before.",
    label: "Minimum previous bookings (optional)",
    min: 0,
    name: "min_visits",
    parse: (value: string) => (value ? Number(value) : 0),
    type: "number",
  },
  {
    hint: "Total number available across all orders. Leave blank for unlimited.",
    label: "Stock (optional)",
    min: 0,
    name: "stock",
    type: "number",
  },
  {
    label: "Status",
    name: "active",
    options: [{ label: "Active (apply at checkout)", value: "1" }],
    type: "checkbox-group",
  },
];

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

/** Phone field for ticket forms */
const phoneField: Field = {
  autocomplete: "tel",
  label: "Your Phone Number",
  name: "phone",
  pattern: "[+\\d][\\d\\s\\-()]{5,}",
  required: true,
  title:
    "Phone number (digits, spaces, hyphens, parentheses, optional leading +)",
  type: "text",
  validate: validatePhone,
};

/** Max length for address field (must fit in payment metadata) */
const MAX_ADDRESS_LENGTH = 250;

/** Validate address length */
const AddressSchema = v.pipe(v.string(), v.maxLength(MAX_ADDRESS_LENGTH));
export const validateAddress = (value: string): string | null =>
  v.safeParse(AddressSchema, value).success
    ? null
    : t("fields.validation.address_max", { max: MAX_ADDRESS_LENGTH });

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

/** Max length for special instructions field (must fit in payment metadata) */
const MAX_SPECIAL_INSTRUCTIONS_LENGTH = 250;

/** Validate special instructions length */
const SpecialInstructionsSchema = v.pipe(
  v.string(),
  v.maxLength(MAX_SPECIAL_INSTRUCTIONS_LENGTH),
);
export const validateSpecialInstructions = (value: string): string | null =>
  v.safeParse(SpecialInstructionsSchema, value).success
    ? null
    : t("fields.validation.special_instructions_max", {
        max: MAX_SPECIAL_INSTRUCTIONS_LENGTH,
      });

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

export { mergeListingFields, parseListingFields };

/** Stubbable API for testing */
export const fieldsApi = { getSettingCached: settings.getCachedRaw };

/**
 * Get ticket form fields based on listing fields setting.
 * Always includes name. Adds contact fields based on the comma-separated setting.
 * When isPaid is true and Square is the active provider, email is always included
 * because Square requires an email address for checkout.
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
  return [nameField, ...parsed.map((f) => contactFieldMap[f])];
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

/** Quantity field for admin add-attendee form */
const addAttendeeQuantityField: Field = {
  label: "Quantity",
  min: 1,
  name: "quantity",
  required: true,
  type: "number",
};

/** Date field for admin add-attendee form (daily listings only) */
const addAttendeeDateField: Field = {
  label: "Date",
  name: "date",
  required: true,
  type: "date",
  validate: validateDate,
};

/** Day-count select for adding an attendee to a customisable daily listing. */
const addAttendeeDayCountField = (dayCounts: number[]): Field => ({
  label: "Number of days",
  name: "day_count",
  options: dayCounts.map((n) => ({
    label: `${n} day${n === 1 ? "" : "s"}`,
    value: String(n),
  })),
  required: true,
  type: "select",
});

/**
 * Get admin add-attendee form fields based on listing config.
 * Includes contact fields (name + email/phone per setting), quantity, a date
 * field for daily listings, and — for customisable daily listings — a day-count
 * selector so the manually-added booking reserves the chosen span.
 */
export const getAddAttendeeFields = (
  fields: ListingFields,
  isDaily: boolean,
  dayCounts?: number[],
): Field[] => {
  // Admin enters a customer's details here, so disable native autofill: we don't
  // want the operator's browser to store or suggest other customers' PII. The
  // shared ticket fields keep their semantic autocomplete for the public form,
  // so override on copies rather than mutating the originals.
  const contactFields = getTicketFields(fields, false).map(
    (f): Field => ({ ...f, autocomplete: "off" }),
  );
  const result = [...contactFields, addAttendeeQuantityField];
  if (isDaily) result.push(addAttendeeDateField);
  if (dayCounts && dayCounts.length > 0) {
    result.push(addAttendeeDayCountField(dayCounts));
  }
  return result;
};

/** Password field with new-password autocomplete (reused across setup, change password, and join forms) */
const newPasswordField = (
  name: string,
  label: string,
  { confirm }: { confirm?: boolean } = {},
): Field => ({
  autocomplete: "new-password",
  label,
  name,
  required: true,
  type: "password",
  ...(!confirm && { hint: t("fields.setup.password_hint"), minlength: 8 }),
});

/**
 * Setup form field definitions (per-request builder)
 * Note: Stripe keys are now configured via environment variables
 */
export const getSetupFields = (): Field[] => [
  {
    autocomplete: "username",
    hint: t("fields.setup.username_hint"),
    label: t("fields.setup.username"),
    name: "admin_username",
    required: true,
    type: "text",
    validate: validateUsername,
  },
  newPasswordField("admin_password", t("fields.setup.password")),
  newPasswordField(
    "admin_password_confirm",
    t("fields.setup.confirm_password"),
    {
      confirm: true,
    },
  ),
];

/**
 * Change password form field definitions (per-request builder)
 */
export const getChangePasswordFields = (): Field[] => [
  {
    autocomplete: "current-password",
    label: t("fields.change_password.current"),
    name: "current_password",
    required: true,
    type: "password",
  },
  newPasswordField("new_password", t("fields.change_password.new")),
  newPasswordField(
    "new_password_confirm",
    t("fields.change_password.confirm"),
    {
      confirm: true,
    },
  ),
];

/**
 * Stripe key settings form field definitions (per-request builder)
 */
export const getStripeKeyFields = (): Field[] => [
  {
    autocomplete: "off",
    hint: t("fields.stripe.secret_key_hint"),
    label: t("fields.stripe.secret_key"),
    name: "stripe_secret_key",
    placeholder: t("fields.stripe.secret_key_placeholder"),
    required: true,
    type: "password",
  },
];

/**
 * Square access token and location form field definitions (per-request builder)
 */
export const getSquareAccessTokenFields = (): Field[] => [
  {
    autocomplete: "off",
    hint: t("fields.square.access_token_hint"),
    label: t("fields.square.access_token"),
    name: "square_access_token",
    placeholder: t("fields.square.access_token_placeholder"),
    required: true,
    type: "password",
  },
  {
    autocomplete: "off",
    hint: t("fields.square.location_id_hint"),
    label: t("fields.square.location_id"),
    name: "square_location_id",
    placeholder: t("fields.square.location_id_placeholder"),
    required: true,
    type: "text",
  },
];

/**
 * Square webhook settings form field definitions (per-request builder)
 */
export const getSquareWebhookFields = (): Field[] => [
  {
    autocomplete: "off",
    hint: t("fields.square.webhook_key_hint"),
    label: t("fields.square.webhook_key"),
    name: "square_webhook_signature_key",
    required: true,
    type: "password",
  },
];

/**
 * SumUp API key and merchant code form field definitions (per-request builder)
 */
export const getSumupFields = (): Field[] => [
  {
    autocomplete: "off",
    hint: t("fields.sumup.api_key_hint"),
    label: t("fields.sumup.api_key"),
    name: "sumup_api_key",
    placeholder: t("fields.sumup.api_key_placeholder"),
    required: true,
    type: "password",
  },
  {
    autocomplete: "off",
    hint: t("fields.sumup.merchant_code_hint"),
    label: t("fields.sumup.merchant_code"),
    name: "sumup_merchant_code",
    placeholder: t("fields.sumup.merchant_code_placeholder"),
    required: true,
    type: "text",
  },
];

/**
 * Invite user form field definitions (per-request builder)
 */
export const getInviteUserFields = (): Field[] => [
  {
    ...getUsernameFieldBase(),
    hint: t("fields.user.username_hint"),
    validate: validateUsername,
  },
  {
    label: t("fields.user.role"),
    name: "admin_level",
    options: [
      { label: t("fields.user.manager"), value: "manager" },
      { label: t("fields.user.owner"), value: "owner" },
      { label: t("fields.user.agent"), value: "agent" },
    ],
    required: true,
    type: "select",
  },
];

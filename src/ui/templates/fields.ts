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

/** True if the four IPv4 octets fall in a private/reserved range. */
const isPrivateIPv4 = (a: number, b: number, c: number, d: number): boolean => {
  // 127.0.0.0/8  (loopback)
  if (a === 127) return true;
  // 10.0.0.0/8   (private)
  if (a === 10) return true;
  // 172.16.0.0/12 (private)
  if (a === 172 && b >= 16 && b <= 31) return true;
  // 192.168.0.0/16 (private)
  if (a === 192 && b === 168) return true;
  // 169.254.0.0/16 (link-local — including cloud IMDS at 169.254.169.254)
  if (a === 169 && b === 254) return true;
  // 0.0.0.0/8
  if (a === 0) return true;
  // 255.255.255.255
  if (a === 255 && b === 255 && c === 255 && d === 255) return true;
  return false;
};

/**
 * Extract the IPv4 octets from an IPv4-mapped IPv6 address as normalized by
 * the URL parser (e.g. "[::ffff:7f00:1]" → [127, 0, 0, 1]). Returns null
 * for any string that isn't a well-formed ::ffff:<ipv4> form.
 */
const extractMappedIPv4 = (
  ipv6: string,
): [number, number, number, number] | null => {
  if (!ipv6.toLowerCase().startsWith("::ffff:")) return null;
  // URL parser normalizes the embedded IPv4 to 1 or 2 hex groups
  // (e.g. "7f00:1" for 127.0.0.1, "0" for 0.0.0.0).
  const tail = ipv6.slice("::ffff:".length);
  const groups = tail.split(":");
  const hi = groups.length >= 2 ? Number.parseInt(groups[0]!, 16) : 0;
  const lo = Number.parseInt(groups[groups.length - 1]!, 16);
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
};

/**
 * Classify a bracketed-IPv6 hostname (without brackets) as private/internal.
 * Recognizes the unspecified/loopback, IPv4-mapped, link-local, and unique-
 * local ranges that the URL parser can hand us.
 */
const isPrivateIPv6 = (ipv6: string): boolean => {
  // :: (unspecified — equivalent to 0.0.0.0) and ::1 (loopback)
  if (ipv6 === "::" || ipv6 === "::1") return true;
  // IPv4-mapped IPv6 (::ffff:127.0.0.1 normalizes to [::ffff:7f00:1])
  const mapped = extractMappedIPv4(ipv6);
  if (mapped) return isPrivateIPv4(...mapped);
  // fe80::/10 — link-local (first 10 bits: 1111111010 → first group 0xfe80..0xfebf)
  // fc00::/7  — unique local (first 7 bits: 1111110  → first group 0xfc00..0xfdff)
  // A short or empty first group (e.g. "1" of 1::, or "" of ::2) parses to a
  // value below 0xfc00 — or to NaN, whose range comparisons are all false — so
  // non-private addresses fall through to false with no explicit guard needed.
  const n = Number.parseInt(ipv6.split(":")[0]!, 16);
  return (n >= 0xfe80 && n <= 0xfebf) || (n >= 0xfc00 && n <= 0xfdff);
};

/** Check if a hostname is a private/internal IP or localhost */
const isPrivateHostname = (hostname: string): boolean => {
  if (hostname === "localhost") return true;

  // IPv6 hostnames from the URL parser arrive wrapped in brackets.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    return isPrivateIPv6(hostname.slice(1, -1));
  }

  const parts = hostname.split(".");
  if (
    parts.length === 4 &&
    parts.every((p) => p !== "" && !Number.isNaN(Number(p)))
  ) {
    return isPrivateIPv4(
      Number(parts[0]),
      Number(parts[1]),
      Number(parts[2]),
      Number(parts[3]),
    );
  }

  return false;
};

/**
 * Validate webhook URL — must be an externally routable HTTPS URL.
 * Rejects relative paths, localhost, and private IP ranges (SSRF protection).
 */
const validateWebhookUrl = (value: string): string | null => {
  // Reject relative URLs — webhook must be absolute and externally routable
  if (value.startsWith("/")) return t("error.url_https");

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return t("error.url_https");
    }
    if (isPrivateHostname(url.hostname)) {
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
export const validateEmail = (value: string): string | null =>
  v.safeParse(EmailFormatSchema, value).success
    ? null
    : t("error.email_invalid");

/**
 * Validate phone number format
 */
const PhoneSchema = v.pipe(
  v.string(),
  // Allow digits, spaces, hyphens, parentheses, plus sign
  v.regex(/^[+\d][\d\s\-()]{5,}$/),
);

export const validatePhone = (value: string): string | null =>
  v.safeParse(PhoneSchema, value).success ? null : t("error.phone_invalid");

/** Validate username format: alphanumeric, hyphens, underscores, 2-32 chars */
const UsernameSchema = v.pipe(
  v.string(),
  v.minLength(2, t("error.username_min")),
  v.maxLength(32, t("error.username_max")),
  v.regex(/^[a-zA-Z0-9_-]+$/, t("error.username_chars")),
  v.check(
    (s) => !s.startsWith("-") && !s.startsWith("_"),
    "Username may not start with a hyphen or underscore",
  ),
);

export const validateUsername = (value: string): string | null => {
  const result = v.safeParse(UsernameSchema, value, { abortPipeEarly: true });
  return result.success ? null : result.issues[0].message;
};

/** Base username field shared across login and invite forms */
const usernameFieldBase: Field = {
  label: t("login.username"),
  maxlength: 32,
  minlength: 2,
  name: "username",
  pattern: "[a-zA-Z0-9_-]+",
  required: true,
  title: "Letters, numbers, hyphens, and underscores only",
  type: "text",
};

/**
 * Login form field definitions
 */
export const loginFields: Field[] = [
  { ...usernameFieldBase, autocomplete: "username" },
  {
    autocomplete: "current-password",
    label: t("login.password"),
    name: "password",
    required: true,
    type: "password",
  },
];

/** Validate listing fields setting (comma-separated contact field names) */
const validateListingFields = (value: string): string | null => {
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

/** Validate listing type setting */
const validateListingType = (value: string): string | null => {
  if (!isListingType(value)) {
    return t("error.listing_type_invalid");
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
  '<a href="/admin/guide#text-formatting" target="_blank" rel="noopener">Formatting help</a>';

/** Validate description length */
const DescriptionSchema = v.pipe(v.string(), v.maxLength(MAX_TEXTAREA_LENGTH));
const validateDescription = (value: string): string | null =>
  v.safeParse(DescriptionSchema, value).success
    ? null
    : `Description must be ${MAX_TEXTAREA_LENGTH} characters or fewer`;

/** Validate a datetime value is parseable */
const validateDatetime = (value: string): string | null =>
  isValidDatetime(value) ? null : t("error.datetime_invalid");

/** Build a "hidden" visibility checkbox field for an listing or group. */
const buildHiddenField = (kind: "Listing" | "Group"): Field => ({
  hint: `Hide from the public listings page and search engines. The ${kind.toLowerCase()} is still bookable via its direct link.`,
  label: `Hidden ${kind}`,
  name: "hidden",
  options: [{ label: "Hide from public listings list", value: "1" }],
  type: "checkbox-group",
});

/**
 * Listing form field definitions (shared between create and edit)
 */
export const listingFields: Field[] = [
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
    hint: "Shown on the ticket page.",
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
    hint: "How many days each booking reserves. With Customisable Days on, this is the maximum a visitor can choose. Only applies to daily listings unless Customisable Days is on.",
    label: "Booking Duration (days)",
    max: MAX_DURATION_DAYS,
    min: 1,
    name: "duration_days",
    type: "number",
    validate: (value: string): string | null => {
      // validateSingleField only calls this when the value is non-empty, so
      // the empty-string case never reaches here.
      const parsed = Number(value);
      if (!Number.isInteger(parsed)) {
        return "Booking Duration (days) must be a whole number";
      }
      if (parsed < 1) return "Booking Duration (days) must be at least 1";
      if (parsed > MAX_DURATION_DAYS) {
        return `Booking Duration (days) must be at most ${MAX_DURATION_DAYS}`;
      }
      return null;
    },
  },
  {
    hint: "Let visitors choose how many days to book (1 up to the Booking Duration above), each priced separately below. Works for standard and daily listings. Cannot be combined with Allow Pay More.",
    label: "Customisable Days",
    name: "customisable_days",
    options: [{ label: "Let visitors choose the number of days", value: "1" }],
    type: "checkbox-group",
  },
  {
    hint: t("fields.listing.contact_fields_hint"),
    hintHtml:
      "If you don't collect email addresses, <strong>attendees won't be emailed their ticket</strong>.",
    label: t("fields.listing.contact_fields"),
    name: "fields",
    options: [
      { label: t("fields.listing.contact_email"), value: "email" },
      { label: t("fields.listing.contact_phone"), value: "phone" },
      { label: t("fields.listing.contact_address"), value: "address" },
      {
        label: t("fields.listing.contact_special"),
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
    title: "A non-negative number (e.g. 10.00)",
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
    get hint() {
      return t("fields.listing.max_price_hint", {
        amount: formatCurrency(100),
      });
    },
    inputmode: "decimal",
    label: t("fields.listing.max_price"),
    name: "max_price",
    pattern: "\\d+(\\.\\d{1,2})?",
    placeholder: t("fields.listing.max_price_placeholder"),
    title: "A non-negative number (e.g. 100.00)",
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
    validate: validateSafeUrl,
  },
  {
    hint: t("fields.listing.webhook_url_hint"),
    label: t("fields.listing.webhook_url"),
    name: "webhook_url",
    placeholder: "https://example.com/webhook",
    type: "url",
    validate: validateWebhookUrl,
  },
  {
    hint: t("fields.listing.non_transferable_hint"),
    label: t("fields.listing.non_transferable"),
    name: "non_transferable",
    options: [
      { label: t("common.no"), value: "" },
      { label: t("common.yes"), value: "1" },
    ],
    type: "select",
  },
  buildHiddenField("Listing"),
  {
    hint: "For raffles, fundraisers, donations, or other non-attendance items. Hides QR codes, check-in, and wallet passes. Shows \u2018Buy now\u2019 instead of \u2018Reserve\u2019.",
    label: "Purchase Only",
    name: "purchase_only",
    options: [{ label: "No attendance required", value: "1" }],
    type: "checkbox-group",
  },
];

export const monthsPerUnitField: Field = {
  hint: "How many months one ticket buys. Leave 0 for non-renewal listings.",
  label: "Months Per Unit (renewal tiers only)",
  max: 24,
  min: 0,
  name: "months_per_unit",
  type: "number",
};

export const initialSiteMonthsField: Field = {
  hint: "How many months the site stays active after purchase. Required when assigning a built site.",
  label: "Initial Site Months (built site listings only)",
  max: 120,
  min: 0,
  name: "initial_site_months",
  type: "number",
};

/** Validate date format (YYYY-MM-DD) */
export const validateDate = (value: string): string | null =>
  isIsoDate(value) ? null : t("error.date_format_invalid");

/**
 * Holiday form field definitions
 */
export const holidayFields: Field[] = [
  {
    label: t("holidays.fields.name"),
    name: "name",
    placeholder: t("holidays.fields.name_placeholder"),
    required: true,
    type: "text",
  },
  {
    label: t("holidays.fields.start_date"),
    name: "start_date",
    required: true,
    type: "date",
    validate: validateDate,
  },
  {
    hint: t("holidays.fields.end_date_hint"),
    label: t("holidays.fields.end_date"),
    name: "end_date",
    required: true,
    type: "date",
    validate: validateDate,
  },
];

/**
 * Built site form field definitions
 */
export const builtSiteFields: Field[] = [
  {
    label: "Site Name",
    name: "name",
    placeholder: "My Ticket Site",
    required: true,
    type: "text",
  },
  {
    label: "Bunny URL",
    name: "bunny_url",
    placeholder: "https://example.b-cdn.net",
    required: true,
    type: "url",
  },
  {
    label: "Database URL",
    name: "db_url",
    placeholder: "libsql://your-db.turso.io",
    type: "url",
  },
  {
    label: "Database Token",
    name: "db_token",
    placeholder: "Database auth token",
    type: "password",
  },
  {
    label: "Bunny Script ID",
    name: "bunny_script_id",
    placeholder: "12345",
    type: "text",
  },
  {
    hint: "Make this site available for automatic assignment when a ticket is purchased",
    label: "Assignable",
    name: "assignable",
    options: [{ label: "Available for assignment", value: "1" }],
    type: "checkbox-group",
  },
];

/** Field for assign_built_site on listings (conditionally shown when CAN_BUILD_SITES is enabled) */
export const assignBuiltSiteField: Field = {
  hint: "Automatically assign a built site to each ticket purchased for this listing",
  label: "Assign Built Site",
  name: "assign_built_site",
  options: [{ label: "Assign a site on booking", value: "1" }],
  type: "checkbox-group",
};

/** Image upload field for listing forms (appended when storage is enabled) */
export const imageField: Field = {
  accept: "image/jpeg,image/png,image/gif,image/webp",
  label: t("fields.listing.image", { size: formatBytes(MAX_IMAGE_SIZE) }),
  name: "image",
  type: "file",
};

/** Attachment upload field for listing forms (appended when storage is enabled) */
export const attachmentField: Field = {
  label: t("fields.listing.attachment", {
    size: formatBytes(MAX_ATTACHMENT_SIZE),
  }),
  name: "attachment",
  type: "file",
};

/** Slug field for listing/group edit pages */
export const slugField: Field = {
  hint: "URL-friendly identifier (lowercase letters, numbers, hyphens, and underscores). Changing this will break any existing links, embeds, or QR codes that point to this page. Only change if you know what you're doing.",
  label: t("fields.listing.slug"),
  name: "slug",
  pattern: "[a-z0-9_-]+",
  required: true,
  title: "Lowercase letters, numbers, hyphens, and underscores only",
  type: "text",
  validate: (value: string) => validateSlug(normalizeSlug(value)),
};

/** Group selection field (validated even when rendered manually) */
export const groupIdField: Field = {
  label: t("fields.listing.group"),
  name: "group_id",
  type: "text",
};

/** Max attendees field for group forms */
const groupMaxAttendeesField: Field = {
  hint: t("groups.fields.max_attendees_hint"),
  label: t("groups.fields.max_attendees"),
  name: "max_attendees",
  type: "number",
};

/** Hidden group field (same as listing hidden field) */
const groupHiddenField: Field = buildHiddenField("Group");

/** Group description field */
const groupDescriptionField: Field = {
  hint: "Shown on the public page.",
  hintHtml: FORMATTING_HINT,
  label: "Description (optional)",
  markdown: true,
  maxlength: MAX_TEXTAREA_LENGTH,
  name: "description",
  placeholder: "A short description of the group",
  type: "textarea",
  validate: validateDescription,
};

/** Group form fields for creation (no slug - auto-generated) */
export const groupCreateFields: Field[] = [
  {
    label: t("groups.fields.name"),
    name: "name",
    placeholder: t("groups.fields.name_placeholder"),
    required: true,
    type: "text",
  },
  groupDescriptionField,
  groupMaxAttendeesField,
  {
    hint: t("groups.fields.terms_hint"),
    hintHtml: FORMATTING_HINT,
    label: t("groups.fields.terms"),
    markdown: true,
    maxlength: MAX_TEXTAREA_LENGTH,
    name: "terms_and_conditions",
    type: "textarea",
    validate: (value: string) =>
      value.length > MAX_TEXTAREA_LENGTH
        ? `Terms must be ${MAX_TEXTAREA_LENGTH} characters or fewer`
        : null,
  },
  groupHiddenField,
];

/** Group form field definitions (edit - includes slug) */
export const groupFields: Field[] = [
  groupCreateFields[0]!,
  slugField,
  groupCreateFields[1]!,
  groupCreateFields[2]!,
  groupCreateFields[3]!,
  groupHiddenField,
];

/** Name field shown on all ticket forms */
const nameField: Field = {
  autocomplete: "name",
  label: t("public.ticket.your_name"),
  name: "name",
  required: true,
  type: "text",
};

/** Email field for ticket forms */
const emailField: Field = {
  autocomplete: "email",
  label: t("public.ticket.your_email"),
  name: "email",
  required: true,
  type: "email",
  validate: validateEmail,
};

/** Phone field for ticket forms */
const phoneField: Field = {
  autocomplete: "tel",
  label: t("public.ticket.your_phone"),
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
    : `Address must be ${MAX_ADDRESS_LENGTH} characters or fewer`;

/** Address field for ticket forms (textarea) */
const addressField: Field = {
  autocomplete: "street-address",
  label: t("public.ticket.your_address"),
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
    : `Special instructions must be ${MAX_SPECIAL_INSTRUCTIONS_LENGTH} characters or fewer`;

/** Special instructions field for ticket forms (textarea) */
const specialInstructionsField: Field = {
  label: t("public.ticket.special_instructions"),
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
  label: t("admin.attendees.edit.quantity"),
  min: 1,
  name: "quantity",
  required: true,
  type: "number",
};

/** Date field for admin add-attendee form (daily listings only) */
const addAttendeeDateField: Field = {
  label: t("admin.attendee_table.col.date"),
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
  const result = [...getTicketFields(fields, false), addAttendeeQuantityField];
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
 * Setup form field definitions
 * Note: Stripe keys are now configured via environment variables
 */
export const setupFields: Field[] = [
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
 * Change password form field definitions
 */
export const changePasswordFields: Field[] = [
  {
    autocomplete: "current-password",
    label: t("password.current"),
    name: "current_password",
    required: true,
    type: "password",
  },
  newPasswordField("new_password", t("password.new")),
  newPasswordField("new_password_confirm", t("password.confirm"), {
    confirm: true,
  }),
];

/**
 * Stripe key settings form field definitions
 */
export const stripeKeyFields: Field[] = [
  {
    hint: t("fields.stripe.secret_key_hint"),
    label: t("fields.stripe.secret_key"),
    name: "stripe_secret_key",
    placeholder: t("fields.stripe.secret_key_placeholder"),
    required: true,
    type: "password",
  },
];

/**
 * Square access token and location form field definitions
 */
export const squareAccessTokenFields: Field[] = [
  {
    hint: t("fields.square.access_token_hint"),
    label: t("fields.square.access_token"),
    name: "square_access_token",
    placeholder: "EAAAl...",
    required: true,
    type: "password",
  },
  {
    hint: t("fields.square.location_id_hint"),
    label: t("fields.square.location_id"),
    name: "square_location_id",
    placeholder: "L...",
    required: true,
    type: "text",
  },
];

/**
 * Square webhook settings form field definitions
 */
export const squareWebhookFields: Field[] = [
  {
    hint: t("fields.square.webhook_key_hint"),
    label: t("fields.square.webhook_key"),
    name: "square_webhook_signature_key",
    required: true,
    type: "password",
  },
];

/**
 * SumUp API key and merchant code form field definitions
 */
export const sumupFields: Field[] = [
  {
    hint: "Your SumUp secret API key (sk_live_... or sk_test_...)",
    label: "SumUp API Key",
    name: "sumup_api_key",
    placeholder: "sk_live_... or sk_test_...",
    required: true,
    type: "password",
  },
  {
    hint: "Your SumUp merchant code (found in the SumUp dashboard, e.g. MC...)",
    label: "Merchant Code",
    name: "sumup_merchant_code",
    placeholder: "MC...",
    required: true,
    type: "text",
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
    label: t("users.invite_fields.role"),
    name: "admin_level",
    options: [
      { label: t("users.invite_fields.role_manager"), value: "manager" },
      { label: t("users.invite_fields.role_owner"), value: "owner" },
    ],
    required: true,
    type: "select",
  },
];

/**
 * Form field definitions and typed value interfaces for all forms
 */

import { formatCurrency } from "#shared/currency.ts";
import { DAY_NAMES } from "#shared/dates.ts";
import { CONFIG_KEYS, settings } from "#shared/db/settings.ts";
import {
  mergeEventFields,
  parseEventFields,
  withRequiredEmail,
} from "#shared/event-fields.ts";
import type { FormParams } from "#shared/form-data.ts";
import { type Field, validateForm } from "#shared/forms.tsx";
import {
  formatBytes,
  MAX_ATTACHMENT_SIZE,
  MAX_IMAGE_SIZE,
  MAX_TEXTAREA_LENGTH,
} from "#shared/limits.ts";
import { normalizeSlug, validateSlug } from "#shared/slug.ts";
import { isValidDatetime } from "#shared/timezone.ts";
import {
  type AdminLevel,
  type ContactField,
  type ContactInfo,
  type EventFields,
  type EventType,
  isContactField,
  isEventType,
} from "#shared/types.ts";

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
  purchase_only: string;
  assign_built_site: string;
  months_per_unit: string;
  initial_site_months: string;
};

/** Typed values from event edit form (includes slug) */
export type EventEditFormValues = EventFormValues & {
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
      return "URL must use https://";
    }
    return null;
  } catch {
    return "Invalid URL format";
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

/** Check if a hostname is a private/internal IP or localhost */
const isPrivateHostname = (hostname: string): boolean => {
  if (hostname === "localhost") return true;

  // IPv6 hostnames from the URL parser arrive wrapped in brackets.
  if (hostname.startsWith("[") && hostname.endsWith("]")) {
    const ipv6 = hostname.slice(1, -1);
    // :: (unspecified — equivalent to 0.0.0.0) and ::1 (loopback)
    if (ipv6 === "::" || ipv6 === "::1") return true;
    // IPv4-mapped IPv6 (::ffff:127.0.0.1 normalizes to [::ffff:7f00:1])
    const mapped = extractMappedIPv4(ipv6);
    if (mapped) return isPrivateIPv4(...mapped);
    // fe80::/10 — link-local (first 10 bits: 1111111010 → first group 0xfe80..0xfebf)
    // fc00::/7  — unique local (first 7 bits: 1111110  → first group 0xfc00..0xfdff)
    const firstGroup = ipv6.split(":")[0]!;
    if (firstGroup.length >= 3) {
      const n = Number.parseInt(firstGroup, 16);
      if (Number.isFinite(n)) {
        if (n >= 0xfe80 && n <= 0xfebf) return true;
        if (n >= 0xfc00 && n <= 0xfdff) return true;
      }
    }
    return false;
  }

  const parts = hostname.split(".");
  if (
    parts.length === 4 &&
    parts.every((p) => p !== "" && !Number.isNaN(Number(p)))
  ) {
    const a = Number(parts[0]);
    const b = Number(parts[1]);
    const c = Number(parts[2]);
    const d = Number(parts[3]);
    return isPrivateIPv4(a, b, c, d);
  }

  return false;
};

/**
 * Validate webhook URL — must be an externally routable HTTPS URL.
 * Rejects relative paths, localhost, and private IP ranges (SSRF protection).
 */
const validateWebhookUrl = (value: string): string | null => {
  // Reject relative URLs — webhook must be absolute and externally routable
  if (value.startsWith("/")) return "URL must use https://";

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") {
      return "URL must use https://";
    }
    if (isPrivateHostname(url.hostname)) {
      return "URL must use https://";
    }
    return null;
  } catch {
    return "Invalid URL format";
  }
};

/**
 * Validate price is non-negative
 */
const validateNonNegativePrice = (value: string): string | null => {
  const num = Number.parseFloat(value);
  if (Number.isNaN(num) || num < 0) {
    return "Price must be 0 or greater";
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
    return "Please enter a valid email address";
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
    return "Please enter a valid phone number";
  }
  return null;
};

/** Validate username format: alphanumeric, hyphens, underscores, 2-32 chars */
export const validateUsername = (value: string): string | null => {
  if (value.length < 2) return "Username must be at least 2 characters";
  if (value.length > 32) return "Username must be 32 characters or fewer";
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) {
    return "Username may only contain letters, numbers, hyphens, and underscores";
  }
  if (value.startsWith("-") || value.startsWith("_")) {
    return "Username may not start with a hyphen or underscore";
  }
  return null;
};

/** Base username field shared across login and invite forms */
const usernameFieldBase: Field = {
  label: "Username",
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
    label: "Password",
    name: "password",
    required: true,
    type: "password",
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
      return `Invalid contact field: ${part}`;
    }
  }
  return null;
};

/** Validate event type setting */
const validateEventType = (value: string): string | null => {
  if (!isEventType(value)) {
    return "Event Type must be standard or daily";
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
  if (days.length === 0) return "At least one day is required";
  for (const day of days) {
    if (!isValidDayName(day)) {
      return `Invalid day: ${day}. Use: ${VALID_DAY_NAMES.join(", ")}`;
    }
  }
  return null;
};

/** Shared formatting hint linking to the admin guide */
export const FORMATTING_HINT =
  '<a href="/admin/guide#text-formatting" target="_blank" rel="noopener">Formatting help</a>';

/** Validate description length */
const validateDescription = (value: string): string | null =>
  value.length > MAX_TEXTAREA_LENGTH
    ? `Description must be ${MAX_TEXTAREA_LENGTH} characters or fewer`
    : null;

/** Validate a datetime value is parseable */
const validateDatetime = (value: string): string | null =>
  isValidDatetime(value) ? null : "Please enter a valid date and time";

/** Build a "hidden" visibility checkbox field for an event or group. */
const buildHiddenField = (kind: "Event" | "Group"): Field => ({
  hint: `Hide from the public events page and search engines. The ${kind.toLowerCase()} is still bookable via its direct link.`,
  label: `Hidden ${kind}`,
  name: "hidden",
  options: [{ label: "Hide from public events list", value: "1" }],
  type: "checkbox-group",
});

/**
 * Event form field definitions (shared between create and edit)
 */
export const eventFields: Field[] = [
  {
    hint: "Displayed to attendees on the ticket page",
    label: "Event Name",
    name: "name",
    placeholder: "Village Quiz Night",
    required: true,
    type: "text",
  },
  {
    hint: "Daily events require attendees to select a specific date when booking",
    label: "Event Type",
    name: "event_type",
    options: [
      { label: "Standard", value: "standard" },
      { label: "Daily", value: "daily" },
    ],
    type: "select",
    validate: validateEventType,
  },
  {
    hint: "Shown on the ticket page.",
    hintHtml: FORMATTING_HINT,
    label: "Description (optional)",
    maxlength: MAX_TEXTAREA_LENGTH,
    name: "description",
    placeholder: "A short description of the event",
    type: "textarea",
    validate: validateDescription,
  },
  {
    hint: "When the event takes place. Times are in your configured timezone.",
    label: "Event Date (optional)",
    name: "date",
    type: "datetime",
    validate: validateDatetime,
  },
  {
    hint: "Where the event takes place. Shown on the ticket page.",
    label: "Location (optional)",
    name: "location",
    placeholder: "e.g. Village Hall, Main Street",
    type: "text",
  },
  {
    hint: "For daily events, this limit applies per date",
    label: "Max Attendees",
    min: 1,
    name: "max_attendees",
    required: true,
    type: "number",
  },
  {
    hint: "Maximum tickets a customer can buy in one transaction",
    label: "Max Tickets Per Purchase",
    min: 1,
    name: "max_quantity",
    required: true,
    type: "number",
  },
  {
    hint: "Select which days of the week are available for booking",
    label: "Bookable Days (for daily events)",
    name: "bookable_days",
    options: VALID_DAY_NAMES.map((d) => ({ label: d, value: d })),
    type: "checkbox-group",
    validate: validateBookableDays,
  },
  {
    hint: "How many days in advance attendees must book (0 = same day)",
    label: "Minimum Days Notice (for daily events)",
    min: 0,
    name: "minimum_days_before",
    type: "number",
  },
  {
    hint: "How far into the future attendees can book (0 = no limit)",
    label: "Maximum Days Ahead (for daily events)",
    min: 0,
    name: "maximum_days_after",
    type: "number",
  },
  {
    hint: "Which contact details to collect from attendees",
    hintHtml:
      "If you don't collect email addresses, <strong>attendees won't be emailed their ticket</strong>.",
    label: "Contact Fields",
    name: "fields",
    options: [
      { label: "Email", value: "email" },
      { label: "Phone Number", value: "phone" },
      { label: "Address", value: "address" },
      { label: "Special Instructions", value: "special_instructions" },
    ],
    type: "checkbox-group",
    validate: validateEventFields,
  },
  {
    inputmode: "decimal",
    label: "Ticket Price (leave empty for free)",
    name: "unit_price",
    pattern: "\\d+(\\.\\d{1,2})?",
    placeholder: "e.g. 10.00",
    title: "A non-negative number (e.g. 10.00)",
    type: "text",
    validate: validateNonNegativePrice,
  },
  {
    hint: "Let attendees pay more than the ticket price (the price above becomes a minimum)",
    label: "Allow Pay More",
    name: "can_pay_more",
    options: [{ label: "Allow attendees to set their own price", value: "1" }],
    type: "checkbox-group",
  },
  {
    defaultValue: "100.00",
    get hint() {
      return `The maximum price attendees can pay. Must be at least ${formatCurrency(
        100,
      )} more than the ticket price.`;
    },
    inputmode: "decimal",
    label: "Maximum Price (for pay more)",
    name: "max_price",
    pattern: "\\d+(\\.\\d{1,2})?",
    placeholder: "e.g. 100.00",
    title: "A non-negative number (e.g. 100.00)",
    type: "text",
    validate: validateNonNegativePrice,
  },
  {
    hint: "Leave blank for no deadline. Times are in your configured timezone.",
    label: "Registration Closes At (optional)",
    name: "closes_at",
    type: "datetime",
    validate: validateDatetime,
  },
  {
    hint: "Leave blank to show a simple success message",
    label: "Thank You URL (optional)",
    name: "thank_you_url",
    placeholder: "https://example.com/thank-you",
    type: "url",
    validate: validateSafeUrl,
  },
  {
    hint: "Receives POST with attendee name, email, and phone on registration",
    label: "Webhook URL (optional)",
    name: "webhook_url",
    placeholder: "https://example.com/webhook",
    type: "url",
    validate: validateWebhookUrl,
  },
  {
    hint: "Requires attendees to show ID matching the ticket name at entry",
    label: "Non-Transferable Tickets",
    name: "non_transferable",
    options: [
      { label: "No", value: "" },
      { label: "Yes", value: "1" },
    ],
    type: "select",
  },
  buildHiddenField("Event"),
  {
    hint: "For raffles, fundraisers, donations, or other non-attendance items. Hides QR codes, check-in, and wallet passes. Shows \u2018Buy now\u2019 instead of \u2018Reserve\u2019.",
    label: "Purchase Only",
    name: "purchase_only",
    options: [{ label: "No attendance required", value: "1" }],
    type: "checkbox-group",
  },
];

export const monthsPerUnitField: Field = {
  hint: "How many months one ticket buys. Leave 0 for non-renewal events.",
  label: "Months Per Unit (renewal tiers only)",
  max: 24,
  min: 0,
  name: "months_per_unit",
  type: "number",
};

export const initialSiteMonthsField: Field = {
  hint: "How many months the site stays active after purchase. Required when assigning a built site.",
  label: "Initial Site Months (built site events only)",
  max: 120,
  min: 0,
  name: "initial_site_months",
  type: "number",
};

/** Validate date format (YYYY-MM-DD) */
export const validateDate = (value: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return "Please enter a valid date (YYYY-MM-DD)";
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Please enter a valid date";
  return null;
};

/**
 * Holiday form field definitions
 */
export const holidayFields: Field[] = [
  {
    label: "Holiday Name",
    name: "name",
    placeholder: "Bank Holiday",
    required: true,
    type: "text",
  },
  {
    label: "Start Date",
    name: "start_date",
    required: true,
    type: "date",
    validate: validateDate,
  },
  {
    hint: "Must be on or after the start date",
    label: "End Date",
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

/** Field for assign_built_site on events (conditionally shown when CAN_BUILD_SITES is enabled) */
export const assignBuiltSiteField: Field = {
  hint: "Automatically assign a built site to each ticket purchased for this event",
  label: "Assign Built Site",
  name: "assign_built_site",
  options: [{ label: "Assign a site on booking", value: "1" }],
  type: "checkbox-group",
};

/** Image upload field for event forms (appended when storage is enabled) */
export const imageField: Field = {
  accept: "image/jpeg,image/png,image/gif,image/webp",
  label: `Event Image (JPEG, PNG, GIF, WebP \u2014 max ${formatBytes(
    MAX_IMAGE_SIZE,
  )})`,
  name: "image",
  type: "file",
};

/** Attachment upload field for event forms (appended when storage is enabled) */
export const attachmentField: Field = {
  label: `Attachment (any file \u2014 max ${formatBytes(MAX_ATTACHMENT_SIZE)})`,
  name: "attachment",
  type: "file",
};

/** Slug field for event/group edit pages */
export const slugField: Field = {
  hint: "URL-friendly identifier (lowercase letters, numbers, and hyphens). Changing this will break any existing links, embeds, or QR codes that point to this page. Only change if you know what you're doing.",
  label: "Slug",
  name: "slug",
  pattern: "[a-z0-9-]+",
  required: true,
  title: "Lowercase letters, numbers, and hyphens only",
  type: "text",
  validate: (value: string) => validateSlug(normalizeSlug(value)),
};

/** Group selection field (validated even when rendered manually) */
export const groupIdField: Field = {
  label: "Group",
  name: "group_id",
  type: "text",
};

/** Max attendees field for group forms */
const groupMaxAttendeesField: Field = {
  hint: "Limits total attendees across all events in this group. Leave blank for no limit. Works best when all events in the group are the same type (daily or standard).",
  label: "Max Attendees (optional)",
  name: "max_attendees",
  type: "number",
};

/** Hidden group field (same as event hidden field) */
const groupHiddenField: Field = buildHiddenField("Group");

/** Group description field */
const groupDescriptionField: Field = {
  hint: "Shown on the public page.",
  hintHtml: FORMATTING_HINT,
  label: "Description (optional)",
  maxlength: MAX_TEXTAREA_LENGTH,
  name: "description",
  placeholder: "A short description of the group",
  type: "textarea",
  validate: validateDescription,
};

/** Group form fields for creation (no slug - auto-generated) */
export const groupCreateFields: Field[] = [
  {
    label: "Group Name",
    name: "name",
    placeholder: "Summer Fete",
    required: true,
    type: "text",
  },
  groupDescriptionField,
  groupMaxAttendeesField,
  {
    hint: "If set, overrides the global terms and conditions for this group ticket page",
    hintHtml: FORMATTING_HINT,
    label: "Terms and Conditions (optional)",
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
export const validateAddress = (value: string): string | null =>
  value.length > MAX_ADDRESS_LENGTH
    ? `Address must be ${MAX_ADDRESS_LENGTH} characters or fewer`
    : null;

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
export const validateSpecialInstructions = (value: string): string | null =>
  value.length > MAX_SPECIAL_INSTRUCTIONS_LENGTH
    ? `Special instructions must be ${MAX_SPECIAL_INSTRUCTIONS_LENGTH} characters or fewer`
    : null;

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

export { mergeEventFields, parseEventFields };

/** Stubbable API for testing */
export const fieldsApi = { getSettingCached: settings.getCachedRaw };

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

/** Date field for admin add-attendee form (daily events only) */
const addAttendeeDateField: Field = {
  label: "Date",
  name: "date",
  required: true,
  type: "date",
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
  ...(!confirm && { hint: "Minimum 8 characters", minlength: 8 }),
});

/**
 * Setup form field definitions
 * Note: Stripe keys are now configured via environment variables
 */
export const setupFields: Field[] = [
  {
    autocomplete: "username",
    hint: "Letters, numbers, hyphens, underscores (2-32 chars)",
    label: "Admin Username *",
    name: "admin_username",
    required: true,
    type: "text",
    validate: validateUsername,
  },
  newPasswordField("admin_password", "Admin Password *"),
  newPasswordField("admin_password_confirm", "Confirm Admin Password *", {
    confirm: true,
  }),
];

/**
 * Change password form field definitions
 */
export const changePasswordFields: Field[] = [
  {
    autocomplete: "current-password",
    label: "Current Password",
    name: "current_password",
    required: true,
    type: "password",
  },
  newPasswordField("new_password", "New Password"),
  newPasswordField("new_password_confirm", "Confirm New Password", {
    confirm: true,
  }),
];

/**
 * Stripe key settings form field definitions
 */
export const stripeKeyFields: Field[] = [
  {
    hint: "Enter a new key to update",
    label: "Stripe Secret Key",
    name: "stripe_secret_key",
    placeholder: "sk_live_... or sk_test_...",
    required: true,
    type: "password",
  },
];

/**
 * Square access token and location form field definitions
 */
export const squareAccessTokenFields: Field[] = [
  {
    hint: "Your Square application's access token",
    label: "Square Access Token",
    name: "square_access_token",
    placeholder: "EAAAl...",
    required: true,
    type: "password",
  },
  {
    hint: "Your Square location ID (found in Square Dashboard under Locations)",
    label: "Location ID",
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
    hint: "The signature key from your Square webhook subscription",
    label: "Webhook Signature Key",
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
    hint: "Letters, numbers, hyphens, underscores (2-32 chars)",
    validate: validateUsername,
  },
  {
    label: "Role",
    name: "admin_level",
    options: [
      { label: "Manager", value: "manager" },
      { label: "Owner", value: "owner" },
    ],
    required: true,
    type: "select",
  },
];

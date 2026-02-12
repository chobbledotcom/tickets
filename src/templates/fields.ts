/**
 * Form field definitions and typed value interfaces for all forms
 */

import { DAY_NAMES, normalizeDatetime } from "#lib/dates.ts";
import type { Field } from "#lib/forms.tsx";
import type { AdminLevel, EventFields, EventType } from "#lib/types.ts";
import { normalizeSlug, validateSlug } from "#lib/slug.ts";

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
  unit_price: number | null;
  closes_at: string;
  thank_you_url: string;
  webhook_url: string;
  event_type: EventType | "";
  bookable_days: string;
  minimum_days_before: number | null;
  maximum_days_after: number | null;
};

/** Typed values from event edit form (includes slug) */
export type EventEditFormValues = EventFormValues & {
  slug: string;
};

/** Typed values from ticket form (field presence varies by event config) */
export type TicketFormValues = {
  name: string;
  email: string;
  phone: string;
};

/** Typed values from admin add-attendee form */
export type AddAttendeeFormValues = {
  name: string;
  email: string;
  phone: string;
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
  currency_code: string;
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
  const num = Number.parseInt(value, 10);
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
  return null;
};

/**
 * Login form field definitions
 */
export const loginFields: Field[] = [
  { name: "username", label: "Username", type: "text", required: true },
  { name: "password", label: "Password", type: "password", required: true },
];

/** Valid event fields values */
const VALID_EVENT_FIELDS: readonly string[] = ["email", "phone", "both"];

/** Validate event fields setting */
const validateEventFields = (value: string): string | null => {
  if (!VALID_EVENT_FIELDS.includes(value)) {
    return "Contact Fields must be email, phone, or both";
  }
  return null;
};

/** Valid event type values */
const VALID_EVENT_TYPES: EventType[] = ["standard", "daily"];

/** Validate event type setting */
const validateEventType = (value: string): string | null => {
  if (!VALID_EVENT_TYPES.includes(value as EventType)) {
    return "Event Type must be standard or daily";
  }
  return null;
};

/** Valid day names for bookable_days (Monday-first for display) */
export const VALID_DAY_NAMES = [...DAY_NAMES.slice(1), DAY_NAMES[0]!];

/** Validate bookable days (comma-separated day names) */
export const validateBookableDays = (value: string): string | null => {
  const days = value.split(",").map((d) => d.trim()).filter((d) => d);
  if (days.length === 0) return "At least one day is required";
  for (const day of days) {
    if (!(VALID_DAY_NAMES as readonly string[]).includes(day)) {
      return `Invalid day: ${day}. Use: ${VALID_DAY_NAMES.join(", ")}`;
    }
  }
  return null;
};

/** Max length for event description */
const MAX_DESCRIPTION_LENGTH = 128;

/** Validate description length */
const validateDescription = (value: string): string | null =>
  value.length > MAX_DESCRIPTION_LENGTH
    ? `Description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`
    : null;

/** Validate a datetime-local value is a valid UTC date */
const validateDatetimeLocal = (value: string): string | null => {
  try {
    normalizeDatetime(value, "date");
    return null;
  } catch {
    return "Please enter a valid date and time";
  }
};

/**
 * Event form field definitions (shared between create and edit)
 */
export const eventFields: Field[] = [
  {
    name: "name",
    label: "Event Name",
    type: "text",
    required: true,
    placeholder: "Village Quiz Night",
    hint: "Displayed to attendees on the ticket page",
  },
  {
    name: "description",
    label: "Description (optional)",
    type: "text",
    placeholder: "A short description of the event",
    hint: "Shown on the ticket page. HTML is allowed. Max 128 characters.",
    validate: validateDescription,
  },
  {
    name: "date",
    label: "Event Date (optional)",
    type: "datetime-local",
    hint: "When the event takes place. Times are in UTC.",
    validate: validateDatetimeLocal,
  },
  {
    name: "location",
    label: "Location (optional)",
    type: "text",
    placeholder: "e.g. Village Hall, Main Street",
    hint: "Where the event takes place. Shown on the ticket page.",
  },
  {
    name: "event_type",
    label: "Event Type",
    type: "select",
    hint: "Daily events require attendees to select a specific date when booking",
    options: [
      { value: "standard", label: "Standard" },
      { value: "daily", label: "Daily" },
    ],
    validate: validateEventType,
  },
  {
    name: "max_attendees",
    label: "Max Attendees",
    type: "number",
    required: true,
    min: 1,
    hint: "For daily events, this limit applies per date",
  },
  {
    name: "max_quantity",
    label: "Max Tickets Per Purchase",
    type: "number",
    required: true,
    min: 1,
    hint: "Maximum tickets a customer can buy in one transaction",
  },
  {
    name: "bookable_days",
    label: "Bookable Days (for daily events)",
    type: "checkbox-group",
    hint: "Select which days of the week are available for booking",
    options: VALID_DAY_NAMES.map((d) => ({ value: d, label: d })),
    validate: validateBookableDays,
  },
  {
    name: "minimum_days_before",
    label: "Minimum Days Notice (for daily events)",
    type: "number",
    min: 0,
    hint: "How many days in advance attendees must book (0 = same day)",
  },
  {
    name: "maximum_days_after",
    label: "Maximum Days Ahead (for daily events)",
    type: "number",
    min: 0,
    hint: "How far into the future attendees can book (0 = no limit)",
  },
  {
    name: "fields",
    label: "Contact Fields",
    type: "select",
    hint: "Which contact details to collect from attendees",
    options: [
      { value: "email", label: "Email" },
      { value: "phone", label: "Phone Number" },
      { value: "both", label: "Email & Phone Number" },
    ],
    validate: validateEventFields,
  },
  {
    name: "unit_price",
    label: "Ticket Price (in pence/cents, leave empty for free)",
    type: "number",
    min: 0,
    placeholder: "e.g. 1000 for 10.00",
    validate: validateNonNegativePrice,
  },
  {
    name: "closes_at",
    label: "Registration Closes At (optional)",
    type: "datetime-local",
    hint: "Leave blank for no deadline. Times are in UTC.",
    validate: validateDatetimeLocal,
  },
  {
    name: "thank_you_url",
    label: "Thank You URL (optional)",
    type: "url",
    placeholder: "https://example.com/thank-you",
    hint: "Leave blank to show a simple success message",
    validate: validateSafeUrl,
  },
  {
    name: "webhook_url",
    label: "Webhook URL (optional)",
    type: "url",
    placeholder: "https://example.com/webhook",
    hint: "Receives POST with attendee name, email, and phone on registration",
    validate: validateSafeUrl,
  },
];

/** Validate date format (YYYY-MM-DD) */
export const validateDate = (value: string): string | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "Please enter a valid date (YYYY-MM-DD)";
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "Please enter a valid date";
  return null;
};

/**
 * Holiday form field definitions
 */
export const holidayFields: Field[] = [
  {
    name: "name",
    label: "Holiday Name",
    type: "text",
    required: true,
    placeholder: "Bank Holiday",
  },
  {
    name: "start_date",
    label: "Start Date",
    type: "date",
    required: true,
    validate: validateDate,
  },
  {
    name: "end_date",
    label: "End Date",
    type: "date",
    required: true,
    hint: "Must be on or after the start date",
    validate: validateDate,
  },
];

/** Slug field for event edit page only */
export const slugField: Field = {
  name: "slug",
  label: "Slug",
  type: "text",
  required: true,
  hint: "URL-friendly identifier (lowercase letters, numbers, and hyphens)",
  validate: (value: string) => validateSlug(normalizeSlug(value)),
};

/** Name field shown on all ticket forms */
const nameField: Field = {
  name: "name",
  label: "Your Name",
  type: "text",
  required: true,
};

/** Email field for ticket forms */
const emailField: Field = {
  name: "email",
  label: "Your Email",
  type: "email",
  required: true,
  validate: validateEmail,
};

/** Phone field for ticket forms */
const phoneField: Field = {
  name: "phone",
  label: "Your Phone Number",
  type: "text",
  required: true,
  validate: validatePhone,
};

/**
 * Ticket reservation form field definitions (legacy - email only)
 */
export const ticketFields: Field[] = [nameField, emailField];

/**
 * Get ticket form fields based on event fields setting.
 * Always includes name. Adds email and/or phone based on the setting.
 */
export const getTicketFields = (fields: EventFields): Field[] => {
  switch (fields) {
    case "email":
      return [nameField, emailField];
    case "phone":
      return [nameField, phoneField];
    case "both":
      return [nameField, emailField, phoneField];
  }
};

/** Quantity field for admin add-attendee form */
const addAttendeeQuantityField: Field = {
  name: "quantity",
  label: "Quantity",
  type: "number",
  required: true,
  min: 1,
};

/** Date field for admin add-attendee form (daily events only) */
const addAttendeeDateField: Field = {
  name: "date",
  label: "Date",
  type: "date",
  required: true,
  validate: validateDate,
};

/**
 * Get admin add-attendee form fields based on event config.
 * Includes contact fields (name + email/phone per setting), quantity,
 * and a date field for daily events.
 */
export const getAddAttendeeFields = (fields: EventFields, isDaily: boolean): Field[] => {
  const result = [...getTicketFields(fields), addAttendeeQuantityField];
  if (isDaily) result.push(addAttendeeDateField);
  return result;
};

/**
 * Determine which contact fields to collect for multiple events.
 * If all events share the same single-field setting, use that.
 * If any differ, collect both.
 */
export const mergeEventFields = (fieldSettings: EventFields[]): EventFields => {
  if (fieldSettings.length === 0) return "email";
  const first = fieldSettings[0]!;
  const allSame = fieldSettings.every((f) => f === first);
  if (allSame) return first;
  return "both";
};

/**
 * Setup form field definitions
 * Note: Stripe keys are now configured via environment variables
 */
export const setupFields: Field[] = [
  {
    name: "admin_username",
    label: "Admin Username *",
    type: "text",
    required: true,
    hint: "Letters, numbers, hyphens, underscores (2-32 chars)",
    validate: validateUsername,
  },
  {
    name: "admin_password",
    label: "Admin Password *",
    type: "password",
    required: true,
    hint: "Minimum 8 characters",
  },
  {
    name: "admin_password_confirm",
    label: "Confirm Admin Password *",
    type: "password",
    required: true,
  },
  {
    name: "currency_code",
    label: "Currency Code",
    type: "text",
    pattern: "[A-Z]{3}",
    hint: "3-letter ISO code (e.g., GBP, USD, EUR)",
  },
];

/**
 * Change password form field definitions
 */
export const changePasswordFields: Field[] = [
  {
    name: "current_password",
    label: "Current Password",
    type: "password",
    required: true,
  },
  {
    name: "new_password",
    label: "New Password",
    type: "password",
    required: true,
    hint: "Minimum 8 characters",
  },
  {
    name: "new_password_confirm",
    label: "Confirm New Password",
    type: "password",
    required: true,
  },
];

/**
 * Stripe key settings form field definitions
 */
export const stripeKeyFields: Field[] = [
  {
    name: "stripe_secret_key",
    label: "Stripe Secret Key",
    type: "password",
    required: true,
    placeholder: "sk_live_... or sk_test_...",
    hint: "Enter a new key to update",
  },
];

/**
 * Square access token and location form field definitions
 */
export const squareAccessTokenFields: Field[] = [
  {
    name: "square_access_token",
    label: "Square Access Token",
    type: "password",
    required: true,
    placeholder: "EAAAl...",
    hint: "Your Square application's access token",
  },
  {
    name: "square_location_id",
    label: "Location ID",
    type: "text",
    required: true,
    placeholder: "L...",
    hint: "Your Square location ID (found in Square Dashboard under Locations)",
  },
];

/**
 * Square webhook settings form field definitions
 */
export const squareWebhookFields: Field[] = [
  {
    name: "square_webhook_signature_key",
    label: "Webhook Signature Key",
    type: "password",
    required: true,
    hint: "The signature key from your Square webhook subscription",
  },
];

/**
 * Invite user form field definitions
 */
export const inviteUserFields: Field[] = [
  {
    name: "username",
    label: "Username",
    type: "text",
    required: true,
    hint: "Letters, numbers, hyphens, underscores (2-32 chars)",
    validate: validateUsername,
  },
  {
    name: "admin_level",
    label: "Role",
    type: "select",
    required: true,
    options: [
      { value: "manager", label: "Manager" },
      { value: "owner", label: "Owner" },
    ],
  },
];

/**
 * Join (set password) form field definitions
 */
export const joinFields: Field[] = [
  {
    name: "password",
    label: "Password",
    type: "password",
    required: true,
    hint: "Minimum 8 characters",
  },
  {
    name: "password_confirm",
    label: "Confirm Password",
    type: "password",
    required: true,
  },
];

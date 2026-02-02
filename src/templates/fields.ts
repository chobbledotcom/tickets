/**
 * Form field definitions for all forms
 */

import type { Field } from "#lib/forms.tsx";
import type { EventFields } from "#lib/types.ts";
import { normalizeSlug, validateSlug } from "#lib/slug.ts";

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
const VALID_EVENT_FIELDS: EventFields[] = ["email", "phone", "both"];

/** Validate event fields setting */
const validateEventFields = (value: string): string | null => {
  if (!VALID_EVENT_FIELDS.includes(value as EventFields)) {
    return "Contact Fields must be email, phone, or both";
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

/**
 * Validate closes_at is a valid date if provided.
 * Normalizes datetime-local format to UTC ISO before parsing.
 */
const validateClosesAt = (value: string): string | null => {
  const normalized = value.length === 16 ? `${value}:00.000Z` : value;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())) {
    return "Please enter a valid date and time";
  }
  return null;
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
    name: "max_attendees",
    label: "Max Attendees",
    type: "number",
    required: true,
    min: 1,
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
    validate: validateClosesAt,
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

/**
 * Determine which contact fields to collect for multiple events.
 * If all events share the same single-field setting, use that.
 * If any differ, collect both.
 */
export const mergeEventFields = (fieldSettings: EventFields[]): EventFields => {
  if (fieldSettings.length === 0) return "email";
  const first = fieldSettings[0] as EventFields;
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

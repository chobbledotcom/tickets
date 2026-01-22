/**
 * Form field definitions for all forms
 */

import type { Field } from "#lib/forms.ts";

/**
 * Validate URL is safe (https or relative path, no javascript: etc.)
 */
const validateSafeUrl = (value: string): string | null => {
  // Allow relative URLs starting with /
  if (value.startsWith("/")) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      return "URL must use https:// or http://";
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
const validateEmail = (value: string): string | null => {
  // Basic email format check - more permissive than strict RFC but catches common issues
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(value)) {
    return "Please enter a valid email address";
  }
  return null;
};

/**
 * Login form field definitions
 */
export const loginFields: Field[] = [
  { name: "password", label: "Password", type: "password", required: true },
];

/**
 * Event form field definitions (shared between create and edit)
 */
export const eventFields: Field[] = [
  { name: "name", label: "Event Name", type: "text", required: true },
  {
    name: "description",
    label: "Description",
    type: "textarea",
    required: true,
  },
  {
    name: "max_attendees",
    label: "Max Attendees",
    type: "number",
    required: true,
    min: 1,
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
    name: "thank_you_url",
    label: "Thank You URL",
    type: "url",
    required: true,
    placeholder: "https://example.com/thank-you",
    validate: validateSafeUrl,
  },
];

/**
 * Ticket reservation form field definitions
 */
export const ticketFields: Field[] = [
  { name: "name", label: "Your Name", type: "text", required: true },
  {
    name: "email",
    label: "Your Email",
    type: "email",
    required: true,
    validate: validateEmail,
  },
];

/**
 * Setup form field definitions
 */
export const setupFields: Field[] = [
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
    name: "stripe_secret_key",
    label: "Stripe Secret Key (optional)",
    type: "password",
    placeholder: "sk_live_... or sk_test_...",
    hint: "Leave empty to disable payments",
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

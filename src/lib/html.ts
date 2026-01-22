/**
 * HTML template functions for the ticket reservation system
 */

import { map, pipe, reduce } from "#fp";

/**
 * Escape a value for CSV (handles commas, quotes, newlines)
 */
const escapeCsvValue = (value: string): string => {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
};

/**
 * Generate CSV content from attendees
 */
export const generateAttendeesCsv = (attendees: Attendee[]): string => {
  const header = "Name,Email,Registered";
  const rows = pipe(
    map((a: Attendee) =>
      [
        escapeCsvValue(a.name),
        escapeCsvValue(a.email),
        escapeCsvValue(new Date(a.created).toISOString()),
      ].join(","),
    ),
    reduce((acc: string, row: string) => `${acc}\n${row}`, header),
  )(attendees);
  return rows;
};

import {
  type Field,
  type FieldValues,
  renderError,
  renderFields,
} from "./forms.ts";
import type { Attendee, Event, EventWithCount } from "./types.ts";

const escapeHtml = (str: string): string =>
  str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

const baseStyles = `
  body { font-family: system-ui, sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; }
  h1 { color: #333; }
  .form-group { margin-bottom: 1rem; }
  label { display: block; margin-bottom: 0.5rem; font-weight: 500; }
  input, textarea { padding: 0.5rem; font-size: 1rem; border: 1px solid #ccc; border-radius: 4px; width: 100%; box-sizing: border-box; }
  button { background: #0066cc; color: white; padding: 0.5rem 1.5rem; font-size: 1rem; border: none; border-radius: 4px; cursor: pointer; }
  button:hover { background: #0055aa; }
  .error { color: #cc0000; background: #ffeeee; padding: 1rem; border-radius: 4px; margin-bottom: 1rem; }
  .success { color: #006600; background: #eeffee; padding: 1rem; border-radius: 4px; margin-bottom: 1rem; }
  table { width: 100%; border-collapse: collapse; margin-top: 1rem; }
  th, td { padding: 0.5rem; text-align: left; border-bottom: 1px solid #ddd; }
  th { background: #f5f5f5; }
  a { color: #0066cc; }
`;

/**
 * Wrap content in basic HTML layout
 */
export const layout = (
  title: string,
  content: string,
): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>${baseStyles}</style>
</head>
<body>
  ${content}
</body>
</html>`;

/**
 * Login form field definitions
 */
export const loginFields: Field[] = [
  { name: "password", label: "Password", type: "password", required: true },
];

/**
 * Admin login page
 */
export const adminLoginPage = (error?: string): string =>
  layout(
    "Admin Login",
    `
    <h1>Admin Login</h1>
    ${renderError(error)}
    <form method="POST" action="/admin/login">
      ${renderFields(loginFields)}
      <button type="submit">Login</button>
    </form>
  `,
  );

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

const renderEventRow = (e: EventWithCount): string => `
  <tr>
    <td>${escapeHtml(e.name)}</td>
    <td>${e.attendee_count} / ${e.max_attendees}</td>
    <td>${new Date(e.created).toLocaleDateString()}</td>
    <td><a href="/admin/event/${e.id}">View</a></td>
  </tr>
`;

/**
 * Admin dashboard page
 */
export const adminDashboardPage = (
  events: EventWithCount[],
  csrfToken: string,
): string => {
  const eventRows =
    events.length > 0
      ? pipe(map(renderEventRow), joinStrings)(events)
      : '<tr><td colspan="4">No events yet</td></tr>';

  return layout(
    "Admin Dashboard",
    `
    <h1>Admin Dashboard</h1>
    <p><a href="/admin/logout">Logout</a></p>

    <h2>Events</h2>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Attendees</th>
          <th>Created</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        ${eventRows}
      </tbody>
    </table>

    <h2>Create New Event</h2>
    <form method="POST" action="/admin/event">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
      ${renderFields(eventFields)}
      <button type="submit">Create Event</button>
    </form>
  `,
  );
};

const renderAttendeeRow = (a: Attendee): string => `
  <tr>
    <td>${escapeHtml(a.name)}</td>
    <td>${escapeHtml(a.email)}</td>
    <td>${new Date(a.created).toLocaleString()}</td>
  </tr>
`;

/**
 * Admin event detail page
 */
export const adminEventPage = (
  event: EventWithCount,
  attendees: Attendee[],
): string => {
  const attendeeRows =
    attendees.length > 0
      ? pipe(map(renderAttendeeRow), joinStrings)(attendees)
      : '<tr><td colspan="3">No attendees yet</td></tr>';

  return layout(
    `Event: ${event.name}`,
    `
    <h1>${escapeHtml(event.name)}</h1>
    <p><a href="/admin/">&larr; Back to Dashboard</a> | <a href="/admin/event/${event.id}/edit">Edit Event</a></p>

    <h2>Event Details</h2>
    <p><strong>Description:</strong> ${escapeHtml(event.description)}</p>
    <p><strong>Max Attendees:</strong> ${event.max_attendees}</p>
    <p><strong>Current Attendees:</strong> ${event.attendee_count}</p>
    <p><strong>Spots Remaining:</strong> ${event.max_attendees - event.attendee_count}</p>
    <p><strong>Thank You URL:</strong> <a href="${escapeHtml(event.thank_you_url)}">${escapeHtml(event.thank_you_url)}</a></p>
    <p><strong>Ticket URL:</strong> <a href="/ticket/${event.id}">/ticket/${event.id}</a></p>

    <h2>Attendees</h2>
    <p><a href="/admin/event/${event.id}/export" style="display: inline-block; background: #0066cc; color: white; padding: 0.5rem 1rem; font-size: 0.9rem; border-radius: 4px; text-decoration: none;">Export CSV</a></p>
    <table>
      <thead>
        <tr>
          <th>Name</th>
          <th>Email</th>
          <th>Registered</th>
        </tr>
      </thead>
      <tbody>
        ${attendeeRows}
      </tbody>
    </table>
  `,
  );
};

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
 * Convert event to form field values
 */
const eventToFieldValues = (event: EventWithCount): FieldValues => ({
  name: event.name,
  description: event.description,
  max_attendees: event.max_attendees,
  unit_price: event.unit_price,
  thank_you_url: event.thank_you_url,
});

/**
 * Admin event edit page
 */
export const adminEventEditPage = (
  event: EventWithCount,
  csrfToken: string,
  error?: string,
): string =>
  layout(
    `Edit: ${event.name}`,
    `
    <h1>Edit Event</h1>
    <p><a href="/admin/event/${event.id}">&larr; Back to Event</a></p>
    ${renderError(error)}
    <form method="POST" action="/admin/event/${event.id}/edit">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
      ${renderFields(eventFields, eventToFieldValues(event))}
      <button type="submit">Save Changes</button>
    </form>
  `,
  );

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
 * Public ticket page
 */
export const ticketPage = (event: EventWithCount, error?: string): string => {
  const spotsRemaining = event.max_attendees - event.attendee_count;
  const isFull = spotsRemaining <= 0;

  return layout(
    `Reserve Ticket: ${event.name}`,
    `
    <h1>${escapeHtml(event.name)}</h1>
    <p>${escapeHtml(event.description)}</p>
    <p><strong>Spots remaining:</strong> ${spotsRemaining}</p>

    ${renderError(error)}

    ${
      isFull
        ? '<div class="error">Sorry, this event is full.</div>'
        : `
      <form method="POST" action="/ticket/${event.id}">
        ${renderFields(ticketFields)}
        <button type="submit">Reserve Ticket</button>
      </form>
    `
    }
  `,
  );
};

/**
 * Event not found page
 */
export const notFoundPage = (): string =>
  layout(
    "Not Found",
    `
    <h1>Event Not Found</h1>
    <p>The event you're looking for doesn't exist.</p>
  `,
  );

/**
 * Home page
 */
export const homePage = (): string =>
  layout(
    "Ticket Reservation System",
    `
    <h1>Ticket Reservation System</h1>
    <p>Welcome to the ticket reservation system.</p>
    <p><a href="/admin/">Admin Login</a></p>
  `,
  );

/**
 * Payment page - redirects to Stripe Checkout
 */
export const paymentPage = (
  event: Event,
  attendee: Attendee,
  checkoutUrl: string,
  formattedPrice: string,
): string =>
  layout(
    `Payment: ${event.name}`,
    `
    <h1>Complete Your Payment</h1>
    <p>You are purchasing a ticket for <strong>${escapeHtml(event.name)}</strong></p>

    <div style="background: #f5f5f5; padding: 1rem; border-radius: 4px; margin: 1rem 0;">
      <p><strong>Name:</strong> ${escapeHtml(attendee.name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(attendee.email)}</p>
      <p><strong>Amount:</strong> ${escapeHtml(formattedPrice)}</p>
    </div>

    <p>Click the button below to complete your payment securely via Stripe.</p>
    <a href="${escapeHtml(checkoutUrl)}" style="display: inline-block; background: #0066cc; color: white; padding: 0.75rem 2rem; font-size: 1rem; border-radius: 4px; text-decoration: none;">
      Pay Now
    </a>
  `,
  );

/**
 * Payment success page
 */
export const paymentSuccessPage = (event: Event, thankYouUrl: string): string =>
  layout(
    "Payment Successful",
    `
    <h1>Payment Successful!</h1>
    <div class="success">
      <p>Thank you for your payment. Your ticket for <strong>${escapeHtml(event.name)}</strong> has been confirmed.</p>
    </div>
    <p>You will be redirected shortly...</p>
    <p><a href="${escapeHtml(thankYouUrl)}">Click here if you are not redirected</a></p>
    <script>
      setTimeout(function() {
        window.location.href = "${escapeHtml(thankYouUrl)}";
      }, 3000);
    </script>
  `,
  );

/**
 * Payment cancelled page
 */
export const paymentCancelPage = (event: Event, ticketUrl: string): string =>
  layout(
    "Payment Cancelled",
    `
    <h1>Payment Cancelled</h1>
    <p>Your payment was cancelled. Your ticket reservation for <strong>${escapeHtml(event.name)}</strong> has been removed.</p>
    <p><a href="${escapeHtml(ticketUrl)}">Try again</a></p>
  `,
  );

/**
 * Payment error page
 */
export const paymentErrorPage = (message: string): string =>
  layout(
    "Payment Error",
    `
    <h1>Payment Error</h1>
    <div class="error">
      <p>${escapeHtml(message)}</p>
    </div>
    <p><a href="/">Return to home</a></p>
  `,
  );

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
 * Initial setup page
 */
export const setupPage = (error?: string, csrfToken?: string): string =>
  layout(
    "Setup",
    `
    <h1>Initial Setup</h1>
    <p>Welcome! Please configure your ticket reservation system.</p>
    ${renderError(error)}
    <form method="POST" action="/setup/">
      ${csrfToken ? `<input type="hidden" name="csrf_token" value="${csrfToken}">` : ""}
      ${renderFields(setupFields, { currency_code: "GBP" })}
      <button type="submit">Complete Setup</button>
    </form>
  `,
  );

/**
 * Setup complete page
 */
export const setupCompletePage = (): string =>
  layout(
    "Setup Complete",
    `
    <h1>Setup Complete!</h1>
    <div class="success">
      <p>Your ticket reservation system has been configured successfully.</p>
    </div>
    <p><a href="/admin/">Go to Admin Dashboard</a></p>
  `,
  );

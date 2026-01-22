/**
 * Admin page templates - dashboard, events, settings
 */

import { map, pipe, reduce } from "#fp";
import { type FieldValues, renderError, renderFields } from "#lib/forms.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { changePasswordFields, eventFields, loginFields } from "./fields.ts";
import { escapeHtml, layout } from "./layout.ts";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

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
    <p><a href="/admin/settings">Settings</a> | <a href="/admin/logout">Logout</a></p>

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
 * Admin settings page
 */
export const adminSettingsPage = (
  csrfToken: string,
  error?: string,
  success?: string,
): string =>
  layout(
    "Admin Settings",
    `
    <h1>Admin Settings</h1>
    <p><a href="/admin/">&larr; Back to Dashboard</a></p>

    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    ${success ? `<div class="success">${escapeHtml(success)}</div>` : ""}

    <h2>Change Password</h2>
    <p>Changing your password will log you out of all sessions.</p>
    <form method="POST" action="/admin/settings">
      <input type="hidden" name="csrf_token" value="${escapeHtml(csrfToken)}">
      ${renderFields(changePasswordFields)}
      <button type="submit">Change Password</button>
    </form>
  `,
  );

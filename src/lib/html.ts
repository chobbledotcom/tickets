/**
 * HTML template functions for the ticket reservation system
 */

import { map, pipe, reduce } from "#fp";
import type { Attendee, EventWithCount } from "./types.ts";

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
 * Admin login page
 */
export const adminLoginPage = (error?: string): string =>
  layout(
    "Admin Login",
    `
    <h1>Admin Login</h1>
    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
    <form method="POST" action="/admin/login">
      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required>
      </div>
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
export const adminDashboardPage = (events: EventWithCount[]): string => {
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
      <div class="form-group">
        <label for="name">Event Name</label>
        <input type="text" id="name" name="name" required>
      </div>
      <div class="form-group">
        <label for="description">Description</label>
        <textarea id="description" name="description" rows="3" required></textarea>
      </div>
      <div class="form-group">
        <label for="max_attendees">Max Attendees</label>
        <input type="number" id="max_attendees" name="max_attendees" min="1" required>
      </div>
      <div class="form-group">
        <label for="thank_you_url">Thank You URL</label>
        <input type="url" id="thank_you_url" name="thank_you_url" required placeholder="https://example.com/thank-you">
      </div>
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
    <p><a href="/admin/">&larr; Back to Dashboard</a></p>

    <h2>Event Details</h2>
    <p><strong>Description:</strong> ${escapeHtml(event.description)}</p>
    <p><strong>Max Attendees:</strong> ${event.max_attendees}</p>
    <p><strong>Current Attendees:</strong> ${event.attendee_count}</p>
    <p><strong>Spots Remaining:</strong> ${event.max_attendees - event.attendee_count}</p>
    <p><strong>Thank You URL:</strong> <a href="${escapeHtml(event.thank_you_url)}">${escapeHtml(event.thank_you_url)}</a></p>
    <p><strong>Ticket URL:</strong> <a href="/ticket/${event.id}">/ticket/${event.id}</a></p>

    <h2>Attendees</h2>
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

    ${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}

    ${
      isFull
        ? '<div class="error">Sorry, this event is full.</div>'
        : `
      <form method="POST" action="/ticket/${event.id}">
        <div class="form-group">
          <label for="name">Your Name</label>
          <input type="text" id="name" name="name" required>
        </div>
        <div class="form-group">
          <label for="email">Your Email</label>
          <input type="email" id="email" name="email" required>
        </div>
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

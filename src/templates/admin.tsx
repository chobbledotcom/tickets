/**
 * Admin page templates - dashboard, events, settings
 */

import { map, pipe, reduce } from "#fp";
import { type FieldValues, renderError, renderFields } from "#lib/forms.tsx";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { changePasswordFields, eventFields, loginFields } from "./fields.ts";
import { Layout } from "./layout.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

/**
 * Admin login page
 */
export const adminLoginPage = (error?: string): string =>
  String(
    <Layout title="Admin Login">
      <h1>Admin Login</h1>
      <Raw html={renderError(error)} />
      <form method="POST" action="/admin/login">
        <Raw html={renderFields(loginFields)} />
        <button type="submit">Login</button>
      </form>
    </Layout>
  );

const EventRow = ({ e }: { e: EventWithCount }): string =>
  String(
    <tr>
      <td>{e.name}</td>
      <td>{e.attendee_count} / {e.max_attendees}</td>
      <td>{new Date(e.created).toLocaleDateString()}</td>
      <td><a href={`/admin/event/${e.id}`}>View</a></td>
    </tr>
  );

/**
 * Admin dashboard page
 */
export const adminDashboardPage = (
  events: EventWithCount[],
  csrfToken: string,
): string => {
  const eventRows =
    events.length > 0
      ? pipe(map((e: EventWithCount) => EventRow({ e })), joinStrings)(events)
      : '<tr><td colspan="4">No events yet</td></tr>';

  return String(
    <Layout title="Admin Dashboard">
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
          <Raw html={eventRows} />
        </tbody>
      </table>

      <h2>Create New Event</h2>
      <form method="POST" action="/admin/event">
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <Raw html={renderFields(eventFields)} />
        <button type="submit">Create Event</button>
      </form>
    </Layout>
  );
};

const AttendeeRow = ({ a }: { a: Attendee }): string =>
  String(
    <tr>
      <td>{a.name}</td>
      <td>{a.email}</td>
      <td>{new Date(a.created).toLocaleString()}</td>
    </tr>
  );

/**
 * Admin event detail page
 */
export const adminEventPage = (
  event: EventWithCount,
  attendees: Attendee[],
): string => {
  const attendeeRows =
    attendees.length > 0
      ? pipe(map((a: Attendee) => AttendeeRow({ a })), joinStrings)(attendees)
      : '<tr><td colspan="3">No attendees yet</td></tr>';

  return String(
    <Layout title={`Event: ${event.name}`}>
      <h1>{event.name}</h1>
      <p>
        <a href="/admin/">&larr; Back to Dashboard</a> |{" "}
        <a href={`/admin/event/${event.id}/edit`}>Edit Event</a>
      </p>

      <h2>Event Details</h2>
      <p><strong>Description:</strong> {event.description}</p>
      <p><strong>Max Attendees:</strong> {event.max_attendees}</p>
      <p><strong>Current Attendees:</strong> {event.attendee_count}</p>
      <p><strong>Spots Remaining:</strong> {event.max_attendees - event.attendee_count}</p>
      <p>
        <strong>Thank You URL:</strong>{" "}
        <a href={event.thank_you_url}>{event.thank_you_url}</a>
      </p>
      <p>
        <strong>Ticket URL:</strong>{" "}
        <a href={`/ticket/${event.id}`}>/ticket/{event.id}</a>
      </p>

      <h2>Attendees</h2>
      <p>
        <a
          href={`/admin/event/${event.id}/export`}
          style="display: inline-block; background: #0066cc; color: white; padding: 0.5rem 1rem; font-size: 0.9rem; border-radius: 4px; text-decoration: none;"
        >
          Export CSV
        </a>
      </p>
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>Email</th>
            <th>Registered</th>
          </tr>
        </thead>
        <tbody>
          <Raw html={attendeeRows} />
        </tbody>
      </table>
    </Layout>
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
  String(
    <Layout title={`Edit: ${event.name}`}>
      <h1>Edit Event</h1>
      <p><a href={`/admin/event/${event.id}`}>&larr; Back to Event</a></p>
      <Raw html={renderError(error)} />
      <form method="POST" action={`/admin/event/${event.id}/edit`}>
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <Raw html={renderFields(eventFields, eventToFieldValues(event))} />
        <button type="submit">Save Changes</button>
      </form>
    </Layout>
  );

/**
 * Admin settings page
 */
export const adminSettingsPage = (
  csrfToken: string,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Admin Settings">
      <h1>Admin Settings</h1>
      <p><a href="/admin/">&larr; Back to Dashboard</a></p>

      {error && <div class="error">{error}</div>}
      {success && <div class="success">{success}</div>}

      <h2>Change Password</h2>
      <p>Changing your password will log you out of all sessions.</p>
      <form method="POST" action="/admin/settings">
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <Raw html={renderFields(changePasswordFields)} />
        <button type="submit">Change Password</button>
      </form>
    </Layout>
  );

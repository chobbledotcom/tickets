/**
 * Admin page templates - dashboard, events, settings
 */

import { map, pipe, reduce } from "#fp";
import { type FieldValues, renderError, renderFields } from "#lib/forms.tsx";
import type { Attendee, EventWithCount, Session } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import {
  changePasswordFields,
  eventFields,
  loginFields,
  stripeKeyFields,
} from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";

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
      <p><a href="/admin/settings">Settings</a> | <a href="/admin/sessions">Sessions</a> | <a href="/admin/logout">Logout</a></p>

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

const AttendeeRow = ({ a, eventId }: { a: Attendee; eventId: number }): string =>
  String(
    <tr>
      <td>{a.name}</td>
      <td>{a.email}</td>
      <td>{a.quantity}</td>
      <td>{new Date(a.created).toLocaleString()}</td>
      <td>
        <a href={`/admin/event/${eventId}/attendee/${a.id}/delete`} style="color: #c00;">
          Delete
        </a>
      </td>
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
      ? pipe(
          map((a: Attendee) => AttendeeRow({ a, eventId: event.id })),
          joinStrings,
        )(attendees)
      : '<tr><td colspan="5">No attendees yet</td></tr>';

  return String(
    <Layout title={`Event: ${event.name}`}>
      <h1>{event.name}</h1>
      <p>
        <a href="/admin/">&larr; Back to Dashboard</a> |{" "}
        <a href={`/admin/event/${event.id}/edit`}>Edit Event</a> |{" "}
        <a href={`/admin/event/${event.id}/delete`} style="color: #c00;">Delete Event</a>
      </p>

      <h2>Event Details</h2>
      <p><strong>Description:</strong> {event.description}</p>
      <p><strong>Max Attendees:</strong> {event.max_attendees}</p>
      <p><strong>Max Tickets Per Purchase:</strong> {event.max_quantity}</p>
      <p><strong>Tickets Sold:</strong> {event.attendee_count}</p>
      <p><strong>Spots Remaining:</strong> {event.max_attendees - event.attendee_count}</p>
      <p>
        <strong>Thank You URL:</strong>{" "}
        <a href={event.thank_you_url}>{event.thank_you_url}</a>
      </p>
      <p>
        <strong>Ticket URL:</strong>{" "}
        <a href={`/ticket/${event.id}`}>/ticket/{event.id}</a>
      </p>
      {event.webhook_url && (
        <p>
          <strong>Webhook URL:</strong>{" "}
          <a href={event.webhook_url}>{event.webhook_url}</a>
        </p>
      )}

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
            <th>Qty</th>
            <th>Registered</th>
            <th>Actions</th>
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
  max_quantity: event.max_quantity,
  unit_price: event.unit_price,
  thank_you_url: event.thank_you_url,
  webhook_url: event.webhook_url,
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
 * Admin delete event confirmation page
 */
export const adminDeleteEventPage = (
  event: EventWithCount,
  csrfToken: string,
  error?: string,
): string =>
  String(
    <Layout title={`Delete: ${event.name}`}>
      <h1>Delete Event</h1>
      <p><a href={`/admin/event/${event.id}`}>&larr; Back to Event</a></p>

      {error && <div class="error">{error}</div>}

      <p style="color: #c00; font-weight: bold;">
        Warning: This will permanently delete the event and all {event.attendee_count} attendee(s).
      </p>

      <p>To delete this event, you must type its name "{event.name}" into the box below:</p>

      <form method="POST" action={`/admin/event/${event.id}/delete`}>
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <div class="field">
          <input
            type="text"
            name="confirm_name"
            placeholder={event.name}
            autocomplete="off"
            required
          />
        </div>
        <button
          type="submit"
          style="background: #c00; border-color: #900;"
        >
          Delete Event
        </button>
      </form>
    </Layout>
  );

/**
 * Admin delete attendee confirmation page
 */
export const adminDeleteAttendeePage = (
  event: EventWithCount,
  attendee: Attendee,
  csrfToken: string,
  error?: string,
): string =>
  String(
    <Layout title={`Delete Attendee: ${attendee.name}`}>
      <h1>Delete Attendee</h1>
      <p><a href={`/admin/event/${event.id}`}>&larr; Back to Event</a></p>

      {error && <div class="error">{error}</div>}

      <p style="color: #c00; font-weight: bold;">
        Warning: This will permanently remove this attendee from the event.
      </p>

      <h2>Attendee Details</h2>
      <p><strong>Name:</strong> {attendee.name}</p>
      <p><strong>Email:</strong> {attendee.email}</p>
      <p><strong>Quantity:</strong> {attendee.quantity}</p>
      <p><strong>Registered:</strong> {new Date(attendee.created).toLocaleString()}</p>

      <p>To delete this attendee, you must type their name "{attendee.name}" into the box below:</p>

      <form method="POST" action={`/admin/event/${event.id}/attendee/${attendee.id}/delete`}>
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <div class="field">
          <input
            type="text"
            name="confirm_name"
            placeholder={attendee.name}
            autocomplete="off"
            required
          />
        </div>
        <button
          type="submit"
          style="background: #c00; border-color: #900;"
        >
          Delete Attendee
        </button>
      </form>
    </Layout>
  );

/**
 * Admin settings page
 */
export const adminSettingsPage = (
  csrfToken: string,
  stripeKeyConfigured: boolean,
  error?: string,
  success?: string,
): string =>
  String(
    <Layout title="Admin Settings">
      <h1>Admin Settings</h1>
      <p><a href="/admin/">&larr; Back to Dashboard</a></p>

      {error && <div class="error">{error}</div>}
      {success && <div class="success">{success}</div>}

      <h2>Stripe Settings</h2>
      <p>
        {stripeKeyConfigured
          ? "A Stripe secret key is currently configured. Enter a new key below to replace it."
          : "No Stripe key is configured. Payments are disabled."}
      </p>
      <form method="POST" action="/admin/settings/stripe">
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <Raw html={renderFields(stripeKeyFields)} />
        <button type="submit">Update Stripe Key</button>
      </form>

      <h2>Change Password</h2>
      <p>Changing your password will log you out of all sessions.</p>
      <form method="POST" action="/admin/settings">
        <input type="hidden" name="csrf_token" value={csrfToken} />
        <Raw html={renderFields(changePasswordFields)} />
        <button type="submit">Change Password</button>
      </form>
    </Layout>
  );

const SessionRow = ({
  session,
  isCurrent,
}: {
  session: Session;
  isCurrent: boolean;
}): string =>
  String(
    <tr style={isCurrent ? "font-weight: bold;" : ""}>
      <td>{session.token.slice(0, 8)}...</td>
      <td>{new Date(session.expires).toLocaleString()}</td>
      <td>{isCurrent ? "Current" : ""}</td>
    </tr>
  );

/**
 * Admin sessions page
 */
export const adminSessionsPage = (
  sessions: Session[],
  currentToken: string,
  csrfToken: string,
  success?: string,
): string => {
  const sessionRows =
    sessions.length > 0
      ? pipe(
          map((s: Session) =>
            SessionRow({ session: s, isCurrent: s.token === currentToken }),
          ),
          joinStrings,
        )(sessions)
      : '<tr><td colspan="3">No sessions</td></tr>';

  const otherSessionCount = sessions.filter(
    (s) => s.token !== currentToken,
  ).length;

  return String(
    <Layout title="Admin Sessions">
      <h1>Sessions</h1>
      <p><a href="/admin/">&larr; Back to Dashboard</a></p>

      {success && <div class="success">{success}</div>}

      <table>
        <thead>
          <tr>
            <th>Token</th>
            <th>Expires</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <Raw html={sessionRows} />
        </tbody>
      </table>

      {otherSessionCount > 0 && (
        <form method="POST" action="/admin/sessions" style="margin-top: 1rem;">
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <button type="submit" style="background: #c00; border-color: #900;">
            Log out of all other sessions ({otherSessionCount})
          </button>
        </form>
      )}
    </Layout>
  );
};

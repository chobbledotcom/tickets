/**
 * Admin event page templates - detail, edit, delete
 */

import { map, pipe, reduce } from "#fp";
import { type FieldValues, renderError, renderFields } from "#lib/forms.tsx";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { eventFields } from "../fields.ts";
import { Layout } from "../layout.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

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

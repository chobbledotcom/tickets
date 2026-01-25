/**
 * Admin event page templates - detail, edit, delete
 */

import { map, pipe, reduce } from "#fp";
import { type FieldValues, renderError, renderFields } from "#lib/forms.tsx";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { eventFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

const AttendeeRow = ({ a, eventId }: { a: Attendee; eventId: number }): string =>
  String(
    <tr>
      <td>{a.name}</td>
      <td>{a.email}</td>
      <td>{a.quantity}</td>
      <td>{new Date(a.created).toLocaleString()}</td>
      <td>
        <a href={`/admin/event/${eventId}/attendee/${a.id}/delete`} class="danger">
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
  allowedDomain: string,
): string => {
  const ticketUrl = `https://${allowedDomain}/ticket/${event.slug}`;
  const embedCode = `<iframe src="${ticketUrl}" loading="lazy" style="border: none; width: 100%; height: 10rem">Loading..</iframe>`;
  const attendeeRows =
    attendees.length > 0
      ? pipe(
          map((a: Attendee) => AttendeeRow({ a, eventId: event.id })),
          joinStrings,
        )(attendees)
      : '<tr><td colspan="5">No attendees yet</td></tr>';

  return String(
    <Layout title={`Event: ${event.name}`}>
      <AdminNav />

        <h1>{event.name}</h1>
        <nav>
          <ul>
            <li><a href={`/admin/event/${event.id}/edit`}>Edit</a></li>
            <li><a href={`/admin/event/${event.id}/activity-log`}>Activity Log</a></li>
            <li><a href={`/admin/event/${event.id}/export`}>Export CSV</a></li>
            {event.active === 1 ? (
              <li><a href={`/admin/event/${event.id}/deactivate`} class="danger">Deactivate</a></li>
            ) : (
              <li><a href={`/admin/event/${event.id}/reactivate`}>Reactivate</a></li>
            )}
            <li><a href={`/admin/event/${event.id}/delete`} class="danger">Delete</a></li>
          </ul>
        </nav>

        <article>
          <h2>Event Details</h2>
          <p>
            <strong>Status:</strong>{" "}
            {event.active === 1 ? (
              <span style="color: green;">Active</span>
            ) : (
              <span style="color: red;">Inactive (returns 404 on public page)</span>
            )}
          </p>
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
            <a href={`/ticket/${event.slug}`}>/ticket/{event.slug}</a>
          </p>
          {event.webhook_url && (
            <p>
              <strong>Webhook URL:</strong>{" "}
              <a href={event.webhook_url}>{event.webhook_url}</a>
            </p>
          )}
          <p>
            <label for={`embed-code-${event.id}`}><strong>Embed Code:</strong></label>
            <input
              type="text"
              id={`embed-code-${event.id}`}
              value={embedCode}
              readonly
              onclick="this.select()"
            />
          </p>
        </article>

        <h2>Attendees</h2>
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
  slug: event.slug,
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
      <AdminNav />
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
      <AdminNav />
        {error && <div class="error">{error}</div>}

        <article>
          <aside>
            <p><strong>Warning:</strong> This will permanently delete the event and all {event.attendee_count} attendee(s).</p>
          </aside>
        </article>

        <p>To delete this event, you must type its name "{event.name}" into the box below:</p>

        <form method="POST" action={`/admin/event/${event.id}/delete`}>
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <label for="confirm_name">Event name</label>
          <input
            type="text"
            id="confirm_name"
            name="confirm_name"
            placeholder={event.name}
            autocomplete="off"
            required
          />
          <button type="submit" class="danger">
            Delete Event
          </button>
        </form>
    </Layout>
  );

/**
 * Admin deactivate event confirmation page
 */
export const adminDeactivateEventPage = (
  event: EventWithCount,
  csrfToken: string,
  error?: string,
): string =>
  String(
    <Layout title={`Deactivate: ${event.name}`}>
      <AdminNav />
        {error && <div class="error">{error}</div>}

        <article>
          <aside>
            <p><strong>Warning:</strong> Deactivating this event will:</p>
            <ul>
              <li>Return a 404 error on the public ticket page</li>
              <li>Prevent new registrations</li>
              <li>Reject any pending payments</li>
            </ul>
            <p>Existing attendees will not be affected.</p>
          </aside>
        </article>

        <p>To deactivate this event, you must type its name "{event.name}" into the box below:</p>

        <form method="POST" action={`/admin/event/${event.id}/deactivate`}>
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <label for="confirm_name">Event name</label>
          <input
            type="text"
            id="confirm_name"
            name="confirm_name"
            placeholder={event.name}
            autocomplete="off"
            required
          />
          <button type="submit" class="danger">
            Deactivate Event
          </button>
        </form>
    </Layout>
  );

/**
 * Admin reactivate event confirmation page
 */
export const adminReactivateEventPage = (
  event: EventWithCount,
  csrfToken: string,
  error?: string,
): string =>
  String(
    <Layout title={`Reactivate: ${event.name}`}>
      <AdminNav />
        {error && <div class="error">{error}</div>}

        <article>
          <aside>
            <p>Reactivating this event will make it available for registrations again.</p>
            <p>The public ticket page will be accessible and new attendees can register.</p>
          </aside>
        </article>

        <p>To reactivate this event, you must type its name "{event.name}" into the box below:</p>

        <form method="POST" action={`/admin/event/${event.id}/reactivate`}>
          <input type="hidden" name="csrf_token" value={csrfToken} />
          <label for="confirm_name">Event name</label>
          <input
            type="text"
            id="confirm_name"
            name="confirm_name"
            placeholder={event.name}
            autocomplete="off"
            required
          />
          <button type="submit">
            Reactivate Event
          </button>
        </form>
    </Layout>
  );

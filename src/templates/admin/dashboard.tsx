/**
 * Admin dashboard page template
 */

import { map, pipe, reduce } from "#fp";
import { renderFields } from "#lib/forms.tsx";
import type { EventWithCount } from "#lib/types.ts";
import { Raw } from "#jsx/jsx-runtime.ts";
import { eventFields } from "../fields.ts";
import { Layout } from "../layout.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

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

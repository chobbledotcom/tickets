/**
 * Admin dashboard page template
 */

import { map, pipe, reduce } from "#fp";
import { renderFields } from "#lib/forms.tsx";
import type { AdminSession, EventWithCount } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { eventFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

const EventRow = ({ e }: { e: EventWithCount }): string => {
  const isInactive = e.active !== 1;
  const rowStyle = isInactive ? 'opacity: 0.5;' : '';
  return String(
    <tr style={rowStyle || undefined}>
      <td><a href={`/admin/event/${e.id}`}>{e.name}</a></td>
      <td>{e.description}</td>
      <td>{isInactive ? "Inactive" : "Active"}</td>
      <td>{e.attendee_count} / {e.max_attendees}</td>
      <td>{new Date(e.created).toLocaleDateString()}</td>
    </tr>
  );
};

/**
 * Admin dashboard page
 */
export const adminDashboardPage = (
  events: EventWithCount[],
  session: AdminSession,
): string => {
  const eventRows =
    events.length > 0
      ? pipe(map((e: EventWithCount) => EventRow({ e })), joinStrings)(events)
      : '<tr><td colspan="5">No events yet</td></tr>';

  return String(
    <Layout title="Events">
      <AdminNav session={session} />

      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Event Name</th>
              <th>Description</th>
              <th>Status</th>
              <th>Attendees</th>
              <th>Created</th>
            </tr>
          </thead>
          <tbody>
            <Raw html={eventRows} />
          </tbody>
        </table>
      </div>

      <br />

        <form method="POST" action="/admin/event">
            <h2>Create New Event</h2>
          <input type="hidden" name="csrf_token" value={session.csrfToken} />
          <Raw html={renderFields(eventFields)} />
          <button type="submit">Create Event</button>
        </form>
    </Layout>
  );
};

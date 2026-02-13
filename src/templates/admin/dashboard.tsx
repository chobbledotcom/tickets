/**
 * Admin dashboard page template
 */

import { filter, map, pipe, reduce } from "#fp";
import { computeIframeHeight } from "#lib/embed.ts";
import { renderFields } from "#lib/forms.tsx";
import type { AdminSession, EventWithCount } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { eventFields, mergeEventFields } from "#templates/fields.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { renderEventImage } from "#templates/public.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

const EventRow = ({ e }: { e: EventWithCount }): string => {
  const isInactive = e.active !== 1;
  const rowStyle = isInactive ? 'opacity: 0.5;' : '';
  return String(
    <tr style={rowStyle || undefined}>
      <td><Raw html={renderEventImage(e, "event-thumbnail")} /><a href={`/admin/event/${e.id}`}>{e.name}</a></td>
      <td>{e.description}</td>
      <td>{isInactive ? "Inactive" : "Active"}</td>
      <td>{e.attendee_count} / {e.max_attendees}</td>
      <td>{new Date(e.created).toLocaleDateString()}</td>
    </tr>
  );
};

/** Checkbox item for multi-booking link builder */
const MultiBookingCheckbox = ({ e }: { e: EventWithCount }): string =>
  String(
    <li>
      <label>
        <input type="checkbox" data-multi-booking-slug={e.slug} />
        {` ${e.name}`}
      </label>
    </li>
  );

/** Multi-booking link builder section (only rendered when 2+ active events) */
const multiBookingSection = (
  activeEvents: EventWithCount[],
  allowedDomain: string,
): string => {
  const checkboxes = pipe(
    map((e: EventWithCount) => MultiBookingCheckbox({ e })),
    joinStrings,
  )(activeEvents);

  const mergedFields = mergeEventFields(
    map((e: EventWithCount) => e.fields)(activeEvents),
  );
  const iframeHeight = computeIframeHeight(mergedFields);

  return String(
    <details>
      <summary>Multi-booking link</summary>
      <p>Select events to generate a combined booking link:</p>
      <ul class="multi-booking-list">
        <Raw html={checkboxes} />
      </ul>
      <label for="multi-booking-url">Booking link</label>
      <input
        type="text"
        id="multi-booking-url"
        readonly
        data-select-on-click
        data-multi-booking-url
        data-domain={allowedDomain}
        placeholder="Select two or more events"
      />
      <label for="multi-booking-embed">Embed code</label>
      <input
        type="text"
        id="multi-booking-embed"
        readonly
        data-select-on-click
        data-multi-booking-embed
        data-iframe-height={iframeHeight}
        placeholder="Select two or more events"
      />
    </details>
  );
};

/**
 * Admin dashboard page
 */
export const adminDashboardPage = (
  events: EventWithCount[],
  session: AdminSession,
  allowedDomain: string,
): string => {
  const eventRows =
    events.length > 0
      ? pipe(map((e: EventWithCount) => EventRow({ e })), joinStrings)(events)
      : '<tr><td colspan="5">No events yet</td></tr>';

  const activeEvents = filter((e: EventWithCount) => e.active === 1)(events);

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

      {activeEvents.length >= 2 && (
        <Raw html={multiBookingSection(activeEvents, allowedDomain)} />
      )}

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

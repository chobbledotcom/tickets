/**
 * Admin dashboard page template
 */

import { filter, map, pipe, reduce } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { renderSuccess } from "#lib/forms.tsx";
import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { renderEventImage } from "#templates/public.tsx";
import { AttendeeTable, type AttendeeTableRow } from "#templates/attendee-table.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

export const EventRow = ({ e }: { e: EventWithCount }): string => {
  const isInactive = !e.active;
  return String(
    <tr class={isInactive ? "inactive-row" : undefined}>
      <td><Raw html={renderEventImage(e, "event-thumbnail")} /><a href={`/admin/event/${e.id}`}>{e.name}</a></td>
      <td class="cell-description">{e.description}</td>
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
        <input type="checkbox" data-multi-booking-slug={e.slug} data-fields={e.fields} />
        {` ${e.name}`}
      </label>
    </li>
  );

/** Multi-booking link builder section (only rendered when 2+ active events) */
const multiBookingSection = (activeEvents: EventWithCount[]): string => {
  const checkboxes = pipe(
    map((e: EventWithCount) => MultiBookingCheckbox({ e })),
    joinStrings,
  )(activeEvents);

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
        data-domain={getAllowedDomain()}
        placeholder="Select two or more events"
      />
      <label for="multi-booking-embed-script">Embed Script</label>
      <input
        type="text"
        id="multi-booking-embed-script"
        readonly
        data-select-on-click
        data-multi-booking-embed-script
        placeholder="Select two or more events"
      />
      <label for="multi-booking-embed-iframe">Embed Iframe</label>
      <input
        type="text"
        id="multi-booking-embed-iframe"
        readonly
        data-select-on-click
        data-multi-booking-embed-iframe
        placeholder="Select two or more events"
      />
    </details>
  );
};

/** Build the newest attendees section with a details/summary wrapper */
const newestAttendeesSection = (
  attendees: Attendee[],
  events: EventWithCount[],
): string => {
  const eventMap = new Map(events.map((e) => [e.id, e]));
  const tableRows = reduce(
    (acc: AttendeeTableRow[], a: Attendee) => {
      const event = eventMap.get(a.event_id);
      if (event) {
        acc.push({
          attendee: a,
          eventId: event.id,
          eventName: event.name,
          hasPaidEvent: event.unit_price > 0,
        });
      }
      return acc;
    },
    [] as AttendeeTableRow[],
  )(attendees);

  if (tableRows.length === 0) return "";

  const count = tableRows.length;

  return String(
    <details open>
      <summary>Newest {count} Attendee{count !== 1 ? "s" : ""}</summary>
      <div class="table-scroll">
        <Raw html={AttendeeTable({
          rows: tableRows,
          allowedDomain: getAllowedDomain(),
          showEvent: true,
          showDate: false,
          showActions: false,
          presorted: true,
        })} />
      </div>
    </details>
  );
};

/**
 * Admin dashboard page
 */
export const adminDashboardPage = (
  events: EventWithCount[],
  session: AdminSession,
  imageError?: string | null,
  newestAttendees: Attendee[] = [],
  successMessage?: string | null,
): string => {
  const eventRows =
    events.length > 0
      ? pipe(map((e: EventWithCount) => EventRow({ e })), joinStrings)(events)
      : '<tr><td colspan="5">No events yet</td></tr>';

  const activeEvents = filter((e: EventWithCount) => e.active)(events);

  return String(
    <Layout title="Events">
      <AdminNav session={session} active="/admin/" />

      <Raw html={renderSuccess(successMessage ?? undefined)} />

      {imageError && (
        <p class="error">Event created but image was not saved: {imageError}</p>
      )}

      <p><a href="/admin/event/new">Add Event</a></p>

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
        <Raw html={multiBookingSection(activeEvents)} />
      )}

      {newestAttendees.length > 0 && (
        <Raw html={newestAttendeesSection(newestAttendees, events)} />
      )}
    </Layout>
  );
};

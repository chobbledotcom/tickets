/**
 * Admin calendar view template - shows attendees across all daily events by date
 */

import { map, pipe, reduce } from "#fp";
import { formatDateLabel } from "#lib/dates.ts";
import type { AdminSession, Attendee } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";

const joinStrings = reduce((acc: string, s: string) => acc + s, "");

/** Calendar date option for the date filter dropdown */
export type CalendarDateOption = {
  value: string;
  label: string;
  hasBookings: boolean;
};

/** Attendee row with event context for display */
export type CalendarAttendeeRow = Attendee & {
  eventName: string;
  eventDate: string;
  eventLocation: string;
  eventId: number;
};

/** Build date selector dropdown for calendar view */
const CalendarDateSelector = ({ dateFilter, dates }: { dateFilter: string | null; dates: CalendarDateOption[] }): string => {
  const options = [
    `<option value="/admin/calendar#attendees"${!dateFilter ? " selected" : ""}>Select a date</option>`,
    ...dates.map(
      (d) =>
        d.hasBookings
          ? `<option value="/admin/calendar?date=${d.value}#attendees"${dateFilter === d.value ? " selected" : ""}>${d.label}</option>`
          : `<option disabled>${d.label}</option>`,
    ),
  ].join("");
  return `<select data-nav-select>${options}</select>`;
};

const AttendeeRow = ({ a, allowedDomain }: { a: CalendarAttendeeRow; allowedDomain: string }): string =>
  String(
    <tr>
      <td><a href={`/admin/event/${a.eventId}`}>{a.eventName}</a></td>
      <td>{a.name}</td>
      <td>{a.email || ""}</td>
      <td>{a.phone || ""}</td>
      <td>{a.quantity}</td>
      <td><a href={`https://${allowedDomain}/t/${a.ticket_token}`}>{a.ticket_token}</a></td>
      <td>{new Date(a.created).toLocaleString()}</td>
    </tr>
  );

/**
 * Admin calendar page - shows attendees across all daily events for a selected date
 */
export const adminCalendarPage = (
  attendees: CalendarAttendeeRow[],
  allowedDomain: string,
  session: AdminSession,
  dateFilter: string | null,
  availableDates: CalendarDateOption[],
): string => {
  const attendeeRows =
    attendees.length > 0
      ? pipe(
          map((a: CalendarAttendeeRow) => AttendeeRow({ a, allowedDomain })),
          joinStrings,
        )(attendees)
      : dateFilter
        ? '<tr><td colspan="7">No attendees for this date</td></tr>'
        : '<tr><td colspan="7">Select a date above to view attendees</td></tr>';

  return String(
    <Layout title="Calendar">
      <AdminNav session={session} />

        <h1>Calendar</h1>

        <article>
          <h2 id="attendees">Attendees by Date</h2>
          <Raw html={CalendarDateSelector({ dateFilter, dates: availableDates })} />
          {dateFilter && (
            <p><strong>{formatDateLabel(dateFilter)}</strong></p>
          )}
          {dateFilter && attendees.length > 0 && (
            <p><a href={`/admin/calendar/export?date=${dateFilter}`}>Export CSV</a></p>
          )}
          <div class="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>Event</th>
                  <th>Name</th>
                  <th>Email</th>
                  <th>Phone</th>
                  <th>Qty</th>
                  <th>Ticket</th>
                  <th>Registered</th>
                </tr>
              </thead>
              <tbody>
                <Raw html={attendeeRows} />
              </tbody>
            </table>
          </div>
        </article>
    </Layout>
  );
};

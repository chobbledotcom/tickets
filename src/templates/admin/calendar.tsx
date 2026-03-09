/**
 * Admin calendar view template - shows attendees across all daily events by date
 */

import { map, pipe } from "#fp";
import { formatDateLabel } from "#lib/dates.ts";
import type { AdminSession, Attendee } from "#lib/types.ts";
import { Raw } from "#lib/jsx/jsx-runtime.ts";
import { Layout } from "#templates/layout.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import { AttendeeTable, type AttendeeTableRow } from "#templates/attendee-table.tsx";

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
const CalendarDateSelector = ({ dateFilter, dates, today }: { dateFilter: string | null; dates: CalendarDateOption[]; today: string }): string => {
  const selectOption = `<option value="/admin/calendar#attendees"${!dateFilter ? " selected" : ""}>Select a date</option>`;
  const dateOptions = dates.map(
    (d) =>
      d.hasBookings
        ? `<option value="/admin/calendar?date=${d.value}#attendees"${dateFilter === d.value ? " selected" : ""}>${d.label}</option>`
        : `<option disabled>${d.label}</option>`,
  );
  // Insert "Select a date" before the first current/future date to split past from future
  const splitIndex = dates.findIndex((d) => d.value >= today);
  const insertAt = splitIndex === -1 ? dateOptions.length : splitIndex;
  dateOptions.splice(insertAt, 0, selectOption);
  return `<select data-nav-select>${dateOptions.join("")}</select>`;
};

/**
 * Admin calendar page - shows attendees across all daily events for a selected date
 */
export const adminCalendarPage = (
  attendees: CalendarAttendeeRow[],
  allowedDomain: string,
  session: AdminSession,
  dateFilter: string | null,
  availableDates: CalendarDateOption[],
  today: string,
  phonePrefix?: string,
): string => {
  const tableRows: AttendeeTableRow[] = pipe(
    map((a: CalendarAttendeeRow): AttendeeTableRow => ({
      attendee: a,
      eventId: a.eventId,
      eventName: a.eventName,
    })),
  )(attendees);

  const returnUrl = dateFilter
    ? `/admin/calendar?date=${dateFilter}#attendees`
    : "/admin/calendar#attendees";

  const emptyMessage = dateFilter
    ? "No attendees for this date"
    : "Select a date above to view attendees";

  return String(
    <Layout title="Calendar">
      <AdminNav session={session} active="/admin/calendar" />

        <h1>Calendar</h1>

        <article>
          <h2 id="attendees">Attendees by Date</h2>
          <Raw html={CalendarDateSelector({ dateFilter, dates: availableDates, today })} />
          {dateFilter && (
            <p><strong>{formatDateLabel(dateFilter)}</strong></p>
          )}
          {dateFilter && attendees.length > 0 && (
            <p><a href={`/admin/calendar/export?date=${dateFilter}`}>Export CSV</a></p>
          )}
          <div class="table-scroll">
            <Raw html={AttendeeTable({
              rows: tableRows,
              allowedDomain,
              showEvent: true,
              showDate: false,
              returnUrl,
              emptyMessage,
              phonePrefix,
            })} />
          </div>
        </article>
    </Layout>
  );
};

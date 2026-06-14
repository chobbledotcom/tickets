/**
 * Admin calendar view template - shows attendees across all daily listings by date
 */

import { map, pipe } from "#fp";
import { formatDateLabel } from "#shared/dates.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import type { AdminSession, Attendee } from "#shared/types.ts";
import {
  buildSharedDetailRows,
  renderDetailRows,
} from "#templates/admin/detail-rows.tsx";
import { AdminNav } from "#templates/admin/nav.tsx";
import {
  AttendeeTable,
  type AttendeeTableRow,
  type TableQuestionData,
} from "#templates/attendee-table.tsx";
import { Layout } from "#templates/layout.tsx";

/** Calendar date option for the date filter dropdown */
export type CalendarDateOption = {
  value: string;
  label: string;
  hasBookings: boolean;
};

/** Attendee row with listing context for display */
export type CalendarAttendeeRow = Attendee & {
  durationDays: number;
  listingName: string;
  listingDate: string;
  listingLocation: string;
  listingId: number;
};

/** Build date selector dropdown for calendar view */
const CalendarDateSelector = ({
  dateFilter,
  dates,
  today,
}: {
  dateFilter: string | null;
  dates: CalendarDateOption[];
  today: string;
}): string => {
  const selectOption = `<option value="/admin/calendar#attendees"${
    !dateFilter ? " selected" : ""
  }>Select a date</option>`;
  const dateOptions = dates.map((d) =>
    d.hasBookings
      ? `<option value="/admin/calendar?date=${d.value}#attendees"${
          dateFilter === d.value ? " selected" : ""
        }>${d.label}</option>`
      : `<option disabled>${d.label}</option>`,
  );
  // Insert "Select a date" before the first current/future date to split past from future
  const splitIndex = dates.findIndex((d) => d.value >= today);
  const insertAt = splitIndex === -1 ? dateOptions.length : splitIndex;
  dateOptions.splice(insertAt, 0, selectOption);
  return `<select data-nav-select aria-label="Select a date">${dateOptions.join(
    "",
  )}</select>`;
};

/**
 * Admin calendar page - shows attendees across all daily listings for a selected date
 */
export const adminCalendarPage = (
  attendees: CalendarAttendeeRow[],
  allowedDomain: string,
  session: AdminSession,
  dateFilter: string | null,
  availableDates: CalendarDateOption[],
  today: string,
  phonePrefix?: string,
  questionData?: TableQuestionData,
  hasPaidListing = false,
): string => {
  const tableRows: AttendeeTableRow[] = pipe(
    map(
      (a: CalendarAttendeeRow): AttendeeTableRow => ({
        attendee: a,
        listingId: a.listingId,
        listingName: a.listingName,
      }),
    ),
  )(attendees);

  const returnUrl = dateFilter
    ? `/admin/calendar?date=${dateFilter}#attendees`
    : "/admin/calendar#attendees";

  const emptyMessage = dateFilter
    ? "No attendees for this date"
    : "Select a date above to view attendees";

  const sharedRows =
    dateFilter && attendees.length > 0
      ? buildSharedDetailRows({
          attendeeCount: attendees.length,
          attendees,
          hasPaidListing,
          maxCapacity: 0,
          questionData,
        })
      : [];

  return String(
    <Layout title="Calendar">
      <AdminNav active="/admin/calendar" session={session} />

      <p>
        <a href="/admin/guide#calendar">Calendar guide</a>
      </p>

      <article>
        <h2 id="attendees">Attendees by Date</h2>
        <Raw
          html={CalendarDateSelector({
            dateFilter,
            dates: availableDates,
            today,
          })}
        />
        {dateFilter && (
          <p>
            <strong>{formatDateLabel(dateFilter)}</strong>
          </p>
        )}
        {dateFilter && attendees.length > 0 && (
          <p>
            <a href={`/admin/calendar/export?date=${dateFilter}`}>Export CSV</a>
          </p>
        )}
        {sharedRows.length > 0 && (
          <div class="table-scroll">
            <table class="listing-details-table">
              <tbody>
                <Raw html={renderDetailRows(sharedRows)} />
              </tbody>
            </table>
          </div>
        )}
        <div class="table-scroll">
          <Raw
            html={AttendeeTable({
              allowedDomain,
              emptyMessage,
              phonePrefix,
              questionData,
              returnUrl,
              rows: tableRows,
              showDate: false,
              showListing: true,
            })}
          />
        </div>
      </article>
    </Layout>,
  );
};

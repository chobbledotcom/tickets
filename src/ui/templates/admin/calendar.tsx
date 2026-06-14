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
import { DatePicker, type DatePickerDate } from "#templates/date-picker.tsx";
import { Layout } from "#templates/layout.tsx";

/** Attendee row with listing context for display */
export type CalendarAttendeeRow = Attendee & {
  durationDays: number;
  listingName: string;
  listingDate: string;
  listingLocation: string;
  listingId: number;
};

/**
 * Admin calendar page - shows attendees across all daily listings for a selected date
 */
export const adminCalendarPage = (
  attendees: CalendarAttendeeRow[],
  allowedDomain: string,
  session: AdminSession,
  dateFilter: string | null,
  availableDates: DatePickerDate[],
  today: string,
  viewMonth: string | null = null,
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
        <DatePicker
          ariaLabel="Select a date"
          clearHref="/admin/calendar#attendees"
          dates={availableDates}
          dayHref={(value) => `/admin/calendar?date=${value}#attendees`}
          monthHref={(month) =>
            `/admin/calendar?${
              dateFilter ? `date=${dateFilter}&` : ""
            }cal=${month}#calendar`
          }
          selected={dateFilter}
          today={today}
          viewMonth={viewMonth}
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

/**
 * Admin calendar view template - shows attendees across all daily listings by date
 */

import { map, pipe } from "#fp";
import { t } from "#i18n";
import { attendeeLineRow } from "#shared/attendee-table-rows.ts";
import { formatDateLabel } from "#shared/dates.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  type AgentFilter,
  agentFilterParam,
  renderAgentFilter,
} from "#shared/logistics-filter.ts";
import type {
  AdminSession,
  Attendee,
  AttendeeTableRow,
  LogisticsAgent,
} from "#shared/types.ts";
import { AdminPage } from "#templates/admin/admin-page.tsx";
import {
  AvailabilityChecker,
  type AvailabilityRow,
} from "#templates/admin/availability-checker.tsx";
import { buildSharedDetailRows } from "#templates/admin/detail-rows.tsx";
import { AttendeeTable } from "#templates/attendee-table/component.tsx";
import type { TableQuestionData } from "#templates/attendee-table/types.ts";
import { GuideFooter } from "#templates/components/actions.tsx";
import { DetailTable } from "#templates/components/detail-table.tsx";
import { DatePicker, type DatePickerDate } from "#templates/date-picker.tsx";

/** Attendee row with listing context for display */
export type CalendarAttendeeRow = Attendee & {
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
  availabilityRows: AvailabilityRow[] = [],
  agents: LogisticsAgent[] = [],
  agentFilter: AgentFilter = "all",
): string => {
  const tableRows: AttendeeTableRow[] = pipe(
    map(
      (a: CalendarAttendeeRow): AttendeeTableRow =>
        attendeeLineRow(a, { id: a.listingId, name: a.listingName }),
    ),
  )(attendees);

  const returnUrl = dateFilter
    ? `/admin/calendar?date=${dateFilter}#attendees`
    : "/admin/calendar#attendees";

  const emptyMessage = dateFilter
    ? t("admin.calendar.no_attendees")
    : t("admin.calendar.select_date_prompt");

  const agentHref = (f: AgentFilter): string => {
    const params = new URLSearchParams();
    if (dateFilter) params.set("date", dateFilter);
    const param = agentFilterParam(f);
    if (param) params.set("agent", param);
    return `/admin/calendar?${params.toString()}#attendees`;
  };

  // The export carries the active agent filter so it matches the on-screen
  // list — i.e. a per-agent run sheet.
  const agentParam = agentFilterParam(agentFilter);
  const exportHref = `/admin/calendar/export?date=${dateFilter}${
    agentParam ? `&agent=${agentParam}` : ""
  }`;

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
    <AdminPage
      active="/admin/calendar"
      session={session}
      title={t("admin.calendar.title")}
    >
      <article id="attendees">
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
        <AvailabilityChecker date={dateFilter} rows={availabilityRows} />
        {sharedRows.length > 0 && <DetailTable rows={sharedRows} />}
        {agents.length > 0 && (
          <Raw html={renderAgentFilter(agentFilter, agents, agentHref)} />
        )}
        {AttendeeTable({
          allowedDomain,
          emptyMessage,
          phonePrefix,
          questionData,
          returnUrl,
          rows: tableRows,
          showDate: false,
          showListing: true,
        })}
        {dateFilter && attendees.length > 0 && (
          <div class="table-actions">
            <a href={exportHref}>{t("admin.calendar.export_csv")}</a>
          </div>
        )}
      </article>
      <GuideFooter href="/admin/guide#calendar">Calendar guide</GuideFooter>
    </AdminPage>,
  );
};

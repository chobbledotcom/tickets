/**
 * Admin calendar view template - shows attendees across all daily listings by date
 */

/* jscpd:ignore-start -- imports */
import { map, pipe } from "#fp";
import { t } from "#i18n";
import { Raw } from "#jsx/jsx-runtime.ts";
import { attendeeLineRow } from "#shared/attendee-table-rows.ts";
/* jscpd:ignore-end */
import { formatDateLabel } from "#shared/dates.ts";
import { filterHref, type ParamWriter } from "#shared/filter-href.ts";
import {
  type AgentFilter,
  agentFilterParam,
  renderAgentFilter,
} from "#shared/logistics-filter.ts";
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
import type {
  AdminSession,
  Attendee,
  AttendeeTableRow,
  LogisticsAgent,
} from "#types";

/** What the calendar is showing: the day, who is assigned, and the month the
 * date picker is browsing. */
type CalendarView = {
  readonly agent: AgentFilter;
  readonly date: string | null;
  readonly month: string | null;
};

const CALENDAR_PARAMS: ParamWriter<CalendarView>[] = [
  { name: "date", value: ({ date }) => date },
  {
    name: "agent",
    value: ({ agent }) => agentFilterParam(agent) || null,
  },
  { name: "cal", value: ({ month }) => month },
];

/** An address for the calendar with some of what it is showing changed. Every
 * link goes through this, so choosing another day or month keeps the agent
 * the operator picked instead of quietly returning the whole site's list. */
const calendarLink =
  (view: CalendarView) =>
  (changes: Partial<CalendarView>, hash: string, path = "/admin/calendar") =>
    filterHref(CALENDAR_PARAMS, path, { ...view, ...changes }, hash);

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

  const view: CalendarView = {
    agent: agentFilter,
    date: dateFilter,
    month: viewMonth,
  };
  const link = calendarLink(view);
  // The picker browses months, so a link out of the list leaves it behind.
  const returnUrl = link({ month: null }, "#attendees");

  const emptyMessage = dateFilter
    ? t("admin.calendar.no_attendees")
    : t("admin.calendar.select_date_prompt");

  const agentHref = (agent: AgentFilter): string =>
    link({ agent, month: null }, "#attendees");

  // The export carries the active agent filter so it matches the on-screen
  // list — i.e. a per-agent run sheet.
  const exportHref = link({ month: null }, "", "/admin/calendar/export");

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
          clearHref={link(
            { agent: "all", date: null, month: null },
            "#attendees",
          )}
          dates={availableDates}
          dayHref={(value) => link({ date: value, month: null }, "#attendees")}
          monthHref={(month) => link({ month }, "#calendar")}
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

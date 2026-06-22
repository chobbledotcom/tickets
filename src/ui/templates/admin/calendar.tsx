/**
 * Admin calendar view template - shows attendees across all daily listings by date
 */

import { map, pipe } from "#fp";
import { t } from "#i18n";
import { formatDateLabel } from "#shared/dates.ts";
import { Raw } from "#shared/jsx/jsx-runtime.ts";
import {
  type AgentFilter,
  agentFilterParam,
  renderAgentFilter,
} from "#shared/logistics-filter.ts";
import type { AdminSession, Attendee, LogisticsAgent } from "#shared/types.ts";
import {
  AvailabilityChecker,
  type AvailabilityRow,
} from "#templates/admin/availability-checker.tsx";
import {
  buildSharedDetailRows,
  renderDetailRows,
} from "#templates/admin/detail-rows.tsx";
import { AdminNav, CalendarSubNav } from "#templates/admin/nav.tsx";
import {
  AttendeeTable,
  type AttendeeTableRow,
  type TableQuestionData,
} from "#templates/attendee-table.tsx";
import { GuideLink } from "#templates/components/actions.tsx";
import { DatePicker, type DatePickerDate } from "#templates/date-picker.tsx";
import { Layout } from "#templates/layout.tsx";

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
    <Layout title={t("admin.calendar.title")}>
      <AdminNav active="/admin/calendar" session={session}>
        <CalendarSubNav />
      </AdminNav>
      <p class="actions">
        <GuideLink href="/admin/guide#calendar">Calendar guide</GuideLink>
      </p>

      <article>
        <h2 id="attendees">{t("admin.calendar.attendees_by_date")}</h2>
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
        {sharedRows.length > 0 && (
          <div class="table-scroll">
            <table class="listing-details-table">
              <tbody>
                <Raw html={renderDetailRows(sharedRows)} />
              </tbody>
            </table>
          </div>
        )}
        {agents.length > 0 && (
          <Raw html={renderAgentFilter(agentFilter, agents, agentHref)} />
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
        {dateFilter && attendees.length > 0 && (
          <p class="table-footer-actions">
            <a href={exportHref}>{t("admin.calendar.export_csv")}</a>
          </p>
        )}
      </article>
    </Layout>,
  );
};

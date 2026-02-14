/**
 * Admin calendar view routes
 */

import { flatMap, map, pipe, reduce, sort, unique } from "#fp";
import { getAllowedDomain, getTz } from "#lib/config.ts";
import { formatDateLabel, getAvailableDates } from "#lib/dates.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { decryptAttendees } from "#lib/db/attendees.ts";
import { getAllDailyEvents, getDailyEventAttendeeDates, getDailyEventAttendeesByDate } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { defineRoutes } from "#routes/router.ts";
import { csvResponse, getDateFilter } from "#routes/admin/utils.ts";
import {
  getPrivateKey,
  htmlResponse,
  redirect,
  requireSessionOr,
} from "#routes/utils.ts";
import { adminCalendarPage, type CalendarAttendeeRow, type CalendarDateOption } from "#templates/admin/calendar.tsx";
import { type CalendarAttendee, generateCalendarCsv } from "#templates/csv.ts";

/** Compile all possible dates from events (available + existing attendee dates) */
const compileDateOptions = (
  events: EventWithCount[],
  attendeeDates: string[],
  holidays: { id: number; name: string; start_date: string; end_date: string }[],
  tz: string,
): CalendarDateOption[] => {
  const availableDates = pipe(
    flatMap((event: EventWithCount) => getAvailableDates(event, holidays, tz)),
    unique,
  )(events);

  const allDates = sort((a: string, b: string) => a.localeCompare(b))(
    unique([...availableDates, ...attendeeDates]),
  );

  const attendeeDateSet = new Set(attendeeDates);
  return map((d: string) => ({
    value: d,
    label: formatDateLabel(d),
    hasBookings: attendeeDateSet.has(d),
  }))(allDates);
};

/** Build calendar attendee rows by joining attendees with their event info */
const buildCalendarAttendees = (
  events: EventWithCount[],
  attendees: Attendee[],
): CalendarAttendeeRow[] => {
  const eventById = reduce(
    (acc: Map<number, EventWithCount>, e: EventWithCount) => {
      acc.set(e.id, e);
      return acc;
    },
    new Map<number, EventWithCount>(),
  )(events);

  return map((a: Attendee): CalendarAttendeeRow => {
    const event = eventById.get(a.event_id)!;
    return {
      ...a,
      eventName: event.name,
      eventDate: event.date,
      eventLocation: event.location,
      eventId: event.id,
    };
  })(attendees);
};

/** Auth + parse date filter from request, then call handler */
const withCalendarSession = (
  request: Request,
  handler: (session: Parameters<Parameters<typeof requireSessionOr>[1]>[0], dateFilter: string | null) => Response | Promise<Response>,
) => requireSessionOr(request, (session) => handler(session, getDateFilter(request)));

/**
 * Handle GET /admin/calendar
 */
const handleAdminCalendarGet = (request: Request) =>
  withCalendarSession(request, async (session, dateFilter) => {
    const tz = getTz();
    const [events, attendeeDates, holidays] = await Promise.all([
      getAllDailyEvents(),
      getDailyEventAttendeeDates(),
      getActiveHolidays(tz),
    ]);

    let attendees: CalendarAttendeeRow[] = [];
    if (dateFilter) {
      const privateKey = (await getPrivateKey(session))!;
      const rawAttendees = await getDailyEventAttendeesByDate(dateFilter);
      const decrypted = await decryptAttendees(rawAttendees, privateKey);
      attendees = buildCalendarAttendees(events, decrypted);
    }

    const availableDates = compileDateOptions(events, attendeeDates, holidays, tz);
    return htmlResponse(
      adminCalendarPage(
        attendees,
        getAllowedDomain(),
        session,
        dateFilter,
        availableDates,
      ),
    );
  });

/**
 * Handle GET /admin/calendar/export (CSV export for calendar view)
 */
const handleAdminCalendarExport = (request: Request) =>
  withCalendarSession(request, async (session, dateFilter) => {
    if (!dateFilter) return redirect("/admin/calendar");

    const privateKey = (await getPrivateKey(session))!;
    const [events, rawAttendees] = await Promise.all([
      getAllDailyEvents(),
      getDailyEventAttendeesByDate(dateFilter),
    ]);

    const decrypted = await decryptAttendees(rawAttendees, privateKey);
    const attendees = buildCalendarAttendees(events, decrypted);
    const calendarAttendees: CalendarAttendee[] = attendees;

    const csv = generateCalendarCsv(calendarAttendees);
    const filename = `calendar_${dateFilter}_attendees.csv`;
    await logActivity(`Calendar CSV exported for date ${dateFilter}`);
    return csvResponse(csv, filename);
  });

/** Calendar routes */
export const calendarRoutes = defineRoutes({
  "GET /admin/calendar": (request) => handleAdminCalendarGet(request),
  "GET /admin/calendar/export": (request) => handleAdminCalendarExport(request),
});

/**
 * Admin calendar view routes
 */

import { flatMap, map, pipe, reduce, sort, unique } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { formatDateLabel, getAvailableDates } from "#lib/dates.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { decryptAttendees } from "#lib/db/attendees.ts";
import { getAllDailyEvents, getDailyEventAttendeeDates, getDailyEventAttendeesByDate } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import type { Attendee, EventWithCount } from "#lib/types.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  getPrivateKey,
  htmlResponse,
  redirect,
  requireSessionOr,
} from "#routes/utils.ts";
import { adminCalendarPage, type CalendarAttendeeRow, type CalendarDateOption } from "#templates/admin/calendar.tsx";
import { type CalendarAttendee, generateCalendarCsv } from "#templates/csv.ts";

/** Extract and validate ?date= query parameter */
const getDateFilter = (request: Request): string | null => {
  const date = new URL(request.url).searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date;
};

/** Compile all possible dates from events (available + existing attendee dates) */
const compileDateOptions = (
  events: EventWithCount[],
  attendeeDates: string[],
  holidays: { id: number; name: string; start_date: string; end_date: string }[],
): CalendarDateOption[] => {
  const availableDates = pipe(
    flatMap((event: EventWithCount) => getAvailableDates(event, holidays)),
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

  return flatMap((a: Attendee): CalendarAttendeeRow[] => {
    const event = eventById.get(a.event_id);
    return event ? [{ ...a, eventName: event.name, eventId: event.id }] : [];
  })(attendees);
};

/**
 * Handle GET /admin/calendar
 */
const handleAdminCalendarGet = (request: Request) =>
  requireSessionOr(request, async (session) => {
    const dateFilter = getDateFilter(request);
    const [events, attendeeDates, holidays] = await Promise.all([
      getAllDailyEvents(),
      getDailyEventAttendeeDates(),
      getActiveHolidays(),
    ]);

    let attendees: CalendarAttendeeRow[] = [];
    if (dateFilter) {
      const privateKey = (await getPrivateKey(session))!;
      const rawAttendees = await getDailyEventAttendeesByDate(dateFilter);
      const decrypted = await decryptAttendees(rawAttendees, privateKey);
      attendees = buildCalendarAttendees(events, decrypted);
    }

    const availableDates = compileDateOptions(events, attendeeDates, holidays);
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
  requireSessionOr(request, async (session) => {
    const dateFilter = getDateFilter(request);
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
    return new Response(csv, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${filename}"`,
      },
    });
  });

/** Calendar routes */
export const calendarRoutes = defineRoutes({
  "GET /admin/calendar": (request) => handleAdminCalendarGet(request),
  "GET /admin/calendar/export": (request) => handleAdminCalendarExport(request),
});

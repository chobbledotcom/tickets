/**
 * Admin calendar view routes
 */

import { filter, pipe, unique } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { formatDateLabel, getAvailableDates } from "#lib/dates.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { decryptAttendees } from "#lib/db/attendees.ts";
import { getAllDailyEventsWithAttendeesRaw } from "#lib/db/events.ts";
import { getActiveHolidays } from "#lib/db/holidays.ts";
import type { AdminSession, Attendee, EventWithCount } from "#lib/types.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  getAuthenticatedSession,
  getPrivateKey,
  htmlResponse,
  redirect,
} from "#routes/utils.ts";
import { adminCalendarPage, type CalendarAttendeeRow, type CalendarDateOption } from "#templates/admin/calendar.tsx";
import { type CalendarAttendee, generateCalendarCsv } from "#templates/csv.ts";

/** Extract and validate ?date= query parameter */
const getDateFilter = (request: Request): string | null => {
  const date = new URL(request.url).searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  return date;
};

/** Context for calendar view */
type CalendarContext = {
  events: { event: EventWithCount; attendees: Attendee[] }[];
  session: AdminSession;
};

/** Authenticate and load all daily events with decrypted attendees */
const withCalendarData = async (
  request: Request,
  handler: (ctx: CalendarContext) => Response | Promise<Response>,
): Promise<Response> => {
  const session = await getAuthenticatedSession(request);
  if (!session) return redirect("/admin");

  const privateKey = (await getPrivateKey(session))!;
  const rawResults = await getAllDailyEventsWithAttendeesRaw();

  const events = await Promise.all(
    rawResults.map(async ({ event, attendeesRaw }) => ({
      event,
      attendees: await decryptAttendees(attendeesRaw, privateKey),
    })),
  );

  return handler({ events, session });
};

/** Compile all possible dates from events (available + existing attendee dates) */
const compileDateOptions = (
  events: { event: EventWithCount; attendees: Attendee[] }[],
  holidays: { id: number; name: string; start_date: string; end_date: string }[],
): CalendarDateOption[] => {
  // Collect all available dates from each event
  const availableDateSet = new Set<string>();
  for (const { event } of events) {
    for (const d of getAvailableDates(event, holidays)) {
      availableDateSet.add(d);
    }
  }

  // Collect all unique attendee dates
  const attendeeDateSet = new Set<string>();
  for (const { attendees } of events) {
    for (const a of attendees) {
      if (a.date) attendeeDateSet.add(a.date);
    }
  }

  // Merge: all available dates + all attendee dates
  const allDates = pipe(unique)([...availableDateSet, ...attendeeDateSet]);
  allDates.sort();

  // Determine which dates have bookings
  const datesWithBookings = attendeeDateSet;

  return allDates.map((d) => ({
    value: d,
    label: formatDateLabel(d),
    hasBookings: datesWithBookings.has(d),
  }));
};

/** Build calendar attendee rows for the selected date */
const buildCalendarAttendees = (
  events: { event: EventWithCount; attendees: Attendee[] }[],
  dateFilter: string,
): CalendarAttendeeRow[] => {
  const rows: CalendarAttendeeRow[] = [];
  for (const { event, attendees } of events) {
    const filtered = filter((a: Attendee) => a.date === dateFilter)(attendees);
    for (const a of filtered) {
      rows.push({ ...a, eventName: event.name, eventId: event.id });
    }
  }
  return rows;
};

/**
 * Handle GET /admin/calendar
 */
const handleAdminCalendarGet = (request: Request) =>
  withCalendarData(request, async ({ events, session }) => {
    const dateFilter = getDateFilter(request);
    const holidays = await getActiveHolidays();
    const availableDates = compileDateOptions(events, holidays);
    const attendees = dateFilter ? buildCalendarAttendees(events, dateFilter) : [];
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
  withCalendarData(request, async ({ events }) => {
    const dateFilter = getDateFilter(request);
    if (!dateFilter) return redirect("/admin/calendar");

    const attendees = buildCalendarAttendees(events, dateFilter);
    const calendarAttendees: CalendarAttendee[] = attendees.map((a) => ({
      ...a,
      eventName: a.eventName,
    }));

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

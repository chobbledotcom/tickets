/**
 * Admin calendar view routes
 */

import { filter, flatMap, map, pipe, reduce, sort, unique } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { eventDateToCalendarDate, formatDateLabel, getAvailableDates } from "#lib/dates.ts";
import { logActivity } from "#lib/db/activityLog.ts";
import { decryptAttendees } from "#lib/db/attendees.ts";
import {
  getAllDailyEvents,
  getAllStandardEvents,
  getAttendeesByEventIds,
  getDailyEventAttendeeDates,
  getDailyEventAttendeesByDate,
} from "#lib/db/events.ts";
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

/** Build a map of YYYY-MM-DD → event IDs for standard events that have a date */
const buildStandardEventDateMap = (
  events: EventWithCount[],
): Map<string, number[]> => {
  const dateMap = new Map<string, number[]>();
  for (const event of events) {
    const calDate = eventDateToCalendarDate(event.date);
    if (!calDate) continue;
    const ids = dateMap.get(calDate);
    if (ids) {
      ids.push(event.id);
    } else {
      dateMap.set(calDate, [event.id]);
    }
  }
  return dateMap;
};

/** Compile all possible dates from events (available + existing attendee dates + standard event dates) */
const compileDateOptions = (
  dailyEvents: EventWithCount[],
  attendeeDates: string[],
  standardEventDateMap: Map<string, number[]>,
  standardEvents: EventWithCount[],
  holidays: { id: number; name: string; start_date: string; end_date: string }[],
): CalendarDateOption[] => {
  const availableDates = pipe(
    flatMap((event: EventWithCount) => getAvailableDates(event, holidays)),
    unique,
  )(dailyEvents);

  const standardDates = Array.from(standardEventDateMap.keys());

  const allDates = sort((a: string, b: string) => a.localeCompare(b))(
    unique([...availableDates, ...attendeeDates, ...standardDates]),
  );

  const attendeeDateSet = new Set(attendeeDates);
  // Standard event dates with attendees count as having bookings
  const standardDatesWithBookings = new Set(
    pipe(
      filter((d: string) =>
        standardEvents.some(
          (e) => standardEventDateMap.get(d)!.includes(e.id) && e.attendee_count > 0,
        ),
      ),
    )(standardDates),
  );

  return map((d: string) => ({
    value: d,
    label: formatDateLabel(d),
    hasBookings: attendeeDateSet.has(d) || standardDatesWithBookings.has(d),
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
      hasPaidEvent: event.unit_price !== null,
    };
  })(attendees);
};

/** Sort attendees by newest registration first */
const sortAttendeesByCreatedDesc = (attendees: Attendee[]): Attendee[] =>
  [...attendees].sort((a, b) => new Date(b.created).getTime() - new Date(a.created).getTime());

/** Auth + parse date filter from request, then call handler */
const withCalendarSession = (
  request: Request,
  handler: (session: Parameters<Parameters<typeof requireSessionOr>[1]>[0], dateFilter: string | null) => Response | Promise<Response>,
) => requireSessionOr(request, (session) => handler(session, getDateFilter(request)));

/** Load standard events and build their date map */
const loadStandardEventContext = async () => {
  const standardEvents = await getAllStandardEvents();
  const standardEventDateMap = buildStandardEventDateMap(standardEvents);
  return { standardEvents, standardEventDateMap };
};

/** Load and decrypt attendees for standard events matching a calendar date */
const loadStandardEventAttendees = async (
  dateFilter: string,
  standardEventDateMap: Map<string, number[]>,
  privateKey: CryptoKey,
): Promise<Attendee[]> => {
  const matchingEventIds = standardEventDateMap.get(dateFilter);
  if (!matchingEventIds || matchingEventIds.length === 0) return [];
  const rawStandardAttendees = await getAttendeesByEventIds(matchingEventIds);
  return decryptAttendees(rawStandardAttendees, privateKey);
};

/**
 * Handle GET /admin/calendar
 */
const handleAdminCalendarGet = (request: Request) =>
  withCalendarSession(request, async (session, dateFilter) => {
    const [dailyEvents, attendeeDates, holidays, standardCtx] = await Promise.all([
      getAllDailyEvents(),
      getDailyEventAttendeeDates(),
      getActiveHolidays(),
      loadStandardEventContext(),
    ]);

    const allEvents = [...dailyEvents, ...standardCtx.standardEvents];
    let attendees: CalendarAttendeeRow[] = [];
    if (dateFilter) {
      const privateKey = (await getPrivateKey(session))!;
      const [rawDailyAttendees, standardAttendees] = await Promise.all([
        getDailyEventAttendeesByDate(dateFilter),
        loadStandardEventAttendees(dateFilter, standardCtx.standardEventDateMap, privateKey),
      ]);
      const dailyAttendees = await decryptAttendees(rawDailyAttendees, privateKey);
      const sortedAttendees = sortAttendeesByCreatedDesc([...dailyAttendees, ...standardAttendees]);
      attendees = buildCalendarAttendees(allEvents, sortedAttendees);
    }

    const availableDates = compileDateOptions(
      dailyEvents, attendeeDates, standardCtx.standardEventDateMap,
      standardCtx.standardEvents, holidays,
    );
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
    const [dailyEvents, rawDailyAttendees, standardCtx] = await Promise.all([
      getAllDailyEvents(),
      getDailyEventAttendeesByDate(dateFilter),
      loadStandardEventContext(),
    ]);

    const [dailyDecrypted, standardAttendees] = await Promise.all([
      decryptAttendees(rawDailyAttendees, privateKey),
      loadStandardEventAttendees(dateFilter, standardCtx.standardEventDateMap, privateKey),
    ]);

    const allEvents = [...dailyEvents, ...standardCtx.standardEvents];
    const allAttendees = sortAttendeesByCreatedDesc([...dailyDecrypted, ...standardAttendees]);
    const attendees = buildCalendarAttendees(allEvents, allAttendees);
    const calendarAttendees: CalendarAttendee[] = attendees;

    const csv = generateCalendarCsv(calendarAttendees);
    const filename = `calendar_${dateFilter}_attendees.csv`;
    await logActivity(`Calendar CSV exported for date ${dateFilter}`);
    return csvResponse(csv, filename);
  });

/** Calendar routes */
export const calendarRoutes = defineRoutes({
  "GET /admin/calendar": handleAdminCalendarGet,
  "GET /admin/calendar/export": handleAdminCalendarExport,
});

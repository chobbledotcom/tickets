/**
 * Admin calendar view routes
 */

/* jscpd:ignore-start */
import { filter, flatMap, map, pipe, reduce, sort, unique } from "#fp";
import {
  csvResponse,
  getDateFilter,
  getMonthFilter,
} from "#routes/admin/actions.ts";
import { getPrivateKey, requireSessionOr } from "#routes/auth.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import {
  formatDateLabel,
  getAvailableDates,
  listingDateToCalendarDate,
} from "#shared/dates.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import { decryptAttendees } from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import {
  getAllDailyListings,
  getAllStandardListings,
  getAttendeesByListingIds,
  getDailyListingAttendeeDates,
  getDailyListingAttendeesByDate,
} from "#shared/db/listings.ts";
import { loadAttendeeQuestionData } from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  type Attendee,
  isPaidListing,
  type ListingWithCount,
} from "#shared/types.ts";
import {
  adminCalendarPage,
  type CalendarAttendeeRow,
} from "#templates/admin/calendar.tsx";
import { type CalendarAttendee, generateCalendarCsv } from "#templates/csv.ts";
import type { DatePickerDate } from "#templates/date-picker.tsx";

/* jscpd:ignore-end */

/** Build a map of YYYY-MM-DD → listing IDs for standard listings that have a date */
const buildStandardListingDateMap = (
  listings: ListingWithCount[],
): Map<string, number[]> =>
  reduce((acc: Map<string, number[]>, listing: ListingWithCount) => {
    const calDate = listingDateToCalendarDate(listing.date);
    if (calDate) {
      const ids = acc.get(calDate) ?? [];
      ids.push(listing.id);
      acc.set(calDate, ids);
    }
    return acc;
  }, new Map())(listings);

/** Compile all possible dates from listings (available + existing attendee dates + standard listing dates) */
const compileDateOptions = (
  dailyListings: ListingWithCount[],
  attendeeDates: string[],
  standardListingDateMap: Map<string, number[]>,
  standardListings: ListingWithCount[],
  holidays: {
    id: number;
    name: string;
    start_date: string;
    end_date: string;
  }[],
): DatePickerDate[] => {
  const availableDates = pipe(
    flatMap((listing: ListingWithCount) =>
      getAvailableDates(listing, holidays),
    ),
    (dates: string[]) => unique(dates),
  )(dailyListings);

  const standardDates = Array.from(standardListingDateMap.keys());

  const allDates = sort((a: string, b: string) => a.localeCompare(b))(
    unique([...availableDates, ...attendeeDates, ...standardDates]),
  );

  const attendeeDateSet = new Set(attendeeDates);
  // Standard listing dates with attendees count as having bookings
  const standardDatesWithBookings = new Set(
    pipe(
      filter((d: string) =>
        standardListings.some(
          (e) =>
            standardListingDateMap.get(d)!.includes(e.id) &&
            e.attendee_count > 0,
        ),
      ),
    )(standardDates),
  );

  return map((d: string) => ({
    label: formatDateLabel(d),
    selectable: attendeeDateSet.has(d) || standardDatesWithBookings.has(d),
    value: d,
  }))(allDates);
};

/** Build calendar attendee rows by joining attendees with their listing info */
const buildCalendarAttendees = (
  listings: ListingWithCount[],
  attendees: Attendee[],
): CalendarAttendeeRow[] => {
  const listingById = reduce(
    (acc: Map<number, ListingWithCount>, e: ListingWithCount) => {
      acc.set(e.id, e);
      return acc;
    },
    new Map(),
  )(listings);

  return map((a: Attendee): CalendarAttendeeRow => {
    const listing = listingById.get(a.listing_id)!;
    return {
      ...a,
      durationDays: listing.duration_days,
      listingDate: listing.date,
      listingId: listing.id,
      listingLocation: listing.location,
      listingName: listing.name,
    };
  })(attendees);
};

/** Sort attendees by newest registration first */
const sortAttendeesByCreatedDesc = (attendees: Attendee[]): Attendee[] =>
  [...attendees].sort(
    (a, b) => new Date(b.created).getTime() - new Date(a.created).getTime(),
  );

/** Auth + parse date filter from request, then call handler */
const withCalendarSession = (
  request: Request,
  handler: (
    session: Parameters<Parameters<typeof requireSessionOr>[1]>[0],
    dateFilter: string | null,
  ) => Response | Promise<Response>,
) =>
  requireSessionOr(request, (session) =>
    handler(session, getDateFilter(request)),
  );

/** Load standard listings and build their date map */
const loadStandardListingContext = async () => {
  const standardListings = await getAllStandardListings();
  const standardListingDateMap = buildStandardListingDateMap(standardListings);
  return { standardListingDateMap, standardListings };
};

/** Load and decrypt attendees for standard listings matching a calendar date */
const loadStandardListingAttendees = async (
  dateFilter: string,
  standardListingDateMap: Map<string, number[]>,
  privateKey: CryptoKey,
  standardListings?: ListingWithCount[],
): Promise<Attendee[]> => {
  const matchingListingIds = standardListingDateMap.get(dateFilter);
  if (!matchingListingIds || matchingListingIds.length === 0) return [];
  const rawStandardAttendees =
    await getAttendeesByListingIds(matchingListingIds);
  if (standardListings) {
    const matchingListings = standardListings.filter((e) =>
      matchingListingIds.includes(e.id),
    );
    const hasPaidListing = matchingListings.some(isPaidListing);
    return decryptAttendees(rawStandardAttendees, privateKey, hasPaidListing);
  }
  return decryptAttendees(rawStandardAttendees, privateKey);
};

/**
 * Handle GET /admin/calendar
 */
const handleAdminCalendarGet = (request: Request) =>
  withCalendarSession(request, async (session, dateFilter) => {
    const [dailyListings, attendeeDates, holidays, standardCtx] =
      await Promise.all([
        getAllDailyListings(),
        getDailyListingAttendeeDates(),
        getActiveHolidays(),
        loadStandardListingContext(),
      ]);

    const allListings = [...dailyListings, ...standardCtx.standardListings];
    let attendees: CalendarAttendeeRow[] = [];
    if (dateFilter) {
      const privateKey = (await getPrivateKey(session))!;
      const [rawDailyAttendees, standardAttendees] = await Promise.all([
        getDailyListingAttendeesByDate(dateFilter),
        loadStandardListingAttendees(
          dateFilter,
          standardCtx.standardListingDateMap,
          privateKey,
          standardCtx.standardListings,
        ),
      ]);
      const hasPaidDailyListing = dailyListings.some(isPaidListing);
      const dailyAttendees = await decryptAttendees(
        rawDailyAttendees,
        privateKey,
        hasPaidDailyListing,
      );
      const sortedAttendees = sortAttendeesByCreatedDesc([
        ...dailyAttendees,
        ...standardAttendees,
      ]);
      attendees = buildCalendarAttendees(allListings, sortedAttendees);
    }

    const availableDates = compileDateOptions(
      dailyListings,
      attendeeDates,
      standardCtx.standardListingDateMap,
      standardCtx.standardListings,
      holidays,
    );
    const questionData = await loadAttendeeQuestionData(
      attendees.map((a) => a.listingId),
      attendees.map((a) => a.id),
    );

    const hasPaidListing = allListings.some(isPaidListing);

    return htmlResponse(
      adminCalendarPage(
        attendees,
        getEffectiveDomain(),
        session,
        dateFilter,
        availableDates,
        todayInTz(settings.timezone),
        getMonthFilter(request),
        settings.phonePrefix,
        questionData,
        hasPaidListing,
      ),
    );
  });

/**
 * Handle GET /admin/calendar/export (CSV export for calendar view)
 */
const handleAdminCalendarExport = (request: Request) =>
  withCalendarSession(request, async (session, dateFilter) => {
    if (!dateFilter) {
      return redirect("/admin/calendar", "Select a date to export", false);
    }

    const privateKey = (await getPrivateKey(session))!;
    const [dailyListings, rawDailyAttendees, standardCtx] = await Promise.all([
      getAllDailyListings(),
      getDailyListingAttendeesByDate(dateFilter),
      loadStandardListingContext(),
    ]);

    const [dailyDecrypted, standardAttendees] = await Promise.all([
      decryptAttendees(rawDailyAttendees, privateKey),
      loadStandardListingAttendees(
        dateFilter,
        standardCtx.standardListingDateMap,
        privateKey,
      ),
    ]);

    const allListings = [...dailyListings, ...standardCtx.standardListings];
    const allAttendees = sortAttendeesByCreatedDesc([
      ...dailyDecrypted,
      ...standardAttendees,
    ]);
    const attendees = buildCalendarAttendees(allListings, allAttendees);
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

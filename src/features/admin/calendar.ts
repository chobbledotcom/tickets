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
import {
  type CalendarAttendee,
  type CalendarLogisticsCsv,
  generateCalendarCsv,
  toCalendarAttendees,
} from "#routes/admin/calendar-csv.ts";
import { getPrivateKey, requireSessionOr } from "#routes/auth.ts";
import { htmlResponse, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { getSearchParam } from "#routes/url.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import {
  formatDateLabel,
  getAvailableDates,
  listingDateToCalendarDate,
} from "#shared/dates.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  decryptAttendees,
  getListingRemainingForRange,
} from "#shared/db/attendees.ts";
import { getActiveHolidays } from "#shared/db/holidays.ts";
import {
  getAllListings,
  getAttendeesByListingIds,
  getDailyListingAttendeeDates,
  getDailyListingAttendeesByDate,
} from "#shared/db/listings.ts";
import {
  bookingAssignmentKey,
  getLogisticsAssignmentsForAttendees,
} from "#shared/db/logistics.ts";
import {
  agentNameMap,
  getAllLogisticsAgents,
} from "#shared/db/logistics-agents.ts";
import { loadAttendeeQuestionData } from "#shared/db/questions.ts";
import { settings } from "#shared/db/settings.ts";
import {
  type AgentFilter,
  assignmentMatchesAgentFilter,
  parseAgentFilter,
} from "#shared/logistics-filter.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  type Attendee,
  isPaidListing,
  type ListingWithCount,
  type LogisticsAgent,
} from "#shared/types.ts";
import type { AvailabilityRow } from "#templates/admin/availability-checker.tsx";
import {
  adminCalendarPage,
  type CalendarAttendeeRow,
} from "#templates/admin/calendar.tsx";
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

/** Build calendar attendee rows by joining attendees with their listing info.
 * `listingId` mirrors each attendee's own `listing_id` (the join key), so the
 * shared {@link toCalendarAttendees} does the work and we only tack it on. */
const buildCalendarAttendees = (
  listings: ListingWithCount[],
  attendees: Attendee[],
): CalendarAttendeeRow[] =>
  toCalendarAttendees(attendees, listings).map((a) => ({
    ...a,
    listingId: a.listing_id,
  }));

/** The distinct attendee ids for a set of calendar rows. */
const attendeeIds = (attendees: CalendarAttendeeRow[]): number[] =>
  unique(map((a: CalendarAttendeeRow) => a.id)(attendees));

/** Load the logistics agents (when enabled) and parse the request's ?agent=
 * filter against them. Shared by the calendar view and CSV export. */
const resolveAgentFilter = async (
  request: Request,
): Promise<{ agents: LogisticsAgent[]; agentFilter: AgentFilter }> => {
  const agents = settings.hasLogistics ? await getAllLogisticsAgents() : [];
  const agentFilter = parseAgentFilter(
    getSearchParam(request, "agent"),
    new Set(agents.map((a) => a.id)),
  );
  return { agentFilter, agents };
};

/** Keep only the calendar attendees whose booking matches the agent filter
 * (start OR end agent). "all" short-circuits without a query. */
const filterAttendeesByAgent = async (
  attendees: CalendarAttendeeRow[],
  agentFilter: AgentFilter,
): Promise<CalendarAttendeeRow[]> => {
  if (agentFilter === "all") return attendees;
  const assignments = await getLogisticsAssignmentsForAttendees(
    attendeeIds(attendees),
  );
  // The booking keys whose assignment matches the filter; an attendee row is
  // kept when its (attendee, listing) booking is among them.
  const matching = new Set(
    assignments
      .filter((a) =>
        assignmentMatchesAgentFilter(agentFilter, a.startAgentId, a.endAgentId),
      )
      .map((a) => bookingAssignmentKey(a.attendeeId, a.listingId)),
  );
  return attendees.filter((a) =>
    matching.has(bookingAssignmentKey(a.id, a.listingId)),
  );
};

/** Build the logistics run-sheet context for the CSV export: the logistics
 * listing ids, an agent-name lookup, and each booking's assignment. Returns
 * undefined when logistics is off or no exported row is a logistics booking. */
const buildLogisticsCsvContext = async (
  listings: ListingWithCount[],
  attendees: CalendarAttendeeRow[],
  agents: { id: number; name: string }[],
): Promise<CalendarLogisticsCsv | undefined> => {
  if (!settings.hasLogistics) return undefined;
  const listingIds = new Set(
    listings.filter((l) => l.uses_logistics).map((l) => l.id),
  );
  if (!attendees.some((a) => listingIds.has(a.listing_id))) return undefined;
  const rows = await getLogisticsAssignmentsForAttendees(
    attendeeIds(attendees),
  );
  return {
    agentNames: agentNameMap(agents),
    assignments: new Map(
      rows.map((r) => [bookingAssignmentKey(r.attendeeId, r.listingId), r]),
    ),
    listingIds,
  };
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

/** Split the cached listing list once for the calendar view/export. */
const loadListingContext = async () => {
  const allListings = await getAllListings();
  const dailyListings = allListings.filter((e) => e.listing_type === "daily");
  const standardListings = allListings.filter(
    (e) => e.listing_type === "standard",
  );
  const standardListingDateMap = buildStandardListingDateMap(standardListings);
  return {
    allListings,
    dailyListings,
    standardListingDateMap,
    standardListings,
  };
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

/** Build availability-checker rows: every active listing with its remaining
 * capacity for the selected date (or overall, when no date is selected). */
const buildAvailabilityRows = async (
  listings: ListingWithCount[],
  dateFilter: string | null,
): Promise<AvailabilityRow[]> => {
  const bookable = filter((l: ListingWithCount) => l.active)(listings);
  const remaining = await getListingRemainingForRange(bookable, dateFilter, 1);
  return map(
    (l: ListingWithCount): AvailabilityRow => ({
      canPayMore: l.can_pay_more,
      id: l.id,
      name: l.name,
      // getListingRemainingForRange returns an entry for every listing passed.
      remaining: remaining.get(l.id)!,
      total: l.max_attendees,
      unitPrice: l.unit_price,
    }),
  )(bookable);
};

/**
 * Handle GET /admin/calendar
 */
const handleAdminCalendarGet = (request: Request) =>
  withCalendarSession(request, async (session, dateFilter) => {
    // The availability rows only need the listings list, so build them in a
    // small async helper that awaits loadListingContext and runs inside the same
    // Promise.all. It starts as soon as the listings resolve and overlaps with
    // the date-picker and holiday queries still in flight (hiding under the
    // slowest of them) instead of costing an extra serial round trip after this
    // batch.
    const listingCtxPromise = loadListingContext();
    const loadAvailabilityRows = async (): Promise<AvailabilityRow[]> =>
      buildAvailabilityRows((await listingCtxPromise).allListings, dateFilter);
    const [listingCtx, attendeeDates, holidays, availabilityRows] =
      await Promise.all([
        listingCtxPromise,
        getDailyListingAttendeeDates(),
        getActiveHolidays(),
        loadAvailabilityRows(),
      ]);

    const {
      allListings,
      dailyListings,
      standardListings,
      standardListingDateMap,
    } = listingCtx;
    const { agents, agentFilter } = dateFilter
      ? await resolveAgentFilter(request)
      : { agentFilter: "all" as AgentFilter, agents: [] };
    let attendees: CalendarAttendeeRow[] = [];
    if (dateFilter) {
      const privateKey = (await getPrivateKey(session))!;
      const [rawDailyAttendees, standardAttendees] = await Promise.all([
        getDailyListingAttendeesByDate(dateFilter),
        loadStandardListingAttendees(
          dateFilter,
          standardListingDateMap,
          privateKey,
          standardListings,
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
      attendees = await filterAttendeesByAgent(
        buildCalendarAttendees(allListings, sortedAttendees),
        agentFilter,
      );
    }

    const availableDates = compileDateOptions(
      dailyListings,
      attendeeDates,
      standardListingDateMap,
      standardListings,
      holidays,
    );
    const questionData = await loadAttendeeQuestionData(
      attendees.map((a) => a.listingId),
      attendees.map((a) => a.id),
      (await getPrivateKey(session))!,
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
        availabilityRows,
        agents,
        agentFilter,
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
    const [listingCtx, rawDailyAttendees] = await Promise.all([
      loadListingContext(),
      getDailyListingAttendeesByDate(dateFilter),
    ]);
    const { allListings, standardListingDateMap } = listingCtx;

    const [dailyDecrypted, standardAttendees] = await Promise.all([
      decryptAttendees(rawDailyAttendees, privateKey),
      loadStandardListingAttendees(
        dateFilter,
        standardListingDateMap,
        privateKey,
      ),
    ]);

    const allAttendees = sortAttendeesByCreatedDesc([
      ...dailyDecrypted,
      ...standardAttendees,
    ]);
    const { agents, agentFilter } = await resolveAgentFilter(request);
    const attendees = await filterAttendeesByAgent(
      buildCalendarAttendees(allListings, allAttendees),
      agentFilter,
    );
    const calendarAttendees: CalendarAttendee[] = attendees;

    const logisticsCsv = await buildLogisticsCsvContext(
      allListings,
      attendees,
      agents,
    );
    const csv = generateCalendarCsv(
      calendarAttendees,
      logisticsCsv,
      settings.timezone,
    );
    const filename = `calendar_${dateFilter}_attendees.csv`;
    await logActivity(`Calendar CSV exported for date ${dateFilter}`);
    return csvResponse(csv, filename);
  });

/** Calendar routes */
export const calendarRoutes = defineRoutes({
  "GET /admin/calendar": handleAdminCalendarGet,
  "GET /admin/calendar/export": handleAdminCalendarExport,
});

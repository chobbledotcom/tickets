import { defineRoutes } from "#routes/router.ts";

/**
 * Delivery run sheet routes.
 *
 * `/admin/deliveries` shows the drop-offs and collections for the logistics
 * agents a user drives, with a per-leg done toggle. An agent-class user is sent
 * here as their only page (every other admin route is closed to agents by the
 * default auth gate) and is pinned to today and tomorrow. Owners and managers
 * reach it from the Calendar submenu, keep the full staff navigation, and get
 * the shared calendar date picker so they can open any date (and the day after
 * it) rather than only today and tomorrow.
 */

import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeesByIds } from "#db/attendees/queries.ts";
import { getAllListings } from "#db/listings/records.ts";
import { logisticsAgents } from "#db/logistics-agents.ts";
import {
  type AgentRunLeg,
  getAgentRunSheet,
  getAgentRunSheetDates,
  setLegDone,
} from "#db/logistics-run-sheet.ts";
import { settings } from "#db/settings.ts";
import { userAgents } from "#db/user-agents.ts";
/* jscpd:ignore-start */
import { fieldById, unique } from "#fp";
import { t } from "#i18n";
import { getDateFilter, getMonthFilter } from "#routes/admin/actions.ts";
import {
  type AuthSession,
  DELIVERY_FORM,
  deliveryPage,
  withAuth,
} from "#routes/auth.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import { addDays, formatDateLabel } from "#shared/dates.ts";
import { getFlash } from "#shared/flash-context.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { todayInTz } from "#shared/timezone.ts";
import {
  agentDeliveriesPage,
  type DeliveriesDateNav,
  type DeliveryBookingView,
  type DeliveryDayGroup,
} from "#templates/admin/deliveries.tsx";
import type { DatePickerDate } from "#templates/date-picker.tsx";
import { type Attendee, isStaffRole } from "#types";

/* jscpd:ignore-end */

/** Lookups used to flesh out a bare run-sheet leg into a display row. */
type LegLookups = {
  attendeeById: Map<number, Attendee>;
  listingNameById: Map<number, string>;
  agentNameById: Map<number, string>;
};

/** Drop-off legs sort ahead of collection legs within a booking. */
const legOrder = (kind: AgentRunLeg["kind"]): number =>
  kind === "start" ? 0 : 1;

/** Group one date's legs into bookings, so a listing's drop-off and collection
 * for the day appear together under a single entry. Bookings are ordered by
 * their earliest leg time then listing name; within a booking the drop-off
 * comes before the collection. Each leg comes from a real booking for one of
 * the user's real agents, so the attendee/listing/agent lookups always hit. */
const bookingsForDate = (
  legs: AgentRunLeg[],
  date: string,
  lookups: LegLookups,
): DeliveryBookingView[] => {
  const byBooking = new Map<string, DeliveryBookingView>();
  for (const leg of legs.filter((l) => l.date === date)) {
    const key = `${leg.attendeeId}|${leg.listingId}`;
    let booking = byBooking.get(key);
    if (!booking) {
      const attendee = lookups.attendeeById.get(leg.attendeeId)!;
      booking = {
        address: attendee.address,
        attendeeId: leg.attendeeId,
        attendeeName: attendee.name,
        legs: [],
        listingId: leg.listingId,
        listingName: lookups.listingNameById.get(leg.listingId)!,
        phone: attendee.phone,
        ticketToken: attendee.ticket_token,
      };
      byBooking.set(key, booking);
    }
    booking.legs.push({
      agentName: lookups.agentNameById.get(leg.agentId)!,
      date: leg.date,
      done: leg.done,
      kind: leg.kind,
      time: leg.time,
    });
  }
  for (const booking of byBooking.values()) {
    booking.legs.sort((a, b) => legOrder(a.kind) - legOrder(b.kind));
  }
  return Array.from(byBooking.values()).sort(
    (a, b) =>
      a.legs[0]!.time.localeCompare(b.legs[0]!.time) ||
      a.listingName.localeCompare(b.listingName),
  );
};

/** A day's heading relative to the real today: the opened day and its
 * following day read as "Today"/"Tomorrow" when they line up with the real
 * calendar, and as a full date label ("Monday 6 July 2026") otherwise — so a
 * staff member who opens a future date sees which day each section is. */
const dayHeading = (date: string, today: string): string =>
  date === today
    ? t("deliveries.today")
    : date === addDays(today, 1)
      ? t("deliveries.tomorrow")
      : formatDateLabel(date);

/** Group the run sheet into two sections: the opened day and the day after. */
const buildGroups = (
  legs: AgentRunLeg[],
  baseDate: string,
  tomorrow: string,
  today: string,
  lookups: LegLookups,
): DeliveryDayGroup[] => [
  {
    bookings: bookingsForDate(legs, baseDate, lookups),
    heading: dayHeading(baseDate, today),
  },
  {
    bookings: bookingsForDate(legs, tomorrow, lookups),
    heading: dayHeading(tomorrow, today),
  },
];

/** Build the per-attendee, per-listing and per-agent lookups for a leg set. */
const loadLegLookups = async (
  legs: AgentRunLeg[],
  privateKey: CryptoKey,
): Promise<LegLookups> => {
  const attendeeIds = unique(legs.map((leg) => leg.attendeeId));
  const [rawAttendees, listings, agents] = await Promise.all([
    getAttendeesByIds(attendeeIds),
    getAllListings(),
    logisticsAgents.getAll(),
  ]);
  const decrypted = await decryptAttendees(rawAttendees, privateKey);
  const attendeeById = new Map<number, Attendee>();
  for (const attendee of decrypted) {
    if (!attendeeById.has(attendee.id)) attendeeById.set(attendee.id, attendee);
  }
  return {
    agentNameById: fieldById("name")(agents),
    attendeeById,
    listingNameById: fieldById("name")(listings),
  };
};

/** Build the staff date picker for the run sheet: every date the user's agents
 * have a delivery on is a selectable link, using the same calendar component as
 * the calendar page. Agents never see it, so this only runs for staff. */
const buildDateNav = async (
  agentIds: number[],
  today: string,
  selected: string | null,
  viewMonth: string | null,
): Promise<DeliveriesDateNav> => {
  const deliveryDates = await getAgentRunSheetDates(agentIds);
  const availableDates: DatePickerDate[] = deliveryDates.map((date) => ({
    label: formatDateLabel(date),
    selectable: true,
    value: date,
  }));
  return { availableDates, selected, today, viewMonth };
};

/** Handle GET /admin/deliveries — render the run sheet. Agents are sent here as
 * their only page and are pinned to today and tomorrow; staff (owner/manager)
 * reach it from the Calendar submenu and may open any date via the calendar
 * picker, seeing that date and the day after it. */
const handleDeliveriesGet = deliveryPage(async (session, request) => {
  const flash = getFlash();
  const staff = isStaffRole(session.adminLevel);
  const agentIds = await userAgents.getIds(session.userId);
  if (agentIds.length === 0) {
    return agentDeliveriesPage(
      [],
      settings.phonePrefix,
      { error: flash.error, noAgents: true, success: flash.success },
      session,
      null,
    );
  }

  const today = todayInTz(settings.timezone);
  // Only staff may open a different date; an agent's date/month params are
  // ignored so a driver always sees just today and tomorrow.
  const selected = staff ? getDateFilter(request) : null;
  const viewMonth = staff ? getMonthFilter(request) : null;
  const baseDate = selected ?? today;
  const tomorrow = addDays(baseDate, 1);
  const legs = await getAgentRunSheet(agentIds, [baseDate, tomorrow]);

  const privateKey = await requireRequestPrivateKey();
  const lookups = await loadLegLookups(legs, privateKey);
  const groups = buildGroups(legs, baseDate, tomorrow, today, lookups);
  const dateNav = staff
    ? await buildDateNav(agentIds, today, selected, viewMonth)
    : null;
  return agentDeliveriesPage(
    groups,
    settings.phonePrefix,
    { error: flash.error, noAgents: false, success: flash.success },
    session,
    dateNav,
  );
});

/** Whether a mark for `date` is allowed for the marking user. An agent only
 * ever sees today and tomorrow, so a mark from one may name only those two
 * days; staff may open any date on the run sheet, so their date is left to the
 * query's per-day scoping (and agent ownership) to police. */
const markDateAllowed = (session: AuthSession, date: string): boolean => {
  if (isStaffRole(session.adminLevel)) return true;
  const today = todayInTz(settings.timezone);
  return date === today || date === addDays(today, 1);
};

/** Handle POST /admin/deliveries/mark — toggle a leg done, scoped to the
 * agent's own logistics agents and to the run-sheet day it was shown on. */
const handleDeliveriesMark = (request: Request): Promise<Response> =>
  withAuth(request, DELIVERY_FORM, async (session, form) => {
    const attendeeId = form.getOptionalInt("attendee_id");
    const listingId = form.getOptionalInt("listing_id");
    const kind = form.getString("kind");
    const date = form.getString("date");
    const done = form.getFlag("done");
    if (attendeeId === null || listingId === null) {
      return errorRedirect(
        "/admin/deliveries",
        t("deliveries.invalid_request"),
      );
    }
    if (kind !== "start" && kind !== "end") {
      return errorRedirect(
        "/admin/deliveries",
        t("deliveries.invalid_request"),
      );
    }
    if (!markDateAllowed(session, date)) {
      return errorRedirect(
        "/admin/deliveries",
        t("deliveries.invalid_request"),
      );
    }

    const agentIds = await userAgents.getIds(session.userId);
    const updated = await setLegDone(
      attendeeId,
      listingId,
      kind,
      date,
      done,
      agentIds,
    );
    if (!updated) {
      return errorRedirect("/admin/deliveries", t("deliveries.not_yours"));
    }
    return redirect(
      "/admin/deliveries",
      done ? t("deliveries.marked_done") : t("deliveries.marked_not_done"),
      true,
    );
  });

/** Delivery agent routes. */
export const adminHandlers = defineRoutes({
  "GET /admin/deliveries": handleDeliveriesGet,
  "POST /admin/deliveries/mark": handleDeliveriesMark,
});

/**
 * Delivery run sheet routes.
 *
 * `/admin/deliveries` shows the drop-offs and collections for the logistics
 * agents a user drives, today and tomorrow, with a per-leg done toggle. An
 * agent-class user is sent here as their only page (every other admin route is
 * closed to agents by the default auth gate); owners and managers reach it from
 * the Calendar submenu and, unlike agents, keep the full staff navigation.
 */

/* jscpd:ignore-start */
import { unique } from "#fp";
import { t } from "#i18n";
import { ANY_USER_FORM, anyUserPage, withAuth } from "#routes/auth.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import { addDays } from "#shared/dates.ts";
import { decryptAttendees, getAttendeesByIds } from "#shared/db/attendees.ts";
import { getAllListings } from "#shared/db/listings.ts";
import {
  type AgentRunLeg,
  getAgentRunSheet,
  setLegDone,
} from "#shared/db/logistics.ts";
import {
  agentNameMap,
  getAllLogisticsAgents,
} from "#shared/db/logistics-agents.ts";
import { settings } from "#shared/db/settings.ts";
import { getUserAgentIds } from "#shared/db/user-agents.ts";
import { getFlash } from "#shared/flash-context.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { todayInTz } from "#shared/timezone.ts";
import type { Attendee } from "#shared/types.ts";
import {
  agentDeliveriesPage,
  type DeliveryBookingView,
  type DeliveryDayGroup,
} from "#templates/admin/deliveries.tsx";

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

/** Group the run sheet into Today / Tomorrow sections. */
const buildGroups = (
  legs: AgentRunLeg[],
  today: string,
  tomorrow: string,
  lookups: LegLookups,
): DeliveryDayGroup[] => [
  {
    bookings: bookingsForDate(legs, today, lookups),
    heading: t("deliveries.today"),
  },
  {
    bookings: bookingsForDate(legs, tomorrow, lookups),
    heading: t("deliveries.tomorrow"),
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
    getAllLogisticsAgents(),
  ]);
  const decrypted = await decryptAttendees(rawAttendees, privateKey);
  const attendeeById = new Map<number, Attendee>();
  for (const attendee of decrypted) {
    if (!attendeeById.has(attendee.id)) attendeeById.set(attendee.id, attendee);
  }
  return {
    agentNameById: agentNameMap(agents),
    attendeeById,
    listingNameById: new Map(listings.map((l) => [l.id, l.name])),
  };
};

/** Handle GET /admin/deliveries — render the run sheet. Agents are sent here as
 * their only page; staff (owner/manager) reach it from the Calendar submenu. */
const handleDeliveriesGet = anyUserPage(async (session) => {
  const flash = getFlash();
  const agentIds = await getUserAgentIds(session.userId);
  if (agentIds.length === 0) {
    return agentDeliveriesPage(
      [],
      settings.phonePrefix,
      { error: flash.error, noAgents: true, success: flash.success },
      session,
    );
  }

  const today = todayInTz(settings.timezone);
  const tomorrow = addDays(today, 1);
  const legs = await getAgentRunSheet(agentIds, [today, tomorrow]);

  const privateKey = await requireRequestPrivateKey();
  const lookups = await loadLegLookups(legs, privateKey);
  const groups = buildGroups(legs, today, tomorrow, lookups);
  return agentDeliveriesPage(
    groups,
    settings.phonePrefix,
    { error: flash.error, noAgents: false, success: flash.success },
    session,
  );
});

/** Handle POST /admin/deliveries/mark — toggle a leg done, scoped to the
 * agent's own logistics agents. */
const handleDeliveriesMark = (request: Request): Promise<Response> =>
  withAuth(request, ANY_USER_FORM, async (session, form) => {
    const attendeeId = form.getOptionalInt("attendee_id");
    const listingId = form.getOptionalInt("listing_id");
    const kind = form.getString("kind");
    const date = form.getString("date");
    const done = form.getString("done") === "1";
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
    const today = todayInTz(settings.timezone);
    const tomorrow = addDays(today, 1);
    if (date !== today && date !== tomorrow) {
      return errorRedirect(
        "/admin/deliveries",
        t("deliveries.invalid_request"),
      );
    }

    const agentIds = await getUserAgentIds(session.userId);
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
export const deliveriesRoutes = defineRoutes({
  "GET /admin/deliveries": handleDeliveriesGet,
  "POST /admin/deliveries/mark": handleDeliveriesMark,
});

/**
 * Delivery agent run sheet routes — agent-only.
 *
 * An agent user sees only `/admin/deliveries`: the drop-offs and collections
 * for the logistics agents they drive, today and tomorrow. They can toggle each
 * leg done. Every other admin route is closed to agents by the default auth
 * gate (see auth.ts), so this module is their whole world.
 */

import { unique } from "#fp";
import { t } from "#i18n";
import {
  AGENT_FORM,
  agentPage,
  getPrivateKey,
  withAuth,
} from "#routes/auth.ts";
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
import { todayInTz } from "#shared/timezone.ts";
import type { Attendee } from "#shared/types.ts";
import {
  agentDeliveriesPage,
  type DeliveryDayGroup,
  type DeliveryLegView,
} from "#templates/admin/deliveries.tsx";

/** Lookups used to flesh out a bare run-sheet leg into a display row. */
type LegLookups = {
  attendeeById: Map<number, Attendee>;
  listingNameById: Map<number, string>;
  agentNameById: Map<number, string>;
};

/** Turn a run-sheet leg into a display row, resolving names/PII via lookups.
 * Each leg comes from a real booking for one of the user's real agents, so the
 * attendee, listing and agent lookups always hit (non-null, like calendar.ts). */
const toLegView = (leg: AgentRunLeg, lookups: LegLookups): DeliveryLegView => {
  const attendee = lookups.attendeeById.get(leg.attendeeId)!;
  return {
    address: attendee.address,
    agentName: lookups.agentNameById.get(leg.agentId)!,
    attendeeId: leg.attendeeId,
    attendeeName: attendee.name,
    done: leg.done,
    kind: leg.kind,
    listingId: leg.listingId,
    listingName: lookups.listingNameById.get(leg.listingId)!,
    phone: attendee.phone,
    time: leg.time,
  };
};

/** Legs for one date, as display rows ordered by time then listing name. */
const legsForDate = (
  legs: AgentRunLeg[],
  date: string,
  lookups: LegLookups,
): DeliveryLegView[] =>
  legs
    .filter((leg) => leg.date === date)
    .map((leg) => toLegView(leg, lookups))
    .sort(
      (a, b) =>
        a.time.localeCompare(b.time) ||
        a.listingName.localeCompare(b.listingName),
    );

/** Group the run sheet into Today / Tomorrow sections. */
const buildGroups = (
  legs: AgentRunLeg[],
  today: string,
  tomorrow: string,
  lookups: LegLookups,
): DeliveryDayGroup[] => [
  { heading: t("deliveries.today"), legs: legsForDate(legs, today, lookups) },
  {
    heading: t("deliveries.tomorrow"),
    legs: legsForDate(legs, tomorrow, lookups),
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

/** Handle GET /admin/deliveries — render the agent's run sheet. */
const handleDeliveriesGet = agentPage(async (session) => {
  const agentIds = await getUserAgentIds(session.userId);
  if (agentIds.length === 0) {
    return agentDeliveriesPage([], settings.phonePrefix, { noAgents: true });
  }

  const today = todayInTz(settings.timezone);
  const tomorrow = addDays(today, 1);
  const legs = await getAgentRunSheet(agentIds, [today, tomorrow]);

  const privateKey = (await getPrivateKey(session))!;
  const lookups = await loadLegLookups(legs, privateKey);
  const groups = buildGroups(legs, today, tomorrow, lookups);
  return agentDeliveriesPage(groups, settings.phonePrefix, { noAgents: false });
});

/** Handle POST /admin/deliveries/mark — toggle a leg done, scoped to the
 * agent's own logistics agents. */
const handleDeliveriesMark = (request: Request): Promise<Response> =>
  withAuth(request, AGENT_FORM, async (session, form) => {
    const attendeeId = form.getOptionalInt("attendee_id");
    const listingId = form.getOptionalInt("listing_id");
    const kind = form.getString("kind");
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

    const agentIds = await getUserAgentIds(session.userId);
    const updated = await setLegDone(
      attendeeId,
      listingId,
      kind,
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

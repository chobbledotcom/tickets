/**
 * Check-in routes - /checkin/:tokens
 * GET: Shows attendee details and check-in/check-out button
 * POST: Sets check-in status based on explicit check_in form field (PRG pattern)
 */

import { logActivities } from "#db/activity-log.ts";
import { setCheckedInOnBookingRows } from "#db/attendees/update.ts";
import { withTransaction } from "#db/client.ts";
import type { DeliveryBookingRef } from "#db/logistics.ts";
/* jscpd:ignore-start -- imports */
import {
  getAgentRunSheetBookings,
  runSheetBookingKey,
} from "#db/logistics-run-sheet.ts";
import { settings } from "#db/settings.ts";
import { userAgents } from "#db/user-agents.ts";
/* jscpd:ignore-end */
/* jscpd:ignore-start */
import { filter, map } from "#fp";
import {
  type AuthSession,
  DOOR_FORM,
  getAuthenticatedSession,
  withAuth,
} from "#routes/auth.ts";
import { authFailure } from "#routes/auth-failures.ts";
import {
  htmlResponse,
  notFoundResponse,
  redirectResponse,
} from "#routes/response.ts";
import {
  createTokenRoute,
  decryptTokenEntries,
  lookupAttendees,
  resolveEntries,
  type TokenEntry,
  type TokenMethodHandler,
} from "#routes/tickets/token-utils.ts";
import { getSearchParam } from "#routes/url.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { addDays } from "#shared/dates.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { todayInTz } from "#shared/timezone.ts";
import { checkinAdminPage, checkinPublicPage } from "#templates/checkin.tsx";
import { type Attendee, isDoorRole, isStaffRole } from "#types";

/* jscpd:ignore-end */

const formatTicketCount = (count: number): string => {
  const suffix = count === 1 ? "" : "s";
  return `${count} ticket${suffix}`;
};

const checkinPath = (tokens: string[]): string =>
  `/checkin/${tokens.join("+")}`;

const sumTicketCount = (
  attendees: Attendee[],
  include: (attendee: Attendee) => boolean = () => true,
): number => {
  let total = 0;
  for (const attendee of attendees) {
    if (include(attendee)) total += attendee.quantity;
  }
  return total;
};

/** Decrypt entries' attendees using the current request's private key */
const decryptEntries = async (entries: TokenEntry[]): Promise<TokenEntry[]> => {
  const privateKey = await requireRequestPrivateKey();
  return decryptTokenEntries(entries, privateKey);
};

const agentRunSheetDates = (): string[] => {
  const today = todayInTz(settings.timezone);
  return [today, addDays(today, 1)];
};

const entryBookingRef = (entry: TokenEntry): DeliveryBookingRef => ({
  attendeeId: entry.attendee.id,
  listingId: entry.listing.id,
});

const entryRunSheetKey = (entry: TokenEntry): string =>
  runSheetBookingKey({
    attendeeId: entry.attendee.id,
    date: entry.attendee.date,
    listingId: entry.listing.id,
    packageGroupId: entry.attendee.package_group_id,
    parentListingId: entry.parentListingId,
  });

const entriesVisibleToSession = async (
  session: AuthSession,
  entries: TokenEntry[],
): Promise<TokenEntry[]> => {
  if (isDoorRole(session.adminLevel)) return entries;
  if (session.adminLevel !== "agent") return [];

  const agentIds = await userAgents.getIds(session.userId);
  // The agent sees the booking rows whose drop-off or collection leg is on
  // their run sheet for today or tomorrow — matched at row granularity, so a
  // multi-row attendee's row outside the run sheet never leaks alongside an
  // assigned sibling row.
  const allowedBookings = await getAgentRunSheetBookings(
    agentIds,
    agentRunSheetDates(),
    entries.map(entryBookingRef),
  );
  const allowedKeys = new Set(allowedBookings.map(runSheetBookingKey));
  return filter((entry: TokenEntry) =>
    allowedKeys.has(entryRunSheetKey(entry)),
  )(entries);
};

/** The facts a door-only login may read from a ticket row: who, which listing
 * and day, how many places, and the check-in state. Contact details stay
 * behind — the ticket itself never shows them either. Blank fields also hide
 * their table columns outright. */
const doorSafeEntries = (entries: TokenEntry[]): TokenEntry[] =>
  map((entry: TokenEntry) => ({
    ...entry,
    attendee: {
      ...entry.attendee,
      address: "",
      email: "",
      phone: "",
      special_instructions: "",
    },
  }))(entries);

const renderAdminCheckin = async (
  request: Request,
  tokens: string[],
  entries: TokenEntry[],
  page: {
    canCheckIn: boolean;
    doorOnly: boolean;
    linkAdminPages: boolean;
  },
): Promise<Response> => {
  const decrypted = await decryptEntries(entries);
  const shown = page.doorOnly ? doorSafeEntries(decrypted) : decrypted;
  const message = getSearchParam(request, "message");
  return htmlResponse(
    checkinAdminPage(
      shown,
      checkinPath(tokens),
      message,
      getEffectiveDomain(),
      settings.phonePrefix,
      page,
    ),
  );
};

/** Look up attendees by tokens and resolve to entries */
const withLookup = async (
  tokens: string[],
  handler: ResponseHandler<[entries: TokenEntry[]]>,
): Promise<Response> => {
  const lookup = await lookupAttendees(tokens);
  if (!lookup.ok) return lookup.response;
  const entries = await resolveEntries(lookup.attendees);
  return entries.length === 0 ? notFoundResponse() : handler(entries);
};

/** Handle GET /checkin/:tokens - show current status */
const handleCheckinGet: TokenMethodHandler = (request, tokens) =>
  withLookup(tokens, async (entries) => {
    const session = await getAuthenticatedSession(request);
    if (!session) return htmlResponse(checkinPublicPage());

    const visibleEntries = await entriesVisibleToSession(session, entries);
    // Door roles may toggle check-in; only staff may follow the attendee and
    // listing links into the admin, which a scanner login cannot open. A
    // door-only login (a scanner) reads door facts only; an agent's own
    // delivery rows still show contact details, which the run sheet needs.
    // The toggle form renders only when the POST has something it can change
    // — a token whose every row is refunded or no-check-in offers no action.
    const door = isDoorRole(session.adminLevel);
    const canCheckIn =
      door &&
      entries.some((e) => !e.attendee.refunded && !e.listing.purchase_only);
    return visibleEntries.length === 0
      ? authFailure("html", "forbidden")
      : renderAdminCheckin(request, tokens, visibleEntries, {
          canCheckIn,
          doorOnly: door && !isStaffRole(session.adminLevel),
          linkAdminPages: isStaffRole(session.adminLevel),
        });
  });

/** Handle POST /checkin/:tokens - set check-in status from form field */
const handleCheckinPost: TokenMethodHandler = (request, tokens) =>
  withAuth(request, DOOR_FORM, (_session, form) =>
    withLookup(tokens, async (entries) => {
      const checkedIn = form.get("check_in") === "true";
      const decrypted = await decryptEntries(entries);
      // Refunded rows are never touched, and purchase-only ("No Check-In")
      // listings' rows are excluded too — a package QR shared with a checkable
      // member must not silently mark the no-check-in member as attended.
      const eligibleEntries = filter(
        (e: TokenEntry) => !e.attendee.refunded && !e.listing.purchase_only,
      )(decrypted);
      const eligible = eligibleEntries.map((e) => e.attendee);

      if (eligible.length === 0) {
        return redirectResponse(
          `${checkinPath(tokens)}?message=${encodeURIComponent(
            "No tickets on this token can be checked in",
          )}`,
        );
      }

      const totalTickets = sumTicketCount(eligible);
      const uncheckedTickets = sumTicketCount(
        eligible,
        (attendee) => !attendee.checked_in,
      );
      // Every row's status change and every row's activity record commit as
      // one unit, by the rows the eligibility filter selected — a merged
      // attendee's refunded order on the same listing stays untouched. The
      // action reads in the activity log exactly like its camera-scan and
      // per-row siblings do.
      await withTransaction(async (tx) => {
        await setCheckedInOnBookingRows(
          eligibleEntries.map((e) => e.bookingRowId),
          checkedIn,
          tx,
        );
        await logActivities(
          eligibleEntries.map((e) => ({
            attendeeId: e.attendee.id,
            listing: e.listing.id,
            message: `Attendee checked ${checkedIn ? "in" : "out"} for '${e.listing.name}'`,
          })),
          tx,
        );
      });

      let message: string;
      if (!checkedIn) {
        message = "Checked out";
      } else if (uncheckedTickets === 0) {
        message = `Already checked in ${formatTicketCount(totalTickets)}`;
      } else {
        message = `Checked in ${formatTicketCount(uncheckedTickets)}`;
      }
      return redirectResponse(
        `${checkinPath(tokens)}?message=${encodeURIComponent(message)}`,
      );
    }),
  );

/** Route check-in requests */
export const routeCheckin = createTokenRoute("checkin", {
  GET: handleCheckinGet,
  POST: handleCheckinPost,
});

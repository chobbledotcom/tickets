/**
 * Check-in routes - /checkin/:tokens
 * GET: Shows attendee details and check-in/check-out button
 * POST: Sets check-in status based on explicit check_in form field (PRG pattern)
 */

/* jscpd:ignore-start */
import { filter, map } from "#fp";
import {
  AUTH_FORM,
  type AuthSession,
  authFailure,
  getAuthenticatedSession,
  withAuth,
} from "#routes/auth.ts";
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
import { updateCheckedIn } from "#shared/db/attendees/update.ts";
import {
  bookingAssignmentKey,
  type DeliveryBookingRef,
  getAgentRunSheetBookingKeys,
} from "#shared/db/logistics.ts";
import { settings } from "#shared/db/settings.ts";
import { userAgents } from "#shared/db/user-agents.ts";
import type { ResponseHandler } from "#shared/response-steps.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import { todayInTz } from "#shared/timezone.ts";
import { type Attendee, isStaffRole } from "#shared/types.ts";
import { checkinAdminPage, checkinPublicPage } from "#templates/checkin.tsx";

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

const entryBookingKey = (entry: TokenEntry): string =>
  bookingAssignmentKey(entry.attendee.id, entry.listing.id);

const entryAllowedBy = (allowedKeys: Set<string>) => (entry: TokenEntry) =>
  allowedKeys.has(entryBookingKey(entry));

const entriesVisibleToSession = async (
  session: AuthSession,
  entries: TokenEntry[],
): Promise<TokenEntry[]> => {
  if (isStaffRole(session.adminLevel)) return entries;
  if (session.adminLevel !== "agent") return [];

  const agentIds = await userAgents.getIds(session.userId);
  const allowedKeys = await getAgentRunSheetBookingKeys(
    agentIds,
    agentRunSheetDates(),
    entries.map(entryBookingRef),
  );
  return filter(entryAllowedBy(allowedKeys))(entries);
};

const renderAdminCheckin = async (
  request: Request,
  tokens: string[],
  entries: TokenEntry[],
  canCheckIn: boolean,
): Promise<Response> => {
  const decrypted = await decryptEntries(entries);
  const message = getSearchParam(request, "message");
  return htmlResponse(
    checkinAdminPage(
      decrypted,
      checkinPath(tokens),
      message,
      getEffectiveDomain(),
      settings.phonePrefix,
      { canCheckIn, linkAdminPages: canCheckIn },
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
    const canCheckIn = isStaffRole(session.adminLevel);
    return visibleEntries.length === 0
      ? authFailure("html", "forbidden")
      : renderAdminCheckin(request, tokens, visibleEntries, canCheckIn);
  });

/** Handle POST /checkin/:tokens - set check-in status from form field */
const handleCheckinPost: TokenMethodHandler = (request, tokens) =>
  withAuth(request, AUTH_FORM, (_session, form) =>
    withLookup(tokens, async (entries) => {
      const checkedIn = form.get("check_in") === "true";
      const decrypted = await decryptEntries(entries);
      // Refunded rows are never touched, and purchase-only ("No Check-In")
      // listings' rows are excluded too — a package QR shared with a checkable
      // member must not silently mark the no-check-in member as attended.
      const eligible = filter(
        (e: TokenEntry) => !e.attendee.refunded && !e.listing.purchase_only,
      )(decrypted).map((e) => e.attendee);

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
      await Promise.all(
        map((a: Attendee) => updateCheckedIn(a.id, a.listing_id, checkedIn))(
          eligible,
        ),
      );

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

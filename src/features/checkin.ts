/**
 * Check-in routes - /checkin/:tokens
 * GET: Shows attendee details and check-in/check-out button
 * POST: Sets check-in status based on explicit check_in form field (PRG pattern)
 */

import { filter, map } from "#fp";
import { AUTH_FORM, getAuthenticatedSession, withAuth } from "#routes/auth.ts";
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
} from "#routes/tickets/token-utils.ts";
import { getSearchParam } from "#routes/url.ts";
import { getEffectiveDomain } from "#shared/config.ts";
import { updateCheckedIn } from "#shared/db/attendees.ts";
import { settings } from "#shared/db/settings.ts";
import { requireRequestPrivateKey } from "#shared/session-private-key.ts";
import type { Attendee } from "#shared/types.ts";
import { checkinAdminPage, checkinPublicPage } from "#templates/checkin.tsx";

const formatTicketCount = (count: number): string => {
  const suffix = count === 1 ? "" : "s";
  return `${count} ticket${suffix}`;
};

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

/** Look up attendees by tokens and resolve to entries */
const withLookup = async (
  tokens: string[],
  handler: (entries: TokenEntry[]) => Response | Promise<Response>,
): Promise<Response> => {
  const lookup = await lookupAttendees(tokens);
  if (!lookup.ok) return lookup.response;
  const entries = await resolveEntries(lookup.attendees);
  return entries.length === 0 ? notFoundResponse() : handler(entries);
};

/** Handle GET /checkin/:tokens - show current status */
const handleCheckinGet = (
  request: Request,
  tokens: string[],
): Promise<Response> =>
  withLookup(tokens, async (entries) => {
    const session = await getAuthenticatedSession(request);
    if (!session) return htmlResponse(checkinPublicPage());

    const decrypted = await decryptEntries(entries);
    const message = getSearchParam(request, "message");
    return htmlResponse(
      checkinAdminPage(
        decrypted,
        `/checkin/${tokens.join("+")}`,
        message,
        getEffectiveDomain(),
        settings.phonePrefix,
      ),
    );
  });

/** Handle POST /checkin/:tokens - set check-in status from form field */
const handleCheckinPost = (
  request: Request,
  tokens: string[],
): Promise<Response> =>
  withAuth(request, AUTH_FORM, (_session, form) =>
    withLookup(tokens, async (entries) => {
      const checkedIn = form.get("check_in") === "true";
      const decrypted = await decryptEntries(entries);
      const eligible = filter((e: TokenEntry) => !e.attendee.refunded)(
        decrypted,
      ).map((e) => e.attendee);

      if (eligible.length === 0) {
        return redirectResponse(
          `/checkin/${tokens.join("+")}?message=${encodeURIComponent(
            "Cannot check in refunded tickets",
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
        `/checkin/${tokens.join("+")}?message=${encodeURIComponent(message)}`,
      );
    }),
  );

/** Route check-in requests */
export const routeCheckin = createTokenRoute("checkin", {
  GET: handleCheckinGet,
  POST: handleCheckinPost,
});

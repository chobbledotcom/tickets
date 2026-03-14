/**
 * Check-in routes - /checkin/:tokens
 * GET: Shows attendee details and check-in/check-out button
 * POST: Sets check-in status based on explicit check_in form field (PRG pattern)
 */

import { filter, map } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { getPhonePrefixFromDb } from "#lib/db/settings.ts";
import { decryptAttendees, updateCheckedIn } from "#lib/db/attendees.ts";
import type { Attendee } from "#lib/types.ts";
import { checkinAdminPage, checkinPublicPage } from "#templates/checkin.tsx";
import {
  type AuthSession,
  getAuthenticatedSession,
  getPrivateKey,
  getSearchParam,
  htmlResponse,
  redirectResponse,
  withAuthForm,
} from "#routes/utils.ts";
import { createTokenRoute, lookupAttendees, resolveEntries } from "#routes/token-utils.ts";

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

/** Decrypt attendees using the session's private key */
const decryptWithSession = async (rawAttendees: Attendee[], session: AuthSession) => {
  const privateKey = (await getPrivateKey(session))!;
  return decryptAttendees(rawAttendees, privateKey);
};

/** Render admin check-in view with current attendee state */
const renderAdminView = async (
  rawAttendees: Attendee[],
  session: AuthSession,
  tokens: string[],
  message: string | null,
): Promise<Response> => {
  const decrypted = await decryptWithSession(rawAttendees, session);
  const entries = await resolveEntries(decrypted);
  const phonePrefix = await getPhonePrefixFromDb();
  return htmlResponse(checkinAdminPage(entries, `/checkin/${tokens.join("+")}`, message, getAllowedDomain(), phonePrefix));
};

/** Look up attendees by tokens, returning early with error response if not found */
const withLookup = async (
  tokens: string[],
  handler: (attendees: Attendee[]) => Response | Promise<Response>,
): Promise<Response> => {
  const lookup = await lookupAttendees(tokens);
  return lookup.ok ? handler(lookup.attendees) : lookup.response;
};

/** Handle GET /checkin/:tokens - show current status */
const handleCheckinGet = (
  request: Request,
  tokens: string[],
): Promise<Response> =>
  withLookup(tokens, async (rawAttendees) => {
    const session = await getAuthenticatedSession(request);
    if (!session) return htmlResponse(checkinPublicPage());

    const message = getSearchParam(request, "message");
    return renderAdminView(rawAttendees, session, tokens, message);
  });

/** Handle POST /checkin/:tokens - set check-in status from form field */
const handleCheckinPost = (request: Request, tokens: string[]): Promise<Response> =>
  withAuthForm(request, (session, form) =>
    withLookup(tokens, async (rawAttendees) => {
      const checkedIn = form.get("check_in") === "true";
      const decrypted = await decryptWithSession(rawAttendees, session);
      const eligible = filter((a: Attendee) => !a.refunded)(decrypted);

      if (eligible.length === 0) {
        return redirectResponse(`/checkin/${tokens.join("+")}?message=${encodeURIComponent("Cannot check in refunded tickets")}`);
      }

      const totalTickets = sumTicketCount(eligible);
      const uncheckedTickets = sumTicketCount(
        eligible,
        (attendee) => !attendee.checked_in,
      );
      await Promise.all(map((a: Attendee) => updateCheckedIn(a.id, checkedIn))(eligible));

      let message: string;
      if (!checkedIn) {
        message = "Checked out";
      } else if (uncheckedTickets === 0) {
        message = `Already checked in ${formatTicketCount(totalTickets)}`;
      } else {
        message = `Checked in ${formatTicketCount(uncheckedTickets)}`;
      }
      return redirectResponse(`/checkin/${tokens.join("+")}?message=${encodeURIComponent(message)}`);
    }));

/** Route check-in requests */
export const routeCheckin = createTokenRoute("checkin", {
  GET: handleCheckinGet,
  POST: handleCheckinPost,
});

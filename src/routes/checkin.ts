/**
 * Check-in routes - /checkin/:tokens
 * GET: Shows attendee details and check-in/check-out button
 * POST: Sets check-in status based on explicit check_in form field (PRG pattern)
 */

import { filter, map } from "#fp";
import { getAllowedDomain } from "#lib/config.ts";
import { decryptAttendees, updateCheckedIn } from "#lib/db/attendees.ts";
import type { Attendee } from "#lib/types.ts";
import { checkinAdminPage, checkinPublicPage } from "#templates/checkin.tsx";
import {
  type AuthSession,
  getAuthenticatedSession,
  getPrivateKey,
  getSearchParam,
  htmlResponse,
  redirect,
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

/** Render admin check-in view with current attendee state */
const renderAdminView = async (
  rawAttendees: Attendee[],
  session: AuthSession,
  tokens: string[],
  message: string | null,
): Promise<Response> => {
  const privateKey = (await getPrivateKey(session))!;
  const decrypted = await decryptAttendees(rawAttendees, privateKey);
  const entries = await resolveEntries(decrypted);
  return htmlResponse(checkinAdminPage(entries, session.csrfToken, `/checkin/${tokens.join("+")}`, message, getAllowedDomain()));
};

/** Handle GET /checkin/:tokens - show current status */
const handleCheckinGet = async (
  request: Request,
  tokens: string[],
): Promise<Response> => {
  const lookup = await lookupAttendees(tokens);
  if (!lookup.ok) return lookup.response;

  const session = await getAuthenticatedSession(request);
  if (!session) return htmlResponse(checkinPublicPage());

  const message = getSearchParam(request, "message");
  return renderAdminView(lookup.attendees, session, tokens, message);
};

/** Handle POST /checkin/:tokens - set check-in status from form field */
const handleCheckinPost = (request: Request, tokens: string[]): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const lookup = await lookupAttendees(tokens);
    if (!lookup.ok) return lookup.response;

    const checkedIn = form.get("check_in") === "true";
    const privateKey = (await getPrivateKey(session))!;
    const decrypted = await decryptAttendees(lookup.attendees, privateKey);
    const eligible = filter((a: Attendee) => !a.refunded)(decrypted);

    if (eligible.length === 0) {
      return redirect(`/checkin/${tokens.join("+")}?message=${encodeURIComponent("Cannot check in refunded tickets")}`);
    }

    const totalTickets = sumTicketCount(eligible);
    const uncheckedTickets = sumTicketCount(
      eligible,
      (attendee) => attendee.checked_in !== "true",
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
    return redirect(`/checkin/${tokens.join("+")}?message=${encodeURIComponent(message)}`);
  });

/** Route check-in requests */
export const routeCheckin = createTokenRoute("checkin", {
  GET: handleCheckinGet,
  POST: handleCheckinPost,
});

/**
 * Check-in routes - /checkin/:tokens
 * GET: Shows attendee details and check-in/check-out button
 * POST: Sets check-in status based on explicit check_in form field
 */

import { map } from "#fp";
import { decryptAttendees, updateCheckedIn } from "#lib/db/attendees.ts";
import type { Attendee } from "#lib/types.ts";
import { checkinAdminPage, checkinPublicPage } from "#templates/checkin.tsx";
import {
  type AuthSession,
  getAuthenticatedSession,
  getPrivateKey,
  htmlResponse,
  withAuthForm,
} from "#routes/utils.ts";
import { createTokenRoute, lookupAttendees, resolveEntries } from "#routes/token-utils.ts";

/** Decrypt raw attendees, optionally update check-in status, and render */
const buildAdminView = async (
  rawAttendees: Attendee[],
  session: AuthSession,
  tokens: string[],
  setCheckedIn: boolean | null,
): Promise<Response> => {
  if (setCheckedIn !== null) {
    await Promise.all(map((a: Attendee) => updateCheckedIn(a.id, setCheckedIn))(rawAttendees));
  }
  const privateKey = (await getPrivateKey(session.token, session.wrappedDataKey))!;
  const decrypted = await decryptAttendees(rawAttendees, privateKey);
  const attendees = setCheckedIn !== null
    ? map((a: Attendee) => ({ ...a, checked_in: setCheckedIn ? "true" : "false" }))(decrypted)
    : decrypted;
  const entries = await resolveEntries(attendees);
  const message = setCheckedIn === true ? "Checked in" : setCheckedIn === false ? "Checked out" : null;
  return htmlResponse(checkinAdminPage(entries, session.csrfToken, `/checkin/${tokens.join("+")}`, message));
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

  return buildAdminView(lookup.attendees, session, tokens, null);
};

/** Handle POST /checkin/:tokens - set check-in status from form field */
const handleCheckinPost = (request: Request, tokens: string[]): Promise<Response> =>
  withAuthForm(request, async (session, form) => {
    const lookup = await lookupAttendees(tokens);
    if (!lookup.ok) return lookup.response;

    const checkedIn = form.get("check_in") === "true";
    return buildAdminView(lookup.attendees, session, tokens, checkedIn);
  });

/** Route check-in requests */
export const routeCheckin = createTokenRoute("checkin", {
  GET: handleCheckinGet,
  POST: handleCheckinPost,
});

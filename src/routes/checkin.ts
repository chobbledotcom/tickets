/**
 * Check-in routes - /checkin/:tokens
 * GET: Admin auto-checks-in attendees and shows details; non-admin sees message
 * POST: Admin checks-out attendees and redirects back
 */

import { map } from "#fp";
import { updateCheckedIn } from "#lib/db/attendees.ts";
import type { Attendee } from "#lib/types.ts";
import { checkinAdminPage, checkinPublicPage } from "#templates/checkin.tsx";
import {
  getAuthenticatedSession,
  getSearchParam,
  htmlResponse,
  redirect,
  withAuthForm,
} from "#routes/utils.ts";
import { createTokenRoute, lookupAttendees, resolveEntries } from "#routes/token-utils.ts";

/** Update one attendee's check-in status and return updated copy */
const updateAndCopy = async (
  attendee: Attendee,
  checkedIn: boolean,
): Promise<Attendee> => {
  await updateCheckedIn(attendee.id, checkedIn);
  return { ...attendee, checked_in: checkedIn ? "true" : "false" };
};

/** Set checked_in for all attendees and return updated copies */
const setCheckedInAll = (
  attendees: Attendee[],
  checkedIn: boolean,
): Promise<Attendee[]> =>
  Promise.all(map((a: Attendee) => updateAndCopy(a, checkedIn))(attendees));

/** Render admin view after check-in/check-out */
const renderAdminView = async (
  attendees: Attendee[],
  csrfToken: string,
  tokens: string[],
): Promise<Response> => {
  const entries = await resolveEntries(attendees);
  return htmlResponse(checkinAdminPage(entries, csrfToken, `/checkin/${tokens.join("+")}`));
};

/** Handle GET /checkin/:tokens */
const handleCheckinGet = async (
  request: Request,
  tokens: string[],
): Promise<Response> => {
  const lookup = await lookupAttendees(tokens);
  if (!lookup.ok) return lookup.response;

  const session = await getAuthenticatedSession(request);
  if (!session) return htmlResponse(checkinPublicPage());

  // When view=true (redirected from check-out POST), show current state without auto-check-in
  const viewOnly = getSearchParam(request, "view") === "true";
  const attendees = viewOnly
    ? lookup.attendees
    : await setCheckedInAll(lookup.attendees, true);
  return renderAdminView(attendees, session.csrfToken, tokens);
};

/** Handle POST /checkin/:tokens (check-out) */
const handleCheckinPost = (request: Request, tokens: string[]): Promise<Response> =>
  withAuthForm(request, async (_session) => {
    const lookup = await lookupAttendees(tokens);
    if (!lookup.ok) return lookup.response;

    await setCheckedInAll(lookup.attendees, false);
    return redirect(`/checkin/${tokens.join("+")}?view=true`);
  });

/** Route check-in requests */
export const routeCheckin = createTokenRoute("checkin", {
  GET: handleCheckinGet,
  POST: handleCheckinPost,
});

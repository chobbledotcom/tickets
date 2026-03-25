/**
 * Check-in routes - /checkin/:tokens
 * GET: Shows attendee details and check-in/check-out button
 * POST: Sets check-in status based on explicit check_in form field (PRG pattern)
 */

import { filter, map } from "#fp";
import { getEffectiveDomain } from "#lib/config.ts";
import { decryptAttendees, updateCheckedIn } from "#lib/db/attendees.ts";
import { settings } from "#lib/db/settings.ts";
import type { FormParams } from "#lib/form-data.ts";
import type { Attendee } from "#lib/types.ts";
import {
  createTokenRoute,
  lookupAttendees,
  resolveEntries,
} from "#routes/token-utils.ts";
import {
  type AuthSession,
  getAuthenticatedSession,
  getPrivateKey,
  getSearchParam,
  htmlResponse,
  redirectResponse,
  withAuthForm,
} from "#routes/utils.ts";
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

/** Decrypt attendees using the session's private key */
const decryptWithSession = async (
  rawAttendees: Attendee[],
  session: AuthSession,
) => {
  const privateKey = (await getPrivateKey(session)) as CryptoKey;
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
  return htmlResponse(
    checkinAdminPage(
      entries,
      `/checkin/${tokens.join("+")}`,
      message,
      getEffectiveDomain(),
      settings.phonePrefix,
    ),
  );
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

/** Build check-in status message based on action and ticket counts */
const buildCheckinMessage = (
  checkedIn: boolean,
  totalTickets: number,
  uncheckedTickets: number,
): string => {
  if (!checkedIn) return "Checked out";
  if (uncheckedTickets === 0)
    return `Already checked in ${formatTicketCount(totalTickets)}`;
  return `Checked in ${formatTicketCount(uncheckedTickets)}`;
};

/** Process check-in/check-out for a set of attendees */
const processCheckin = async (
  session: AuthSession,
  form: FormParams,
  tokens: string[],
  rawAttendees: Attendee[],
): Promise<Response> => {
  const checkedIn = form.get("check_in") === "true";
  const decrypted = await decryptWithSession(rawAttendees, session);
  const eligible = filter((a: Attendee) => !a.refunded)(decrypted);

  if (eligible.length === 0) {
    return redirectResponse(
      `/checkin/${tokens.join("+")}?message=${encodeURIComponent("Cannot check in refunded tickets")}`,
    );
  }

  const totalTickets = sumTicketCount(eligible);
  const uncheckedTickets = sumTicketCount(
    eligible,
    (attendee) => !attendee.checked_in,
  );
  await Promise.all(
    map((a: Attendee) => updateCheckedIn(a.id, checkedIn))(eligible),
  );

  const message = buildCheckinMessage(
    checkedIn,
    totalTickets,
    uncheckedTickets,
  );
  return redirectResponse(
    `/checkin/${tokens.join("+")}?message=${encodeURIComponent(message)}`,
  );
};

/** Handle POST /checkin/:tokens - set check-in status from form field */
const handleCheckinPost = (
  request: Request,
  tokens: string[],
): Promise<Response> =>
  withAuthForm(request, (session, form) =>
    withLookup(tokens, (rawAttendees) =>
      processCheckin(session, form, tokens, rawAttendees),
    ),
  );

/** Route check-in requests */
export const routeCheckin = createTokenRoute("checkin", {
  GET: handleCheckinGet,
  POST: handleCheckinPost,
});

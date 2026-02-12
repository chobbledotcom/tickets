/**
 * QR scanner routes for admin check-in
 * GET /admin/event/:id/scanner - Scanner page with camera UI
 * POST /admin/event/:id/scan - JSON API for processing scanned tokens
 */

import { logActivity } from "#lib/db/activityLog.ts";
import {
  decryptAttendees,
  getAttendeesByTokens,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import type { Attendee } from "#lib/types.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  getPrivateKey,
  jsonResponse,
  withAuthJson,
  withEventPage,
} from "#routes/utils.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";

/** Handle GET /admin/event/:id/scanner - render scanner page */
const handleScannerGet = withEventPage(adminScannerPage);

/** Look up attendee by token, decrypt, and resolve event */
const resolveTokenAttendee = async (
  token: string,
  privateKey: CryptoKey,
): Promise<{ attendee: Attendee; eventName: string } | null> => {
  const attendees = await getAttendeesByTokens([token]);
  const raw = attendees[0];
  if (!raw) return null;

  const [decrypted] = await decryptAttendees([raw], privateKey);
  if (!decrypted) return null;

  const event = await getEventWithCount(decrypted.event_id);
  return { attendee: decrypted, eventName: event?.name ?? "Unknown event" };
};

/** Handle POST /admin/event/:id/scan - JSON check-in API */
const handleScanPost = (request: Request, eventId: number): Promise<Response> =>
  withAuthJson(request, async (session, body) => {
    if (typeof body.token !== "string") {
      return jsonResponse({ status: "error", message: "Missing token" }, 400);
    }

    const token = body.token;
    const force = body.force === true;

    const privateKey = await getPrivateKey(session);
    if (!privateKey) {
      logError({ code: ErrorCode.KEY_DERIVATION, detail: "Scanner: private key unavailable" });
      return jsonResponse({ status: "error", message: "Decryption unavailable" }, 500);
    }

    const resolved = await resolveTokenAttendee(token, privateKey);
    if (!resolved) {
      return jsonResponse({ status: "not_found" });
    }

    const { attendee, eventName } = resolved;

    // Wrong event - let client prompt for confirmation
    if (attendee.event_id !== eventId && !force) {
      return jsonResponse({
        status: "wrong_event",
        name: attendee.name,
        eventName,
        attendeeEventId: attendee.event_id,
      });
    }

    // Already checked in
    if (attendee.checked_in === "true") {
      return jsonResponse({
        status: "already_checked_in",
        name: attendee.name,
        eventName,
      });
    }

    // Check them in
    await updateCheckedIn(attendee.id, true);
    await logActivity(`Attendee checked in via scanner`, attendee.event_id);

    return jsonResponse({
      status: "checked_in",
      name: attendee.name,
      eventName,
    });
  });

/** Parse event ID from route params */
const parseEventId = (params: { id?: string }): number =>
  Number.parseInt(params.id!, 10);

/** Scanner routes */
export const scannerRoutes = defineRoutes({
  "GET /admin/event/:id/scanner": (request, params) =>
    handleScannerGet(request, parseEventId(params)),
  "POST /admin/event/:id/scan": (request, params) =>
    handleScanPost(request, parseEventId(params)),
});

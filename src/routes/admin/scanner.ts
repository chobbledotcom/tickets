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

/** Look up attendee by token and decrypt */
const resolveTokenAttendee = async (
  token: string,
  privateKey: CryptoKey,
): Promise<Attendee | null> => {
  const attendees = await getAttendeesByTokens([token]);
  const raw = attendees[0];
  if (!raw) return null;

  // decryptAttendees maps 1:1 over input, so index 0 is always present
  return (await decryptAttendees([raw], privateKey))[0]!;
};

/** Get event name by ID (for cross-event responses) */
const getEventName = async (eventId: number): Promise<string> => {
  const event = await getEventWithCount(eventId);
  return event?.name ?? "Unknown event";
};

/**
 * Handle POST /admin/event/:id/scan - JSON check-in API.
 * Scanner is intentionally one-way (check-in only, no check-out) to prevent
 * accidental check-outs from double-scans during rapid door check-in.
 */
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

    const attendee = await resolveTokenAttendee(token, privateKey);
    if (!attendee) {
      return jsonResponse({ status: "not_found" }, 404);
    }

    // Wrong event - let client prompt for confirmation
    if (attendee.event_id !== eventId && !force) {
      const eventName = await getEventName(attendee.event_id);
      return jsonResponse({
        status: "wrong_event",
        name: attendee.name,
        eventName,
      });
    }

    // Already checked in
    if (attendee.checked_in === "true") {
      return jsonResponse({
        status: "already_checked_in",
        name: attendee.name,
        quantity: attendee.quantity,
      });
    }

    // Check them in
    await updateCheckedIn(attendee.id, true);
    await logActivity(`Attendee checked in via scanner`, attendee.event_id);

    return jsonResponse({
      status: "checked_in",
      name: attendee.name,
      quantity: attendee.quantity,
    });
  });

/** Pattern matching scan API paths (used by middleware for content-type validation) */
export const SCAN_API_PATTERN = /^\/admin\/event\/\d+\/scan$/;

/** Scanner routes */
export const scannerRoutes = defineRoutes({
  "GET /admin/event/:id/scanner": (request, { id }) =>
    handleScannerGet(request, id),
  "POST /admin/event/:id/scan": (request, { id }) =>
    handleScanPost(request, id),
});

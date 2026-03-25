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
  type AuthSession,
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
  return (await decryptAttendees([raw], privateKey))[0] as Attendee;
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
/** Resolve attendee from token, returning JSON error response if unavailable */
const resolveScannedAttendee = async (
  token: string,
  session: AuthSession,
): Promise<Attendee | Response> => {
  const privateKey = await getPrivateKey(session);
  if (!privateKey) {
    logError({
      code: ErrorCode.KEY_DERIVATION,
      detail: "Scanner: private key unavailable",
    });
    return jsonResponse(
      { status: "error", message: "Decryption unavailable" },
      500,
    );
  }
  const attendee = await resolveTokenAttendee(token, privateKey);
  if (!attendee) return jsonResponse({ status: "not_found" }, 404);
  return attendee;
};

/** Check pre-checkin conditions (refunded, wrong event, already checked in) */
const checkScanPreConditions = async (
  attendee: Attendee,
  eventId: number,
  force: boolean,
): Promise<Response | null> => {
  if (attendee.refunded) {
    return jsonResponse({ status: "refunded", name: attendee.name });
  }
  if (attendee.event_id !== eventId && !force) {
    const eventName = await getEventName(attendee.event_id);
    return jsonResponse({
      status: "wrong_event",
      name: attendee.name,
      eventName,
    });
  }
  if (attendee.checked_in) {
    return jsonResponse({
      status: "already_checked_in",
      name: attendee.name,
      quantity: attendee.quantity,
    });
  }
  return null;
};

/** Process a scan: resolve attendee, check pre-conditions, verify ID, check in */
const processScan = async (
  session: AuthSession,
  body: Record<string, unknown>,
  id: number,
): Promise<Response> => {
  if (typeof body.token !== "string") {
    return jsonResponse({ status: "error", message: "Missing token" }, 400);
  }

  const token = body.token;
  const force = body.force === true;
  const idVerified = body.id_verified === true;

  const resolved = await resolveScannedAttendee(token, session);
  if (resolved instanceof Response) return resolved;
  const attendee = resolved;

  const preCondition = await checkScanPreConditions(attendee, id, force);
  if (preCondition) return preCondition;

  // Non-transferable event - require ID verification before check-in
  const event = await getEventWithCount(force ? attendee.event_id : id);
  if (event?.non_transferable && !idVerified) {
    return jsonResponse({
      status: "verify_id",
      name: attendee.name,
      quantity: attendee.quantity,
    });
  }

  await updateCheckedIn(attendee.id, true);
  const eventName = event?.name ?? (await getEventName(attendee.event_id));
  await logActivity(
    `Attendee checked in via scanner for '${eventName}'`,
    attendee.event_id,
  );

  return jsonResponse({
    status: "checked_in",
    name: attendee.name,
    quantity: attendee.quantity,
  });
};

const handleScanPost = (
  request: Request,
  { id }: { id: number },
): Promise<Response> =>
  withAuthJson(request, (session, body) => processScan(session, body, id));

/** Pattern matching scan API paths (used by middleware for content-type validation) */
export const SCAN_API_PATTERN = /^\/admin\/event\/\d+\/scan$/;

/** Scanner routes */
export const scannerRoutes = defineRoutes({
  "GET /admin/event/:id/scanner": handleScannerGet,
  "POST /admin/event/:id/scan": handleScanPost,
});

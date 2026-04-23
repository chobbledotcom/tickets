/**
 * QR scanner routes for admin check-in
 * GET /admin/event/:id/scanner - Scanner page with camera UI
 * POST /admin/event/:id/scan - JSON API for processing scanned tokens
 */

import { filter, map, pipe } from "#fp";
import { logActivity } from "#lib/db/activityLog.ts";
import {
  type AttendeeWithBookings,
  decryptAttendees,
  getAttendeesByTokens,
  getAttendeesRaw,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { getEventWithCount } from "#lib/db/events.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import type { Attendee } from "#lib/types.ts";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import { withEntityLoader } from "#routes/admin/entity-handlers.ts";
import {
  AUTH_JSON,
  getPrivateKey,
  requireSessionOr,
  withAuth,
} from "#routes/auth.ts";
import type { IdRouteHandler } from "#routes/entity.ts";
import { htmlResponse, jsonResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  decryptTokenEntries,
  resolveEntries,
  type TokenEntry,
} from "#routes/token-utils.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";

const withEvent = withEntityLoader(getEventWithCount);

/** Handle GET /admin/event/:id/scanner - render scanner page */
const handleScannerGet: IdRouteHandler = (request, { id }) =>
  requireSessionOr(request, (session) =>
    withEvent(id)(async (event) => {
      const privateKey = await requirePrivateKey(session);
      const rawAttendees = await getAttendeesRaw(event.id);
      const attendees = await decryptAttendees(rawAttendees, privateKey);
      const uncheckedIn = pipe(
        filter((a: Attendee) => !a.checked_in && !a.refunded),
        map((a: Attendee) => ({
          name: a.name,
          quantity: a.quantity,
          token: a.ticket_token,
        })),
      )(attendees);
      return htmlResponse(adminScannerPage(event, session, uncheckedIn));
    }),
  );

/** Resolve an AttendeeWithBookings to decrypted entries */
const resolveTokenEntries = async (
  awb: AttendeeWithBookings,
  privateKey: CryptoKey,
): Promise<TokenEntry[]> => {
  const entries = await resolveEntries([awb]);
  return entries.length === 0 ? [] : decryptTokenEntries(entries, privateKey);
};

/** Get the attendee name from decrypted entries, falling back to raw decrypt */
const resolveAttendeeName = async (
  allEntries: TokenEntry[],
  awb: AttendeeWithBookings,
  privateKey: CryptoKey,
): Promise<string> => {
  const fromEntry = allEntries[0]?.attendee.name;
  if (fromEntry) return fromEntry;
  const decrypted = await decryptAttendees(
    [{ pii_blob: awb.pii_blob } as Attendee],
    privateKey,
  );
  return decrypted[0]!.name;
};

/** Build a wrong_event response when scanned token doesn't match the event */
const wrongEventResponse = (
  allEntries: TokenEntry[],
  attendeeName: string,
): Response => {
  const eventNames =
    allEntries.length > 0
      ? allEntries.map((e) => e.event.name).join(", ")
      : "Unknown event";
  return jsonResponse({
    eventName: eventNames,
    name: attendeeName,
    status: "wrong_event",
  });
};

/** Check attendee state (refunded/checked_in/verify_id); return response or null */
const checkAttendeeState = (
  entry: TokenEntry,
  attendeeName: string,
  idVerified: boolean,
): Response | null => {
  if (entry.attendee.refunded) {
    return jsonResponse({ name: attendeeName, status: "refunded" });
  }
  if (entry.attendee.checked_in) {
    return jsonResponse({
      name: attendeeName,
      quantity: entry.attendee.quantity,
      status: "already_checked_in",
    });
  }
  if (entry.event.non_transferable && !idVerified) {
    return jsonResponse({
      name: attendeeName,
      quantity: entry.attendee.quantity,
      status: "verify_id",
    });
  }
  return null;
};

/** Perform the actual check-in (database update + activity log) */
const performCheckIn = async (
  entry: TokenEntry,
  attendeeName: string,
): Promise<Response> => {
  await updateCheckedIn(entry.attendee.id, entry.event.id, true);
  await logActivity(
    `Attendee checked in via scanner for '${entry.event.name}'`,
    entry.event.id,
  );
  return jsonResponse({
    name: attendeeName,
    quantity: entry.attendee.quantity,
    status: "checked_in",
  });
};

/**
 * Handle POST /admin/event/:id/scan - JSON check-in API.
 * Scanner is intentionally one-way (check-in only, no check-out) to prevent
 * accidental check-outs from double-scans during rapid door check-in.
 */
const handleScanPost: IdRouteHandler = (request, { id }) =>
  withAuth(request, AUTH_JSON, async (session, body) => {
    if (typeof body.token !== "string") {
      return jsonResponse({ message: "Missing token", status: "error" }, 400);
    }

    const token = body.token;
    const force = body.force === true;
    const idVerified = body.id_verified === true;

    const privateKey = await getPrivateKey(session);
    if (!privateKey) {
      logError({
        code: ErrorCode.KEY_DERIVATION,
        detail: "Scanner: private key unavailable",
      });
      return jsonResponse(
        { message: "Decryption unavailable", status: "error" },
        500,
      );
    }

    const results = await getAttendeesByTokens([token]);
    const awb = results[0];
    if (!awb) {
      return jsonResponse({ status: "not_found" }, 404);
    }

    const allEntries = await resolveTokenEntries(awb, privateKey);
    const matchingEntry = allEntries.find((e) => e.event.id === id);
    const attendeeName = await resolveAttendeeName(allEntries, awb, privateKey);

    // Wrong event — attendee not registered for the scanned event
    if (!matchingEntry && !force) {
      return wrongEventResponse(allEntries, attendeeName);
    }

    // When force=true, use the first entry if no match (cross-event check-in)
    const entry = matchingEntry ?? allEntries[0];
    if (!entry) {
      return jsonResponse({ status: "not_found" }, 404);
    }

    const stateResponse = checkAttendeeState(entry, attendeeName, idVerified);
    if (stateResponse) return stateResponse;

    return performCheckIn(entry, attendeeName);
  });

/** Pattern matching scan API paths (used by middleware for content-type validation) */
export const SCAN_API_PATTERN = /^\/admin\/event\/\d+\/scan$/;

/** Scanner routes */
export const scannerRoutes = defineRoutes({
  "GET /admin/event/:id/scanner": handleScannerGet,
  "POST /admin/event/:id/scan": handleScanPost,
});

/**
 * QR scanner routes for admin check-in
 * GET /admin/event/:id/scanner - Scanner page with camera UI
 * POST /admin/event/:id/scan - JSON API for processing scanned tokens
 */

import { logActivity } from "#lib/db/activityLog.ts";
import {
  type AttendeeWithBookings,
  decryptAttendees,
  getAttendeesByTokens,
  updateCheckedIn,
} from "#lib/db/attendees.ts";
import { ErrorCode, logError } from "#lib/logger.ts";
import type { Attendee } from "#lib/types.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  decryptTokenEntries,
  resolveEntries,
  type TokenEntry,
} from "#routes/token-utils.ts";
import {
  AUTH_JSON,
  getPrivateKey,
  jsonResponse,
  withAuth,
  withEventPage,
} from "#routes/utils.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";

/** Handle GET /admin/event/:id/scanner - render scanner page */
const handleScannerGet = withEventPage(adminScannerPage);

/** Resolve an AttendeeWithBookings to decrypted entries */
const resolveTokenEntries = async (
  awb: AttendeeWithBookings,
  privateKey: CryptoKey,
): Promise<TokenEntry[]> => {
  const entries = await resolveEntries([awb]);
  return entries.length === 0 ? [] : decryptTokenEntries(entries, privateKey);
};

/**
 * Handle POST /admin/event/:id/scan - JSON check-in API.
 * Scanner is intentionally one-way (check-in only, no check-out) to prevent
 * accidental check-outs from double-scans during rapid door check-in.
 */
const handleScanPost = (
  request: Request,
  { id }: { id: number },
): Promise<Response> =>
  withAuth(request, AUTH_JSON, async (session, body) => {
    if (typeof body.token !== "string") {
      return jsonResponse({ status: "error", message: "Missing token" }, 400);
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
        { status: "error", message: "Decryption unavailable" },
        500,
      );
    }

    const results = await getAttendeesByTokens([token]);
    const awb = results[0];
    if (!awb) {
      return jsonResponse({ status: "not_found" }, 404);
    }

    const allEntries = await resolveTokenEntries(awb, privateKey);

    // Find the entry matching the scanned event
    const matchingEntry = allEntries.find((e) => e.event.id === id);

    // Decrypt name from first available entry, or from raw attendee if all events deleted
    // Get name from resolved entries, or decrypt directly if all events were deleted
    const attendeeName =
      allEntries[0]?.attendee.name ??
      (
        await decryptAttendees(
          [{ pii_blob: awb.pii_blob } as Attendee],
          privateKey,
        )
      )[0]!.name;

    // Wrong event — attendee not registered for the scanned event
    if (!matchingEntry && !force) {
      const eventNames =
        allEntries.length > 0
          ? allEntries.map((e) => e.event.name).join(", ")
          : "Unknown event";
      return jsonResponse({
        status: "wrong_event",
        name: attendeeName,
        eventName: eventNames,
      });
    }

    // When force=true, use the first entry if no match (cross-event check-in)
    const entry = matchingEntry ?? allEntries[0];
    if (!entry) {
      return jsonResponse({ status: "not_found" }, 404);
    }

    // Refunded - cannot check in
    if (entry.attendee.refunded) {
      return jsonResponse({
        status: "refunded",
        name: attendeeName,
      });
    }

    // Already checked in
    if (entry.attendee.checked_in) {
      return jsonResponse({
        status: "already_checked_in",
        name: attendeeName,
        quantity: entry.attendee.quantity,
      });
    }

    // Non-transferable event - require ID verification before check-in
    if (entry.event.non_transferable && !idVerified) {
      return jsonResponse({
        status: "verify_id",
        name: attendeeName,
        quantity: entry.attendee.quantity,
      });
    }

    // Check them in for the specific event
    await updateCheckedIn(entry.attendee.id, entry.event.id, true);
    await logActivity(
      `Attendee checked in via scanner for '${entry.event.name}'`,
      entry.event.id,
    );

    return jsonResponse({
      status: "checked_in",
      name: attendeeName,
      quantity: entry.attendee.quantity,
    });
  });

/** Pattern matching scan API paths (used by middleware for content-type validation) */
export const SCAN_API_PATTERN = /^\/admin\/event\/\d+\/scan$/;

/** Scanner routes */
export const scannerRoutes = defineRoutes({
  "GET /admin/event/:id/scanner": handleScannerGet,
  "POST /admin/event/:id/scan": handleScanPost,
});

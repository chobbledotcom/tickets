/**
 * QR scanner routes for admin check-in
 * GET /admin/listing/:id/scanner - Scanner page with camera UI
 * POST /admin/listing/:id/scan - JSON API for processing scanned tokens
 */

import { filter, map, pipe } from "#fp";
import { requirePrivateKey } from "#routes/admin/actions.ts";
import { withEntityLoader } from "#routes/admin/entity-handlers.ts";
import {
  getPrivateKey,
  requireSessionOr,
  SCANNER_JSON,
  withAuth,
} from "#routes/auth.ts";
import type { IdRouteHandler } from "#routes/entity.ts";
import { htmlResponse, jsonResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  decryptTokenEntries,
  resolveEntries,
  type TokenEntry,
} from "#routes/tickets/token-utils.ts";
import { logActivity } from "#shared/db/activityLog.ts";
import {
  type AttendeeWithBookings,
  decryptAttendees,
  getAttendeesByTokens,
  getAttendeesRaw,
  updateCheckedIn,
} from "#shared/db/attendees.ts";
import { getListingWithCount } from "#shared/db/listings.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { Attendee } from "#shared/types.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";

const withListing = withEntityLoader(getListingWithCount);

/** Handle GET /admin/listing/:id/scanner - render scanner page */
const handleScannerGet: IdRouteHandler = (request, { id }) =>
  requireSessionOr(request, (session) =>
    withListing(id)(async (listing) => {
      const privateKey = await requirePrivateKey(session);
      const rawAttendees = await getAttendeesRaw(listing.id);
      const attendees = await decryptAttendees(rawAttendees, privateKey);
      const uncheckedIn = pipe(
        // quantity > 0: a no-quantity sentinel line isn't a real ticket, so it
        // must not appear as a manual check-in candidate (updateCheckedIn would
        // refuse it anyway).
        filter((a: Attendee) => !a.checked_in && !a.refunded && a.quantity > 0),
        map((a: Attendee) => ({
          name: a.name,
          quantity: a.quantity,
          token: a.ticket_token,
        })),
      )(attendees);
      return htmlResponse(adminScannerPage(listing, session, uncheckedIn));
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

/** Build a wrong_listing response when scanned token doesn't match the listing */
const wrongListingResponse = (
  allEntries: TokenEntry[],
  attendeeName: string,
): Response => {
  const listingNames =
    allEntries.length > 0
      ? allEntries.map((e) => e.listing.name).join(", ")
      : "Unknown listing";
  return jsonResponse({
    listingName: listingNames,
    name: attendeeName,
    status: "wrong_listing",
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
  if (entry.listing.non_transferable && !idVerified) {
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
  await updateCheckedIn(entry.attendee.id, entry.listing.id, true);
  await logActivity(
    `Attendee checked in via scanner for '${entry.listing.name}'`,
    entry.listing.id,
    entry.attendee.id,
  );
  return jsonResponse({
    name: attendeeName,
    quantity: entry.attendee.quantity,
    status: "checked_in",
  });
};

/**
 * Handle POST /admin/listing/:id/scan - JSON check-in API.
 * Scanner is intentionally one-way (check-in only, no check-out) to prevent
 * accidental check-outs from double-scans during rapid door check-in.
 */
const handleScanPost: IdRouteHandler = (request, { id }) =>
  withAuth(request, SCANNER_JSON, async (session, body) => {
    if (typeof body.token !== "string") {
      return jsonResponse({ error: "Missing token" }, 400);
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
      return jsonResponse({ error: "Decryption unavailable" }, 500);
    }

    const results = await getAttendeesByTokens([token]);
    const awb = results[0];
    if (!awb) {
      return jsonResponse({ status: "not_found" }, 404);
    }

    const allEntries = await resolveTokenEntries(awb, privateKey);
    const matchingEntry = allEntries.find((e) => e.listing.id === id);
    const attendeeName = await resolveAttendeeName(allEntries, awb, privateKey);

    // Wrong listing — attendee not registered for the scanned listing
    if (!matchingEntry && !force) {
      return wrongListingResponse(allEntries, attendeeName);
    }

    // When force=true, use the first entry if no match (cross-listing check-in)
    const entry = matchingEntry ?? allEntries[0];
    if (!entry) {
      return jsonResponse({ status: "not_found" }, 404);
    }

    const stateResponse = checkAttendeeState(entry, attendeeName, idVerified);
    if (stateResponse) return stateResponse;

    return performCheckIn(entry, attendeeName);
  });

/** Pattern matching scan API paths (used by middleware for content-type validation) */
export const SCAN_API_PATTERN = /^\/admin\/listing\/\d+\/scan$/;

/** Scanner routes */
export const scannerRoutes = defineRoutes({
  "GET /admin/listing/:id/scanner": handleScannerGet,
  "POST /admin/listing/:id/scan": handleScanPost,
});

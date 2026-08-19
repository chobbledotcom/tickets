import { apiErrorResponse } from "#routes/api/cors.ts";
import { defineRoutes } from "#routes/router.ts";

/**
 * QR scanner routes for admin check-in
 * GET /admin/listing/:id/scanner - Scanner page with camera UI
 * POST /admin/listing/:id/scan - JSON API for processing scanned tokens
 */

import { logActivity } from "#db/activity-log.ts";
import type { AttendeeWithBookings } from "#db/attendee-types.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { getAttendeesByTokens } from "#db/attendees/tokens.ts";
import { updateCheckedIn } from "#db/attendees/update.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { filter, map, pipe } from "#fp";
import { requireSessionOr, SCANNER_JSON, withAuth } from "#routes/auth.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import { htmlResponse, jsonResponse } from "#routes/response.ts";
import {
  decryptTokenEntries,
  resolveEntries,
  type TokenEntry,
} from "#routes/tickets/token-utils.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  getRequestPrivateKey,
  requireRequestPrivateKey,
} from "#shared/session-private-key.ts";
import { adminScannerPage } from "#templates/admin/scanner.tsx";
import { type Attendee, hasTicketQuantity } from "#types";

/** Handle GET /admin/listing/:id/scanner - render scanner page */
const handleScannerGet: IdRouteHandler = createIdEntityHandler<
  NonNullable<Awaited<ReturnType<typeof getListingWithCount>>>
>(getListingWithCount)(requireSessionOr)(async (listing, session) => {
  const privateKey = await requireRequestPrivateKey();
  const rawAttendees = await getAttendeesRaw(listing.id);
  const attendees = await decryptAttendees(rawAttendees, privateKey);
  const uncheckedIn = pipe(
    // A no-quantity sentinel isn't a manual check-in candidate
    // (updateCheckedIn would refuse it anyway).
    filter(
      (a: Attendee) => !a.checked_in && !a.refunded && hasTicketQuantity(a),
    ),
    map((a) => ({
      name: a.name,
      quantity: a.quantity,
      token: a.ticket_token,
    })),
  )(attendees);
  return htmlResponse(adminScannerPage(listing, session, uncheckedIn));
});

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

/** The JSON scan result for one attendee: who they are, how many tickets they
 * hold, and what the scan found or did. */
const scanResult = (
  entry: TokenEntry,
  attendeeName: string,
  status: "already_checked_in" | "verify_id" | "checked_in",
): Response =>
  jsonResponse({
    name: attendeeName,
    quantity: entry.attendee.quantity,
    status,
  });

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
    return scanResult(entry, attendeeName, "already_checked_in");
  }
  if (entry.listing.non_transferable && !idVerified) {
    return scanResult(entry, attendeeName, "verify_id");
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
  return scanResult(entry, attendeeName, "checked_in");
};

/** Resolve a token to the requested listing and perform its scan decision. */
const scanToken = async (
  listingId: number,
  token: string,
  force: boolean,
  idVerified: boolean,
  privateKey: CryptoKey,
): Promise<Response> => {
  const results = await getAttendeesByTokens([token]);
  const awb = results[0];
  if (!awb) return jsonResponse({ status: "not_found" }, 404);

  const allEntries = await resolveTokenEntries(awb, privateKey);
  const matchingEntry = allEntries.find(
    (entry) => entry.listing.id === listingId,
  );
  const attendeeName = await resolveAttendeeName(allEntries, awb, privateKey);

  // Wrong listing — attendee not registered for the scanned listing.
  if (!matchingEntry && !force) {
    return wrongListingResponse(allEntries, attendeeName);
  }

  // A forced cross-listing check-in uses the attendee's first live entry.
  const entry = matchingEntry ?? allEntries[0];
  if (!entry) return jsonResponse({ status: "not_found" }, 404);

  const stateResponse = checkAttendeeState(entry, attendeeName, idVerified);
  return stateResponse ?? performCheckIn(entry, attendeeName);
};

/** Validate scan controls and load the request's decryption key. */
const processScan = async (
  listingId: number,
  body: Record<string, unknown>,
): Promise<Response> => {
  if (typeof body.token !== "string") {
    return apiErrorResponse("Missing token");
  }
  const privateKey = await getRequestPrivateKey();
  if (!privateKey) {
    logError({
      code: ErrorCode.KEY_DERIVATION,
      detail: "Scanner: private key unavailable",
    });
    return apiErrorResponse("Decryption unavailable", 500);
  }
  return scanToken(
    listingId,
    body.token,
    body.force === true,
    body.id_verified === true,
    privateKey,
  );
};

/**
 * Handle POST /admin/listing/:id/scan - JSON check-in API.
 * Scanner is intentionally one-way (check-in only, no check-out) to prevent
 * accidental check-outs from double-scans during rapid door check-in.
 */
const handleScanPost: IdRouteHandler = (request, { id }) =>
  withAuth(request, SCANNER_JSON, (_session, body) => processScan(id, body));

/** Scanner routes */
export const adminHandlers = defineRoutes({
  "GET /admin/listing/:id/scanner": handleScannerGet,
  "POST /admin/listing/:id/scan": handleScanPost,
});

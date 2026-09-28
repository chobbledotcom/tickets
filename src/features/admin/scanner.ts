/**
 * QR scanner routes for admin check-in
 * GET /admin/listing/:id/scanner - Scanner page with camera UI
 * POST /admin/listing/:id/scan - JSON API for processing scanned tokens
 * GET /admin/groups/:id/scanner - One scanner for every member of a group
 * POST /admin/groups/:id/scan - The same JSON API over the group's members
 */

import { remainingTickets } from "#booking/remaining-tickets.ts";
import { logActivities } from "#db/activity-log.ts";
import type { AttendeeWithBookings } from "#db/attendee-types.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { getAttendeesByTokens } from "#db/attendees/tokens.ts";
import { moveTickets } from "#db/attendees/update.ts";
import { withTransaction } from "#db/client.ts";
import { getGroupById, getListingsByGroupId } from "#db/groups.ts";
import { getAttendeesByListingIds } from "#db/listings/attendees.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { filter, reduce, sumOf, unique } from "#fp";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { requireSessionOr, SCANNER_JSON, withAuth } from "#routes/auth.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import { htmlResponse, jsonResponse } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
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
import { isPositiveSafeInteger } from "#shared/validation/number.ts";
import {
  adminScannerPage,
  type TicketOption,
} from "#templates/admin/scanner.tsx";
import { type Attendee, type Group, hasTicketQuantity } from "#types";
import { decideScan, type ScanUnit } from "./scan-decision.ts";

/** What one door's scan resolves against: the listings it admits, and its
 * group's stored choice between one listing per scan and all of them. */
type ScanScope = {
  checkInEveryListing: boolean;
  listingIds: ReadonlySet<number>;
};

/** The scope a single listing's door admits. */
const listingScope = (listingId: number): ScanScope => ({
  checkInEveryListing: false,
  listingIds: new Set([listingId]),
});

/** Load the scope one group's door admits: every member listing, minus the
 * members marked "No check-in" — they sell something that has no door.
 * Hidden and inactive members stay: hidden is a buyer-visibility fact, and a
 * hidden member carries genuine guest-list tickets. */
const groupScope = async (group: Group): Promise<ScanScope> => ({
  checkInEveryListing: group.scan_checks_in_all_listings,
  listingIds: new Set(
    (await getListingsByGroupId(group.id))
      .filter((listing) => !listing.purchase_only)
      .map((listing) => listing.id),
  ),
});

/** The manual check-in list: one option per person, with every place they
 * still owe on this door's listings summed into one quantity. A pick from
 * this list goes through the same scan as a camera read, so it can never
 * admit something the camera would not. */
const manualCheckinOptions = (attendees: Attendee[]): TicketOption[] => [
  ...reduce((byToken: Map<string, TicketOption>, attendee: Attendee) => {
    const known = byToken.get(attendee.ticket_token);
    const places = remainingTickets(attendee);
    if (known) known.quantity += places;
    else {
      byToken.set(attendee.ticket_token, {
        name: attendee.name,
        quantity: places,
        token: attendee.ticket_token,
      });
    }
    return byToken;
  }, new Map<string, TicketOption>())(
    filter(
      (a: Attendee) =>
        remainingTickets(a) > 0 && !a.refunded && hasTicketQuantity(a),
    )(attendees),
  ).values(),
];

/** Handle GET /admin/listing/:id/scanner - render scanner page */
const handleScannerGet: IdRouteHandler = createIdEntityHandler<
  NonNullable<Awaited<ReturnType<typeof getListingWithCount>>>
>(getListingWithCount)(requireSessionOr)(async (listing, session) => {
  const privateKey = await requireRequestPrivateKey();
  const attendees = await decryptAttendees(
    await getAttendeesRaw(listing.id),
    privateKey,
  );
  return htmlResponse(
    adminScannerPage(
      listing,
      `/admin/listing/${listing.id}/scan`,
      session,
      manualCheckinOptions(attendees),
    ),
  );
});

/** Handle GET /admin/groups/:id/scanner - render the group scanner page */
const handleGroupScannerGet: IdRouteHandler = createIdEntityHandler<Group>(
  getGroupById,
)(requireSessionOr)(async (group, session) => {
  const privateKey = await requireRequestPrivateKey();
  const scope = await groupScope(group);
  const attendees = await decryptAttendees(
    await getAttendeesByListingIds([...scope.listingIds]),
    privateKey,
  );
  return htmlResponse(
    adminScannerPage(
      group,
      `/admin/groups/${group.id}/scan`,
      session,
      manualCheckinOptions(attendees),
      // One scan at this door spans listings only from a multi-listing
      // group whose stored rule says to check in every listing.
      scope.listingIds.size > 1 && scope.checkInEveryListing,
    ),
  );
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
  // One token belongs to one attendee, so every entry names the same person;
  // the first entry answers, and an empty entry list falls back to the blob.
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

/** The door's own listing names behind an answer, first occurrence first. */
const listingNamesOf = (rows: readonly TokenEntry[]): string =>
  unique(rows.map((row) => row.listing.name)).join(", ");

/** The tickets the covered lines hold in total. */
const lineTickets = sumOf((row: TokenEntry) => row.attendee.quantity);

/** The JSON answer for one ticket: who they are, the tickets this answer
 * covers, the tickets the covered lines hold in total, and the listing
 * names that drove it. */
const scanBody = (
  rows: readonly TokenEntry[],
  attendeeName: string,
  status: "already_checked_in" | "checked_in" | "verify_id",
  tickets: number,
): Record<string, unknown> => ({
  listingName: listingNamesOf(rows),
  name: attendeeName,
  quantity: tickets,
  status,
  total: lineTickets([...rows]),
});

/** The answer for a ticket whose lines owe nothing more. */
const alreadyCheckedIn = (
  rows: readonly TokenEntry[],
  attendeeName: string,
): Response =>
  jsonResponse(
    scanBody(rows, attendeeName, "already_checked_in", lineTickets([...rows])),
  );

/** Perform one scan's whole admission as one transaction: every unit's
 * admit, and one activity row per listing that really admitted tickets,
 * carrying that listing's own name and count. A failure in either write
 * rolls both back, so a check-in never lands without its activity record.
 * Answers the tickets the lines really took, which is less than planned
 * when another door admitted some of them first. */
const performCheckIns = (
  attendeeId: number,
  units: readonly ScanUnit[],
): Promise<number> =>
  withTransaction(async (tx) => {
    const listingOf = (unit: ScanUnit) => unit.rows[0]!.listing;
    const moved = await moveTickets(
      "admit",
      units.map((unit) => ({
        attendeeId,
        count: unit.tickets,
        listingId: listingOf(unit).id,
      })),
      tx,
    );
    const admitted = units
      .map((unit, index) => ({
        listing: listingOf(unit),
        tickets: moved[index]!.count,
      }))
      .filter(({ tickets }) => tickets > 0);
    await logActivities(
      admitted.map(({ listing, tickets }) => ({
        attendeeId,
        listing: listing.id,
        message: `Attendee checked in ${tickets} ticket${
          tickets === 1 ? "" : "s"
        } via scanner for '${listing.name}'`,
      })),
      tx,
    );
    return sumOf(({ tickets }: { tickets: number }) => tickets)(admitted);
  });

/** Resolve a token against one door's scope and perform its scan decision. */
const scanToken = async (
  scope: ScanScope,
  token: string,
  force: boolean,
  idVerified: boolean,
  privateKey: CryptoKey,
  count?: number,
): Promise<Response> => {
  const results = await getAttendeesByTokens([token]);
  const awb = results[0];
  if (!awb) return jsonResponse({ status: "not_found" }, 404);

  const allEntries = await resolveTokenEntries(awb, privateKey);
  const attendeeName = await resolveAttendeeName(allEntries, awb, privateKey);
  const decision = decideScan(
    { entries: allEntries, force, scope: scope.listingIds },
    scope.checkInEveryListing,
    idVerified,
    count,
  );

  switch (decision.kind) {
    case "not_found":
      return jsonResponse({ status: "not_found" }, 404);
    case "wrong_listing":
      return wrongListingResponse(allEntries, attendeeName);
    case "refunded":
      return jsonResponse({ name: attendeeName, status: "refunded" });
    case "already_checked_in":
      return alreadyCheckedIn(decision.live, attendeeName);
    case "verify_id":
      return jsonResponse(
        scanBody(
          decision.rows,
          attendeeName,
          "verify_id",
          lineTickets([...decision.rows]),
        ),
      );
    case "select_quantity":
      return jsonResponse({
        listingName: listingNamesOf(decision.rows),
        max: decision.max,
        name: attendeeName,
        status: "select_quantity",
      });
    case "admit": {
      const admitted = await performCheckIns(
        decision.rows[0]!.attendee.id,
        decision.units,
      );
      // Another door took every ticket this scan planned to admit.
      if (admitted === 0) return alreadyCheckedIn(decision.rows, attendeeName);
      return jsonResponse({
        ...scanBody(decision.rows, attendeeName, "checked_in", admitted),
        remaining: decision.remaining,
      });
    }
  }
};

/** A door's quantity pick: a whole number of tickets, at least one. Anything
 * else fails closed — the cap at what the lines owe is moveTickets' guard,
 * not a reason to silently fix a bad input here. */
const isAdmitCount = (value: unknown): value is number =>
  typeof value === "number" && isPositiveSafeInteger(value);

/** Validate scan controls and load the request's decryption key. */
const processScan = async (
  scope: ScanScope,
  body: Record<string, unknown>,
): Promise<Response> => {
  if (typeof body.token !== "string") {
    return apiErrorResponse("Missing token");
  }
  if (body.quantity !== undefined && !isAdmitCount(body.quantity)) {
    return apiErrorResponse("Invalid quantity");
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
    scope,
    body.token,
    body.force === true,
    body.id_verified === true,
    privateKey,
    isAdmitCount(body.quantity) ? body.quantity : undefined,
  );
};

/**
 * Handle POST /admin/listing/:id/scan - JSON check-in API.
 * Scanner is intentionally one-way (check-in only, no check-out) to prevent
 * accidental check-outs from double-scans during rapid door check-in.
 */
const handleScanPost: IdRouteHandler = (request, { id }) =>
  withAuth(request, SCANNER_JSON, (_session, body) =>
    processScan(listingScope(id), body),
  );

/** Handle POST /admin/groups/:id/scan — the same API over the group's whole
 * scope. A missing group answers 404 rather than an empty scope, so a broken
 * link cannot pass every ticket off as "wrong listing". */
const handleGroupScanPost: IdRouteHandler = (request, { id }) =>
  withAuth(request, SCANNER_JSON, async (_session, body) => {
    const group = await getGroupById(id);
    if (!group) return jsonResponse({ status: "not_found" }, 404);
    return processScan(await groupScope(group), body);
  });

/** Scanner routes */
export const adminHandlers = defineRoutes({
  "GET /admin/groups/:id/scanner": handleGroupScannerGet,
  "GET /admin/listing/:id/scanner": handleScannerGet,
  "POST /admin/groups/:id/scan": handleGroupScanPost,
  "POST /admin/listing/:id/scan": handleScanPost,
});

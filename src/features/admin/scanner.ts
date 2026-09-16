/**
 * QR scanner routes for admin check-in
 * GET /admin/listing/:id/scanner - Scanner page with camera UI
 * POST /admin/listing/:id/scan - JSON API for processing scanned tokens
 * GET /admin/groups/:id/scanner - One scanner for every member of a group
 * POST /admin/groups/:id/scan - The same JSON API over the group's members
 * POST /admin/groups/:id/scanner - Save the group's "check in every listing" box
 */

import { logActivities } from "#db/activity-log.ts";
import type { AttendeeWithBookings } from "#db/attendee-types.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import { getAttendeesByTokens } from "#db/attendees/tokens.ts";
import { updateCheckedInOnListings } from "#db/attendees/update.ts";
import { getGroupById, getListingsByGroupId, groups } from "#db/groups.ts";
import { getAttendeesByListingIds } from "#db/listings/attendees.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { filter, reduce, sumOf, unique } from "#fp";
import { t } from "#i18n";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { requireSessionOr, SCANNER_JSON, withAuth } from "#routes/auth.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import { htmlResponse, jsonResponse, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  decryptTokenEntries,
  resolveEntries,
  type TokenEntry,
} from "#routes/tickets/token-utils.ts";
import { createAuthedHandler } from "#shared/app-forms.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import {
  getRequestPrivateKey,
  requireRequestPrivateKey,
} from "#shared/session-private-key.ts";
import {
  adminScannerPage,
  type TicketOption,
} from "#templates/admin/scanner.tsx";
import { type Attendee, type Group, hasTicketQuantity } from "#types";
import { decideScan, rowsByListing } from "./scan-decision.ts";

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

/** The manual check-in list: one option per person, with every one of their
 * unchecked live places on this door's listings summed into one quantity.
 * A pick from this list goes through the same scan as a camera read, so it
 * can never admit something the camera would not. */
const manualCheckinOptions = (attendees: Attendee[]): TicketOption[] => [
  ...reduce((byToken: Map<string, TicketOption>, attendee: Attendee) => {
    const known = byToken.get(attendee.ticket_token);
    if (known) known.quantity += attendee.quantity;
    else {
      byToken.set(attendee.ticket_token, {
        name: attendee.name,
        quantity: attendee.quantity,
        token: attendee.ticket_token,
      });
    }
    return byToken;
  }, new Map<string, TicketOption>())(
    filter(
      (a: Attendee) => !a.checked_in && !a.refunded && hasTicketQuantity(a),
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
      // The checkbox only means something once one scan can span listings.
      scope.listingIds.size > 1
        ? {
            checked: group.scan_checks_in_all_listings,
            savePath: `/admin/groups/${group.id}/scanner`,
          }
        : undefined,
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

/** The JSON answer for one ticket: who they are, how many places the answer
 * covers, and the listing names that drove it. */
const scanBody = (
  rows: readonly TokenEntry[],
  attendeeName: string,
  status: "already_checked_in" | "checked_in" | "verify_id",
): Record<string, unknown> => ({
  listingName: listingNamesOf(rows),
  name: attendeeName,
  quantity: sumOf((row: TokenEntry) => row.attendee.quantity)([...rows]),
  status,
});

/** Perform one scan's whole admission: one UPDATE covering every admitted
 * listing, then one activity row per listing carrying that listing's own
 * name, so each listing's record of the day shows its own check-ins. */
const performCheckIns = async (rows: readonly TokenEntry[]): Promise<void> => {
  const units = rowsByListing(rows);
  await updateCheckedInOnListings(
    rows[0]!.attendee.id,
    units.map((unit) => unit[0]!.listing.id),
  );
  await logActivities(
    units.map((unit) => {
      const entry = unit[0]!;
      return {
        attendeeId: entry.attendee.id,
        listing: entry.listing.id,
        message: `Attendee checked in via scanner for '${entry.listing.name}'`,
      };
    }),
  );
};

/** Resolve a token against one door's scope and perform its scan decision. */
const scanToken = async (
  scope: ScanScope,
  token: string,
  force: boolean,
  idVerified: boolean,
  privateKey: CryptoKey,
): Promise<Response> => {
  const results = await getAttendeesByTokens([token]);
  const awb = results[0];
  if (!awb) return jsonResponse({ status: "not_found" }, 404);

  const allEntries = await resolveTokenEntries(awb, privateKey);
  const attendeeName = await resolveAttendeeName(allEntries, awb, privateKey);
  const decision = decideScan(
    allEntries,
    scope.listingIds,
    force,
    scope.checkInEveryListing,
    idVerified,
  );

  switch (decision.kind) {
    case "not_found":
      return jsonResponse({ status: "not_found" }, 404);
    case "wrong_listing":
      return wrongListingResponse(allEntries, attendeeName);
    case "refunded":
      return jsonResponse({ name: attendeeName, status: "refunded" });
    case "already_checked_in":
      return jsonResponse(
        scanBody(decision.live, attendeeName, "already_checked_in"),
      );
    case "verify_id":
      return jsonResponse(scanBody(decision.rows, attendeeName, "verify_id"));
    case "admit": {
      await performCheckIns(decision.rows);
      return jsonResponse({
        ...scanBody(decision.rows, attendeeName, "checked_in"),
        remaining: decision.remaining,
      });
    }
  }
};

/** Validate scan controls and load the request's decryption key. */
const processScan = async (
  scope: ScanScope,
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
    scope,
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

/** Handle POST /admin/groups/:id/scanner — save the group's "check in every
 * listing" checkbox and return to the scanner page. */
const handleGroupScannerSettingPost: IdRouteHandler = createAuthedHandler<
  { id: number },
  Group
>({
  handle: async ({ context: group, form }) => {
    await groups.table.update(group.id, {
      scanChecksInAllListings: form.getFlag("scan_checks_in_all_listings"),
    });
    return redirect(
      `/admin/groups/${group.id}/scanner`,
      t("admin.scanner.setting_saved"),
      true,
    );
  },
  loadContext: ({ id }) => getGroupById(id),
});

/** Scanner routes */
export const adminHandlers = defineRoutes({
  "GET /admin/groups/:id/scanner": handleGroupScannerGet,
  "GET /admin/listing/:id/scanner": handleScannerGet,
  "POST /admin/groups/:id/scan": handleGroupScanPost,
  "POST /admin/groups/:id/scanner": handleGroupScannerSettingPost,
  "POST /admin/listing/:id/scan": handleScanPost,
});

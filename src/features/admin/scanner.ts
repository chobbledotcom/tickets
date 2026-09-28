/**
 * QR scanner routes for admin check-in
 * GET /admin/scanner - The doors list a scanner login lands on
 * GET /admin/listing/:id/scanner - Scanner page with camera UI
 * POST /admin/listing/:id/scan - JSON API for processing scanned tokens
 * GET /admin/groups/:id/scanner - One scanner for every member of a group
 * POST /admin/groups/:id/scan - The same JSON API over the group's members
 */

import { logActivities } from "#db/activity-log.ts";
import type { AttendeeWithBookings } from "#db/attendee-types.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import { getAttendeesRaw } from "#db/attendees/queries.ts";
import {
  getAttendeesByIdsWithBookings,
  getAttendeesByTokens,
} from "#db/attendees/tokens.ts";
import { setCheckedInOnListings } from "#db/attendees/update.ts";
import { withTransaction } from "#db/client.ts";
import {
  getAllGroupNames,
  getGroupById,
  getListingsByGroupId,
} from "#db/groups.ts";
import { getAttendeesByListingIds } from "#db/listings/attendees.ts";
import { getListingPickerNames } from "#db/listings/catalog.ts";
import { getListingWithCount } from "#db/listings/records.ts";
import { filter, reduce, sumOf, unique } from "#fp";
import { sortedByString } from "#fp-strings";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { pageGuardFor, SCANNER_JSON, withAuth } from "#routes/auth.ts";
import { createIdEntityHandler, type IdRouteHandler } from "#routes/entity.ts";
import {
  htmlResponse,
  jsonResponse,
  notFoundResponse,
} from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  decryptTokenEntries,
  resolveEntries,
  type TokenEntry,
} from "#routes/tickets/token-utils.ts";
import { adminDestination } from "#shared/admin-surface.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import type { RequestRoute } from "#shared/response-steps.ts";
import {
  getRequestPrivateKey,
  requireRequestPrivateKey,
} from "#shared/session-private-key.ts";
import {
  adminScannerDoorsPage,
  adminScannerPage,
  type ScannerDoor,
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
 * An option carries the attendee's internal id, never the ticket credential:
 * the pick goes through the same scope-checked scan decision as a camera
 * read, so it can never admit something the camera would not. */
const manualCheckinOptions = (attendees: Attendee[]): TicketOption[] => [
  ...reduce((byAttendee: Map<number, TicketOption>, attendee: Attendee) => {
    const known = byAttendee.get(attendee.id);
    if (known) known.quantity += attendee.quantity;
    else {
      byAttendee.set(attendee.id, {
        attendeeId: attendee.id,
        name: attendee.name,
        quantity: attendee.quantity,
      });
    }
    return byAttendee;
  }, new Map<number, TicketOption>())(
    filter(
      (a: Attendee) => !a.checked_in && !a.refunded && hasTicketQuantity(a),
    )(attendees),
  ).values(),
];

/** Handle GET /admin/listing/:id/scanner - render scanner page */
const handleScannerGet: IdRouteHandler = createIdEntityHandler<
  NonNullable<Awaited<ReturnType<typeof getListingWithCount>>>
>(getListingWithCount)(pageGuardFor(adminDestination("listingScanner")))(
  async (listing, session) => {
    // A "No check-in" listing has no door: the doors list hides it, and a
    // guessed URL meets the same answer as an unknown listing.
    if (listing.purchase_only) return notFoundResponse();
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
  },
);

/** Handle GET /admin/groups/:id/scanner - render the group scanner page */
const handleGroupScannerGet: IdRouteHandler = createIdEntityHandler<Group>(
  getGroupById,
)(pageGuardFor(adminDestination("groupScanner")))(async (group, session) => {
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

/** Perform one scan's whole admission as one transaction: the UPDATE that
 * covers every admitted listing and the activity rows for each admitted
 * listing carry that listing's own name, so each listing's record of the day
 * shows its own check-ins. A failure in either write rolls both back, so a
 * check-in never lands without its activity record. */
const performCheckIns = async (rows: readonly TokenEntry[]): Promise<void> => {
  const units = rowsByListing(rows);
  await withTransaction(async (tx) => {
    await setCheckedInOnListings(
      rows[0]!.attendee.id,
      units.map((unit) => unit[0]!.listing.id),
      true,
      tx,
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
      tx,
    );
  });
};

/** One door scan, however the request names its person: resolve that person
 * (a camera-read token, or a manual pick's attendee id), then answer the
 * door's decision. A camera read names the person it decoded — the guest
 * presented the credential, so a wrong-door answer may say so. A manual pick
 * answers a stranger strictly: an id that resolves to nobody on this door's
 * listings answers not_found, never another door's roster — the ids are
 * sequential, and a wrong-listing body would name people a scanner has no
 * door business reading. */
const scanBy = async (
  scope: ScanScope,
  load: () => Promise<AttendeeWithBookings | null>,
  force: boolean,
  idVerified: boolean,
  privateKey: CryptoKey,
  refuseWrongListing: boolean,
): Promise<Response> => {
  const awb = await load();
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
  if (refuseWrongListing && decision.kind === "wrong_listing") {
    return jsonResponse({ status: "not_found" }, 404);
  }
  return scanDecisionResponse(decision, allEntries, attendeeName);
};

/** Answer one scan's decision: the shared responses a camera read and a
 * manual pick both reach. */
const scanDecisionResponse = async (
  decision: ReturnType<typeof decideScan>,
  allEntries: TokenEntry[],
  attendeeName: string,
): Promise<Response> => {
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
  const privateKey = await getRequestPrivateKey();
  if (!privateKey) {
    logError({
      code: ErrorCode.KEY_DERIVATION,
      detail: "Scanner: private key unavailable",
    });
    return apiErrorResponse("Decryption unavailable", 500);
  }
  // A camera read carries the ticket token it decoded; a manual pick
  // carries the attendee id its roster option holds.
  const load =
    typeof body.token === "string"
      ? async (): Promise<AttendeeWithBookings | null> =>
          (await getAttendeesByTokens([body.token as string]))[0] ?? null
      : typeof body.attendee_id === "number"
        ? async (): Promise<AttendeeWithBookings | null> =>
            (
              await getAttendeesByIdsWithBookings([body.attendee_id as number])
            ).get(body.attendee_id as number) ?? null
        : null;
  if (!load) return apiErrorResponse("Missing token");
  // A token is the credential the guest presented, so the answer may name a
  // wrong door; a picked id is not, so it answers a stranger strictly.
  return scanBy(
    scope,
    load,
    body.force === true,
    body.id_verified === true,
    privateKey,
    typeof body.token !== "string",
  );
};

/** Every door a scanner login can work: each listing that has a door (the
 * "No check-in" listings sell things with no door) and every group, both
 * ordered by name so tonight's door is easy to find. */
const loadDoors = async (): Promise<{
  groupDoors: ScannerDoor[];
  listingDoors: ScannerDoor[];
}> => {
  const [listings, groups] = await Promise.all([
    getListingPickerNames(),
    getAllGroupNames(),
  ]);
  const listingDoors = [...listings]
    .filter(([, listing]) => !listing.purchase_only)
    .map(
      ([id, listing]): ScannerDoor => ({
        name: listing.name,
        path: `/admin/listing/${id}/scanner`,
      }),
    );
  const groupDoors = [...groups].map(
    ([id, name]): ScannerDoor => ({
      name,
      path: `/admin/groups/${id}/scanner`,
    }),
  );
  return {
    groupDoors: sortedByString((door: ScannerDoor) => door.name)(groupDoors),
    listingDoors: sortedByString((door: ScannerDoor) => door.name)(
      listingDoors,
    ),
  };
};

/** Handle GET /admin/scanner - the doors list a scanner login lands on */
const handleDoorsGet: RequestRoute = (request) =>
  pageGuardFor(adminDestination("doors"))(request, async (session) =>
    htmlResponse(adminScannerDoorsPage(session, await loadDoors())),
  );

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
  "GET /admin/scanner": handleDoorsGet,
  "POST /admin/groups/:id/scan": handleGroupScanPost,
  "POST /admin/listing/:id/scan": handleScanPost,
});

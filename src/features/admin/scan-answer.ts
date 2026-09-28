/** One scan's whole answer: the door's scope, the person the request names,
 * the decision, and the JSON the door reads. The routes in
 * `src/features/admin/scanner.ts` hand these their request bodies. */

/* jscpd:ignore-start -- imports */
import { logActivities } from "#db/activity-log.ts";
import type { AttendeeWithBookings } from "#db/attendee-types.ts";
import { decryptAttendees } from "#db/attendees/pii.ts";
import {
  getAttendeesByIdsWithBookings,
  getAttendeesByTokens,
} from "#db/attendees/tokens.ts";
import { setCheckedInOnListings } from "#db/attendees/update.ts";
import { withTransaction } from "#db/client.ts";
import { getListingsByGroupId } from "#db/groups.ts";
import { sumOf, unique } from "#fp";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import {
  decryptTokenEntries,
  resolveEntries,
  type TokenEntry,
} from "#routes/tickets/token-utils.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { getRequestPrivateKey } from "#shared/session-private-key.ts";
import { type Attendee, type Group } from "#types";
import { decideScan, rowsByListing } from "./scan-decision.ts";
/* jscpd:ignore-end */

/** What one door's scan resolves against: the listings it admits, and its
 * group's stored choice between one listing per scan and all of them. */
export type ScanScope = {
  checkInEveryListing: boolean;
  listingIds: ReadonlySet<number>;
};

/** The scope a single listing's door admits. */
export const listingScope = (listingId: number): ScanScope => ({
  checkInEveryListing: false,
  listingIds: new Set([listingId]),
});

/** Load the scope one group's door admits: every member listing, minus the
 * members marked "No check-in" — they sell something that has no door.
 * Hidden and inactive members stay: hidden is a buyer-visibility fact, and a
 * hidden member carries genuine guest-list tickets. */
export const groupScope = async (group: Group): Promise<ScanScope> => ({
  checkInEveryListing: group.scan_checks_in_all_listings,
  listingIds: new Set(
    (await getListingsByGroupId(group.id))
      .filter((listing) => !listing.purchase_only)
      .map((listing) => listing.id),
  ),
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
export const processScan = async (
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
  const load = typeof body.token === "string"
    ? async (): Promise<AttendeeWithBookings | null> =>
      (await getAttendeesByTokens([body.token as string]))[0] ?? null
    : typeof body.attendee_id === "number"
    ? async (): Promise<AttendeeWithBookings | null> =>
      (await getAttendeesByIdsWithBookings([body.attendee_id as number])).get(
        body.attendee_id as number,
      ) ?? null
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

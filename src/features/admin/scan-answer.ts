/** One scan's whole answer: the door's scope, the person the request names,
 * the decision, and the JSON the door reads. The routes in
 * `src/features/admin/scanner.ts` hand these their request bodies. A queued
 * delivery's identity, digest match, and ledger row live in
 * `scan-delivery.ts`. */

/* jscpd:ignore-start -- imports */
import { remainingTickets } from "#booking/remaining-tickets.ts";
import { type TicketMoveAnswer, ticketCount } from "#booking/ticket-moves.ts";
import type { AttendeeWithBookings } from "#db/attendee-types.ts";
import { moveTicketsAndLog, ticketsWord } from "#db/attendees/door-moves.ts";
import {
  type DecryptedAttendeeRow,
  decryptAttendees,
} from "#db/attendees/pii.ts";
import { getAttendeesByTokens } from "#db/attendees/tokens.ts";
import { getListingsByGroupId } from "#db/groups.ts";
import { getAttendeesByListingIds } from "#db/listings/attendees.ts";
import { claimScanOperation } from "#db/processed-scan-operations.ts";
import { requiredMapValue, sumOf, unique } from "#fp";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
import {
  decryptTokenEntries,
  resolveEntries,
  type TokenEntry,
} from "#routes/tickets/token-utils.ts";
import { ErrorCode, logError } from "#shared/logger.ts";
import { getRequestPrivateKey } from "#shared/session-private-key.ts";
import { isPositiveSafeInteger } from "#shared/validation/number.ts";
import type { Attendee, Group } from "#types";
import {
  decideScan,
  type ScanDecision,
  type ScanUnit,
} from "./scan-decision.ts";
import {
  attendeeById,
  attendeeByTokenHash,
  deliveredListingIds,
  foundDelivery,
  type PersonLoader,
  type QueuedDelivery,
  queuedDelivery,
} from "./scan-delivery.ts";

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

/** One door's tickets, decrypted: every attendee of the listings the door
 * admits. The scan API's readers all stand on this one read. */
export const doorAttendees = async (
  listingIds: readonly number[],
  privateKey: CryptoKey,
): Promise<DecryptedAttendeeRow<Attendee>[]> =>
  decryptAttendees(await getAttendeesByListingIds([...listingIds]), privateKey);

/** The request's decryption key, or the 500 answer the door reads when it
 * is missing. Every scanner read path answers the same way. */
export const scannerPrivateKey = async (): Promise<CryptoKey | Response> => {
  const privateKey = await getRequestPrivateKey();
  if (!privateKey) {
    logError({
      code: ErrorCode.KEY_DERIVATION,
      detail: "Scanner: private key unavailable",
    });
    return apiErrorResponse("Decryption unavailable", 500);
  }
  return privateKey;
};

/** The scan API's not-found answer: the same JSON shape whether the scan
 * missed a person or the door itself is gone. */
export const scanNotFoundResponse = (): Response =>
  jsonResponse({ status: "not_found" }, 404);

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

/** Resolve an attendee's booking rows to decrypted entries */
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
  // One token belongs to one attendee, so every entry names the same person.
  // The first entry answers, and an empty entry list falls back to the blob.
  const fromEntry = allEntries[0]?.attendee.name;
  if (fromEntry) return fromEntry;
  const decrypted = await decryptAttendees(
    [{ pii_blob: awb.pii_blob } as Attendee],
    privateKey,
  );
  return decrypted[0]!.name;
};

/** Build a wrong_listing response when the scanned token does not match the listing.
 * A wrong_listing decision always carries the ticket's own door-safe rows, so
 * the names are never empty. */
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

/** The JSON answer for one ticket. It names who they are, the tickets this
 * answer covers, the tickets the covered lines hold in total, and the
 * listing names that drove it. */
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

/** Answer a delivery the ledger already took. The rows are the ones the
 * delivery admitted. The door reads the tier the first send put in. It
 * never reads the tier a fresh decision picks now, and it never asks a
 * prompt the first send passed. */
const acknowledgedAnswer = (
  allEntries: readonly TokenEntry[],
  attendeeName: string,
  listingIds: readonly number[],
): Response =>
  alreadyCheckedIn(
    allEntries.filter((entry) => listingIds.includes(entry.listing.id)),
    attendeeName,
  );

/** Perform one scan's whole admission as one transaction: every unit's
 * admit, and one activity row per listing that really admitted tickets.
 * Each activity row carries that listing's own name and count. The write
 * skips refunded lines, so a merged attendee's refunded order on the same
 * listing stays untouched. A failure in either write rolls both back. A
 * check-in never lands without its activity record. The function answers
 * the tickets the lines really took (less than planned when another door
 * admitted some first). It also answers what the booking still owes after
 * the write. The response then never reports a door race as tickets left.
 * `delivery`, when the request names one, is claimed inside the same
 * transaction. The claim keys the id and the token digest together. A
 * replay of the same queued delivery then moves nothing. */
const performCheckIns = async (
  decision: Extract<ScanDecision, { kind: "admit" }>,
  delivery?: QueuedDelivery,
): Promise<{ admitted: number; remaining: number }> => {
  const attendeeId = decision.rows[0]!.attendee.id;
  const listingOf = (unit: ScanUnit) => unit.rows[0]!.listing;
  const listingNames = new Map(
    decision.units.map((unit) => [listingOf(unit).id, listingOf(unit).name]),
  );
  const moved = await moveTicketsAndLog(
    "admit",
    decision.units.map((unit) => ({
      attendeeId,
      count: unit.tickets,
      listingId: listingOf(unit).id,
    })),
    (move) =>
      `Attendee checked in ${ticketsWord(move.count)} via scanner for '${requiredMapValue(
        listingNames,
        move.listingId,
        `Listing ${move.listingId} is no unit of this scan`,
      )}'`,
    delivery &&
      claimScanOperation({
        listingIds: unique(decision.units.map((unit) => listingOf(unit).id)),
        operationId: delivery.operationId,
        tokenHash: delivery.tokenHash,
      }),
  );
  // What the write left: the touched pairs' post-write owed, plus the owed
  // of rows the scan did not admit. The transaction saw every ticket a
  // racing door took. A widened scan counts every listing.
  const plannedOwed = sumOf((unit: ScanUnit) =>
    sumOf((row: TokenEntry) => remainingTickets(row.attendee))(unit.rows),
  )(decision.units);
  const untouched =
    decision.remaining +
    sumOf((unit: ScanUnit) => unit.tickets)(decision.units) -
    plannedOwed;
  return {
    admitted: ticketCount(moved),
    remaining:
      untouched + sumOf((move: TicketMoveAnswer) => move.owedAfter)(moved),
  };
};

/** The door staff's choices a scan carries: force a ticket that matched
 * nowhere in scope, the ID check they made, and a quantity pick. */
type ScanControls = {
  count: number | undefined;
  force: boolean;
  idVerified: boolean;
};

/** One door scan, however the request names its person. Resolve that person
 * (a camera-read token, or a manual pick's attendee id), then answer the
 * door's decision. A camera read names the person it decoded — the guest
 * presented the credential, so a wrong-door answer can say so. A manual pick
 * answers a stranger strictly. An id that resolves to nobody on this door's
 * listings answers not_found, never another door's roster. The ids are
 * sequential, and a wrong-listing body names people a scanner has no
 * door business reading. */
const scanBy = async (
  scope: ScanScope,
  load: PersonLoader,
  controls: ScanControls,
  privateKey: CryptoKey,
  refuseWrongListing: boolean,
  delivery?: QueuedDelivery,
): Promise<Response> => {
  const awb = await load();
  if (!awb) return jsonResponse({ status: "not_found" }, 404);
  const allEntries = await resolveTokenEntries(awb, privateKey);
  const attendeeName = await resolveAttendeeName(allEntries, awb, privateKey);
  // A delivery the ledger already took is a retry of one that landed. It
  // answers that landing here, before any fresh decision runs. A fresh
  // decision picks the next tier, or asks again for an ID check the first
  // send already passed.
  if (delivery) {
    const landed = await foundDelivery(delivery);
    if (landed) {
      return acknowledgedAnswer(allEntries, attendeeName, landed);
    }
  }
  const decision = decideScan(
    { entries: allEntries, force: controls.force, scope: scope.listingIds },
    scope.checkInEveryListing,
    controls.idVerified,
    controls.count,
  );
  if (refuseWrongListing && decision.kind === "wrong_listing") {
    return jsonResponse({ status: "not_found" }, 404);
  }
  return scanDecisionResponse(decision, allEntries, attendeeName, delivery);
};

/** Answer one scan's decision: the shared responses a camera read and a
 * manual pick both reach. A queued delivery rides along: the ledger has
 * already answered its retry before this point, and the admission claims
 * its id-and-digest pair inside the write. */
const scanDecisionResponse = async (
  decision: ScanDecision,
  allEntries: TokenEntry[],
  attendeeName: string,
  delivery?: QueuedDelivery,
): Promise<Response> => {
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
      const { admitted, remaining } = await performCheckIns(decision, delivery);
      // Another door took every ticket this scan planned to admit. A
      // queued delivery's pair is stored either way, so it answers what
      // that delivery admits — its own claim, or the winner's.
      if (admitted === 0) {
        return delivery
          ? acknowledgedAnswer(
              allEntries,
              attendeeName,
              await deliveredListingIds(delivery),
            )
          : alreadyCheckedIn(decision.rows, attendeeName);
      }
      return jsonResponse({
        ...scanBody(decision.rows, attendeeName, "checked_in", admitted),
        remaining,
      });
    }
  }
};

/** A door's quantity pick: a whole number of tickets, at least one. Anything
 * else fails closed — the cap at what the lines owe is moveTickets' guard,
 * not a reason to silently fix a bad input here. */
const isAdmitCount = (value: unknown): value is number =>
  typeof value === "number" && isPositiveSafeInteger(value);

/** The three ways a request names its person. A camera read carries the
 * ticket token it decoded. A queued check-in replaying after an outage
 * carries only the token's keyed digest — the device never held the token.
 * A manual pick carries the attendee id its roster option holds. A request
 * that names none of the three names nobody. */
const personLoader = (
  scope: ScanScope,
  body: Record<string, unknown>,
  privateKey: CryptoKey,
  door: string,
): PersonLoader | null => {
  const token = typeof body.token === "string" ? body.token : undefined;
  const tokenHash =
    typeof body.token_hash === "string" ? body.token_hash : undefined;
  const attendeeId =
    typeof body.attendee_id === "number" ? body.attendee_id : undefined;
  if (token !== undefined) {
    return async (): Promise<AttendeeWithBookings | null> =>
      (await getAttendeesByTokens([token]))[0] ?? null;
  }
  if (tokenHash !== undefined) {
    return async (): Promise<AttendeeWithBookings | null> =>
      attendeeByTokenHash(
        tokenHash,
        await doorAttendees([...scope.listingIds], privateKey),
        door,
      );
  }
  if (attendeeId !== undefined) {
    return async (): Promise<AttendeeWithBookings | null> =>
      (await attendeeById(attendeeId)) ?? null;
  }
  return null;
};

/** Validate scan controls and load the request's decryption key. */
export const processScan = async (
  scope: ScanScope,
  body: Record<string, unknown>,
  door: string,
): Promise<Response> => {
  if (body.quantity !== undefined && !isAdmitCount(body.quantity)) {
    return apiErrorResponse("Invalid quantity");
  }
  const delivery = queuedDelivery(body);
  if (delivery instanceof Response) return delivery;
  const privateKey = await scannerPrivateKey();
  if (privateKey instanceof Response) return privateKey;
  const load = personLoader(scope, body, privateKey, door);
  if (!load) return apiErrorResponse("Missing token");
  // A camera token is the credential the guest presented. The answer can
  // name a wrong door, and the credential is what force overrides. A
  // digest resolves inside this door's own scope only. The device queued
  // it from this door's saved list, so it never meets a wrong door. A
  // picked id is neither. Force must never widen it. A crafted id
  // otherwise admits someone on another door's listings outright.
  return scanBy(
    scope,
    load,
    {
      count: isAdmitCount(body.quantity) ? body.quantity : undefined,
      force: body.force === true && typeof body.token === "string",
      idVerified: body.id_verified === true,
    },
    privateKey,
    typeof body.token !== "string",
    delivery,
  );
};

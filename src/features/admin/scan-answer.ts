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
import {
  type DeliveredScanOperation,
  scanOperationGuard,
} from "#db/processed-scan-operations.ts";
import { requiredMapValue, sumOf, unique } from "#fp";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { jsonResponse } from "#routes/response.ts";
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
import type { Attendee, Group } from "#types";
import {
  decideScan,
  exactQuantityAdmission,
  type ScanDecision,
  type ScanUnit,
  unitTickets,
} from "./scan-decision.ts";
import {
  attendeeById,
  attendeeByTokenHash,
  deliveredAdmission,
  foundDelivery,
  isAdmitCount,
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

/** The door scope's decrypted attendee lines, in one read. The scanner page
 * and the offline ticket cache both need every line the door's listings
 * hold. */
export const scopeAttendees = async (
  scope: ScanScope,
): Promise<DecryptedAttendeeRow<Attendee>[]> =>
  decryptAttendees(
    await getAttendeesByListingIds([...scope.listingIds]),
    await requireRequestPrivateKey(),
  );

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
 * delivery admitted. The quantity is what that admission took: what the
 * first send's answer said. A fresh decision picks nothing here, and no
 * prompt the first send passed comes back. */
const acknowledgedAnswer = (
  allEntries: readonly TokenEntry[],
  attendeeName: string,
  landed: DeliveredScanOperation,
): Response =>
  jsonResponse(
    scanBody(
      allEntries.filter((entry) =>
        landed.listingIds.includes(entry.listing.id),
      ),
      attendeeName,
      "already_checked_in",
      landed.quantity,
    ),
  );

/** The JSON answer for one landed admission. Another door can take every
 * ticket this scan planned to admit between the decision and the write.
 * A queued delivery's pair is stored either way, so the drained case
 * answers what that delivery admits — its own claim, or the winner's. A
 * live scan answers that the person is already in. */
export const admissionAnswer = async (
  decision: Extract<ScanDecision, { kind: "admit" }>,
  allEntries: readonly TokenEntry[],
  attendeeName: string,
  delivery: QueuedDelivery | undefined,
  took: { admitted: number; remaining: number },
): Promise<Response> => {
  if (took.admitted === 0) {
    return delivery
      ? acknowledgedAnswer(
          allEntries,
          attendeeName,
          await deliveredAdmission(delivery),
        )
      : alreadyCheckedIn(decision.rows, attendeeName);
  }
  return jsonResponse({
    ...scanBody(decision.rows, attendeeName, "checked_in", took.admitted),
    remaining: took.remaining,
  });
};

/** Perform one scan's whole admission as one transaction: every unit's
 * admit, and one activity row per listing that really admitted tickets.
 * The write skips refunded lines, so a merged attendee's refunded order
 * stays untouched. A failure in either write rolls both back, so a
 * check-in never lands without its activity record. The answer names
 * the tickets the lines really took and what the booking still owes,
 * so a door race never reads as tickets left. A `delivery` claims its
 * id-and-digest pair inside the same transaction, with the quantity its
 * admission planned. A replay then reserves and moves nothing. A door
 * race that drained tickets settles the stored admission to what the
 * move really took, so the retry's answer mirrors the first send's. */
const performCheckIns = async (
  decision: Extract<ScanDecision, { kind: "admit" }>,
  delivery?: QueuedDelivery,
): Promise<{ admitted: number; remaining: number }> => {
  const attendeeId = decision.rows[0]!.attendee.id;
  const listingOf = (unit: ScanUnit) => unit.rows[0]!.listing;
  const listingNames = new Map(
    decision.units.map((unit) => [listingOf(unit).id, listingOf(unit).name]),
  );
  const planned = unitTickets(decision.units);
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
      scanOperationGuard({
        listingIds: unique(decision.units.map((unit) => listingOf(unit).id)),
        operationId: delivery.operationId,
        quantity: planned,
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
    decision.remaining + unitTickets(decision.units) - plannedOwed;
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
      // A queued delivery that names a quantity admits exactly that many
      // places — the fill's plan, or a refusal when the booking cannot
      // supply them. A live scan keeps its per-listing cap.
      const exact =
        delivery?.quantity === undefined
          ? decision
          : exactQuantityAdmission(decision, delivery.quantity);
      if (exact === null) {
        return apiErrorResponse("Invalid quantity");
      }
      return admissionAnswer(
        exact,
        allEntries,
        attendeeName,
        delivery,
        await performCheckIns(exact, delivery),
      );
    }
  }
};

/** The person one request's body names. A camera read carries the ticket
 * token it decoded. A queued check-in replays only the token's keyed
 * digest, because the device never held the token. A manual pick carries
 * the attendee id its roster option holds. A body naming none of the three
 * names nobody. */
type ScanPersonRef =
  | { kind: "attendee_id"; id: number }
  | { kind: "token"; token: string }
  | { kind: "token_hash"; tokenHash: string };

const personRef = (body: Record<string, unknown>): ScanPersonRef | null => {
  const token = typeof body.token === "string" ? body.token : undefined;
  const tokenHash =
    typeof body.token_hash === "string" ? body.token_hash : undefined;
  const attendeeId =
    typeof body.attendee_id === "number" ? body.attendee_id : undefined;
  if (token !== undefined) return { kind: "token", token };
  if (tokenHash !== undefined) return { kind: "token_hash", tokenHash };
  if (attendeeId !== undefined) return { id: attendeeId, kind: "attendee_id" };
  return null;
};

/** The person a scan's request names. A digest resolves inside the door's
 * own scope only. */
const personLoader = (
  scope: ScanScope,
  ref: ScanPersonRef,
  door: string,
): PersonLoader => {
  switch (ref.kind) {
    case "token":
      return async (): Promise<AttendeeWithBookings | null> =>
        (await getAttendeesByTokens([ref.token]))[0] ?? null;
    case "token_hash":
      return async (): Promise<AttendeeWithBookings | null> =>
        attendeeByTokenHash(ref.tokenHash, await scopeAttendees(scope), door);
    case "attendee_id":
      return async (): Promise<AttendeeWithBookings | null> =>
        (await attendeeById(ref.id)) ?? null;
  }
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
  const ref = personRef(body);
  if (!ref) return apiErrorResponse("Missing token");
  const privateKey = await getRequestPrivateKey();
  if (!privateKey) {
    logError({
      code: ErrorCode.KEY_DERIVATION,
      detail: "Scanner: private key unavailable",
    });
    return apiErrorResponse("Decryption unavailable", 500);
  }
  // A camera token is the credential the guest presented. The answer can
  // name a wrong door, and the credential is what force overrides. A
  // digest resolves inside this door's own scope only. The device queued
  // it from this door's saved list, so it never meets a wrong door. A
  // picked id is neither. Force must never widen it. A crafted id
  // otherwise admits someone on another door's listings outright.
  return scanBy(
    scope,
    personLoader(scope, ref, door),
    {
      count: isAdmitCount(body.quantity) ? body.quantity : undefined,
      force: body.force === true && ref.kind === "token",
      idVerified: body.id_verified === true,
    },
    privateKey,
    ref.kind !== "token",
    delivery,
  );
};

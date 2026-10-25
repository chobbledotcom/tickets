/** One queued offline check-in's delivery. It carries the identity the
 * device named it by, the keyed digest the door resolves, and the ledger
 * row a completed delivery answers from. The scan answer parses the
 * request through this module. */

// jscpd:ignore-start -- imports
import { deriveDoorCacheKey } from "#crypto/hashing.ts";
import type { AttendeeWithBookings } from "#db/attendee-types.ts";
import type { DecryptedAttendeeRow } from "#db/attendees/pii.ts";
import { getAttendeesByIdsWithBookings } from "#db/attendees/tokens.ts";
import {
  type DeliveredScanOperation,
  deliveredScanOperation,
} from "#db/processed-scan-operations.ts";
import { apiErrorResponse } from "#routes/api/cors.ts";
import { hmacHex, importHmacKey } from "#shared/sha256.ts";
import { isPositiveSafeInteger } from "#shared/validation/number.ts";
import type { Attendee } from "#types";
// jscpd:ignore-end

/** A queued delivery's whole identity: the operation id the device made
 * up, the token digest it stored, and the quantity it admits. The
 * quantity is there only when the device picked one. The pair is the
 * replay guard's whole key. The same pair retrying is a retry of one
 * delivery. Either half differing is another delivery. */
export type QueuedDelivery = {
  operationId: string;
  quantity?: number;
  tokenHash: string;
};

/** One scan's person loader: answers the person the request names, or null
 * when the door's scope names nobody. */
export type PersonLoader = () => Promise<AttendeeWithBookings | null>;

/** The door's quantity pick: a whole number of tickets, at least one.
 * Anything else fails closed — the cap at what the lines owe is
 * moveTickets' guard, not a reason to silently fix a bad input here. */
export const isAdmitCount = (value: unknown): value is number =>
  typeof value === "number" && isPositiveSafeInteger(value);

/** The longest operation id a queued delivery can name. A device makes its
 * own id up, so the cap only bounds the column a hostile caller fills. */
const OPERATION_ID_MAX = 100;

/** Read a queued delivery's identity from the request body. A queued
 * check-in replaying after an outage carries the token digest it stored
 * and the operation id it made up for that one delivery. The pair is what
 * the replay guard keys on. A digest with no id names no delivery the API
 * defines, so the request is refused. An unnamed digest can never be
 * guarded against a replay, and a resent one can admit twice. Anything
 * that is not a plain short string claims nothing. An id beside a raw
 * token or a picked attendee id names no delivery either, so the request
 * is refused, not ignored. */
export const queuedDelivery = (
  body: Record<string, unknown>,
): QueuedDelivery | Response | undefined => {
  const id = body.operation_id;
  const tokenHash = body.token_hash;
  const shapedId =
    typeof id === "string" && id !== "" && id.length <= OPERATION_ID_MAX;
  if (
    (typeof tokenHash === "string" && !shapedId) ||
    (shapedId &&
      (typeof body.token === "string" || typeof body.attendee_id === "number"))
  ) {
    return apiErrorResponse("Invalid operation");
  }
  if (typeof tokenHash !== "string" || !shapedId) return;
  const quantity = isAdmitCount(body.quantity) ? body.quantity : undefined;
  return quantity === undefined
    ? { operationId: id, tokenHash }
    : { operationId: id, quantity, tokenHash };
};

/** One attendee's booking rows, read by the id both scan paths resolve:
 * the digest match's confirmed id, and a manual pick's roster id. */
export const attendeeById = async (
  id: number,
): Promise<AttendeeWithBookings | undefined> =>
  (await getAttendeesByIdsWithBookings([id])).get(id);

/** Resolve a queued check-in's token digest against the door's own
 * tickets. The digest the device stored names nobody on its own. It must
 * match one token of the door's own candidate rows, digested under the
 * door's own cache key. That construction also built the list the device
 * saved. A digest keyed for another door answers null, never a roster. */
export const attendeeByTokenHash = async (
  tokenHash: string,
  candidates: readonly DecryptedAttendeeRow<Attendee>[],
  door: string,
): Promise<AttendeeWithBookings | null> => {
  const key = await importHmacKey(deriveDoorCacheKey(door));
  for (const candidate of candidates) {
    if ((await hmacHex(key, candidate.ticket_token)) === tokenHash) {
      // The line came from the door's own read moments ago, so the
      // attendee read cannot miss. A miss is a broken invariant.
      const attendee = await attendeeById(candidate.id);
      if (attendee === undefined) {
        throw new Error("Missing attendee for a matched ticket digest");
      }
      return attendee;
    }
  }
  return null;
};

/** What one landed delivery admitted, or null when the ledger holds no
 * such delivery. A delivery whose pair is not stored has not landed yet,
 * and the scan answers a fresh decision. */
export const foundDelivery = (
  delivery: QueuedDelivery,
): Promise<DeliveredScanOperation | null> =>
  deliveredScanOperation(delivery.operationId, delivery.tokenHash);

/** What the ledger holds for one delivery. The admission stores the row
 * before any path here reads it, so a miss below is a broken invariant,
 * not an answer. */
export const deliveredAdmission = async (
  delivery: QueuedDelivery,
): Promise<DeliveredScanOperation> => {
  const landed = await foundDelivery(delivery);
  if (!landed) {
    throw new Error(
      "A claimed scan delivery's ledger row went missing before its answer",
    );
  }
  return landed;
};

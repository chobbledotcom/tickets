/** The JSON answers one scan sends: the shared body, the
 * already-checked-in and wrong-listing replies, and the answers a queued
 * delivery's landing and over-admission produce. The decision and writes
 * live in `scan-answer.ts`. The delivery's identity and its ledger row
 * live in `scan-delivery.ts`. */

/* jscpd:ignore-start -- imports */
import type { TxScope } from "#db/client.ts";
import { createSystemNote } from "#db/notes/queries.ts";
import { attendeeNotes } from "#db/notes/target.ts";
import type { DeliveredScanOperation } from "#db/processed-scan-operations.ts";
import { sumOf, unique } from "#fp";
import { jsonResponse } from "#routes/response.ts";
import type { TokenEntry } from "#routes/tickets/token-utils.ts";
import type { ScanDecision } from "./scan-decision.ts";
import { deliveredAdmission, type QueuedDelivery } from "./scan-delivery.ts";
/* jscpd:ignore-end */

/** The door's own listing names behind an answer, first occurrence first. */
export const listingNamesOf = (rows: readonly TokenEntry[]): string =>
  unique(rows.map((row) => row.listing.name)).join(", ");

/** The tickets the covered lines hold in total. */
export const lineTickets = sumOf((row: TokenEntry) => row.attendee.quantity);

/** The JSON answer for one ticket. It names who they are, the tickets this
 * answer covers, the tickets the covered lines hold in total, and the
 * listing names that drove it. */
export const scanBody = (
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
export const alreadyCheckedIn = (
  rows: readonly TokenEntry[],
  attendeeName: string,
): Response =>
  jsonResponse(
    scanBody(rows, attendeeName, "already_checked_in", lineTickets([...rows])),
  );

/** Build a wrong_listing response when the scanned token does not match the listing.
 * A wrong_listing decision always carries the ticket's own door-safe rows, so
 * the names are never empty. */
export const wrongListingResponse = (
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

/** Answer a delivery the ledger already took. The rows are the ones the
 * delivery admitted. The quantity is what that admission took: what the
 * first send's answer said. A fresh decision picks nothing here, and no
 * prompt the first send passed comes back. A delivery that named more
 * people than its landing admitted still answers the numbers. The first
 * send's answer can get lost before it reaches the door, and this retry
 * is the answer the door reads. */
export const acknowledgedAnswer = (
  allEntries: readonly TokenEntry[],
  attendeeName: string,
  landed: DeliveredScanOperation,
  delivery?: QueuedDelivery,
): Response =>
  jsonResponse({
    ...scanBody(
      allEntries.filter((entry) =>
        landed.listingIds.includes(entry.listing.id),
      ),
      attendeeName,
      "already_checked_in",
      landed.quantity,
    ),
    ...(delivery?.quantity !== undefined &&
      delivery.quantity > landed.quantity && {
        overAdmission: {
          admitted: landed.quantity,
          bought: bookingHoldings(allEntries),
          named: delivery.quantity,
        },
      }),
  });

/** The places one booking holds on the lines it still owns, across every
 * listing the booking spans. */
export const bookingHoldings = (allEntries: readonly TokenEntry[]): number =>
  lineTickets(allEntries.filter((entry) => !entry.attendee.refunded));

/** The JSON answer for one landed admission. Another door can take every
 * ticket this scan planned to admit between the decision and the write.
 * A queued delivery's pair is stored either way, so the drained case
 * answers what that delivery admits — its own claim, or the winner's. A
 * live scan answers that the person is already in. A delivery whose pick
 * ran past the booking answers the numbers, so the door can alert. */
export const admissionAnswer = async (
  decision: Extract<ScanDecision, { kind: "admit" }>,
  allEntries: readonly TokenEntry[],
  attendeeName: string,
  delivery: QueuedDelivery | undefined,
  took: { admitted: number; remaining: number },
  overNamed?: { bought: number; named: number },
): Promise<Response> => {
  if (took.admitted === 0) {
    return delivery
      ? acknowledgedAnswer(
          allEntries,
          attendeeName,
          await deliveredAdmission(delivery),
          delivery,
        )
      : alreadyCheckedIn(decision.rows, attendeeName);
  }
  return jsonResponse({
    ...scanBody(decision.rows, attendeeName, "checked_in", took.admitted),
    remaining: took.remaining,
    ...(overNamed && {
      overAdmission: { admitted: took.admitted, ...overNamed },
    }),
  });
};

/** The words an over-admission note carries: what the delivery named, what
 * its landing admitted, and what the booking holds. */
export const overAdmissionNoteText = (
  named: number,
  admitted: number,
  bought: number,
): string =>
  admitted === 0
    ? `An offline door check-in named ${named} people, and none could be checked in. The booking holds ${bought} places.`
    : `An offline door check-in named ${named} people, and ${admitted} of them could be checked in. The booking holds ${bought} places.`;

/** The once-only note an over-admitted delivery leaves on the booking: the
 * numbers the door picked against what the booking held. The delivery's
 * own pair names the note, so a replay writes nothing. */
export const noteOverAdmission = (
  attendeeId: number,
  delivery: QueuedDelivery,
  note: string,
  tx?: TxScope,
): Promise<void> =>
  createSystemNote(
    attendeeNotes(attendeeId),
    note,
    {
      key: `${delivery.operationId}:${delivery.tokenHash}`,
      purpose: "scan_over_admission",
    },
    tx,
  );

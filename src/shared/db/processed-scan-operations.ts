/**
 * The door's replay ledger for queued offline check-ins. A device that
 * checked in while offline resends its delivery until it reads an
 * answer. One lost answer must never admit a second ticket.
 *
 * The delivery names itself with a device-made operation id and travels
 * with the token digest the device stored. That pair is the row's unique
 * key, so the same pair retrying lands nowhere. The same id beside
 * another ticket's digest claims its own row, and a reused id never
 * silently suppresses a different ticket's admission. No ticket token or
 * guest detail rests here, and the digest is the row's only trace.
 */

import { type TicketMoveAnswer, ticketCount } from "#booking/ticket-moves.ts";
import type { ScanOperationGuard } from "#db/attendees/door-moves.ts";
import {
  insert,
  orIgnore,
  queryOne,
  type TxScope,
  update,
} from "#db/client.ts";
import { limit } from "#shared/limits.ts";
import { DAY_MS, nowIso } from "#shared/now.ts";

/** What one claimed delivery keeps: the operation id and token digest
 * that name it, the listings its admission moved, and the places that
 * admission took. */
export type ScanDelivery = {
  listingIds: readonly number[];
  operationId: string;
  quantity: number;
  tokenHash: string;
};

/** What one landed delivery admitted: the listings its admission planned,
 * and the places its write really took. A retry answers these, so its
 * answer mirrors the first send's. */
export type DeliveredScanOperation = {
  listingIds: readonly number[];
  quantity: number;
};

/** Reserve a queued delivery inside the caller's transaction. The answer
 * says whether this delivery claimed its id-and-digest pair. True means
 * the caller admits and answers the admission. False means the pair is
 * already stored: the delivery is a retry of one that landed. The caller
 * then admits nothing and answers the stored admission. */
export const claimScanOperation =
  (delivery: ScanDelivery): ((tx: TxScope) => Promise<boolean>) =>
  async (tx) => {
    const result = await tx.execute(
      orIgnore(
        insert("processed_scan_operations", {
          created: nowIso(),
          listing_ids: JSON.stringify([...delivery.listingIds]),
          operation_id: delivery.operationId,
          quantity: delivery.quantity,
          token_hash: delivery.tokenHash,
        }),
      ),
    );
    return result.rowsAffected > 0;
  };

/** Correct one landed delivery's recorded admission to what its write
 * really took. Another door can take tickets between the delivery's
 * decision and its write, so the write can move fewer places than the
 * delivery claimed — never more. The stored admission keeps the listings
 * the delivery planned beside the places the write really took. A retry
 * then names the same tier the first send's answer named. Runs inside
 * the same transaction as the move it corrects. */
export const settleScanOperation = async (
  operationId: string,
  tokenHash: string,
  landed: DeliveredScanOperation,
  tx: TxScope,
): Promise<void> => {
  await tx.execute(
    update(
      "processed_scan_operations",
      {
        listing_ids: JSON.stringify([...landed.listingIds]),
        quantity: landed.quantity,
      },
      { operation_id: operationId, token_hash: tokenHash },
    ),
  );
};

/** What one delivery already admitted, or null when the ledger holds no
 * such delivery. A retry answers this, so its answer names the tier and
 * the quantity the first send put in. It never names what a fresh
 * decision picks now. */
export const deliveredScanOperation = async (
  operationId: string,
  tokenHash: string,
): Promise<DeliveredScanOperation | null> => {
  const row = await queryOne<{ listing_ids: string; quantity: number }>(
    `SELECT listing_ids, quantity FROM processed_scan_operations
       WHERE operation_id = ? AND token_hash = ?`,
    [operationId, tokenHash],
  );
  if (!row) return null;
  return {
    listingIds: JSON.parse(row.listing_ids) as number[],
    quantity: row.quantity,
  };
};

/** What the delivery's record says after its write: the listings its
 * admission planned, and the places the write really took. A write that
 * moved nothing keeps the claim's own quantity: the drained answer reads
 * the claim, so the retry mirrors what the first send said. The planned
 * listings stand whatever the write moved, so the retry's answer names
 * the same tier the first send's answer named. */
const recordedAdmission = (
  delivery: ScanDelivery,
  moved: readonly TicketMoveAnswer[],
): DeliveredScanOperation => {
  const actual = ticketCount(moved);
  return {
    listingIds: delivery.listingIds,
    quantity: actual === 0 ? delivery.quantity : actual,
  };
};

/** The once-only hold one delivery takes on its admission write: it
 * reserves the delivery's pair, with the admission it plans, inside the
 * write's transaction. The write then settles the record to what really
 * moved, in that same transaction, so a retry mirrors the first send's
 * answer. */
export const scanOperationGuard = (
  delivery: ScanDelivery,
): ScanOperationGuard => ({
  reserve: claimScanOperation(delivery),
  settle: (moved, tx) =>
    settleScanOperation(
      delivery.operationId,
      delivery.tokenHash,
      recordedAdmission(delivery, moved),
      tx,
    ),
});

/** Retention (days) for this ledger's rows (default: 7). A device only
 * retries while its saved cache is valid — 12 hours. A week bounds that
 * many times over. A pruned row then never meets a retry that can still
 * admit. The digest does not outlive the door's delivery window.
 */
export const PRUNE_SCAN_OPERATIONS_RETENTION_DAYS = limit(
  "PRUNE_SCAN_OPERATIONS_RETENTION_DAYS",
  7,
  "Prune: scan operations retention",
  "days",
);

export const PRUNE_SCAN_OPERATIONS_RETENTION_MS =
  PRUNE_SCAN_OPERATIONS_RETENTION_DAYS * DAY_MS;

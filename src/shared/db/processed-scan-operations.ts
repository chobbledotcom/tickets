/**
 * The door's replay ledger for queued offline check-ins. A device that
 * checked a ticket in while offline sends the delivery again until it
 * reads an answer. One lost answer must never admit a second ticket.
 *
 * The row's unique key is the operation id the device made up beside the
 * token digest the device stored. The same id and digest retrying is one
 * delivery landing nowhere. The same id beside another ticket's digest
 * claims its own row, so a reused id never silently suppresses another
 * ticket's admission. No ticket token and no guest detail rests here,
 * only the digest.
 */

import { insert, orIgnore, queryOne, type TxScope } from "#db/client.ts";
import { nowIso } from "#shared/now.ts";

/** What one claimed delivery keeps: the operation id and the token digest
 * that name it, and the listings its admission moved tickets on. */
export type ScanDelivery = {
  listingIds: readonly number[];
  operationId: string;
  tokenHash: string;
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
          token_hash: delivery.tokenHash,
        }),
      ),
    );
    return result.rowsAffected > 0;
  };

/** The listings one delivery already admitted, or null when the ledger
 * holds no such delivery. A retry answers these, so its answer names the
 * tier the first send put in. It never names the tier a fresh decision
 * picks now. */
export const deliveredScanOperation = async (
  operationId: string,
  tokenHash: string,
): Promise<readonly number[] | null> => {
  const row = await queryOne<{ listing_ids: string }>(
    `SELECT listing_ids FROM processed_scan_operations
       WHERE operation_id = ? AND token_hash = ?`,
    [operationId, tokenHash],
  );
  if (!row) return null;
  return JSON.parse(row.listing_ids) as number[];
};

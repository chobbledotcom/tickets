/**
 * The door's replay ledger for queued offline check-ins. A device that
 * checked a ticket in while offline sends the delivery again until it reads
 * an answer, and one lost answer must never admit a second ticket. The
 * delivery names itself with an operation id the device made up, and the
 * admission claims that id inside its own transaction: a repeated delivery
 * finds its id stored and lands nowhere. The row holds the id alone — no
 * ticket token, digest, or guest detail.
 */

import { insert, orIgnore, type TxScope } from "#db/client.ts";

/** Reserve a queued delivery's operation id inside the caller's transaction.
 * Answers true when this delivery claims the id and may admit, and false
 * when the id is already stored — the delivery is a retry of one that
 * already landed, so the caller admits nothing and answers the ticket's
 * current state. */
export const claimScanOperation =
  (operationId: string): ((tx: TxScope) => Promise<boolean>) =>
  async (tx) => {
    const result = await tx.execute(
      orIgnore(
        insert("processed_scan_operations", { operation_id: operationId }),
      ),
    );
    return result.rowsAffected > 0;
  };

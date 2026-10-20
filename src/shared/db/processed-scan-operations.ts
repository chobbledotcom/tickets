/**
 * The door's replay ledger for queued offline check-ins. A device that
 * checked a ticket in while offline sends the delivery again until it
 * reads an answer. One lost answer must never admit a second ticket.
 *
 * The delivery names itself with an operation id the device made up. The
 * admission claims that id inside its own transaction. A repeated delivery
 * finds its id stored and lands nowhere. The row holds the id alone: no
 * ticket token, no digest, no guest detail.
 */

import { insert, orIgnore, type TxScope } from "#db/client.ts";

/** Reserve a queued delivery's operation id inside the caller's
 * transaction. The answer says whether this delivery claimed the id. True
 * means the caller admits and answers the admission. False means the id is
 * already stored: the delivery is a retry of one that landed. The caller
 * then admits nothing and answers the ticket's current state. */
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

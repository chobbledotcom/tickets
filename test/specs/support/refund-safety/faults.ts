/** Real database failures used by refund recovery stories. */

import { execute } from "#shared/db/client.ts";
import type { PutsThingsBack } from "#test/specs/support/memory.ts";

const REFUND_LEDGER_FAULT = "refund_story_ledger_fault";

export interface RefundLedgerFault {
  /** Remove the fault so a visitor can retry the site's recovery action. */
  restore(): Promise<void>;
}

const dropRefundLedgerFault = async (): Promise<void> => {
  await execute(`DROP TRIGGER IF EXISTS ${REFUND_LEDGER_FAULT}`);
};

/**
 * Make only refund-ledger inserts fail at SQLite's real write boundary.
 *
 * Sales and ordinary reads remain available. The provider can therefore return
 * the money while the application's atomic refund transfer group rolls back,
 * which is the production failure the recovery journey needs to exercise.
 */
export const makeRefundLedgerUnavailable = async (
  cleanup: Pick<PutsThingsBack, "add">,
): Promise<RefundLedgerFault> => {
  await execute(`
    CREATE TRIGGER ${REFUND_LEDGER_FAULT}
    BEFORE INSERT ON transfers
    WHEN substr(NEW.kind, 1, 7) = 'refund_'
    BEGIN
      SELECT RAISE(ABORT, 'refund ledger unavailable in this story');
    END
  `);
  cleanup.add(dropRefundLedgerFault);
  return { restore: dropRefundLedgerFault };
};

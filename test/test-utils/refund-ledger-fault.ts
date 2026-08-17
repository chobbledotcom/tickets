/** A real database fault for refund records: only refund-ledger inserts
 * fail, at SQLite's own write boundary, so sales and reads stay available
 * while the atomic refund transfer group rolls back whole. */

import { withDbFault } from "#test-utils/db-fault.ts";

/** The trigger DDL, shared with the recovery stories' fault installer. */
export const refundLedgerFaultTrigger = (name: string): string =>
  `CREATE TRIGGER ${name}
    BEFORE INSERT ON transfers
    WHEN substr(NEW.kind, 1, 7) = 'refund_'
    BEGIN
      SELECT RAISE(ABORT, 'refund ledger unavailable');
    END`;

const FAULT = "test_refund_ledger_fault";

/** Run `body` with the refund ledger refusing writes, then lift the fault. */
export const withRefundLedgerFault = <T>(body: () => Promise<T>): Promise<T> =>
  withDbFault(refundLedgerFaultTrigger(FAULT), FAULT, body);

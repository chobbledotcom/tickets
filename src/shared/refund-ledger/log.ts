import { ErrorCode, logError } from "#shared/logger.ts";

/** Record a ledger failure that cannot undo money already returned. */
export const logRefundLedgerError = (detail: string): void => {
  logError({ code: ErrorCode.LEDGER_POST, detail });
};

import { ErrorCode, logError } from "#shared/logger.ts";

export type LedgerPostResult = { posted: boolean };

/** Report a ledger write failure without exposing private payment data. */
export const reportLedgerPostFailure = (detail: string): void => {
  logError({ code: ErrorCode.LEDGER_POST, detail });
};

/** Run one ledger post without letting an already-settled payment return a 500. */
export const attemptLedgerPost =
  (label: string, attendeeId: number) =>
  async (post: () => Promise<boolean>): Promise<LedgerPostResult> => {
    try {
      return { posted: await post() };
    } catch (error) {
      reportLedgerPostFailure(
        `${label} failed for attendee ${attendeeId}: ${error}`,
      );
      return { posted: false };
    }
  };

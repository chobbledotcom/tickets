import { ErrorCode, logError } from "#shared/logger.ts";

/** Say that something went wrong with a refund on this listing. */
export const reportRefundProblem = (detail: string, listingId: number): void =>
  logError({ code: ErrorCode.PAYMENT_REFUND, detail, listingId });

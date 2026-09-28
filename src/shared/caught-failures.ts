/** Reporting for failures a background path caught and contained: the batch
 * keeps going, the operator still sees what broke. */

import { errorMessage } from "#shared/error-message.ts";
import { ErrorCode, type ErrorCodeType, logError } from "#shared/logger.ts";

/** Log a failure a background path caught, keeping its code and detail. */
export const logCaughtFailure =
  (code: ErrorCodeType, detail: string) =>
  (error: unknown): void => {
    logError({ code, detail, error });
  };

/** Log one recovery worker's failed item without stopping the rest of its
 * batch — the batch continues, the operator still sees which item broke. */
export const logRecoveryItemFailure =
  (label: string, id: string) =>
  (error: unknown): void => {
    logCaughtFailure(
      ErrorCode.PAYMENT_SESSION,
      `${label} failed for ${id}: ${errorMessage(error)}`,
    )(error);
  };

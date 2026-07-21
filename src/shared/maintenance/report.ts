import { ErrorCode, logError } from "#shared/logger.ts";

export const reportMaintenanceFailure = (
  detail: string,
  error: unknown,
): void => {
  logError({ code: ErrorCode.CDN_REQUEST, detail, error });
};

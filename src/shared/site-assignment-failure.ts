import { ErrorCode, type ErrorCodeType, logError } from "#shared/logger.ts";
import { sendNtfyError } from "#shared/ntfy.ts";

export type SiteAssignmentConfigValidation =
  | { ok: true }
  | {
      ok: false;
      reason: "builder_disabled" | "initial_months" | "missing_tier";
      message: string;
      listingId?: number;
    };

type SiteAssignmentConfigFailure = Exclude<
  SiteAssignmentConfigValidation,
  { ok: true }
>;
type SiteAssignmentFailureReport = {
  code: ErrorCodeType;
  notification: ErrorCodeType;
};

const SITE_ASSIGNMENT_FAILURE_REPORTS = {
  builder_disabled: {
    code: ErrorCode.CONFIG_MISSING,
    notification: ErrorCode.CONFIG_MISSING,
  },
  initial_months: {
    code: ErrorCode.DATA_INVALID,
    notification: ErrorCode.DATA_INVALID,
  },
  missing_tier: {
    code: ErrorCode.CONFIG_MISSING,
    notification: ErrorCode.CONFIG_MISSING,
  },
} as const satisfies Record<
  SiteAssignmentConfigFailure["reason"],
  SiteAssignmentFailureReport
>;

/** Report why post-checkout assignment was blocked. */
export const reportSiteAssignmentFailure = (
  failure: SiteAssignmentConfigFailure,
  skippedCount: number,
): void => {
  const report = SITE_ASSIGNMENT_FAILURE_REPORTS[failure.reason];
  logError({
    code: report.code,
    detail: `Site assignment blocked (${failure.reason}, ${skippedCount} entries skipped)${
      failure.listingId !== undefined ? `, listing #${failure.listingId}` : ""
    }`,
  });
  sendNtfyError(report.notification);
};

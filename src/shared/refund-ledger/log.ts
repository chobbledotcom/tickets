import { ErrorCode, logError } from "#shared/logger.ts";

type RefundLedgerFailure =
  | {
      readonly attendeeId: number;
      readonly error: unknown;
      readonly kind: "placeholder_post" | "single_post" | "single_preparation";
    }
  | {
      readonly attendeeCount: number;
      readonly error: unknown;
      readonly kind: "batch_post" | "batch_preparation";
    };

const FAILURE_DETAIL = {
  batch_post: "Bulk refund ledger post failed",
  batch_preparation: "Bulk refund ledger preparation failed",
  placeholder_post: "Placeholder refund ledger post failed",
  single_post: "Refund ledger post failed",
  single_preparation: "Refund ledger preparation failed",
} as const satisfies Record<RefundLedgerFailure["kind"], string>;

const failureDetail = (failure: RefundLedgerFailure): string =>
  `${FAILURE_DETAIL[failure.kind]}${
    "attendeeCount" in failure
      ? ` for ${failure.attendeeCount} attendee records`
      : ""
  }`;

/** Record a ledger failure that cannot undo money already returned. */
export const logRefundLedgerError = (failure: RefundLedgerFailure): void => {
  logError({
    ...("attendeeId" in failure ? { attendeeId: failure.attendeeId } : {}),
    code: ErrorCode.LEDGER_POST,
    detail: failureDetail(failure),
    error: failure.error,
  });
};

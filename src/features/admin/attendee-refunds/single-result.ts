/** Where one failed refund attempt can safely send the owner. */

import { t } from "#i18n";
import { attendeeActionUrlWithReturn } from "#routes/admin/attendees-route-helpers.ts";
import type { RefundBatchResult } from "#routes/admin/refunds/provider.ts";
import { errorRedirect } from "#routes/response.ts";

type RefundErrorPage = "actions" | "recovery" | "refund";

const REFUND_RECOVERY_URL = "/admin/privacy#refund-recovery";

const refundErrorUrls = {
  actions: (attendeeId: number, returnUrl: string): string =>
    returnUrl || `/admin/attendees/${attendeeId}/actions`,
  recovery: (): string => REFUND_RECOVERY_URL,
  refund: (attendeeId: number, returnUrl: string): string =>
    attendeeActionUrlWithReturn(attendeeId, "refund", returnUrl),
} satisfies Record<
  RefundErrorPage,
  (attendeeId: number, returnUrl: string) => string
>;

export const refundError = (
  attendeeId: number,
  msg: string,
  returnUrl: string,
  page: RefundErrorPage = "refund",
): Response => errorRedirect(refundErrorUrls[page](attendeeId, returnUrl), msg);

/** Turn one provider run into either its safe error page or a success. */
export const singleRefundResultError = async (
  result: RefundBatchResult,
  attendeeId: number,
  returnUrl: string,
): Promise<Response | null> => {
  switch (result.kind) {
    case "blocked":
      return refundError(
        attendeeId,
        t("error.refund_pending"),
        returnUrl,
        "actions",
      );
    case "not_ready":
      return refundError(attendeeId, result.message, returnUrl);
    case "finished": {
      const { counts } = result;
      if (counts.refundedCount === 1) return null;
      // Every provider outcome that did not finish cleanly leaves its next
      // allowed action in the canonical recovery queue.
      return refundError(
        attendeeId,
        counts.notRecordedCount === 1
          ? t("error.refund_not_recorded")
          : counts.pendingCount === 1
            ? t("error.refund_pending")
            : t("error.refund_failed"),
        returnUrl,
        "recovery",
      );
    }
  }
};

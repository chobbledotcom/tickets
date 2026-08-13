/** Where one failed refund attempt can safely send the owner. */

import { t } from "#i18n";
import { attendeeActionUrlWithReturn } from "#routes/admin/attendees-route-helpers.ts";
import type { RefundBatchResult } from "#routes/admin/refunds/provider.ts";
import { errorRedirect } from "#routes/response.ts";
import { getPaymentWorkStatus } from "#shared/db/payment-review.ts";

type RefundErrorPage = "actions" | "refund";

const refundErrorUrls = {
  actions: (attendeeId: number, returnUrl: string): string =>
    returnUrl || `/admin/attendees/${attendeeId}/actions`,
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

/** Put unsafe work on Actions; an ordinary failed send may be retried. */
const refundResultError = async (
  attendeeId: number,
  msg: string,
  returnUrl: string,
  readWorkStatus: typeof getPaymentWorkStatus,
): Promise<Response> =>
  (await readWorkStatus(attendeeId)) === "clear"
    ? refundError(attendeeId, msg, returnUrl)
    : refundError(attendeeId, msg, returnUrl, "actions");

/** Turn one provider run into either its safe error page or a success. */
export const singleRefundResultError = async (
  result: RefundBatchResult,
  attendeeId: number,
  returnUrl: string,
  readWorkStatus: typeof getPaymentWorkStatus = getPaymentWorkStatus,
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
      // These outcomes all leave owner work. Re-read it before choosing the
      // page, so none can offer an unsafe second send.
      return await refundResultError(
        attendeeId,
        counts.notRecordedCount === 1
          ? t("error.refund_not_recorded")
          : counts.pendingCount === 1
            ? t("error.refund_pending")
            : t("error.refund_failed"),
        returnUrl,
        readWorkStatus,
      );
    }
  }
};

/** Owner confirmation for retiring durable payment-review work. */

/* jscpd:ignore-start -- imports */
import { t } from "#i18n";
import { OWNER_FORM, requireOwnerOr } from "#routes/auth.ts";
import { errorRedirect, redirect } from "#routes/response.ts";
import { defineRoutes } from "#routes/router.ts";
import {
  acknowledgeCurrentPaymentReview,
  type PaymentWorkStatus,
} from "#shared/db/payment-review.ts";
import { adminPaymentReviewPage } from "#templates/admin/attendees.tsx";
import {
  attendeeActions,
  attendeeActionUrlWithReturn,
} from "./attendees-route-helpers.ts";

/* jscpd:ignore-end */

const ACTION = "payment-review";

const REVIEW_GUARD = {
  clear: "admin.attendees.payment_review_none",
  moving: "admin.attendees.payment_review_in_progress",
  needs_money_record: "admin.attendees.payment_review_none",
  needs_review: null,
} satisfies Record<PaymentWorkStatus, string | null>;

const handlePaymentReviewGet = attendeeActions[ACTION].page(
  ({ attendee, paymentReview }, session, returnUrl, error) =>
    adminPaymentReviewPage(
      attendee,
      paymentReview.status === "needs_review"
        ? paymentReview.identity
        : null,
      session,
      returnUrl,
      error,
    ),
  async ({ paymentReview }) => {
    const messageKey = REVIEW_GUARD[paymentReview.status];
    return Promise.resolve(messageKey === null ? null : t(messageKey));
  },
  requireOwnerOr,
);

const handlePaymentReviewPost = attendeeActions[ACTION].verified(
  "payment review",
  async ({ attendee, listingId }, form) => {
    const result = await acknowledgeCurrentPaymentReview({
      attendeeId: attendee.id,
      listingId,
      reviewIdentity: form.getString("review_identity"),
    });
    const actionsUrl = `/admin/attendees/${attendee.id}/actions`;
    switch (result.kind) {
      case "acknowledged":
        return redirect(actionsUrl, t("success.payment_reviewed"), true, {
          form,
        });
      case "already_acknowledged":
        return redirect(
          actionsUrl,
          t("admin.attendees.payment_review_already_acknowledged"),
          true,
          { form, level: "info" },
        );
      case "review_changed":
        return errorRedirect(
          attendeeActionUrlWithReturn(
            attendee.id,
            ACTION,
            form.getString("return_url"),
          ),
          t("admin.attendees.payment_review_changed"),
        );
      case "nothing_to_review":
        return redirect(
          actionsUrl,
          t("admin.attendees.payment_review_none"),
          true,
          { form, level: "info" },
        );
      case "claim_in_progress":
        return errorRedirect(
          attendeeActionUrlWithReturn(
            attendee.id,
            ACTION,
            form.getString("return_url"),
          ),
          t("admin.attendees.payment_review_in_progress"),
        );
    }
  },
  OWNER_FORM,
);

export const paymentReviewHandlers = defineRoutes({
  "GET /admin/attendees/:attendeeId/payment-review": handlePaymentReviewGet,
  "POST /admin/attendees/:attendeeId/payment-review": handlePaymentReviewPost,
});
